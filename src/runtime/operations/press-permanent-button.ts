import { type InstructionPlan, mainSourceSpan } from "../../plan/model.js";
import { cloneCaptures } from "../captures.js";
import type { PermanentButtonPressedEvent } from "../events.js";
import { permanentButtonBusy, shownPermanentButton } from "../permanent-buttons.js";
import type { RuntimeSnapshot } from "../state.js";
import type { PendingActionOperationResult } from "./model.js";
import { timerHandlerDispatchable } from "./timer-lifecycle.js";
import {
  captureExecutableData,
  type CapturedExecutableData,
  copySpan,
  pendingResult,
  positiveSafeInteger,
  takeSequence,
} from "./support.js";
import { closeDebugTrace, openDebugTrace, type RuntimeDebugContext } from "../debug-trace.js";

export type PermanentButtonPressOutcome =
  /** The click is queued; the next run starts the button's block. */
  | { readonly kind: "pressed"; readonly buttonId: number }
  /** The button's block is queued or running, so the button is inactive. */
  | { readonly kind: "busy"; readonly buttonId: number }
  /** The button was shown but has been removed since. */
  | { readonly kind: "removedButton"; readonly buttonId: number }
  | { readonly kind: "unknownButton"; readonly buttonId: number }
  /**
   * The script is running, scene time has not caught up with the observed time, or a due block must run first. The host
   * runs the engine and then retries if the button is still shown.
   */
  | { readonly kind: "executionPending"; readonly buttonId: number }
  | { readonly kind: "invalidPayload"; readonly message: string };

/**
 * A click on a shown permanent button. Like other host input it happens at the observed time while the story waits; the
 * button's block then queues behind any earlier block and interrupts like a timer expiry block. The click publishes
 * `permanentButtonPressed` and adds nothing to the transcript.
 */
export function pressPermanentButton(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  buttonId: unknown,
  options: { readonly debugTrace?: RuntimeDebugContext } = {},
): PendingActionOperationResult<PermanentButtonPressOutcome> {
  const captured = captureExecutableData(plan, snapshot);
  const trace = openDebugTrace(options.debugTrace, captured.plan, snapshot);
  const pressed = pressCapturedPermanentButton(captured, buttonId);
  closeDebugTrace(trace, pressed);
  return pressed;
}

/** Clicks a permanent button of engine-owned plan/state that already passed complete validation. */
export function pressValidatedPermanentButton(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  buttonId: unknown,
  options: { readonly debugTrace?: RuntimeDebugContext } = {},
): PendingActionOperationResult<PermanentButtonPressOutcome> {
  const trace = openDebugTrace(options.debugTrace, plan, snapshot);
  const pressed = pressCapturedPermanentButton({ plan, snapshot }, buttonId);
  closeDebugTrace(trace, pressed);
  return pressed;
}

function pressCapturedPermanentButton(
  captured: CapturedExecutableData,
  buttonId: unknown,
): PendingActionOperationResult<PermanentButtonPressOutcome> {
  const current = captured.snapshot;
  if (!positiveSafeInteger(buttonId)) {
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "A permanent button press needs the button's ID, a positive safe integer.",
    });
  }
  if (current.status === "failed") {
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "The session has failed and accepts no further input.",
    });
  }
  const action = shownPermanentButton(current, buttonId);
  if (action === undefined) {
    return pendingResult(current, [], {
      kind: buttonId < current.nextPermanentButtonId ? "removedButton" : "unknownButton",
      buttonId,
    });
  }
  if (permanentButtonBusy(current, buttonId)) {
    return pendingResult(current, [], { kind: "busy", buttonId });
  }
  if (
    current.status !== "waiting" ||
    current.currentSessionTimeMs < current.observedSessionTimeMs ||
    timerHandlerDispatchable(current)
  ) {
    return pendingResult(current, [], { kind: "executionPending", buttonId });
  }
  const sequence = takeSequence(current);
  // Everything queued is due no later than now, so the click keeps the queue in due order at its end.
  current.pendingTimerHandlers.push({
    buttonId,
    handlerFunctionId: action.button.handlerFunctionId,
    rootScopeId: action.button.rootScopeId,
    captures: cloneCaptures(action.button.captures),
    dueAtMs: current.currentSessionTimeMs,
    count: 1,
  });
  const event: PermanentButtonPressedEvent = Object.freeze({
    kind: "permanentButtonPressed",
    sequence,
    buttonId,
    text: action.button.text,
    span: copySpan(
      captured.plan.instructions[action.owningInstruction]?.span ?? mainSourceSpan(captured.plan),
    ),
  });
  return pendingResult(current, [event], { kind: "pressed", buttonId });
}
