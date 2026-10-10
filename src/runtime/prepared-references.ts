import type { PlanSourceLocation } from "../plan/model.js";
import { findScope } from "./activations.js";
import {
  createSourcePosition,
  createSourceSpan,
  type SourceSpan as RichSourceSpan,
} from "../source.js";
import { internalFault, RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
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
} from "./serializable-values.js";
import type { RuntimeBindingSnapshot, RuntimeSnapshot, RuntimeTemporarySnapshot } from "./state.js";
import { isDict, isList, isObject, isSet, isSpeakerReference } from "./value-predicates.js";

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
   * A copy of the root: the value of a detached reference, and for an attached one, where the plan keeps it, its
   * fallback (`preparedReferenceTemporaries` of the snapshot validation analysis). `undefined` for an attached
   * reference that keeps none.
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

export function detachPreparedReferencesForMutation(
  snapshot: RuntimeSnapshot,
  mutation: PreparedReferenceMutation,
): void {
  if (mutation.rootFrameId === null || mutation.rootName === null) return;
  for (const temporaries of allTemporaryCollections(snapshot)) {
    for (const temporary of temporaries) {
      if (!isObject(temporary.value)) continue;
      let descriptor: PreparedReferenceDescriptor;
      try {
        descriptor = readPreparedReference(temporary.value, INTERNAL_REFERENCE_SPAN);
      } catch {
        continue;
      }
      if (
        descriptor.detached ||
        !preparedReferenceMutationMatches(snapshot, descriptor, mutation, false)
      ) {
        continue;
      }
      freezePreparedReference(snapshot, temporary.value, descriptor);
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
 * as by `sort` and `shuffle`. `newIndexOf[old]` is the new index of the item at `old`.
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
      // A reference whose path already leads nowhere past the list, as one through an emptied dict's `values` does,
      // keeps its copy of the root: rebasing would refresh that copy from the variable, where it leads nowhere either.
      if (!resolvePreparedReferenceDescriptor(snapshot, descriptor).found) {
        freezePreparedReference(snapshot, temporary.value, descriptor);
        continue;
      }
      const index = newIndex(step.index);
      if (index === undefined) {
        freezePreparedReference(snapshot, temporary.value, descriptor);
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
      freezePreparedReference(snapshot, temporary.value, descriptor);
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

function preparedReferenceMutationMatches(
  snapshot: RuntimeSnapshot,
  descriptor: PreparedReferenceDescriptor,
  mutation: PreparedReferenceMutation,
  descendantsOnly: boolean,
): boolean {
  const rootMatches =
    descriptor.rootFrameId === mutation.rootFrameId &&
    descriptor.rootName === mutation.rootName &&
    (!descendantsOnly || descriptor.path.length > mutation.path.length) &&
    pathStartsWith(descriptor.path, mutation.path);
  if (rootMatches) return true;

  if (mutation.speakerPath === null || mutation.speakerPath === undefined) {
    return false;
  }
  const descriptorSpeakerPath = preparedReferenceSpeakerPath(snapshot, descriptor);
  return (
    descriptorSpeakerPath !== null &&
    descriptorSpeakerPath.speakerId === mutation.speakerPath.speakerId &&
    (!descendantsOnly || descriptorSpeakerPath.path.length > mutation.speakerPath.path.length) &&
    pathStartsWith(descriptorSpeakerPath.path, mutation.speakerPath.path)
  );
}

function freezePreparedReference(
  snapshot: RuntimeSnapshot,
  serialized: SerializableRuntimeObject,
  descriptor: PreparedReferenceDescriptor,
): void {
  const resolution = resolvePreparedReferenceDescriptor(snapshot, descriptor);
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
    path: [],
    capturedRoot: cloneCapturedSerializableValue(resolution.value),
    detached: true,
  });
  serialized.properties.length = 0;
  for (const property of frozen.properties) serialized.properties.push(property);
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

function resolvePreparedReferenceDescriptor(
  snapshot: RuntimeSnapshot,
  descriptor: PreparedReferenceDescriptor,
): { readonly found: boolean; readonly value: SerializableRuntimeValue } {
  const root = preparedReferenceRoot(snapshot, descriptor);
  if (!root.found) return root;
  let current = root.value;
  for (const step of descriptor.path) {
    const next = resolvePreparedReferenceStep(snapshot, current, step);
    if (!next.found) return next;
    current = next.value;
  }
  return { found: true, value: current };
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
    let property = speaker.properties.find((candidate) => candidate.name === step.name)?.value;
    if (property === undefined && step.name === "title") {
      property = speaker.properties.find((candidate) => candidate.name === "shortTitle")?.value;
    } else if (property === undefined && step.name === "shortTitle") {
      property = speaker.properties.find((candidate) => candidate.name === "title")?.value;
    }
    return property === undefined
      ? { found: false, value: null }
      : { found: true, value: property };
  }
  if ((isList(value) || isSet(value)) && step.name === "length") {
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

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
