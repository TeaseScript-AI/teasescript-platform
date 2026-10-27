import type { RuntimeErrorCode } from "../../diagnostic-codes.js";
import type { InstructionPlan, PlanSourceLocation } from "../../plan/model.js";
import { findScope } from "./activations.js";
import {
  createSourcePosition,
  createSourceSpan,
  type SourceSpan as RichSourceSpan,
} from "../../source.js";
import { internalFault, RuntimeFault } from "../errors.js";
import {
  cloneCapturedSerializableValue,
  createCapturedSerializableList,
  createCapturedSerializableObject,
  dictProperty,
  getSerializableDictEntry,
  getSerializableProperty,
  setCapturedSerializableProperty,
  type SerializableRuntimeDict,
  type SerializableRuntimeList,
  type SerializableRuntimeObject,
  type SerializableRuntimeValue,
  type SerializableSpeakerReference,
} from "../values/serializable-values.js";
import {
  currentTemporalContext,
  type RuntimeBindingSnapshot,
  type RuntimeSnapshot,
  type RuntimeTemporarySnapshot,
} from "../snapshot/state.js";
import { snapshotValidationAnalysis } from "../snapshot/snapshot-validation-analysis.js";
import { speakerPropertyValue } from "../../speaker-terms.js";
import { derivedDisplayName } from "../values/speaker-text.js";
import { isDict, isList, isObject, isSet, isSpeakerReference } from "../values/value-predicates.js";
import { listProperty } from "../../list-methods.js";
import { copySpan } from "../../plan/source-location.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

export type PreparedReferenceStep =
  | { readonly kind: "property"; readonly name: string }
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "key"; readonly key: string };

/** The scope ID by which a prepared reference names the session's globals as its root. */
export const GLOBAL_SCOPE_ID = -1;

/** The bindings of a scope frame, or with {@link GLOBAL_SCOPE_ID} the session's globals. */
export function scopeBindings(
  snapshot: RuntimeSnapshot,
  scopeId: number,
): readonly RuntimeBindingSnapshot[] | undefined {
  // A block of an activation the session has left refers into its retained root.
  return scopeId === GLOBAL_SCOPE_ID ? snapshot.globals : findScope(snapshot, scopeId)?.bindings;
}

export interface PreparedReferenceDescriptor {
  /** The scope frame of the root binding, {@link GLOBAL_SCOPE_ID} for a global, or `null` for a captured root. */
  readonly rootFrameId: number | null;
  readonly rootName: string | null;
  readonly path: PreparedReferenceStep[];
  /**
   * A copy of the root: the value a detached reference's path starts from, and for an attached one, where the plan
   * keeps it, its fallback (`preparedReferenceTemporaries` of the snapshot validation analysis). `undefined` for an
   * attached reference that keeps none.
   */
  readonly capturedRoot: SerializableRuntimeValue | undefined;
  readonly detached: boolean;
}

interface PreparedReferenceMutation {
  readonly rootFrameId: number | null;
  readonly rootName: string | null;
  readonly path: readonly PreparedReferenceStep[];
  readonly speakerPath?: PreparedSpeakerPath | null;
}

interface PreparedSpeakerPath {
  readonly speakerId: number;
  readonly path: readonly PreparedReferenceStep[];
}

const INTERNAL_REFERENCE_POSITION = createSourcePosition(0, 0, 0);
const INTERNAL_REFERENCE_SPAN = createSourceSpan(
  INTERNAL_REFERENCE_POSITION,
  INTERNAL_REFERENCE_POSITION,
);

/**
 * The stored form of a descriptor, without `capturedRoot` when it keeps no copy. It shares the descriptor's captured
 * root, which storing it as a temporary copies.
 */
