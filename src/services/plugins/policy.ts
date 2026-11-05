import type { PluginTrustState } from "./trust";

export type PluginPolicy = { status: "ready" | "disabled" | "manual" | "untrusted" | "changed" | "blocked"; reason?: string };
export type PluginPolicyOptions = { enabled?: Record<string, boolean>; blockedFingerprints?: readonly string[] };
type PluginSelection = { name: string; fingerprint?: string; trust: PluginTrustState | "not-required"; lifecycle: { activation: "auto" | "manual" } };

/** One admission decision for executable contributions and resource packages. */
export function resolvePluginPolicy(plugin: PluginSelection, options: PluginPolicyOptions = {}): PluginPolicy {
  const lower = plugin.name.toLowerCase(), enabled = options.enabled;
  if (isPluginFingerprintBlocked(plugin.fingerprint, options.blockedFingerprints)) return { status: "blocked", reason: "Plugin fingerprint is blocked by host policy" };
  if (enabled?.[plugin.name] === false || enabled?.[lower] === false) return { status: "disabled", reason: "Plugin is disabled" };
  if (plugin.trust === "untrusted" || plugin.trust === "changed") return { status: plugin.trust, reason: `Plugin content is ${plugin.trust}` };
  if (plugin.lifecycle.activation === "manual" && enabled?.[plugin.name] !== true && enabled?.[lower] !== true) return { status: "manual", reason: "Plugin requires explicit activation" };
  return { status: "ready" };
}

export function isPluginFingerprintBlocked(fingerprint: string | undefined, blocked?: readonly string[]): boolean {
  return !!fingerprint && blocked?.includes(fingerprint) === true;
}

/** Refresh a cached catalog's permission without granting it a new activation. */
export function applyPluginPolicy<T extends PluginSelection & { active: boolean }>(plugin: T, options: PluginPolicyOptions): T & { policy: PluginPolicy } {
  const policy = resolvePluginPolicy(plugin, options);
  return { ...plugin, policy, active: plugin.active && policy.status === "ready" };
}

type AdmittedPlugin = { name: string; active: boolean; trust: PluginSelection["trust"]; policy?: PluginPolicy };
export function isPluginActive(plugin: AdmittedPlugin): boolean {
  return plugin.active && (plugin.trust === "trusted" || plugin.trust === "not-required") && (!plugin.policy || plugin.policy.status === "ready");
}

/** Also enforce the admission decision at direct consumer/execution entry points. */
export function assertPluginActive(plugin: AdmittedPlugin): void {
  if (!isPluginActive(plugin)) throw new Error(`Plugin ${plugin.name} is unavailable: ${plugin.policy?.reason ?? plugin.trust}`);
}
