import { mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createReadTool, createWriteTool, createEditTool, createGlobTool, createGrepTool } from "../../tools/builtins";
import { createShellTools } from "../../tools/shell";
import { createFileStateCacheWithSizeLimit } from "../../utils/file-state-cache";
import { createPermissionChecker } from "../../core/permissions";
import { loadProviderCatalog, resolveProviderSelection } from "../../providers/config";
import { createConfiguredTransport, resolveBillingRoute } from "../../providers/factory";
import { createSandboxRuntime } from "../sandbox/factory";
import { createSandboxHost } from "../sandbox/shared";
import { ShellSessionManager } from "../shell/manager";
import { loadProjectInstructions } from "../project-context";
import { loadSettings } from "../settings/load";
import { digestJson } from "./json";
import type { RuntimeWorkerFactory } from "./engine";

/** Compose existing tnb tools/providers; credentials stay on the host, outside model and shell environments. */
export function createRuntimeWorkerFactory(options: { configDir: string; runtimeRoot: string; env: Record<string, string | undefined> }): RuntimeWorkerFactory {
  return async ({ task, configuration, signal }) => {
    const catalog = await loadProviderCatalog({ configDir: options.configDir, env: options.env });
    const selection = resolveProviderSelection(catalog, configuration.provider ?? options.env.TNB_PROVIDER ?? "anthropic", configuration.model ?? options.env.TNB_MODEL);
    const reads = createFileStateCacheWithSizeLimit(100);
    const workspace = await realpath(configuration.workspace);
    const settings = await loadSettings({ configDir: options.configDir, cwd: workspace });
    const tools = [createReadTool(workspace, { supportsVision: false, supportsPdf: false }, undefined, reads), createGlobTool(workspace), createGrepTool(workspace)];
    if (configuration.allowWrite) tools.push(createWriteTool(workspace, undefined, reads), createEditTool(workspace, undefined, reads));
    let shell: ShellSessionManager | undefined;
    if (configuration.allowShell || configuration.checks.length) {
      const home = join(workspace, ".tnb", "runtime-home"); await mkdir(home, { recursive: true, mode: 0o700 });
      const temporaryDirectory = join(home, "tmp"); await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      const environment = { PATH: options.env.PATH, HOME: home, TMPDIR: temporaryDirectory, LANG: options.env.LANG, TNB_SHELL: "/bin/sh" };
      const host = createSandboxHost(environment);
      const sandbox = createSandboxRuntime({ requested: true, env: environment,
        settings: { enabled: true, profile: "strict", networkAccess: false } }, { ...host,
        homeDirectory: home, temporaryDirectory,
        // The generic backend admits dirname(dirname(execPath)); keep that root at the executable directory.
        execPath: join(dirname(process.execPath), "bin", "runtime-host"),
      });
      if (!sandbox) throw new Error("A native sandbox is required for durable Shell and verification");
      const protectedRoots = [resolve(options.configDir), resolve(options.runtimeRoot), join(homedir(), ".ssh"), join(homedir(), ".aws")];
      const protectedCanonical = await Promise.all(protectedRoots.map((path) => realpath(path).catch(() => path)));
      shell = new ShellSessionManager({ cwd: workspace, outputDir: join(options.runtimeRoot, task.taskId, "shell"), env: environment,
        sandbox: { ...sandbox, wrap(file, args, cwd) {
          const command = sandbox.wrap(file, args, cwd);
          if (sandbox.command === "sandbox-exec") {
            const index = command.args.indexOf("-p") + 1;
            // The general interactive profile admits shared /tmp. Durable workers use only
            // their workspace scratch directory, keeping other tasks and local control files private.
            command.args[index] = command.args[index]!.replace(/\n  \(subpath "\/tmp"\)/g, "").replace(/\n  \(subpath "\/private\/tmp"\)/g, "");
            command.args[index] += protectedCanonical.map((path) => `\n(deny file-read* file-write* (subpath ${JSON.stringify(path)}))`).join("");
          }
          return command;
        } },
      });
      if (configuration.allowShell) {
        const bash = createShellTools(shell, environment)[0]!;
        const validate = bash.validate;
        bash.validate = (value) => {
          const input = validate(value) as { pty?: boolean; runInBackground?: boolean };
          if (input.pty || input.runInBackground) throw new Error("Durable Shell uses foreground execution; detach work through a durable task instead");
          return input;
        };
        tools.push(bash);
      }
    }
    const checker = createPermissionChecker({ cwd: workspace, trustedFolders: [workspace], mode: configuration.allowWrite ? "acceptEdits" : "plan",
      rules: { deny: settings.permissions?.deny, ask: settings.permissions?.ask, allow: configuration.allowShell ? ["Bash(*)"] : [] } });
    const checkPermission = createPermissionChecker({ cwd: workspace, trustedFolders: [workspace], mode: "acceptEdits",
      rules: { deny: settings.permissions?.deny, ask: settings.permissions?.ask, allow: ["Bash(*)"] } });
    return {
      // Each physical request has one persistent reservation. Retries belong to the durable scheduler.
      transport: { stream: (request, requestSignal) => createConfiguredTransport(selection, undefined, false, { maxRetries: 0 }).stream(request, requestSignal) }, model: selection.model.id, tools,
      route: resolveBillingRoute(selection, selection.model.id), maxOutputTokens: Math.min(selection.model.maxTokens, 8192),
      binding: { provider: selection.provider.id, api: selection.provider.api, endpoint: selection.provider.baseUrl, model: selection.model,
        headers: digestJson(selection.provider.headers), permissions: { deny: settings.permissions?.deny, ask: settings.permissions?.ask } },
      projectInstructions: await loadProjectInstructions(workspace, { stopAt: workspace }),
      authorize: async (tool, input, context) => {
        signal.throwIfAborted();
        if (tool.name === "agent") return { behavior: "allow" };
        return checker({ ...tool, risk: tool.access }, input, signal, context);
      },
      check: shell ? async (command, checkSignal) => {
        if (!configuration.checks.includes(command)) throw new Error("Verification command is not authorized");
        const decision = await checkPermission({ name: "Bash", risk: "execute", isReadOnly: () => false, permissionRuleContent: () => command }, { command }, checkSignal);
        if (decision.behavior !== "allow") throw new Error(decision.message);
        return shell.runForeground(command, 120_000, checkSignal);
      } : undefined,
      close: () => shell?.close() ?? Promise.resolve(),
    };
  };
}
