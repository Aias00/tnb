import type { HostPluginFactory } from "../../agent/plugins";
import type { ChannelPort } from "../../agent/extensions";
import type { Source } from "../../services/collaboration/types";
import { GitHubSource, TimerSource, WebhookSource } from "../../services/collaboration/sources";

export function channelSetup(env: Record<string, string | undefined>): HostPluginFactory {
  return api => {
    for (const type of ["github", "webhook", "timer"] as const) api.registerChannel({ id: type, version: "1",
      connect(configuration) {
        const source = configuration as unknown as Source;
        if (!source || source.type !== type) throw new Error("Channel configuration type mismatch");
        const port = type === "github" ? new GitHubSource(source, env) : type === "timer" ? new TimerSource(source, env) : new WebhookSource(source, env);
        const connection: ChannelPort = { send: port.send.bind(port),
          ...(port instanceof WebhookSource ? { receive: port.receive.bind(port) } : {}),
          ...(port instanceof GitHubSource || port instanceof TimerSource ? { poll: port.poll.bind(port) } : {}),
          ...(port instanceof GitHubSource ? { find: port.find.bind(port), observe: async (resource, signal) => {
            if (resource.kind !== "github.pull-request" || !/^[1-9]\d*$/.test(resource.id)) throw new Error("Unsupported GitHub observation resource");
            return port.inspectPR(Number(resource.id), signal);
          } } : {}),
        };
        return connection;
      },
    });
  };
}
const setup: HostPluginFactory = api => {
  const config = api.configuration as { env?: Record<string, string | undefined> } | undefined;
  if (!config?.env) throw new Error("Channels plugin requires host-supplied credential environment");
  return channelSetup(config.env)(api);
};
export default setup;
