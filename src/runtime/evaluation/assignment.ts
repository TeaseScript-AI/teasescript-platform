import { DICT_ACCESS, isDictMethod, missingDictMethodMessage } from "../../dict-operations.js";
import { hasListMethod, missingListMethodMessage } from "../../list-methods.js";
import { hasTemporalMethod } from "../../temporal-builtins.js";
import { missingTemporalMember } from "../values/temporal-operations.js";
import type { AssignmentTargetPlan, ExpressionPlan, TypeCheckPlan } from "../../plan/model.js";
import { propertiesReadThrough } from "../../speaker-terms.js";
import { internalFault, RuntimeFault } from "../errors.js";
import {
  GLOBAL_SCOPE_ID,
  detachPreparedReferencesForMutation,
  preparedReferenceSpeakerPath,
  readPreparedReference,
  scopeBindings,
  serializePreparedReference,
  type PreparedReferenceDescriptor,
  type PreparedReferenceStep,
} from "../scopes/prepared-references.js";
import { quotedText } from "../values/value-text.js";
import { messageText } from "../values/text-length.js";
import {
  checkCollectionLength,
  collectionTooLong,
  MAX_COLLECTION_LENGTH,
} from "../values/collection-size.js";
import {
  handleMemberMessage,
  hasAssignableProperties,
  isHandleMethod,
  handleKindOf,
} from "../../handle-members.js";
import { missingMemberMessage } from "../values/string-operations.js";
import { isTextMethod, unknownTextMemberMessage } from "../../text-operations.js";
import {
  cloneCapturedSerializableValue,
  getSerializableDictEntry,
  setCapturedSerializableDictValue,
  setCapturedSerializableProperty,
  type SerializableRuntimeObject,
  type SerializableRuntimeValue,
} from "../values/serializable-values.js";
import {
  isDict,
  isList,
  isObject,
  isRange,
  isSet,
  isSpeakerReference,
  isTemporal,
  isTimerHandle,
  isMediaHandle,
  isMessageHandle,
  isCameraView,
} from "../values/value-predicates.js";
import { assertValueType, describeShownValue, matchesValueType } from "../values/value-types.js";
import { bindingKey } from "../debug/debug-trace.js";
import {
  assignTimerProperty,
  assignMediaProperty,
  assignCameraProperty,
  assignMessageProperty,
} from "./handles.js";
import { type SourceSpan, fault, receiverLabel, readTemporary } from "./support.js";
import type { Evaluator } from "../evaluator.js";
import { getProperty, dictKey, listPosition, notIndexable } from "./access.js";
import { speakerById, setSpeakerProperty } from "./speakers.js";
import { binary } from "./operators.js";
import { findBindingLocation } from "./bindings.js";

// Assignment and its checks, and prepared references: preparing, restoring, and resolving them.

