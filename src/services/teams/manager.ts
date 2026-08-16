import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { withFileLock } from "../../utils/lockfile";

export type TeamMemberStatus =
  | "running"
  | "recovering"
  | "idle"
  | "shutdown_requested"
  | "completed"
  | "failed"
  | "stopped";

export type TeamMessageKind =
  | "message"
  | "broadcast"
  | "task_assignment"
  | "task_completed"
  | "idle_notification"
  | "shutdown_request"
  | "shutdown_approved"
  | "shutdown_rejected"
  | "teammate_terminated";

export type TeamMember = {
  name: string;
  agentId: string;
  agentType: string;
  status: TeamMemberStatus;
  ownerAgentId: string;
  runtimeTaskId?: string;
  assignedTaskId?: string;
  recoveryAttempts?: number;
  recoveryRetryAt?: string;
  lastRecoveryError?: string;
  createdAt: string;
  updatedAt: string;
};

export type TeamMessage = {
  id: string;
  from: string;
  to: string;
  text: string;
  kind: TeamMessageKind;
  summary?: string;
  payload?: Record<string, unknown>;
  replyTo?: string;
  createdAt: string;
  deliveredAt?: string;
  deliveredTo?: string[];
};

export type TeamState = {
  version: 2;
  name: string;
  leadSessionId: string;
  createdAt: string;
  updatedAt: string;
  members: TeamMember[];
  messages: TeamMessage[];
};

type TeamLease = {
  version: 1;
  ownerId: string;
  generation: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
};

export class TeamManager {
  private state: TeamState | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private messageListeners = new Set<(message: TeamMessage) => void>();
  private leaseGeneration: string | undefined;

  constructor(private filePath: string) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly current = (): TeamState | undefined => this.state ? structuredClone(this.state) : undefined;

  readonly onMessage = (listener: (message: TeamMessage) => void): (() => void) => {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  };

  async initialize(): Promise<void> {
    await this.load(this.filePath);
  }

  async switchStorage(filePath: string): Promise<void> {
    await this.commit();
    this.filePath = filePath;
    this.leaseGeneration = undefined;
    await this.load(filePath);
  }

  async ensureTeam(name: string, leadSessionId: string): Promise<TeamState> {
    const normalized = normalizeName(name, "team name");
    if (this.state) {
      if (this.state.name !== normalized) {
        throw new Error(`Session already owns team '${this.state.name}'`);
      }
      if (this.state.leadSessionId !== leadSessionId) {
        throw new Error(`Team '${normalized}' belongs to a different lead session`);
      }
      return structuredClone(this.state);
    }
    const now = new Date().toISOString();
    this.state = {
      version: 2,
      name: normalized,
      leadSessionId,
      createdAt: now,
      updatedAt: now,
      members: [{
        name: "main",
        agentId: leadSessionId,
        agentType: "team-lead",
        status: "running",
        ownerAgentId: leadSessionId,
        createdAt: now,
        updatedAt: now,
      }],
      messages: [],
    };
    await this.commit();
    return structuredClone(this.state);
  }

  async reserveMember(input: {
    teamName: string;
    name: string;
    agentId: string;
    agentType: string;
    ownerAgentId: string;
    assignedTaskId?: string;
  }): Promise<TeamMember> {
    const state = this.requireTeam(input.teamName);
    const baseName = normalizeName(input.name, "teammate name").replaceAll("@", "-");
    if (baseName.toLowerCase() === "main") throw new Error("'main' is reserved for the team lead");
    const recoverable = state.members.find((member) =>
      member.name.toLowerCase() === baseName.toLowerCase() &&
      (member.status === "recovering" || member.status === "idle") &&
      member.agentType === input.agentType && member.assignedTaskId === input.assignedTaskId
    );
    if (recoverable) {
      recoverable.ownerAgentId = input.ownerAgentId;
      recoverable.status = "running";
      recoverable.updatedAt = new Date().toISOString();
      state.updatedAt = recoverable.updatedAt;
      await this.commit();
      return structuredClone(recoverable);
    }
    const names = new Set(state.members.map(({ name }) => name.toLowerCase()));
    let name = baseName;
    for (let suffix = 2; names.has(name.toLowerCase()); suffix += 1) name = `${baseName}-${suffix}`;
    const now = new Date().toISOString();
    const member: TeamMember = {
      name,
      agentId: input.agentId,
      agentType: input.agentType,
      status: "running",
      ownerAgentId: input.ownerAgentId,
      createdAt: now,
      updatedAt: now,
      ...(input.assignedTaskId ? { assignedTaskId: input.assignedTaskId } : {}),
    };
    state.members.push(member);
    state.updatedAt = now;
    if (input.assignedTaskId) {
      this.appendMessage(state, {
        from: state.members[0]!.name,
        to: member.name,
        kind: "task_assignment",
        text: `Assigned task #${input.assignedTaskId}`,
        payload: { task_id: input.assignedTaskId },
      });
    }
    await this.commit();
    return structuredClone(member);
  }

