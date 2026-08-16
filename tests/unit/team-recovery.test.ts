import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TeamManager } from "../../src/services/teams/manager";
import { TeamSupervisor } from "../../src/services/teams/supervisor";
import type { TaskRecord } from "../../src/services/tasks/manager";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Agent Team recovery", () => {
  test("keeps an empty session supervisor idle without creating a lease or reporting an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-team-"));
    roots.push(root);
    const manager = new TeamManager(join(root, "missing", "team.json"));
    await manager.initialize();
    const errors: string[] = [];
    const supervisor = new TeamSupervisor(
      manager,
      () => [],
      (error) => errors.push(error.message),
      { recoveryPollIntervalMs: 5 },
    );

    supervisor.start();
    await Bun.sleep(15);
    await supervisor.close();

    expect(errors).toEqual([]);
  });

  test("grants one durable supervisor lease and permits takeover after release", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-team-"));
    roots.push(root);
    const path = join(root, "team.json");
    const first = new TeamManager(path);
    await first.initialize();
    await first.ensureTeam("delivery", "lead-session");
    const second = new TeamManager(path);
    await second.initialize();

    expect(await first.acquireLease("owner-a", 1_000, 1_000)).toBe(true);
    expect(await second.acquireLease("owner-b", 1_000, 1_100)).toBe(false);
    expect(await second.releaseLease("owner-b")).toBe(false);
    expect(await first.renewLease("owner-a", 1_000, 1_200)).toBe(true);
    expect(await first.releaseLease("owner-a")).toBe(true);
    expect(await second.acquireLease("owner-b", 1_000, 1_300)).toBe(true);
    expect(await second.releaseLease("owner-b")).toBe(true);
  });

  test("serializes concurrent lease acquisition across manager instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-team-"));
    roots.push(root);
    const path = join(root, "team.json");
    const first = new TeamManager(path);
    await first.initialize();
    await first.ensureTeam("delivery", "lead-session");
    const second = new TeamManager(path);
    await second.initialize();

    const results = await Promise.all([
      first.acquireLease("owner-a", 1_000, 1_000),
      second.acquireLease("owner-b", 1_000, 1_000),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("fences an expired lease owner after another supervisor takes over", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-team-"));
    roots.push(root);
    const path = join(root, "team.json");
    const first = new TeamManager(path);
    await first.initialize();
    await first.ensureTeam("delivery", "lead-session");
    const replacement = new TeamManager(path);
    await replacement.initialize();

    expect(await first.acquireLease("owner-a", 100, 1_000)).toBe(true);
    expect(await replacement.acquireLease("owner-b", 1_000, 1_101)).toBe(true);
    expect(await first.renewLease("owner-a", 1_000, 1_102)).toBe(false);
    expect(await first.releaseLease("owner-a")).toBe(false);
    expect(await replacement.renewLease("owner-b", 1_000, 1_103)).toBe(true);
  });

  test("preserves concurrent team messages written by separate managers", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-team-"));
    roots.push(root);
    const path = join(root, "team.json");
    const first = new TeamManager(path);
    await first.initialize();
    await first.ensureTeam("delivery", "lead-session");
    const second = new TeamManager(path);
    await second.initialize();

    await Promise.all([
      first.send({ teamName: "delivery", from: "main", to: "main", text: "from first" }),
      second.send({ teamName: "delivery", from: "main", to: "main", text: "from second" }),
    ]);

    const restored = new TeamManager(path);
    await restored.initialize();
    expect(restored.current()?.messages.map(({ text }) => text).sort()).toEqual(["from first", "from second"]);
  });

  test("preserves the durable agent identity when a recovering member is reserved", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-team-"));
    roots.push(root);
    const path = join(root, "team.json");
    const first = new TeamManager(path);
    await first.initialize();
    await first.ensureTeam("delivery", "lead-session");
    await first.reserveMember({
      teamName: "delivery",
      name: "reviewer",
      agentId: "durable-agent-id",
      agentType: "general-purpose",
      ownerAgentId: "lead-session",
      assignedTaskId: "7",
    });

    const restored = new TeamManager(path);
    await restored.initialize();
    expect(restored.member("delivery", "reviewer")).toMatchObject({ status: "recovering", agentId: "durable-agent-id" });
    const member = await restored.reserveMember({
      teamName: "delivery",
      name: "reviewer",
      agentId: "replacement-id-must-not-win",
      agentType: "general-purpose",
      ownerAgentId: "lead-session",
      assignedTaskId: "7",
    });
    expect(member).toMatchObject({ status: "running", agentId: "durable-agent-id" });
  });

  test("recovers persisted teammates and actively resumes idle mail recipients", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-team-"));
    roots.push(root);
    const path = join(root, "team.json");
    const manager = new TeamManager(path);
    await manager.initialize();
    await manager.ensureTeam("delivery", "lead-session");
    const member = await manager.reserveMember({
      teamName: "delivery",
      name: "reviewer",
      agentId: "agent-1",
      agentType: "general-purpose",
      ownerAgentId: "lead-session",
    });
    await manager.attachTask("delivery", member.agentId, "agent-runtime");
    await manager.setStatus("delivery", member.agentId, "idle");
    const task: TaskRecord = {
      id: "agent-runtime",
      type: "agent",
      subject: "Review",
      description: "Review changes",
      profile: "general-purpose",
      status: "completed",
      blocks: [],
      blockedBy: [],
      metadata: { agentId: member.agentId, teamName: "delivery", teammateName: "reviewer" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const resumed: string[] = [];
    const supervisor = new TeamSupervisor(manager, () => [task]);
    supervisor.setResumeHandler(async ({ cause }) => void resumed.push(cause));
    supervisor.start();

    await manager.send({ teamName: "delivery", from: "main", to: "reviewer", text: "Check one more file" });
    await Bun.sleep(10);
    expect(resumed).toEqual(["message"]);
    await supervisor.close();
    await manager.setStatus("delivery", member.agentId, "running");

    const restored = new TeamManager(path);
    await restored.initialize();
    const recovery: string[] = [];
    const recoveringSupervisor = new TeamSupervisor(restored, () => [{ ...task, status: "stopped" }]);
    recoveringSupervisor.setResumeHandler(async ({ cause }) => void recovery.push(cause));
    recoveringSupervisor.start();
    await Bun.sleep(10);
    expect(restored.member("delivery", "reviewer").runtimeTaskId).toBe("agent-runtime");
    expect(recovery).toEqual(["recovery"]);
    await recoveringSupervisor.close();
  });

  test("matches recovery to the member's persisted runtime task instead of a newer task", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-team-"));
    roots.push(root);
    const path = join(root, "team.json");
    const manager = new TeamManager(path);
    await manager.initialize();
    await manager.ensureTeam("delivery", "lead-session");
    const member = await manager.reserveMember({
      teamName: "delivery",
      name: "reviewer",
      agentId: "agent-1",
      agentType: "general-purpose",
      ownerAgentId: "lead-session",
    });
    await manager.attachTask("delivery", member.agentId, "runtime-original");
    await manager.setStatus("delivery", member.agentId, "running");

    const restored = new TeamManager(path);
    await restored.initialize();
    const now = new Date().toISOString();
    const task = (id: string): TaskRecord => ({
      id,
      type: "agent",
      subject: id,
      description: id,
      profile: "general-purpose",
      status: "stopped",
      blocks: [],
      blockedBy: [],
      metadata: { agentId: member.agentId, teamName: "delivery", teammateName: "reviewer" },
      createdAt: now,
      updatedAt: now,
    });
    const resumed: string[] = [];
    const supervisor = new TeamSupervisor(restored, () => [task("runtime-original"), task("runtime-newer")]);
    supervisor.setResumeHandler(async ({ task: recovered }) => {
      resumed.push(recovered.id);
      await restored.setStatus("delivery", member.agentId, "running");
    });
    supervisor.start();
    await Bun.sleep(10);

    expect(resumed).toEqual(["runtime-original"]);
    await supervisor.close();
  });

  test("retries failed recovery with backoff and stops scheduling after close", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-team-"));
    roots.push(root);
    const path = join(root, "team.json");
    const manager = new TeamManager(path);
    await manager.initialize();
    await manager.ensureTeam("delivery", "lead-session");
    const member = await manager.reserveMember({
      teamName: "delivery",
      name: "reviewer",
      agentId: "agent-1",
      agentType: "general-purpose",
      ownerAgentId: "lead-session",
    });
    await manager.attachTask("delivery", member.agentId, "agent-runtime");
    await manager.setStatus("delivery", member.agentId, "running");

    const restored = new TeamManager(path);
    await restored.initialize();
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: "agent-runtime",
      type: "agent",
      subject: "Review",
      description: "Review changes",
      profile: "general-purpose",
      status: "stopped",
      blocks: [],
      blockedBy: [],
      metadata: { agentId: member.agentId, teamName: "delivery", teammateName: "reviewer" },
      createdAt: now,
      updatedAt: now,
    };
    const errors: string[] = [];
    let attempts = 0;
    const supervisor = new TeamSupervisor(
      restored,
      () => [task],
      (error) => errors.push(error.message),
      { recoveryPollIntervalMs: 5, retryBaseDelayMs: 5, retryMaxDelayMs: 10 },
    );
    supervisor.setResumeHandler(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary recovery failure");
      await restored.setStatus("delivery", member.agentId, "running");
    });
    supervisor.start();
    await Bun.sleep(35);

    expect(attempts).toBe(2);
    expect(errors).toEqual(["temporary recovery failure"]);
    expect(restored.member("delivery", member.agentId).recoveryAttempts).toBeUndefined();
    await supervisor.close();
    const attemptsAtClose = attempts;
    await restored.setStatus("delivery", member.agentId, "recovering");
    await Bun.sleep(20);
    expect(attempts).toBe(attemptsAtClose);
  });

  test("wakes an idle teammate from durable pending mail after process restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-team-"));
    roots.push(root);
    const path = join(root, "team.json");
    const manager = new TeamManager(path);
    await manager.initialize();
    await manager.ensureTeam("delivery", "lead-session");
    const member = await manager.reserveMember({
      teamName: "delivery", name: "reviewer", agentId: "agent-1", agentType: "general-purpose", ownerAgentId: "lead-session",
    });
    await manager.attachTask("delivery", member.agentId, "runtime-1");
    await manager.setStatus("delivery", member.agentId, "idle");
    await manager.send({ teamName: "delivery", from: "main", to: "reviewer", text: "Resume review" });

    const restored = new TeamManager(path);
    await restored.initialize();
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: "runtime-1", type: "agent", subject: "Review", description: "Review", profile: "general-purpose", status: "completed",
      blocks: [], blockedBy: [], metadata: { agentId: member.agentId }, createdAt: now, updatedAt: now,
    };
    const resumed: string[] = [];
    const supervisor = new TeamSupervisor(restored, () => [task], undefined, { recoveryPollIntervalMs: 5 });
    supervisor.setResumeHandler(async ({ cause, message }) => {
      resumed.push(`${cause}:${message?.text}`);
      await restored.setStatus("delivery", member.agentId, "running");
    });
    supervisor.start();
    await Bun.sleep(10);
    expect(resumed).toEqual(["message:Resume review"]);
    await supervisor.close();
  });

  test("persists recovery backoff so a replacement supervisor does not hot-loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-team-"));
    roots.push(root);
    const path = join(root, "team.json");
    const manager = new TeamManager(path);
    await manager.initialize();
    await manager.ensureTeam("delivery", "lead-session");
    const member = await manager.reserveMember({
      teamName: "delivery", name: "reviewer", agentId: "agent-1", agentType: "general-purpose", ownerAgentId: "lead-session",
    });
    await manager.attachTask("delivery", member.agentId, "runtime-1");
    await manager.setStatus("delivery", member.agentId, "running");
    const restored = new TeamManager(path);
    await restored.initialize();
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: "runtime-1", type: "agent", subject: "Review", description: "Review", profile: "general-purpose", status: "stopped",
      blocks: [], blockedBy: [], metadata: { agentId: member.agentId }, createdAt: now, updatedAt: now,
    };
    const first = new TeamSupervisor(restored, () => [task], undefined, {
      recoveryPollIntervalMs: 100, retryBaseDelayMs: 40, retryMaxDelayMs: 40,
    });
    first.setResumeHandler(async () => { throw new Error("provider unavailable"); });
    first.start();
    await Bun.sleep(10);
    await first.close();
    expect(restored.member("delivery", member.agentId)).toMatchObject({ recoveryAttempts: 1, lastRecoveryError: "provider unavailable" });

    const replacement = new TeamSupervisor(restored, () => [task], undefined, {
      recoveryPollIntervalMs: 5, retryBaseDelayMs: 5, retryMaxDelayMs: 5,
    });
    let attempts = 0;
    replacement.setResumeHandler(async () => {
      attempts += 1;
      await restored.setStatus("delivery", member.agentId, "running");
    });
    replacement.start();
    await Bun.sleep(15);
    expect(attempts).toBe(0);
    await Bun.sleep(35);
    expect(attempts).toBe(1);
    await replacement.close();
  });
});
