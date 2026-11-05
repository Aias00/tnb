import packageJson from "../../../package.json";
import type { BuiltinHostPlugin, HostPluginFactory } from "../../agent/plugins";
import { TASK_SERVICE, type TaskService } from "../../agent/task-service";
import { hostCodeFingerprint } from "../../agent/plugin-fingerprint";
import { createWebWorkbench } from "./server";

export const WEB_EXTENSION = { kind: "interface" as const, id: "web", version: "1" };
export const webSetup: HostPluginFactory = api => api.registerInterface({ id: "web", version: "1", start(context) {
  const workbench = createWebWorkbench({ tasks: context.service<TaskService>(TASK_SERVICE), signal: context.signal });
  context.onDispose(workbench.close);
  return { status: workbench.status, async handle(request) {
    if (request.method === "GET") return Response.json(workbench.status());
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/launch")) return Response.json({ error: "Unknown web operation" }, { status: 404 });
    const input = await request.json() as { workspace?: unknown; port?: unknown };
    if (!input || typeof input.workspace !== "string" || Object.keys(input).some(key => !["workspace", "port"].includes(key))) throw new Error("Web launch requires an explicit workspace");
    return Response.json(await workbench.launch(input.workspace, input.port as number | undefined));
  } };
} });
export async function createWebPlugin(): Promise<BuiltinHostPlugin> {
  return { identity: { name: "tnb-web", version: packageJson.version, fingerprint: await hostCodeFingerprint() },
    extensions: [{ ...WEB_EXTENSION, entry: "index.mjs", services: [TASK_SERVICE], requires: [] }], setup: webSetup };
}
export default webSetup;
