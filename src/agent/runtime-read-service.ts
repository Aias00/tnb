import { createServiceRef } from "./services";
import type { RuntimeConfiguration } from "../services/runtime/engine-core";
import type { DurableRun, DurableTask } from "../services/runtime/types";

export type RuntimeReadService = { runs(): DurableRun[]; status(runId: string): { run: DurableRun | undefined; tasks: DurableTask[] }; configuration(runId: string): RuntimeConfiguration };
export const RUNTIME_READ_SERVICE = "tnb.runtime.read/v1";
export const RUNTIME_READ_SERVICE_REF = createServiceRef<RuntimeReadService>({ id: "tnb.runtime.read", version: 1, scope: "host", methods: { runs: true, status: true, configuration: true } });
