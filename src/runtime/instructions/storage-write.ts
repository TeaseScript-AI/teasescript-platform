import type { Instruction, InstructionPlan } from "../../plan/model.js";
import type { Evaluator } from "../evaluator.js";
import { internalFault } from "../errors.js";
import {
  assertEventSequenceCapacity,
  copySpan,
  requiredFutureActionCompletionEvents,
  takeSequence,
} from "../operations/support.js";
import type { ActionRequestedEvent, InterpreterEvent } from "../events.js";
import {
  assertPersistable,
  storageKey,
  storageKeyPlace,
  storageKeyType,
  writeScriptStorage,
} from "../script-storage.js";
import { cloneCapturedSerializableValue } from "../serializable-values.js";
import type { RuntimeSnapshot } from "../state.js";
import type { RuntimeStorageWriteActionSnapshot } from "../actions/model.js";
import { assertValueType } from "../value-types.js";
import { advance, fault } from "./support.js";

/**
 * `save` and `delete`. Session-local storage changes at once. Persistent storage waits for the host's acknowledgement:
 * the view changes only when the host reports the write as stored.
 */
export function writeStorage(
  plan: InstructionPlan,
  instruction: Extract<Instruction, { kind: "storageWrite" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  // Copy the value before the key runs: the key expression may change a borrowed collection.
  const value =
    instruction.value === null
      ? null
      : cloneCapturedSerializableValue(evaluator.evaluate(instruction.value));
  const key = storageKey(
    evaluator.evaluate(instruction.key),
    instruction.value === null ? "delete" : "save",
    instruction.key.span,
  );
  assertPersistable(value, instruction.span);
  // A saved value has to fit the key's type, which every load of the key relies on (V30 §25).
  const type = value === null ? undefined : storageKeyType(plan, key);
  if (type !== undefined)
    assertValueType(value, { type, place: storageKeyPlace(key) }, instruction.value!.span);
  if (!snapshot.scriptStoragePersistent) {
    writeScriptStorage(snapshot, key, value);
    evaluator.trace?.storage(key, value);
    advance(snapshot);
    return;
  }
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
  // The request, the completion, a possible failure warning, and every active action's own completions.
  assertEventSequenceCapacity(
    snapshot,
    3 + requiredFutureActionCompletionEvents(snapshot),
    instruction.span,
  );
  const requestSequence = takeSequence(snapshot);
  const write: RuntimeStorageWriteActionSnapshot = Object.freeze({
    kind: "storageWrite",
    actionId: snapshot.nextActionId,
    owningInstruction: snapshot.nextInstruction,
    continuationInstruction: snapshot.nextInstruction + 1,
    ownerCallFrameId: snapshot.callFrames.at(-1)?.id ?? null,
    scopeDepth: snapshot.frames.length,
    loopDepth: snapshot.loopFrames.length,
    createdAtMs: snapshot.currentSessionTimeMs,
    key,
    value,
    requestEventSequence: requestSequence,
  });
  snapshot.nextActionId += 1;
  snapshot.foregroundAction = write;
  snapshot.status = "waiting";
  evaluator.trace?.awaitStorage(write.actionId, key, value);
  events.push(
    Object.freeze({
      kind: "actionRequested",
      sequence: requestSequence,
      action: { ...write, value: cloneCapturedSerializableValue(value) },
      span: copySpan(instruction.span),
    } satisfies ActionRequestedEvent),
  );
}
