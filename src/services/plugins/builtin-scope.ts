/** Product descriptions only; running availability is reported by runtime plugins. */
export const BUILTIN_PLUGIN_SCOPES: Record<string, string> = {
  "tnb-coding": "Controls durable Coding tasks, not ordinary terminal conversation tools.",
  "tnb-channels": "Controls background GitHub, webhook and timer channels.",
  "tnb-collaboration": "Controls background collaboration tickets and notifications.",
  "tnb-web": "Controls the local web interface.",
};
export function builtinPluginScope(name: string): string | undefined { return BUILTIN_PLUGIN_SCOPES[name.toLowerCase()]; }
export function pluginActivationNotice(name: string): string {
  const scope = builtinPluginScope(name);
  return scope ? `${scope} Restart with 'tnb runtime restart' to apply; inspect running state with 'tnb runtime plugins'.` : "";
}
