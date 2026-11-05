import { isIP } from "node:net";
import type { PluginToolSecurity } from "./loader";

/** No DNS names under loopback authority, apart from localhost pinned at connection time. */
export function pluginHttpTarget(value: string, network: PluginToolSecurity["network"]): URL {
  if (!["none", "loopback", "egress"].includes(network)) throw new Error("Invalid plugin tool network policy");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Plugin tool HTTP target must be HTTP(S) without URL credentials");
  if (network === "none") throw new Error("Plugin tool must declare loopback or egress network access for HTTP transport");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (network === "loopback" && host !== "localhost" && host !== "::1"
    && !(isIP(host) === 4 && host.startsWith("127."))) throw new Error("Plugin tool loopback target requires a numeric loopback address or localhost");
  return url;
}
