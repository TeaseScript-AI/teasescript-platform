/* global __GATE_DELAY_MS__ */
// The `delayed` variant's `engine-bridge/in-process.ts` for `usePlayerSession.ts`: the product module, with
// `createInProcessBackend` given `delayMs: __GATE_DELAY_MS__`, the backend's own delayed delivery (its stop flush stays
// synchronous, as in-process). Every other export is the product's own.
import { createInProcessBackend as create } from "../../../player/engine-bridge/in-process.ts";

export * from "../../../player/engine-bridge/in-process.ts";

export function createInProcessBackend(build, options = {}) {
  return create(build, { ...options, delayMs: __GATE_DELAY_MS__ });
}