export function serializePreparedReference(
  descriptor: PreparedReferenceDescriptor,
): SerializableRuntimeObject {
  return {
    kind: "object",
    properties: [
      { name: "marker", value: "preparedReference" },
      { name: "rootFrameId", value: descriptor.rootFrameId },
      { name: "rootName", value: descriptor.rootName },
      { name: "path", value: serializePreparedReferencePath(descriptor.path) },
      ...(descriptor.capturedRoot === undefined
        ? []
        : [{ name: "capturedRoot", value: descriptor.capturedRoot }]),
      { name: "detached", value: descriptor.detached },
    ],
  };
}

function serializePreparedReferencePath(
  path: readonly PreparedReferenceStep[],
): SerializableRuntimeList {
  return createCapturedSerializableList(
    path.map((step) =>
      step.kind === "property"
        ? createCapturedSerializableObject([
            { name: "kind", value: "property" },
            { name: "name", value: step.name },
          ])
        : step.kind === "key"
          ? createCapturedSerializableObject([
              { name: "kind", value: "key" },
              { name: "key", value: step.key },
            ])
          : createCapturedSerializableObject([
              { name: "kind", value: "index" },
              { name: "index", value: step.index },
            ]),
    ),
  );
}

export function readPreparedReference(
  value: SerializableRuntimeValue,
  span: SourceSpan,
): PreparedReferenceDescriptor {
  if (!isObject(value)) {
    throw fault(
      "TSR053",
      internalFault("A prepared reference in the saved state is malformed."),
      span,
    );
  }
  const marker = getSerializableProperty(value, "marker");
  const rootFrameId = getSerializableProperty(value, "rootFrameId");
  const rootName = getSerializableProperty(value, "rootName");
  const pathValue = getSerializableProperty(value, "path");
  const capturedRoot = getSerializableProperty(value, "capturedRoot");
  const detached = getSerializableProperty(value, "detached");
  if (
    marker !== "preparedReference" ||
    (rootFrameId !== null && (typeof rootFrameId !== "number" || !Number.isInteger(rootFrameId))) ||
    (rootName !== null && (typeof rootName !== "string" || rootName.length === 0)) ||
    (rootFrameId === null) !== (rootName === null) ||
    pathValue === undefined ||
    !isList(pathValue) ||
    typeof detached !== "boolean" ||
    (capturedRoot === undefined && (rootFrameId === null || detached))
  ) {
    throw fault(
      "TSR053",
      internalFault("A prepared reference in the saved state is malformed."),
      span,
    );
  }
  const path: PreparedReferenceStep[] = [];
  for (const item of pathValue.items) {
    if (!isObject(item)) {
      throw fault(
        "TSR053",
        internalFault("The path of a prepared reference in the saved state is malformed."),
        span,
      );
    }
    const kind = getSerializableProperty(item, "kind");
    if (kind === "property") {
      const name = getSerializableProperty(item, "name");
      if (typeof name !== "string" || name.length === 0) {
        throw fault(
          "TSR053",
          internalFault("A property step of a prepared reference in the saved state is malformed."),
          span,
        );
      }
      path.push({ kind, name });
      continue;
    }
    if (kind === "key") {
      const key = getSerializableProperty(item, "key");
      if (typeof key !== "string") {
        throw fault(
          "TSR053",
          internalFault("A key step of a prepared reference in the saved state is malformed."),
          span,
        );
      }
      path.push({ kind, key });
      continue;
    }
    if (kind === "index") {
      const index = getSerializableProperty(item, "index");
      if (typeof index !== "number" || !Number.isInteger(index)) {
        throw fault(
          "TSR053",
          internalFault("An index step of a prepared reference in the saved state is malformed."),
          span,
        );
      }
      path.push({ kind, index });
      continue;
    }
    throw fault(
      "TSR053",
      internalFault("A step of a prepared reference in the saved state has an unknown kind."),
      span,
    );
  }
  return { rootFrameId, rootName, path, capturedRoot, detached };
}

/**
 * Freezes, before a store at `mutation`, the attached references that the store changes the value of: a receiver at the
 * changed place or below it, and a current value (`currentValueTemporaries` of the snapshot validation analysis) at,
 * below, or above it.
 */
