import type { RandomDrawPendingOutcome } from "../random/random-control.js";
import type { InstructionPlan } from "../../plan/model.js";
import { withDebugTrace, type RuntimeDebugContext } from "../debug/debug-trace.js";
import type { RuntimeSnapshot } from "../snapshot/state.js";
import type { PendingActionOperationResult } from "./model.js";
import { captureExecutableData, pendingResult } from "./support.js";
import { randomDrawPending } from "./model.js";

export type DebugModeOutcome =
  /** `debugMode` reads `enabled` from now on; setting the value it already has changes nothing. */
  | { readonly kind: "set"; readonly enabled: boolean }
  | { readonly kind: "invalidRequest"; readonly message: string }
  /** An ended or failed session reads nothing more. */
  | { readonly kind: "invalidState"; readonly status: RuntimeSnapshot["status"] }
  | RandomDrawPendingOutcome;

/**
 * Sets what the protected `debugMode` reads, on behalf of the host that runs the session in Debug or not. The change is
 * a recorded input at the current instruction boundary: it runs no instruction, changes nothing else, emits no event,
 * and a `debugMode` evaluated earlier keeps the value it read.
 */
export function setDebugMode(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  enabled: unknown,
  options: { readonly debugTrace?: RuntimeDebugContext } = {},
): PendingActionOperationResult<DebugModeOutcome> {
  const captured = captureExecutableData(plan, snapshot);
  return withDebugTrace(options.debugTrace, captured.plan, snapshot, () =>
    setCapturedDebugMode(captured.snapshot, enabled),
  );
}

/** Sets `debugMode` in engine-owned plan/state that already passed complete validation. */
export function setValidatedDebugMode(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  enabled: unknown,
  options: { readonly debugTrace?: RuntimeDebugContext } = {},
): PendingActionOperationResult<DebugModeOutcome> {
  return withDebugTrace(options.debugTrace, plan, snapshot, () =>
    setCapturedDebugMode(snapshot, enabled),
  );
}

function setCapturedDebugMode(
  current: RuntimeSnapshot,
  enabled: unknown,
): PendingActionOperationResult<DebugModeOutcome> {
  const paused = randomDrawPending(current);
  if (paused !== null) return pendingResult(current, [], paused);
  if (typeof enabled !== "boolean")
    return pendingResult(current, [], {
      kind: "invalidRequest",
      message: "debugMode must be set to a boolean.",
    } as const);
  if (current.status === "halted" || current.status === "failed")
    return pendingResult(current, [], { kind: "invalidState", status: current.status } as const);
  current.debugMode = enabled;
  return pendingResult(current, [], { kind: "set", enabled } as const);
}
