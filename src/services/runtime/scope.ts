import { realpath } from "node:fs/promises";
import { agentNamespace } from "../../agent/execution";

/** Domain namespaces are logical scopes; file scopes must retain canonical real paths. */
export async function canonicalTaskScope(value: string): Promise<string> {
  return value.startsWith("agent:") ? agentNamespace(value.slice(6)) : realpath(value);
}
