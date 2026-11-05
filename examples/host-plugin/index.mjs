export default api => {
  api.registerApplication({ id: "status-panel", version: "1", start(context) {
    const runtime = context.service("tnb.runtime.read/v1");
    context.state.command("initialize", { schema: 1 }, tx => tx.save("visits", { count: 0 }, 0));
    return {
      async handle(request) {
        if (request.method === "POST") {
          const { commandId } = await request.json();
          context.state.command(commandId, { action: "visit" }, tx => {
            const current = tx.get("visits");
            return tx.save("visits", { count: current.value.count + 1 }, current.revision);
          });
        }
        return Response.json({ runs: runtime.runs().length, visits: context.state.get("visits").value.count });
      },
      status: () => ({ ready: true }),
    };
  } });
  api.registerInterface({ id: "status-view", version: "1", start(context) {
    return { async handle(request) {
      const response = await context.request({ kind: "application", id: "status-panel", version: "1" }, new Request("http://plugin/status"));
      const { runs, visits } = await response.json();
      return new Response(`<!doctype html><title>TNB plugin example</title><h1>TNB status</h1><p>Runs: ${Number(runs)} · Visits: ${Number(visits)}</p>`, { headers: { "content-type": "text/html; charset=utf-8" } });
    } };
  } });
  api.registerChannel({ id: "local-notes", version: "1", connect(configuration, context) {
    if (!configuration || typeof configuration.command !== "string") throw new Error("local-notes requires a fixed command");
    return {
      async poll(cursor, signal) {
        signal.throwIfAborted();
        return { cursor: "initial", events: cursor === "initial" ? [] : [{ externalId: "initial", actor: "operator", thread: "notes", text: configuration.command }] };
      },
      async send(message, signal) {
        signal.throwIfAborted();
        const receipt = `local-note:${message.id}`;
        context.state.command(message.id, { thread: message.thread, text: message.text }, tx => tx.save(message.id, { receipt, text: message.text }, 0));
        return receipt;
      },
      async find(message, signal) { signal.throwIfAborted(); return context.state.get(message.id)?.value.receipt; },
    };
  } });
};