export function assign(
  evaluator: Evaluator,
  target: AssignmentTargetPlan,
  value: SerializableRuntimeValue,
): void {
  if (target.kind === "identifier") {
    const location = findBindingLocation(evaluator.snapshot, evaluator.plan, target.name);
    if (location === undefined) {
      throw (
        evaluator.unsetVariable(target.name, target.span) ??
        fault(
          "TSR002",
          internalFault(`The plan assigns to '${target.name}' but does not declare it.`),
          target.span,
        )
      );
    }
    // A speaker's own global names it for the whole session, so the compiler rejects an assignment to it (TSV004). A
    // variable that holds a speaker is an ordinary variable.
    const held = location.binding.value;
    if (
      location.frame.id === GLOBAL_SCOPE_ID &&
      isSpeakerReference(held) &&
      held.identifier === target.name
    ) {
      throw fault(
        "TSR034",
        internalFault(
          `The plan assigns to speaker '${target.name}', whose name always refers to that speaker.`,
        ),
        target.span,
      );
    }
    detachPreparedReferencesForMutation(evaluator.snapshot, {
      rootFrameId: location.frame.id,
      rootName: target.name,
      path: [],
    });
    location.binding.value = cloneCapturedSerializableValue(value);
    evaluator.trace?.write(
      "assignment",
      bindingKey(location.frame.id, target.name),
      target.name,
      location.binding.value,
    );
    return;
  }
  const object = evaluator.evaluate(target.object);
  const receiverDescriptor =
    target.object.kind === "preparedReference"
      ? readPreparedReference(
          readTemporary(
            evaluator.snapshot.temporaries,
            target.object.temporaryId,
            target.object.span,
          ),
          target.object.span,
        )
      : null;
  if (target.kind === "property") {
    if (receiverDescriptor !== null && !receiverDescriptor.detached) {
      const mutationStep: PreparedReferenceStep = { kind: "property", name: target.name };
      detachPreparedReferencesForMutation(evaluator.snapshot, {
        rootFrameId: receiverDescriptor.rootFrameId,
        rootName: receiverDescriptor.rootName,
        path: [...receiverDescriptor.path, mutationStep],
        speakerPath: preparedReferenceSpeakerPath(evaluator.snapshot, receiverDescriptor, [
          mutationStep,
        ]),
      });
    }
    if (isObject(object)) {
      setCapturedSerializableProperty(object, target.name, value);
      if (evaluator.trace !== null)
        evaluator.traceVariableChange("assignment", receiverDescriptor, target.span);
      return;
    }
    // A speaker, timer, media, or camera view keeps its properties as runtime state, which every name for it reads.
    if (isSpeakerReference(object)) {
      const speaker = speakerById(evaluator, object.speakerId, target.span);
      // A reference prepared to the property, through any name for the speaker, keeps the value it leads to now; so
      // does one to a property read through it, as a term through `gender`.
      const has = (name: string) => speaker.properties.some((property) => property.name === name);
      for (const name of [target.name, ...propertiesReadThrough(has, target.name)]) {
        const path: PreparedReferenceStep[] = [{ kind: "property", name }];
        detachPreparedReferencesForMutation(evaluator.snapshot, {
          rootFrameId: GLOBAL_SCOPE_ID,
          rootName: speaker.identifier,
          path,
          speakerPath: { speakerId: speaker.id, path },
        });
      }
      setSpeakerProperty(speaker, target.name, value, target.span);
      if (evaluator.trace !== null)
        evaluator.writeState(object, target.name, value, target.span, { property: target.name });
      return;
    }
    if (isTimerHandle(object)) {
      assignTimerProperty(evaluator, object, target.name, value, target.span);
      if (evaluator.trace !== null)
        evaluator.writeState(object, target.name, value, target.span, { property: target.name });
      return;
    }
    if (isMediaHandle(object)) {
      assignMediaProperty(evaluator, object, target.name, value, target.span);
      if (evaluator.trace !== null)
        evaluator.writeState(object, target.name, value, target.span, { property: target.name });
      return;
    }
    if (isCameraView(object)) {
      assignCameraProperty(evaluator, target.name, value, target.span);
      if (evaluator.trace !== null)
        evaluator.writeState(object, target.name, value, target.span, { property: target.name });
      return;
    }
    if (isMessageHandle(object)) {
      assignMessageProperty(evaluator, object, target.name, value, target.span, target.object);
      return;
    }
    throw noAssignableProperties(evaluator, target.object, object, target.span);
  }
  if (isSet(object)) throw notIndexable(evaluator, "TSR004", target.object, object, target.span);
  if (isDict(object)) {
    // A new key is added at the end; an existing key keeps its position.
    const key = dictKey(evaluator, evaluator.evaluate(target.index), target.index);
    if (
      object.entries.length >= MAX_COLLECTION_LENGTH &&
      getSerializableDictEntry(object, key) === undefined
    )
      throw collectionTooLong(
        "dict",
        DICT_ACCESS.store.grows,
        target.span,
        object.entries.length + 1,
      );
    if (receiverDescriptor !== null && !receiverDescriptor.detached) {
      const mutationStep: PreparedReferenceStep = { kind: "key", key };
      detachPreparedReferencesForMutation(evaluator.snapshot, {
        rootFrameId: receiverDescriptor.rootFrameId,
        rootName: receiverDescriptor.rootName,
        path: [...receiverDescriptor.path, mutationStep],
        speakerPath: preparedReferenceSpeakerPath(evaluator.snapshot, receiverDescriptor, [
          mutationStep,
        ]),
      });
    }
    setCapturedSerializableDictValue(object, key, value);
    if (evaluator.trace !== null)
      evaluator.traceVariableChange("assignment", receiverDescriptor, target.span);
    return;
  }
  if (!isList(object)) throw notIndexable(evaluator, "TSR005", target.object, object, target.span);
  const index = listPosition(
    evaluator,
    object,
    target.object,
    target.index,
    evaluator.evaluate(target.index),
    "assign",
  );
  if (receiverDescriptor !== null && !receiverDescriptor.detached) {
    const mutationStep: PreparedReferenceStep = { kind: "index", index };
    detachPreparedReferencesForMutation(evaluator.snapshot, {
      rootFrameId: receiverDescriptor.rootFrameId,
      rootName: receiverDescriptor.rootName,
      path: [...receiverDescriptor.path, mutationStep],
      speakerPath: preparedReferenceSpeakerPath(evaluator.snapshot, receiverDescriptor, [
        mutationStep,
      ]),
    });
  }
  object.items[index] = cloneCapturedSerializableValue(value);
  if (evaluator.trace !== null)
    evaluator.traceVariableChange("assignment", receiverDescriptor, target.span);
}