export function detachPreparedReferencesForMutation(
  snapshot: RuntimeSnapshot,
  plan: InstructionPlan,
  mutation: PreparedReferenceMutation,
): void {
  if (mutation.rootFrameId === null || mutation.rootName === null) return;
  const currentValues = snapshotValidationAnalysis(plan).currentValueTemporaries;
  for (const temporaries of allTemporaryCollections(snapshot)) {
    for (const temporary of temporaries) {
      if (!isObject(temporary.value)) continue;
      let descriptor: PreparedReferenceDescriptor;
      try {
        descriptor = readPreparedReference(temporary.value, INTERNAL_REFERENCE_SPAN);
      } catch {
        continue;
      }
      // A current value is attached only to a list it reads from a variable, through no speaker.
      if (currentValues.has(temporary.id)) {
        if (
          !descriptor.detached &&
          descriptor.rootFrameId === mutation.rootFrameId &&
          descriptor.rootName === mutation.rootName &&
          (pathStartsWith(descriptor.path, mutation.path) ||
            pathStartsWith(mutation.path, descriptor.path))
        )
          freezePreparedReference(snapshot, temporary.value, descriptor, descriptor.path.length);
        continue;
      }
      // A detached reference holds a copy of its root, which changes only where its path goes through a speaker, whose
      // properties stay shared state, as for a receiver that `speaker` or a function result gave.
      if (descriptor.detached && mutation.speakerPath == null) continue;
      const changedDepth = preparedReferenceMutationDepth(snapshot, descriptor, mutation, false);
      if (changedDepth === null) continue;
      freezePreparedReference(snapshot, temporary.value, descriptor, changedDepth);
    }
  }
}

/**
 * Freezes, before a method changes a list, set, or dict in place, the current values (see
 * `detachPreparedReferencesForMutation`) that may hold it or lead into it: those read from the variable `root` that holds
 * the receiver, or with `null`, when that variable is not known, every one.
 */
export function freezeCurrentValuesForChange(
  snapshot: RuntimeSnapshot,
  plan: InstructionPlan,
  root: { readonly rootFrameId: number | null; readonly rootName: string | null } | null,
): void {
  const currentValues = snapshotValidationAnalysis(plan).currentValueTemporaries;
  for (const temporaries of allTemporaryCollections(snapshot)) {
    for (const temporary of temporaries) {
      if (!currentValues.has(temporary.id) || !isObject(temporary.value)) continue;
      let descriptor: PreparedReferenceDescriptor;
      try {
        descriptor = readPreparedReference(temporary.value, INTERNAL_REFERENCE_SPAN);
      } catch {
        continue;
      }
      if (
        descriptor.detached ||
        (root !== null &&
          (descriptor.rootFrameId !== root.rootFrameId || descriptor.rootName !== root.rootName))
      )
        continue;
      freezePreparedReference(snapshot, temporary.value, descriptor, descriptor.path.length);
    }
  }
}

export function preparePreparedReferencesForListRemoval(
  snapshot: RuntimeSnapshot,
  receiver: SerializableRuntimeList,
  removedIndex: number,
): SerializableRuntimeObject[] {
  return preparePreparedReferencesForListChange(snapshot, receiver, (index) =>
    index === removedIndex ? undefined : index < removedIndex ? index : index - 1,
  );
}

/**
 * Moves prepared references into the items of `receiver` along with their items when the list is reordered in place,
 * as by `sort`, `shuffle`, and `reverse`. `newIndexOf[old]` is the new index of the item at `old`.
 */
export function preparePreparedReferencesForListReorder(
  snapshot: RuntimeSnapshot,
  receiver: SerializableRuntimeList,
  newIndexOf: readonly number[],
): SerializableRuntimeObject[] {
  return preparePreparedReferencesForListChange(snapshot, receiver, (index) => newIndexOf[index]);
}

/**
 * Follows a change of `receiver`'s item indexes: a prepared reference into an item moves to the item's new index, and
 * one into an item that leaves the list (`undefined`) keeps the value it refers to now.
 */
