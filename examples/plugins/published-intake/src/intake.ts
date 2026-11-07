import { defineProcessPlugin, EXECUTION_SERVICE_REF, type CapabilityRequest } from "@tnb/plugin-sdk";

// No runtime control key, raw store, model credentials or resource grants cross this boundary.
export default defineProcessPlugin({ protocol: "tnb.process-plugin/v1", async start(context) {
  return { async handle(request) {
    const url = new URL(request.url);
    let value: unknown;
    if (request.method === "POST" && url.pathname.endsWith("/submit")) {
      const input = JSON.parse(request.body ?? "null") as CapabilityRequest;
      value = await context.call(EXECUTION_SERVICE_REF, "submit", [input]);
    } else if (request.method === "GET" && url.pathname.endsWith("/status")) {
      value = await context.call(EXECUTION_SERVICE_REF, "status", [{ runId: url.searchParams.get("runId") ?? "", ...(url.searchParams.has("after") ? { after: url.searchParams.get("after")! } : {}) }]);
    } else if (request.method === "GET" && url.pathname.endsWith("/result")) {
      value = await context.call(EXECUTION_SERVICE_REF, "result", [{ runId: url.searchParams.get("runId") ?? "", taskId: url.searchParams.get("taskId") ?? "", offset: Number(url.searchParams.get("offset") ?? 0) }]);
    } else if (request.method === "GET" && url.pathname.endsWith("/catalog")) {
      value = await context.call(EXECUTION_SERVICE_REF, "catalog", [{ ...(url.searchParams.has("after") ? { after: url.searchParams.get("after")! } : {}) }]);
    } else return { status: 404, body: "Unknown endpoint" };
    return { status: 200, headers: [["content-type", "application/json"]], body: JSON.stringify(value) };
  } };
} });