/**
 * Runs `items += more`, or `items = items + more`, while the variable holds a list. The joined list starts with the
 * variable's own elements, so copies of the added ones are appended in place, as `addAll` adds them, instead of a
 * copy of the whole list for every addition. The result, its type check, its failures, and the prepared references
 * it freezes are those of the assignment. Gives `false`, having evaluated nothing, for any other assignment, and
 * while Debug traces, which explains the joined value.
 */
export function appendAssigned(
  evaluator: Evaluator,
  target: AssignmentTargetPlan,
  value: ExpressionPlan,
  typeCheck: TypeCheckPlan | undefined,
): boolean {
  if (
    evaluator.trace !== null ||
    target.kind !== "identifier" ||
    value.kind !== "binary" ||
    value.operator !== "+" ||
    value.left.kind !== "identifier" ||
    value.left.name !== target.name ||
    (typeCheck !== undefined && typeCheck.type.kind !== "list")
  )
    return false;
  const location = findBindingLocation(evaluator.snapshot, evaluator.plan, target.name);
  if (location === undefined) return false;
  const list = location.binding.value;
  if (!isList(list)) return false;
  const left = evaluator.evaluate(value.left);
  const right = evaluator.evaluate(value.right);
  // The compiler reads the variable before a user call in `more`, so without one `more` changes the list only in
  // place. Every store into the variable fits its type, so the joined list fits when the added elements do.
  if (
    left !== list ||
    !isList(right) ||
    (typeCheck !== undefined && !matchesValueType(right, typeCheck.type))
  ) {
    const joined = binary(evaluator, value, left, right);
    if (typeCheck !== undefined) assertValueType(joined, typeCheck, value.span);
    assign(evaluator, target, joined);
    return true;
  }
  checkCollectionLength(
    "list",
    list.items.length + right.items.length,
    Math.max(list.items.length, right.items.length),
    "joining with +",
    value.span,
  );
  detachPreparedReferencesForMutation(evaluator.snapshot, {
    rootFrameId: location.frame.id,
    rootName: target.name,
    path: [],
  });
  // Copies are taken first, so a list can add itself.
  const added = right.items.map((item) => cloneCapturedSerializableValue(item));
  for (const item of added) list.items.push(item);
  return true;
}

/**
 * `keepsRoot`: whether an attached reference keeps a copy of its root, as the plan decides for its temporary. Gives
 * the reference to store and the value it selects, which the debug trace shows instead of the reference.
 */