function preparePreparedReferencesForListChange(
  snapshot: RuntimeSnapshot,
  receiver: SerializableRuntimeList,
  newIndex: (index: number) => number | undefined,
): SerializableRuntimeObject[] {
  const rebased: SerializableRuntimeObject[] = [];
  for (const temporaries of allTemporaryCollections(snapshot)) {
    for (const temporary of temporaries) {
      if (!isObject(temporary.value)) continue;
      let descriptor: PreparedReferenceDescriptor;
      try {
        descriptor = readPreparedReference(temporary.value, INTERNAL_REFERENCE_SPAN);
      } catch {
        continue;
      }
      if (descriptor.detached) continue;
      const pathIndex = preparedReferenceStepPosition(snapshot, descriptor, receiver);
      if (pathIndex === null) continue;
      const step = descriptor.path[pathIndex];
      if (step?.kind !== "index") continue;
      const index = newIndex(step.index);
      if (index === undefined) {
        freezePreparedReference(snapshot, temporary.value, descriptor, pathIndex + 1);
        continue;
      }
      if (index === step.index) continue;
      descriptor.path[pathIndex] = { kind: "index", index };
      setCapturedSerializableProperty(
        temporary.value,
        "path",
        serializePreparedReferencePath(descriptor.path),
      );
      rebased.push(temporary.value);
    }
  }
  return rebased;
}

export function refreshPreparedReferenceFallbacks(
  snapshot: RuntimeSnapshot,
  references: readonly SerializableRuntimeObject[],
): void {
  for (const serialized of references) {
    let descriptor: PreparedReferenceDescriptor;
    try {
      descriptor = readPreparedReference(serialized, INTERNAL_REFERENCE_SPAN);
    } catch {
      continue;
    }
    // A reference without a copy of its root resolves through its variable alone.
    if (descriptor.detached || descriptor.capturedRoot === undefined) continue;
    const root = preparedReferenceRoot(snapshot, descriptor);
    if (!root.found) {
      freezePreparedReference(snapshot, serialized, descriptor);
      continue;
    }
    setCapturedSerializableProperty(serialized, "capturedRoot", root.value);
  }
}

/**
 * Freezes the prepared references into the elements of a list or the entries of a dict that a mutation removes: every
 * one of them, or for a dict `key`, only those through that key.
 */
export function freezePreparedReferenceDescendants(
  snapshot: RuntimeSnapshot,
  receiver: SerializableRuntimeList | SerializableRuntimeDict,
  key?: string,
): void {
  for (const temporaries of allTemporaryCollections(snapshot)) {
    for (const temporary of temporaries) {
      if (!isObject(temporary.value)) continue;
      let descriptor: PreparedReferenceDescriptor;
      try {
        descriptor = readPreparedReference(temporary.value, INTERNAL_REFERENCE_SPAN);
      } catch {
        continue;
      }
      if (descriptor.detached) continue;
      const position = preparedReferenceStepPosition(snapshot, descriptor, receiver);
      if (position === null) continue;
      const step = descriptor.path[position]!;
      if (key !== undefined && (step.kind !== "key" || step.key !== key)) continue;
      freezePreparedReference(snapshot, temporary.value, descriptor, position + 1);
    }
  }
}

/** The position of the element or entry step by which a reference leaves `receiver`, or `null` when it does not. */
function preparedReferenceStepPosition(
  snapshot: RuntimeSnapshot,
  descriptor: PreparedReferenceDescriptor,
  receiver: SerializableRuntimeList | SerializableRuntimeDict,
): number | null {
  const root = preparedReferenceRoot(snapshot, descriptor);
  if (!root.found) return null;
  let current = root.value;
  for (let index = 0; index < descriptor.path.length; index += 1) {
    const step = descriptor.path[index]!;
    if (current === receiver) return step.kind === "index" || step.kind === "key" ? index : null;
    const next = resolvePreparedReferenceStep(snapshot, current, step);
    if (!next.found) return null;
    current = next.value;
  }
  return null;
}

