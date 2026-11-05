import { createServiceRef } from "./services";
import type { ChannelRegistry } from "./extensions";

export const CHANNEL_SERVICE = "tnb.channels/v1";
export const CHANNEL_SERVICE_REF = createServiceRef<ChannelRegistry>({ id: "tnb.channels", version: 1, scope: "contribution", methods: { descriptor: true, connect: true } });