export function prepareReference(
  evaluator: Evaluator,
  expression: ExpressionPlan,
  keepsRoot: boolean,
): { readonly reference: SerializableRuntimeObject; readonly value: SerializableRuntimeValue } {
  evaluator.keepPreparedRoot = keepsRoot;
  const prepared = evaluator.evaluateMachine(expression, true);
  let descriptor = prepared.descriptor!;
  // A reference extended from one that keeps a copy for its own preparation shares that copy.
  if (!keepsRoot && !descriptor.detached) descriptor = { ...descriptor, capturedRoot: undefined };
  return {
    reference: serializePreparedReference(
      restorableDescriptor(evaluator, descriptor, expression.span),
    ),
    value: prepared.value,
  };
}

/**
 * Restore validation needs the path of a stored reference to lead somewhere from its captured root and, while it is
 * attached, from its binding. Either can fall behind: an index can add the value it names after the root was
 * captured, or remove an ancestor of that value from the binding, and a reference extended from an earlier one keeps
 * that one's root, which lacks what a function call since then has added. A reference whose binding no longer leads
 * there is detached, as its first use would detach it, and fails now if its captured root falls short as well, as
 * that use would fail. An attached reference whose captured root falls short captures the root it resolves through.
 */
function restorableDescriptor(
  evaluator: Evaluator,
  descriptor: PreparedReferenceDescriptor,
  span: SourceSpan,
): PreparedReferenceDescriptor {
  if (descriptor.detached) return descriptor;
  if (descriptor.capturedRoot === undefined) {
    // Without a call after its root was read, nothing changed the variable while the reference was prepared.
    resolveDescriptor(evaluator, descriptor, span);
    return descriptor;
  }
  if (!resolves(evaluator, descriptor, span)) {
    const detached = { ...descriptor, detached: true };
    resolveDescriptor(evaluator, detached, span);
    return detached;
  }
  if (resolves(evaluator, { ...descriptor, detached: true }, span)) return descriptor;
  return {
    ...descriptor,
    capturedRoot: resolveDescriptor(evaluator, { ...descriptor, path: [] }, span),
  };
}

function resolves(
  evaluator: Evaluator,
  descriptor: PreparedReferenceDescriptor,
  span: SourceSpan,
): boolean {
  try {
    resolveDescriptor(evaluator, descriptor, span);
    return true;
  } catch (error) {
    if (error instanceof RuntimeFault) return false;
    throw error;
  }
}

export function validateAssignmentTarget(evaluator: Evaluator, target: AssignmentTargetPlan): void {
  if (target.kind === "identifier") return;
  const object = evaluator.evaluate(target.object);
  if (target.kind === "property") {
    const handle = handleKindOf(object);
    if (
      !isObject(object) &&
      !isSpeakerReference(object) &&
      (handle === null || !hasAssignableProperties(handle))
    ) {
      throw noAssignableProperties(evaluator, target.object, object, target.span);
    }
    return;
  }
  if (isSet(object)) throw notIndexable(evaluator, "TSR004", target.object, object, target.span);
  if (isDict(object)) {
    dictKey(evaluator, evaluator.evaluate(target.index), target.index);
    return;
  }
  if (!isList(object)) throw notIndexable(evaluator, "TSR005", target.object, object, target.span);
  listPosition(
    evaluator,
    object,
    target.object,
    target.index,
    evaluator.evaluate(target.index),
    "assign",
  );
}