/**
 * The number of steps on the path of `descriptor` that lead to the value `mutation` changes, or `null` when the
 * mutation does not change the value the descriptor refers to.
 */
function preparedReferenceMutationDepth(
  snapshot: RuntimeSnapshot,
  descriptor: PreparedReferenceDescriptor,
  mutation: PreparedReferenceMutation,
  descendantsOnly: boolean,
): number | null {
  const rootMatches =
    descriptor.rootFrameId === mutation.rootFrameId &&
    descriptor.rootName === mutation.rootName &&
    (!descendantsOnly || descriptor.path.length > mutation.path.length) &&
    pathStartsWith(descriptor.path, mutation.path);
  if (rootMatches) return mutation.path.length;

  if (mutation.speakerPath === null || mutation.speakerPath === undefined) {
    return null;
  }
  const descriptorSpeakerPath = preparedReferenceSpeakerPath(snapshot, descriptor);
  // The speaker path is the end of the descriptor's path after the last speaker it reaches.
  return descriptorSpeakerPath !== null &&
    descriptorSpeakerPath.speakerId === mutation.speakerPath.speakerId &&
    (!descendantsOnly || descriptorSpeakerPath.path.length > mutation.speakerPath.path.length) &&
    pathStartsWith(descriptorSpeakerPath.path, mutation.speakerPath.path)
    ? descriptor.path.length - descriptorSpeakerPath.path.length + mutation.speakerPath.path.length
    : null;
}

/**
 * Makes an attached reference independent of the value `changedDepth` steps along its path, which is about to change,
 * or without `changedDepth`, of its root, which no longer exists. The reference keeps a copy of the value it leads to
 * now. A speaker that the path reaches at or after the change stays the same speaker, though, so a reference that goes
 * on from the last such speaker into the values it stores follows it from its global instead, like a reference prepared
 * through the speaker's name.
 */
function freezePreparedReference(
  snapshot: RuntimeSnapshot,
  serialized: SerializableRuntimeObject,
  descriptor: PreparedReferenceDescriptor,
  changedDepth?: number,
): void {
  const speaker =
    changedDepth === undefined ? null : speakerOnPath(snapshot, descriptor, changedDepth);
  if (speaker !== null) {
    const followed = serializePreparedReference({
      rootFrameId: GLOBAL_SCOPE_ID,
      rootName: speaker.reference.identifier,
      path: descriptor.path.slice(speaker.depth),
      // An attached reference keeps a copy of its root exactly where the plan keeps one; a detached one, which always
      // keeps one, stays detached and follows the speaker through that copy.
      capturedRoot:
        descriptor.capturedRoot === undefined
          ? undefined
          : cloneCapturedSerializableValue(speaker.reference),
      detached: descriptor.detached,
    });
    serialized.properties.length = 0;
    for (const property of followed.properties) serialized.properties.push(property);
    return;
  }
  const resolution = resolveStoredPreparedReference(snapshot, descriptor);
  if (!resolution.found) {
    // Every change that could break the path of an attached reference that keeps no copy of its root freezes it first.
    if (descriptor.capturedRoot === undefined) {
      throw fault(
        "TSR053",
        internalFault("A prepared reference no longer leads to the value it names."),
        INTERNAL_REFERENCE_SPAN,
      );
    }
    setCapturedSerializableProperty(serialized, "detached", true);
    return;
  }
  const frozen = serializePreparedReference({
    rootFrameId: null,
    rootName: null,
    path: descriptor.path.slice(resolution.rest),
    capturedRoot: cloneCapturedSerializableValue(resolution.value),
    detached: true,
  });
  serialized.properties.length = 0;
  for (const property of frozen.properties) serialized.properties.push(property);
}

/**
 * The last speaker that the path of `descriptor` reaches after `minimumDepth` or more steps, and the number of steps
 * that lead to it, when the rest of the path goes on from it into values the session stores: properties of objects and
 * speakers, list elements, and dict entries. `null` when there is none, as when the rest reads a property derived at
 * each read, such as a dict's `values`, which no change of the dict follows.
 */
