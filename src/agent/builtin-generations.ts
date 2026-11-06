import type { AdapterPluginIdentity } from "./domain";
import type { RuntimeStore } from "../services/runtime/store";
import { digestJson } from "../services/runtime/json";
import { pluginGenerationKey } from "./plugin-generations";

const namespace = "host.builtin-generations";
export const builtinRecoveryABI = () => ({ protocol: "tnb.domain/v1", bun: Bun.version, platform: process.platform, arch: process.arch });
export const channelRecoveryABI = () => ({ protocol: "tnb.channel/v1", bun: Bun.version, platform: process.platform, arch: process.arch });
export type BuiltinApprovalStatus = "approved" | "missing" | "abi-incompatible" | "identity-mismatch";
export type BuiltinGenerationAuthority = { approved(identity: AdapterPluginIdentity): boolean; approve(identity: AdapterPluginIdentity): void; inspect?(identity: AdapterPluginIdentity): BuiltinApprovalStatus };

/** Separate host fact; archive metadata alone cannot grant a package builtin privileges. */
export function builtinGenerationAuthority(store: RuntimeStore): BuiltinGenerationAuthority {
  return generationAuthority(store, namespace, builtinRecoveryABI());
}
export function builtinChannelGenerationAuthority(store: RuntimeStore): BuiltinGenerationAuthority {
  return generationAuthority(store, "host.builtin-channels", channelRecoveryABI());
}
function generationAuthority(store: RuntimeStore, namespace: string, abi: ReturnType<typeof builtinRecoveryABI>): BuiltinGenerationAuthority {
  const inspect = (identity: AdapterPluginIdentity): BuiltinApprovalStatus => {
    const value = store.applicationRecord<{ identity?: AdapterPluginIdentity; abi?: unknown }>(namespace, pluginGenerationKey(identity))?.value;
    if (!value) return "missing";
    if (digestJson(value.identity ?? null) !== digestJson(identity)) return "identity-mismatch";
    if (digestJson(value) !== digestJson({ identity, abi })) return "abi-incompatible";
    return "approved";
  };
  return Object.freeze({
    inspect,
    approved: (identity: AdapterPluginIdentity) => inspect(identity) === "approved",
    approve(identity: AdapterPluginIdentity) {
      const id = pluginGenerationKey(identity), value = { identity, abi };
      const existing = store.applicationRecord(namespace, id);
      if (existing) { if (digestJson(existing.value) !== digestJson(value)) throw new Error("Builtin generation approval ABI changed"); return; }
      store.command(`${namespace === "host.builtin-channels" ? "builtin-channel" : "builtin-generation"}:${id}`, value, Date.now(), tx => tx.saveApplicationRecord({ namespace, id, value }, 0));
    },
  });
}
