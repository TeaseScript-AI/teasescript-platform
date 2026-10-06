import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan } from "../source.js";
import { interruptFrame } from "./activations.js";
import type {
  RuntimePermanentButtonActionSnapshot,
  RuntimePermanentButtonSettlementSnapshot,
} from "./actions/model.js";
import type { ActionCompletedEvent, InterpreterEvent } from "./events.js";
import { assertEventSequenceCapacity, copySpan, takeSequence } from "./operations/support.js";
import type { RuntimeSnapshot } from "./state.js";
import { sweepRetainedScopes, type RuntimeCaptureSnapshot } from "./captures.js";

/**
 * Permanent buttons (V30 §28). A shown button is a background action until it is removed; a click queues its block in
 * the shared interrupt queue, where it runs like a timer expiry block. While its block is queued or running the button
 * is inactive.
 */
export interface RuntimePermanentButtonSnapshot {
  readonly buttonId: number;
  readonly text: string;
  readonly persist: boolean;
  readonly handlerFunctionId: number;
  /** The root of the activation that showed the button: a transfer that leaves it removes a non-persistent button. */
  readonly rootScopeId: number;
  /** The variables its block shares with the code that showed it. */
  readonly captures: readonly RuntimeCaptureSnapshot[];
}

/** A click whose block has not started yet. It shares the interrupt queue with timer expiry and media cue blocks. */
export interface RuntimePermanentButtonInvocationSnapshot {
  readonly buttonId: number;
  readonly handlerFunctionId: number;
  /** The activation root of its button's block. */
  readonly rootScopeId: number;
  /** Its button's shared variables. */
  readonly captures: readonly RuntimeCaptureSnapshot[];
  /** The scene time of the click. */
  readonly dueAtMs: number;
  /** Always 1: a button cannot be clicked again before its block has run. */
  count: number;
}

/** The shown buttons in the order they were shown. */
function permanentButtonActions(snapshot: RuntimeSnapshot): RuntimePermanentButtonActionSnapshot[] {
  return snapshot.backgroundActions.filter(
    (action): action is RuntimePermanentButtonActionSnapshot => action.kind === "permanentButton",
  );
}

export function shownPermanentButton(
  snapshot: RuntimeSnapshot,
  buttonId: number,
): RuntimePermanentButtonActionSnapshot | undefined {
  return permanentButtonActions(snapshot).find((action) => action.button.buttonId === buttonId);
}

/** Whether a button's block is queued or running, which makes the button inactive. */
export function permanentButtonBusy(snapshot: RuntimeSnapshot, buttonId: number): boolean {
  const interruption = interruptFrame(snapshot)?.timerInterruption ?? null;
  if (interruption !== null && "buttonId" in interruption && interruption.buttonId === buttonId)
    return true;
  return snapshot.pendingTimerHandlers.some(
    (invocation) => "buttonId" in invocation && invocation.buttonId === buttonId,
  );
}

/**
 * Removes the buttons that match, with their queued clicks, publishing a `removed` settlement for each. A block that
 * already runs finishes, and its button does not return.
 */
export function removePermanentButtons(
  snapshot: RuntimeSnapshot,
  removes: (action: RuntimePermanentButtonActionSnapshot) => boolean,
  span: SourceSpan | PlanSourceLocation,
  events: InterpreterEvent[],
): void {
  const removed = permanentButtonActions(snapshot).filter(removes);
  if (removed.length === 0) return;
  assertEventSequenceCapacity(snapshot, removed.length, span);
  const ids = new Set(removed.map((action) => action.button.buttonId));
  for (let index = snapshot.pendingTimerHandlers.length - 1; index >= 0; index -= 1) {
    const invocation = snapshot.pendingTimerHandlers[index]!;
    if ("buttonId" in invocation && ids.has(invocation.buttonId)) {
      snapshot.pendingTimerHandlers.splice(index, 1);
    }
  }
  for (const action of removed) {
    const completionEventSequence = takeSequence(snapshot, 1);
    snapshot.backgroundActions.splice(snapshot.backgroundActions.indexOf(action), 1);
    const settlement: RuntimePermanentButtonSettlementSnapshot = Object.freeze({
      actionId: action.actionId,
      actionKind: "permanentButton",
      settlementKind: "removed",
      buttonId: action.button.buttonId,
      owningInstruction: action.owningInstruction,
      requestEventSequence: action.requestEventSequence,
      completionEventSequence,
      completedAtMs: snapshot.currentSessionTimeMs,
    });
    events.push(
      Object.freeze({
        kind: "actionCompleted",
        sequence: completionEventSequence,
        settlement,
        span: copySpan(span),
      } satisfies ActionCompletedEvent),
    );
  }
  sweepRetainedScopes(snapshot, false);
}

/** A shown permanent button as a Player presents it: in creation order, inactive while `busy`. */
export interface PermanentButtonProjection {
  readonly buttonId: number;
  readonly text: string;
  /** Its block is queued or running; a click is not accepted until it has finished. */
  readonly busy: boolean;
}

export function permanentButtonProjection(
  snapshot: RuntimeSnapshot,
): readonly PermanentButtonProjection[] {
  return Object.freeze(
    permanentButtonActions(snapshot).map(({ button }) =>
      Object.freeze({
        buttonId: button.buttonId,
        text: button.text,
        busy: permanentButtonBusy(snapshot, button.buttonId),
      }),
    ),
  );
}
