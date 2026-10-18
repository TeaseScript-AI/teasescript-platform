import { resolveCaptures } from "../scopes/captures.js";
import type { Instruction } from "../../plan/model.js";
import type { Evaluator } from "../evaluator.js";
import { internalFault } from "../errors.js";
import {
  assertCounterCanAdvance,
  assertEventSequenceCapacity,
  requiredFutureActionCompletionEvents,
  setCapturedTemporary,
  takeSequence,
} from "../operations/support.js";
import { contextRootId } from "../scopes/activations.js";
import type { ActionRequestedEvent, InterpreterEvent } from "../events.js";
import { type RuntimeSnapshot, currentTemporalContext } from "../snapshot/state.js";
import {
  ACTION_COMPLETION_EVENTS,
  type RuntimePermanentButtonActionSnapshot,
} from "../actions/model.js";
import { fieldText } from "../values/value-text.js";
import { advance, fault } from "./support.js";
import { copySpan } from "../../plan/source-location.js";

/**
 * Shows a permanent button after the shown ones, as background work that waits for clicks. Its block runs for the
 * activation that showed it, like a timer's, and the script continues at once.
 */
export function showPermanentButton(
  instruction: Extract<Instruction, { kind: "showPermanentButton" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  const span = copySpan(instruction.span);
  const text = fieldText(
    evaluator.evaluate(instruction.text),
    span,
    currentTemporalContext(snapshot),
  );
  if (
    !Number.isSafeInteger(snapshot.nextActionId) ||
    snapshot.nextActionId >= Number.MAX_SAFE_INTEGER
  ) {
    throw fault(
      "TSR051",
      internalFault("The session has used up its action numbers."),
      instruction.span,
    );
  }
  assertCounterCanAdvance(snapshot.nextPermanentButtonId, "nextPermanentButtonId");
  // The request, its eventual removal, and the other active actions' completions must stay representable.
  assertEventSequenceCapacity(
    snapshot,
    1 + ACTION_COMPLETION_EVENTS.permanentButton + requiredFutureActionCompletionEvents(snapshot),
    instruction.span,
  );
  const captures = resolveCaptures(snapshot, instruction.captures, instruction.span);
  const sequence = takeSequence(snapshot);
  const buttonId = snapshot.nextPermanentButtonId;
  const action: RuntimePermanentButtonActionSnapshot = {
    kind: "permanentButton",
    actionId: snapshot.nextActionId,
    owningInstruction: snapshot.nextInstruction,
    createdAtMs: snapshot.currentSessionTimeMs,
    requestEventSequence: sequence,
    button: {
      buttonId,
      text,
      persist: instruction.persist,
      handlerFunctionId: instruction.handlerFunctionId,
      rootScopeId: contextRootId(snapshot),
      captures,
    },
  };
  snapshot.nextActionId += 1;
  snapshot.nextPermanentButtonId += 1;
  snapshot.backgroundActions.push(action);
  if (instruction.destinationTemporary !== null) {
    const handle = { kind: "permanentButtonHandle" as const, buttonId };
    setCapturedTemporary(snapshot.temporaries, instruction.destinationTemporary, handle);
    evaluator.trace?.writeTemporary(
      evaluator.callFrameId(),
      instruction.destinationTemporary,
      handle,
    );
  }
  events.push(
    Object.freeze({
      kind: "actionRequested",
      sequence,
      action: { ...action, button: { ...action.button } },
      span,
    } satisfies ActionRequestedEvent),
  );
  advance(snapshot);
}
