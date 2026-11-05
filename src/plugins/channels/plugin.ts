import packageJson from "../../../package.json";
import type { BuiltinHostPlugin } from "../../agent/plugins";
import setup from "./plugin-entry";
import { channelsRecoveryPackage } from "./recovery-package";
export { channelSetup } from "./plugin-entry";

export async function createChannelsPlugin(env: Record<string, string | undefined>): Promise<BuiltinHostPlugin> {
  const packed = await channelsRecoveryPackage();
  return { identity: { name: "tnb-channels", version: packageJson.version, fingerprint: packed.fingerprint }, package: packed, configuration: { env },
    extensions: ["github", "webhook", "timer"].map(id => ({ kind: "channel", id, version: "1", entry: "index.mjs", services: [], requires: [] })), setup };
}
export default setup;