export function validateCallReceiver(
  receiver: SerializableRuntimeValue,
  method: string,
  span: SourceSpan,
): void {
  const handle = handleKindOf(receiver);
  if (handle !== null) {
    if (!isHandleMethod(handle, method))
      throw fault("TSR016", handleMemberMessage(handle, method, "call"), span);
    return;
  }
  if (typeof receiver === "string") {
    if (!isTextMethod(method))
      throw fault("TSR016", unknownTextMemberMessage(method, "method"), span);
    return;
  }
  if (isTemporal(receiver)) {
    if (!hasTemporalMethod(receiver.kind, method))
      throw fault("TSR016", missingTemporalMember(receiver, method, "method", null), span);
    return;
  }
  if (isRange(receiver) && method === "toList") return;
  if (isDict(receiver)) {
    if (!isDictMethod(method)) throw fault("TSR016", missingDictMethodMessage(method), span);
    return;
  }
  if (!isList(receiver) && !isSet(receiver)) {
    throw fault("TSR016", missingMemberMessage(receiver, method, "method"), span);
  }
  const kind = isSet(receiver) ? "set" : "list";
  if (!hasListMethod(kind, method))
    throw fault("TSR016", missingListMethodMessage(kind, method), span);
}

export function resolvePreparedReference(
  evaluator: Evaluator,
  serialized: SerializableRuntimeValue,
  span: SourceSpan,
): SerializableRuntimeValue {
  const descriptor = readPreparedReference(serialized, span);
  if (descriptor.detached) return resolveDescriptor(evaluator, descriptor, span);
  try {
    return resolveDescriptor(evaluator, descriptor, span);
  } catch (error) {
    if (
      !(error instanceof RuntimeFault) ||
      !isObject(serialized) ||
      descriptor.capturedRoot === undefined
    )
      throw error;
    setCapturedSerializableProperty(serialized, "detached", true);
    return resolveDescriptor(evaluator, { ...descriptor, detached: true }, span);
  }
}

export function resolveDescriptor(
  evaluator: Evaluator,
  descriptor: PreparedReferenceDescriptor,
  span: SourceSpan,
): SerializableRuntimeValue {
  let value: SerializableRuntimeValue;
  if (!descriptor.detached && descriptor.rootFrameId !== null && descriptor.rootName !== null) {
    const binding = scopeBindings(evaluator.snapshot, descriptor.rootFrameId)?.find(
      (candidate) => candidate.name === descriptor.rootName,
    );
    if (binding === undefined) {
      throw fault(
        "TSR053",
        internalFault("A prepared reference points to a variable that no longer exists."),
        span,
      );
    }
    value = binding.value;
  } else {
    // EVIDENCE: readPreparedReference and the reference machine give every detached or rootless reference a captured
    // root, and #restorableDescriptor detaches only a reference that keeps one.
    value = descriptor.capturedRoot!;
  }
  for (const step of descriptor.path) {
    if (step.kind === "property") {
      value = getProperty(evaluator, value, step.name, span);
      continue;
    }
    if (step.kind === "key") {
      const entry = isDict(value) ? getSerializableDictEntry(value, step.key) : undefined;
      if (entry === undefined)
        throw fault(
          "TSR053",
          `The dict entry this statement changes no longer exists: something in the same statement removed the key ${quotedText(messageText(step.key))}. Make the change in a separate statement.`,
          span,
        );
      value = entry.value;
      continue;
    }
    // Only a list is addressed by position; a set member is always read as a copy.
    if (isList(value)) {
      if (step.index < 0 || step.index >= value.items.length) {
        throw fault(
          "TSR025",
          `The list element this statement changes no longer exists: something in the same statement removed position ${step.index}. Make the change in a separate statement.`,
          span,
        );
      }
      value = value.items[step.index]!;
      continue;
    }
    throw fault(
      "TSR008",
      "The list this statement changes was replaced while the statement ran. Make the change in a separate statement.",
      span,
    );
  }
  return value;
}

/** `TSR003` for a property assignment on a value, which `plan` gives, that has no properties to assign. */
function noAssignableProperties(
  evaluator: Evaluator,
  plan: ExpressionPlan,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): RuntimeFault {
  const label = receiverLabel(evaluator, plan);
  return fault(
    "TSR003",
    `Only objects, speakers, camera views, and handles for timers, media, and messages have assignable properties, but ${label === null ? "this" : `'${label}'`} is ${describeShownValue(value)}.`,
    span,
  );
}