  async attachTask(teamName: string, agentId: string, taskId: string): Promise<void> {
    const member = this.memberByAgentId(this.requireTeam(teamName), agentId);
    member.runtimeTaskId = taskId;
    member.updatedAt = new Date().toISOString();
    await this.commit();
  }

  async setStatus(teamName: string, agentId: string, status: TeamMemberStatus): Promise<void> {
    const state = this.requireTeam(teamName);
    const member = this.memberByAgentId(state, agentId);
    member.status = status;
    member.updatedAt = new Date().toISOString();
    state.updatedAt = member.updatedAt;
    await this.commit();
  }

  async send(input: {
    teamName: string;
    from: string;
    to: string;
    text: string;
    summary?: string;
    kind?: TeamMessageKind;
    payload?: Record<string, unknown>;
    replyTo?: string;
  }): Promise<TeamMessage> {
    const state = this.requireTeam(input.teamName);
    const from = this.resolveMember(state, input.from);
    const isBroadcast = input.to === "*" || input.kind === "broadcast";
    const to = isBroadcast ? undefined : this.resolveMember(state, input.to);
    const text = requiredText(input.text, "team message");
    const kind = isBroadcast ? "broadcast" : input.kind ?? "message";
    const message = this.appendMessage(state, {
      from: from.name,
      to: to?.name ?? "*",
      text,
      kind,
      ...(input.summary ? { summary: requiredText(input.summary, "team message summary") } : {}),
      ...(input.payload ? { payload: structuredClone(input.payload) } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    });
    this.applyProtocolTransition(state, message);
    await this.commit();
    for (const listener of this.messageListeners) listener(structuredClone(message));
    return structuredClone(message);
  }

  async requestShutdown(teamName: string, from: string, recipient: string, reason = "Team lead requested shutdown"): Promise<TeamMessage> {
    return this.send({ teamName, from, to: recipient, text: reason, kind: "shutdown_request" });
  }

  async respondToShutdown(input: {
    teamName: string;
    from: string;
    requestId: string;
    approved: boolean;
    reason?: string;
  }): Promise<TeamMessage> {
    const state = this.requireTeam(input.teamName);
    const request = state.messages.find((message) => message.id === input.requestId && message.kind === "shutdown_request");
    if (!request) throw new Error(`Unknown shutdown request: ${input.requestId}`);
    if (request.to !== this.resolveMember(state, input.from).name) {
      throw new Error("Only the requested teammate may respond to shutdown");
    }
    return this.send({
      teamName: input.teamName,
      from: input.from,
      to: request.from,
      text: input.reason?.trim() || (input.approved ? "Shutdown approved" : "Shutdown rejected"),
      kind: input.approved ? "shutdown_approved" : "shutdown_rejected",
      replyTo: request.id,
    });
  }

  async drain(teamName: string, recipient: string): Promise<TeamMessage[]> {
    const state = this.requireTeam(teamName);
    const member = this.resolveMember(state, recipient);
    const pending = state.messages.filter((message) =>
      (message.to === member.name && !message.deliveredAt) ||
      (message.to === "*" && message.from !== member.name && !message.deliveredTo?.includes(member.name))
    );
    if (!pending.length) return [];
    const deliveredAt = new Date().toISOString();
    for (const message of pending) {
      if (message.to === "*") message.deliveredTo = [...(message.deliveredTo ?? []), member.name];
      else message.deliveredAt = deliveredAt;
    }
    state.updatedAt = deliveredAt;
    await this.commit();
    return structuredClone(pending);
  }

  member(teamName: string, recipient: string): TeamMember {
    return structuredClone(this.resolveMember(this.requireTeam(teamName), recipient));
  }

  recoverableMembers(): TeamMember[] {
    return (this.state?.members ?? [])
      .filter((member) => member.name !== "main" && (
        member.status === "recovering" || (member.status === "idle" && this.pendingMessages(member.name).length > 0)
      ))
      .map((member) => structuredClone(member));
  }

  pendingMessages(recipient: string): TeamMessage[] {
    if (!this.state) return [];
    const member = this.resolveMember(this.state, recipient);
    return this.state.messages.filter((message) =>
      (message.to === member.name && !message.deliveredAt) ||
      (message.to === "*" && message.from !== member.name && !message.deliveredTo?.includes(member.name))
    ).map((message) => structuredClone(message));
  }

  async recordRecoveryFailure(teamName: string, agentId: string, attempts: number, retryAt: number, error: string): Promise<void> {
    const state = this.requireTeam(teamName);
    const member = this.memberByAgentId(state, agentId);
    member.recoveryAttempts = attempts;
    member.recoveryRetryAt = new Date(retryAt).toISOString();
    member.lastRecoveryError = error;
    member.updatedAt = new Date().toISOString();
    state.updatedAt = member.updatedAt;
    await this.commit();
  }

  async clearRecoveryFailure(teamName: string, agentId: string): Promise<void> {
    const state = this.requireTeam(teamName);
    const member = this.memberByAgentId(state, agentId);
    delete member.recoveryAttempts;
    delete member.recoveryRetryAt;
    delete member.lastRecoveryError;
    member.updatedAt = new Date().toISOString();
    state.updatedAt = member.updatedAt;
    await this.commit();
  }

  async acquireLease(ownerId: string, ttlMs: number, now = Date.now()): Promise<boolean> {
    validateLeaseInput(ownerId, ttlMs);
    const path = `${this.filePath}.lease`;
    return withFileLock(this.filePath, async () => {
      const current = await readLease(path);
      if (current && Date.parse(current.expiresAt) > now) {
        if (current.ownerId !== ownerId) return false;
        this.leaseGeneration = current.generation;
        await writeLease(path, refreshLease(current, ttlMs, now));
        return true;
      }
      const lease = createLease(ownerId, ttlMs, now);
      await writeLease(path, lease);
      this.leaseGeneration = lease.generation;
      return true;
    });
  }

  async renewLease(ownerId: string, ttlMs: number, now = Date.now()): Promise<boolean> {
    validateLeaseInput(ownerId, ttlMs);
    const path = `${this.filePath}.lease`;
    return withFileLock(this.filePath, async () => {
      const current = await readLease(path);
      if (
        !current || current.ownerId !== ownerId || current.generation !== this.leaseGeneration ||
        Date.parse(current.expiresAt) <= now
      ) return false;
      await writeLease(path, refreshLease(current, ttlMs, now));
      return true;
    });
  }

  async releaseLease(ownerId: string): Promise<boolean> {
    const path = `${this.filePath}.lease`;
    return withFileLock(this.filePath, async () => {
      const current = await readLease(path);
      if (!current || current.ownerId !== ownerId || current.generation !== this.leaseGeneration) return false;
      await unlink(path).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
      this.leaseGeneration = undefined;
      return true;
    });
  }

  private appendMessage(
    state: TeamState,
    input: Omit<TeamMessage, "id" | "createdAt">,
  ): TeamMessage {
    const message: TeamMessage = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    state.messages.push(message);
    state.updatedAt = message.createdAt;
    return message;
  }

  private applyProtocolTransition(state: TeamState, message: TeamMessage): void {
    let member: TeamMember | undefined;
    if (message.kind === "shutdown_request") {
      member = this.resolveMember(state, message.to);
      member.status = "shutdown_requested";
    } else if (message.kind === "shutdown_rejected") {
      member = this.resolveMember(state, message.from);
      member.status = "running";
    } else if (message.kind === "shutdown_approved" || message.kind === "teammate_terminated") {
      member = this.resolveMember(state, message.from);
      member.status = "stopped";
    } else if (message.kind === "idle_notification") {
      member = this.resolveMember(state, message.from);
      member.status = "idle";
    } else if (message.kind === "task_completed") {
      member = this.resolveMember(state, message.from);
      member.status = "completed";
    }
    if (member) member.updatedAt = message.createdAt;
  }

  private requireTeam(name: string): TeamState {
    if (!this.state) throw new Error("No Agent Team has been created for this session");
    if (this.state.name !== name) throw new Error(`Unknown Agent Team: ${name}`);
    return this.state;
  }

  private resolveMember(state: TeamState, value: string): TeamMember {
    const normalized = normalizeName(value, "team recipient").toLowerCase();
    const member = state.members.find(({ name, agentId }) =>
      name.toLowerCase() === normalized || agentId.toLowerCase() === normalized);
    if (!member) throw new Error(`Unknown teammate '${value}' in team '${state.name}'`);
    return member;
  }

  private memberByAgentId(state: TeamState, agentId: string): TeamMember {
    const member = state.members.find((candidate) => candidate.agentId === agentId);
    if (!member) throw new Error(`Unknown team agent: ${agentId}`);
    return member;
  }

  private async load(filePath: string): Promise<void> {
    try {
      this.state = parseState(JSON.parse(await readFile(filePath, "utf8")), filePath);
      const now = new Date().toISOString();
      for (const member of this.state.members) {
        if (member.name !== "main" && (member.status === "running" || member.status === "shutdown_requested")) {
          member.status = "recovering";
          member.updatedAt = now;
        }
      }
      this.state.updatedAt = now;
      await this.commit();
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.state = undefined;
    }
    this.publish();
  }

  private async commit(): Promise<void> {
    if (!this.state) {
      this.publish();
      return;
    }
    const filePath = this.filePath;
    const state = structuredClone(this.state);
    this.publish();
    let committed: TeamState | undefined;
    const currentWrite = this.writeQueue.catch(() => undefined).then(async () => {
      await withFileLock(filePath, async () => {
        const persisted = await readTeamState(filePath);
        const merged = persisted ? mergeTeamStates(persisted, state) : state;
        const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, filePath);
        committed = merged;
      });
    });
    this.writeQueue = currentWrite;
    await currentWrite;
    if (committed && this.filePath === filePath) this.state = structuredClone(committed);
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}

export function formatTeamMessages(messages: TeamMessage[]): string | undefined {
  if (!messages.length) return undefined;
  return messages.map((message) => {
    const attributes = [
      `id="${escapeAttribute(message.id)}"`,
      `from="${escapeAttribute(message.from)}"`,
      `type="${message.kind}"`,
      ...(message.replyTo ? [`reply_to="${escapeAttribute(message.replyTo)}"`] : []),
      ...(message.summary ? [`summary="${escapeAttribute(message.summary)}"`] : []),
    ].join(" ");
    const payload = message.payload ? `\nPayload: ${JSON.stringify(message.payload)}` : "";
    return `<teammate-message ${attributes}>\n${message.text}${payload}\n</teammate-message>`;
  }).join("\n\n");
}

function parseState(value: unknown, path: string): TeamState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid team state: ${path}`);
  const state = value as Omit<Partial<TeamState>, "version"> & { version?: number };
  if (
    (state.version !== 1 && state.version !== 2) || typeof state.name !== "string" || typeof state.leadSessionId !== "string" ||
    typeof state.createdAt !== "string" || typeof state.updatedAt !== "string" ||
    !Array.isArray(state.members) || !Array.isArray(state.messages)
  ) throw new Error(`Invalid team state: ${path}`);
  for (const member of state.members) {
    if (!member || typeof member !== "object") throw new Error(`Invalid team member: ${path}`);
    const item = member as Partial<TeamMember>;
    if (
      typeof item.name !== "string" || typeof item.agentId !== "string" || typeof item.agentType !== "string" ||
      typeof item.ownerAgentId !== "string" || typeof item.createdAt !== "string" || typeof item.updatedAt !== "string" ||
      !["running", "recovering", "idle", "shutdown_requested", "completed", "failed", "stopped"].includes(item.status ?? "")
    ) throw new Error(`Invalid team member: ${path}`);
    if (item.recoveryAttempts !== undefined && (!Number.isSafeInteger(item.recoveryAttempts) || item.recoveryAttempts < 0)) {
      throw new Error(`Invalid team recovery attempts: ${path}`);
    }
    if (item.recoveryRetryAt !== undefined && typeof item.recoveryRetryAt !== "string") throw new Error(`Invalid team recovery retry time: ${path}`);
    if (item.lastRecoveryError !== undefined && typeof item.lastRecoveryError !== "string") throw new Error(`Invalid team recovery error: ${path}`);
  }
  for (const message of state.messages) {
    if (!message || typeof message !== "object") throw new Error(`Invalid team message: ${path}`);
    const item = message as Partial<TeamMessage>;
    if (
      typeof item.id !== "string" || typeof item.from !== "string" || typeof item.to !== "string" ||
      typeof item.text !== "string" || typeof item.createdAt !== "string"
    ) throw new Error(`Invalid team message: ${path}`);
    if (item.kind !== undefined && !isMessageKind(item.kind)) throw new Error(`Invalid team message kind: ${path}`);
  }
  const migrated = structuredClone(state) as Omit<TeamState, "version"> & { version: 1 | 2 };
  migrated.version = 2;
  for (const message of migrated.messages) message.kind ??= "message";
  return migrated as TeamState;
}

function isMessageKind(value: unknown): value is TeamMessageKind {
  return [
    "message", "broadcast", "task_assignment", "task_completed", "idle_notification",
    "shutdown_request", "shutdown_approved", "shutdown_rejected", "teammate_terminated",
  ].includes(String(value));
}

function normalizeName(value: string, label: string): string {
  const name = requiredText(value, label);
  if (/\p{Cc}/u.test(name)) throw new Error(`${label} cannot contain control characters`);
  return name;
}

function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readLease(path: string): Promise<TeamLease | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const lease = value as Partial<TeamLease>;
    if (lease.version !== 1 || typeof lease.ownerId !== "string" || typeof lease.acquiredAt !== "string" || typeof lease.heartbeatAt !== "string" || typeof lease.expiresAt !== "string") return undefined;
    return {
      ...lease,
      generation: typeof lease.generation === "string" ? lease.generation : `${lease.ownerId}:${lease.acquiredAt}`,
    } as TeamLease;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function createLease(ownerId: string, ttlMs: number, now: number): TeamLease {
  const timestamp = new Date(now).toISOString();
  return {
    version: 1,
    ownerId,
    generation: randomUUID(),
    acquiredAt: timestamp,
    heartbeatAt: timestamp,
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

function refreshLease(lease: TeamLease, ttlMs: number, now: number): TeamLease {
  return {
    ...lease,
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

async function writeLease(path: string, lease: TeamLease): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(lease)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function readTeamState(filePath: string): Promise<TeamState | undefined> {
  try {
    const source = await readFile(filePath, "utf8");
    if (!source.trim()) return undefined;
    return parseState(JSON.parse(source), filePath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function mergeTeamStates(persisted: TeamState, local: TeamState): TeamState {
  if (persisted.name !== local.name || persisted.leadSessionId !== local.leadSessionId) {
    throw new Error(`Team state identity changed while writing '${local.name}'`);
  }

  const members = new Map(persisted.members.map((member) => [member.agentId, structuredClone(member)]));
  for (const member of local.members) {
    const current = members.get(member.agentId);
    if (!current || Date.parse(member.updatedAt) >= Date.parse(current.updatedAt)) {
      members.set(member.agentId, structuredClone(member));
    }
  }

  const messages = new Map(persisted.messages.map((message) => [message.id, structuredClone(message)]));
  for (const message of local.messages) {
    const current = messages.get(message.id);
    if (!current) {
      messages.set(message.id, structuredClone(message));
      continue;
    }
    messages.set(message.id, {
      ...current,
      ...structuredClone(message),
      ...(current.deliveredAt || message.deliveredAt ? { deliveredAt: message.deliveredAt ?? current.deliveredAt } : {}),
      ...(current.deliveredTo || message.deliveredTo ? {
        deliveredTo: [...new Set([...(current.deliveredTo ?? []), ...(message.deliveredTo ?? [])])],
      } : {}),
    });
  }

  return {
    version: 2,
    name: local.name,
    leadSessionId: local.leadSessionId,
    createdAt: Date.parse(persisted.createdAt) <= Date.parse(local.createdAt) ? persisted.createdAt : local.createdAt,
    updatedAt: Date.parse(persisted.updatedAt) >= Date.parse(local.updatedAt) ? persisted.updatedAt : local.updatedAt,
    members: [...members.values()].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)),
    messages: [...messages.values()].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)),
  };
}

function validateLeaseInput(ownerId: string, ttlMs: number): void {
  if (!ownerId.trim()) throw new Error("team lease ownerId must be non-empty");
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("team lease ttlMs must be a positive integer");
}
