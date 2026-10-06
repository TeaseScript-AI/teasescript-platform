import { captureExternalData } from "../../external-data-capture.js";
import type { InstructionPlan } from "../../plan/model.js";
import { interruptFrame } from "../activations.js";
import { applyFormUpdate, formStatesEqual } from "../actions/form.js";
import type { RuntimeSnapshot } from "../state.js";
import { closeDebugTrace, openDebugTrace, type RuntimeDebugContext } from "../debug-trace.js";
import { timerHandlerDispatchable } from "./timer-lifecycle.js";
import {
  captureExecutableData,
  isPlainRecord,
  pendingResult,
  positiveSafeInteger,
} from "./support.js";
import type { PendingActionOperationResult } from "./model.js";

export type InteractionUpdateOutcome =
  /** The edit changed the pending interaction's answers or editor. */
  | { readonly kind: "updated"; readonly actionId: number }
  /** The edit was valid but left everything as it was, such as a repeated one. */
  | { readonly kind: "unchanged"; readonly actionId: number }
  | { readonly kind: "staleAction"; readonly actionId: number }
  | { readonly kind: "unknownAction"; readonly actionId: number }
  /** The interaction belongs to a path that a running block interrupted; it takes no edits until it resumes. */
  | { readonly kind: "suspendedAction"; readonly actionId: number }
  /** The action is not a form, the only interaction with edits. */
  | { readonly kind: "wrongActionKind"; readonly actionId: number }
  /**
   * The edit is malformed or refused, such as text that is not a number for a number field; `message` says why, and
   * nothing changed.
   */
  | { readonly kind: "invalidPayload"; readonly message: string }
  /** As for `completeAction`: execution must run first, then the host retries. */
  | { readonly kind: "executionPending"; readonly actionId: number };

/**
 * Edits the pending form without settling it:
 * `{ actionId, actionKind: "interaction", interactionKind: "form", update }`, where `update` is one of the edits that
 * `applyFormUpdate` describes. An edit changes only the form's answers and editor: it publishes no event, adds nothing
 * to the transcript, uses no randomness, and the script does not continue. It returns the new snapshot, or the same
 * state when the edit is refused or changes nothing.
 */
export function updateInteraction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  request: unknown,
  options: { readonly debugTrace?: RuntimeDebugContext } = {},
): PendingActionOperationResult<InteractionUpdateOutcome> {
  const captured = captureExecutableData(plan, snapshot);
  // An edit changes no script value; the trace only follows the session through it.
  const trace = openDebugTrace(options.debugTrace, captured.plan, snapshot);
  const external = captureExternalData(request);
  const updated =
    !external.ok || !isPlainRecord(external.value)
      ? pendingResult(captured.snapshot, [], {
          kind: "invalidPayload" as const,
          message: "An interaction update must be bounded JSON-safe object data.",
        })
      : updateCapturedInteraction(captured.snapshot, external.value);
  closeDebugTrace(trace, updated);
  return updated;
}

function updateCapturedInteraction(
  current: RuntimeSnapshot,
  request: Record<string, unknown>,
): PendingActionOperationResult<InteractionUpdateOutcome> {
  if (!positiveSafeInteger(request.actionId))
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "An interaction update needs the actionId of the pending interaction.",
    });
  const actionId = request.actionId;
  const action = current.foregroundAction;
  if (action === null || action.actionId !== actionId) {
    if (interruptFrame(current)?.timerInterruption?.suspendedAction?.actionId === actionId)
      return pendingResult(current, [], { kind: "suspendedAction", actionId });
    const known =
      actionId < current.nextActionId ||
      current.backgroundActions.some((background) => background.actionId === actionId);
    return pendingResult(current, [], { kind: known ? "staleAction" : "unknownAction", actionId });
  }
  if (
    action.kind !== "interaction" ||
    action.form === undefined ||
    action.ui.kind !== "form" ||
    request.actionKind !== "interaction" ||
    request.interactionKind !== "form"
  )
    return pendingResult(current, [], { kind: "wrongActionKind", actionId });
  if (current.status === "failed")
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "The session has failed and accepts no further input.",
    });
  if (
    !hasExactKeys(request, ["actionId", "actionKind", "interactionKind", "update"]) ||
    !isPlainRecord(request.update)
  )
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "A form update is { actionId, actionKind, interactionKind, update }.",
    });
  // Like other host input, an edit happens at the observed time, after a due block has run.
  if (
    current.currentSessionTimeMs < current.observedSessionTimeMs ||
    timerHandlerDispatchable(current)
  )
    return pendingResult(current, [], { kind: "executionPending", actionId });
  const step = applyFormUpdate(action.ui, action.form, request.update);
  if (!step.ok)
    return pendingResult(current, [], { kind: "invalidPayload", message: step.message });
  if (formStatesEqual(step.state, action.form))
    return pendingResult(current, [], { kind: "unchanged", actionId });
  current.foregroundAction = Object.freeze({ ...action, form: step.state });
  return pendingResult(current, [], { kind: "updated", actionId });
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
