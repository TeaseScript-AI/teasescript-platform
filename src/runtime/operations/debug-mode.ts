import type { InstructionPlan } from "../../plan/model.js";
import { closeDebugTrace, openDebugTrace, type RuntimeDebugContext } from "../debug-trace.js";
import type { RuntimeSnapshot } from "../state.js";
import type { PendingActionOperationResult } from "./model.js";
import { captureExecutableData, pendingResult } from "./support.js";

export type DebugModeOutcome =
  /** `debugMode` reads `enabled` from now on; setting the value it already has changes nothing. */
  | { readonly kind: "set"; readonly enabled: boolean }
  | { readonly kind: "invalidRequest"; readonly message: string }
  /** An ended or failed session reads nothing more. */
  | { readonly kind: "invalidState"; readonly status: RuntimeSnapshot["status"] };

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
  const trace = openDebugTrace(options.debugTrace, captured.plan, snapshot);
  const set = setCapturedDebugMode(captured.snapshot, enabled);
  closeDebugTrace(trace, set);
  return set;
}

/** Sets `debugMode` in engine-owned plan/state that already passed complete validation. */
export function setValidatedDebugMode(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  enabled: unknown,
  options: { readonly debugTrace?: RuntimeDebugContext } = {},
): PendingActionOperationResult<DebugModeOutcome> {
  const trace = openDebugTrace(options.debugTrace, plan, snapshot);
  const set = setCapturedDebugMode(snapshot, enabled);
  closeDebugTrace(trace, set);
  return set;
}

function setCapturedDebugMode(
  current: RuntimeSnapshot,
  enabled: unknown,
): PendingActionOperationResult<DebugModeOutcome> {
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