function speakerOnPath(
  snapshot: RuntimeSnapshot,
  descriptor: PreparedReferenceDescriptor,
  minimumDepth: number,
): { readonly reference: SerializableSpeakerReference; readonly depth: number } | null {
  const root = preparedReferenceRoot(snapshot, descriptor);
  if (!root.found) return null;
  let speaker: { reference: SerializableSpeakerReference; depth: number } | null = null;
  let current = root.value;
  for (let depth = 0; depth < descriptor.path.length; depth += 1) {
    if (depth >= minimumDepth && isSpeakerReference(current))
      speaker = { reference: current, depth };
    const step = descriptor.path[depth]!;
    if (!selectsStoredValue(current, step)) speaker = null;
    const next = resolvePreparedReferenceStep(snapshot, current, step);
    if (!next.found) return null;
    current = next.value;
  }
  return speaker;
}

/**
 * What a change through `descriptor` changes, for the debug trace: a property of the last speaker its path reaches, when
 * the rest of the path goes on from that property into values the session stores; else, for an attached reference whose
 * whole path does, the variable at its root; else nothing, as for a copy or a value derived at each read, such as a
 * dict's `keys`. A path that no longer leads anywhere leads to no speaker's property, but still into its variable.
 */
export function preparedReferenceChangeTarget(
  snapshot: RuntimeSnapshot,
  descriptor: PreparedReferenceDescriptor,
): { readonly speakerId: number; readonly property: string } | "variable" | null {
  const root = preparedReferenceRoot(snapshot, descriptor);
  if (!root.found) return null;
  let target: { speakerId: number; property: string } | "variable" | null = descriptor.detached
    ? null
    : "variable";
  let current = root.value;
  for (const step of descriptor.path) {
    if (isSpeakerReference(current))
      target =
        step.kind === "property" ? { speakerId: current.speakerId, property: step.name } : null;
    else if (!selectsStoredValue(current, step)) target = null;
    const next = resolvePreparedReferenceStep(snapshot, current, step);
    if (!next.found) return target === "variable" ? target : null;
    current = next.value;
  }
  return target;
}

/**
 * Whether `step` from `value` leads to a value the session stores: a property of an object or a speaker, a list element,
 * or a dict entry. Any other property, such as a dict's `values`, is derived at each read, so no change follows it back.
 */
function selectsStoredValue(value: SerializableRuntimeValue, step: PreparedReferenceStep): boolean {
  return step.kind !== "property" || isObject(value) || isSpeakerReference(value);
}

export function preparedReferenceSpeakerPath(
  snapshot: RuntimeSnapshot,
  descriptor: PreparedReferenceDescriptor,
  extension: readonly PreparedReferenceStep[] = [],
): PreparedSpeakerPath | null {
  const root = preparedReferenceRoot(snapshot, descriptor);
  if (!root.found) return null;
  let current = root.value;
  let identity: { speakerId: number; path: PreparedReferenceStep[] } | null = null;
  for (const step of [...descriptor.path, ...extension]) {
    if (isSpeakerReference(current)) {
      identity = { speakerId: current.speakerId, path: [] };
    }
    identity?.path.push(step);
    const next = resolvePreparedReferenceStep(snapshot, current, step);
    if (!next.found) return null;
    current = next.value;
  }
  if (isSpeakerReference(current)) {
    identity = { speakerId: current.speakerId, path: [] };
  }
  return identity;
}

/**
 * The last value on the path of `descriptor` that the session holds, and the position of the steps after it. A property
 * of any value but an object, a speaker, or a collection, such as a timer's `state` or a date's `weekday`, is read at
 * use, so a frozen reference keeps the value that has it and reads it from there.
 */
