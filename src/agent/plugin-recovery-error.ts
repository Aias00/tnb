export type PluginRecoveryPhase = "inventory" | "archive" | "selection" | "approval" | "contract";
export type PluginRecoveryCode =
  | "PLUGIN_INVENTORY_INCOMPLETE" | "PLUGIN_HISTORY_UNAVAILABLE" | "PLUGIN_CHECK_BUSY"
  | "PLUGIN_ARCHIVE_MISSING" | "PLUGIN_ARCHIVE_DAMAGED" | "PLUGIN_HOST_INCOMPATIBLE"
  | "PLUGIN_FINGERPRINT_BLOCKED" | "PLUGIN_INSTALLATION_UNAVAILABLE" | "PLUGIN_INSTALLATION_ORIGIN_CHANGED" | "PLUGIN_GENERATION_UNTRUSTED"
  | "PLUGIN_BUILTIN_NOT_SELECTED" | "PLUGIN_BUILTIN_APPROVAL_MISSING" | "PLUGIN_BUILTIN_ABI_INCOMPATIBLE" | "PLUGIN_BUILTIN_APPROVAL_OR_ABI"
  | "PLUGIN_CONTRIBUTION_MISSING" | "PLUGIN_CHANNEL_DEPENDENCY_UNSUPPORTED" | "PLUGIN_ENTRY_INVALID" | "PLUGIN_CHECK_FAILED";

/** Stable host diagnostics. Do not use error text to infer recovery decisions. */
export class PluginRecoveryError extends Error {
  constructor(readonly code: PluginRecoveryCode, readonly phase: PluginRecoveryPhase, message: string) { super(message); }
}