function resolveStoredPreparedReference(
  snapshot: RuntimeSnapshot,
  descriptor: PreparedReferenceDescriptor,
): { readonly found: boolean; readonly value: SerializableRuntimeValue; readonly rest: number } {
  const root = preparedReferenceRoot(snapshot, descriptor);
  if (!root.found) return { ...root, rest: 0 };
  let current = root.value;
  for (let index = 0; index < descriptor.path.length; index += 1) {
    const step = descriptor.path[index]!;
    if (
      step.kind === "property" &&
      !isObject(current) &&
      !isSpeakerReference(current) &&
      !isList(current) &&
      !isSet(current) &&
      !isDict(current)
    )
      return { found: true, value: current, rest: index };
    const next = resolvePreparedReferenceStep(snapshot, current, step);
    if (!next.found) return { ...next, rest: index };
    current = next.value;
  }
  return { found: true, value: current, rest: descriptor.path.length };
}

function preparedReferenceRoot(
  snapshot: RuntimeSnapshot,
  descriptor: PreparedReferenceDescriptor,
): { readonly found: boolean; readonly value: SerializableRuntimeValue } {
  if (!descriptor.detached && descriptor.rootFrameId !== null && descriptor.rootName !== null) {
    const binding = scopeBindings(snapshot, descriptor.rootFrameId)?.find(
      (candidate) => candidate.name === descriptor.rootName,
    );
    return binding === undefined
      ? { found: false, value: null }
      : { found: true, value: binding.value };
  }
  // EVIDENCE: readPreparedReference and the evaluator give every detached or rootless reference a captured root.
  return { found: true, value: descriptor.capturedRoot! };
}

function resolvePreparedReferenceStep(
  snapshot: RuntimeSnapshot,
  value: SerializableRuntimeValue,
  step: PreparedReferenceStep,
): { readonly found: boolean; readonly value: SerializableRuntimeValue } {
  if (step.kind === "index") {
    if (!isList(value) || step.index < 0 || step.index >= value.items.length) {
      return { found: false, value: null };
    }
    return { found: true, value: value.items[step.index]! };
  }
  if (step.kind === "key") {
    const entry = isDict(value) ? getSerializableDictEntry(value, step.key) : undefined;
    return entry === undefined
      ? { found: false, value: null }
      : { found: true, value: entry.value };
  }
  if (isObject(value)) {
    const property = getSerializableProperty(value, step.name);
    return property === undefined
      ? { found: false, value: null }
      : { found: true, value: property };
  }
  if (isSpeakerReference(value)) {
    const speaker = snapshot.speakers.find((candidate) => candidate.id === value.speakerId);
    if (speaker === undefined) return { found: false, value: null };
    const property = speakerPropertyValue(
      (name) => speaker.properties.find((candidate) => candidate.name === name)?.value,
      step.name,
      () =>
        derivedDisplayName(
          speaker.properties,
          INTERNAL_REFERENCE_SPAN,
          currentTemporalContext(snapshot),
          "displayName",
        ),
    );
    return property === undefined
      ? { found: false, value: null }
      : { found: true, value: property };
  }
  // A list's or set's element is read as an index or a copy, so only its length is a property step.
  if ((isList(value) || isSet(value)) && listProperty(step.name)?.gives === "length") {
    return { found: true, value: value.items.length };
  }
  if (isDict(value)) {
    const derived = dictProperty(value, step.name);
    return derived === undefined ? { found: false, value: null } : { found: true, value: derived };
  }
  return { found: false, value: null };
}

function pathStartsWith(
  path: readonly PreparedReferenceStep[],
  prefix: readonly PreparedReferenceStep[],
): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((step, index) => {
    const candidate = path[index];
    switch (step.kind) {
      case "property":
        return candidate?.kind === "property" && candidate.name === step.name;
      case "index":
        return candidate?.kind === "index" && candidate.index === step.index;
      case "key":
        return candidate?.kind === "key" && candidate.key === step.key;
    }
  });
}

function allTemporaryCollections(snapshot: RuntimeSnapshot): RuntimeTemporarySnapshot[][] {
  return [snapshot.temporaries, ...snapshot.callFrames.map((frame) => frame.callerTemporaries)];
}

function fault(code: RuntimeErrorCode, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
