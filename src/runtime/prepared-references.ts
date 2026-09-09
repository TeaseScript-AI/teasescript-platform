import type { PlanSourceLocation } from "../plan/model.js";
import {
  createSourcePosition,
  createSourceSpan,
  type SourceSpan as RichSourceSpan,
} from "../source.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
import {
  createCapturedSerializableList,
  createCapturedSerializableObject,
  getSerializableProperty,
  setCapturedSerializableProperty,
  type SerializableRuntimeList,
  type SerializableRuntimeObject,
  type SerializableRuntimeValue,
} from "./serializable-values.js";
import type { RuntimeSnapshot, RuntimeTemporarySnapshot } from "./state.js";
import { isList, isObject, isSet, isSpeakerReference } from "./value-predicates.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

export type PreparedReferenceStep =
  | { readonly kind: "property"; readonly name: string }
  | { readonly kind: "index"; readonly index: number };

export interface PreparedReferenceDescriptor {
  readonly rootFrameId: number | null;
  readonly rootName: string | null;
  readonly path: PreparedReferenceStep[];
  readonly capturedRoot: SerializableRuntimeValue;
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

export function serializePreparedReference(
  descriptor: PreparedReferenceDescriptor,
): SerializableRuntimeObject {
  return createCapturedSerializableObject([
    { name: "marker", value: "preparedReference" },
    { name: "rootFrameId", value: descriptor.rootFrameId },
    { name: "rootName", value: descriptor.rootName },
    { name: "path", value: serializePreparedReferencePath(descriptor.path) },
    { name: "capturedRoot", value: descriptor.capturedRoot },
    { name: "detached", value: descriptor.detached },
  ]);
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
    throw fault("TSR053", "Prepared reference state is malformed.", span);
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
    capturedRoot === undefined ||
    typeof detached !== "boolean"
  ) {
    throw fault("TSR053", "Prepared reference state is malformed.", span);
  }
  const path: PreparedReferenceStep[] = [];
  for (const item of pathValue.items) {
    if (!isObject(item)) {
      throw fault("TSR053", "Prepared reference path is malformed.", span);
    }
    const kind = getSerializableProperty(item, "kind");
    if (kind === "property") {
      const name = getSerializableProperty(item, "name");
      if (typeof name !== "string" || name.length === 0) {
        throw fault("TSR053", "Prepared reference property path is malformed.", span);
      }
      path.push({ kind, name });
      continue;
    }
    if (kind === "index") {
      const index = getSerializableProperty(item, "index");
      if (typeof index !== "number" || !Number.isInteger(index)) {
        throw fault("TSR053", "Prepared reference index path is malformed.", span);
      }
      path.push({ kind, index });
      continue;
    }
    throw fault("TSR053", "Prepared reference path kind is malformed.", span);
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
      const pathIndex = preparedReferenceListIndexPosition(snapshot, descriptor, receiver);
      if (pathIndex === null) continue;
      const step = descriptor.path[pathIndex];
      if (step?.kind !== "index") continue;
      if (step.index === removedIndex) {
        freezePreparedReference(snapshot, temporary.value, descriptor);
        continue;
      }
      if (step.index < removedIndex) continue;
      descriptor.path[pathIndex] = { kind: "index", index: step.index - 1 };
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
    if (descriptor.detached) continue;
    const root = preparedReferenceRoot(snapshot, descriptor);
    if (!root.found) {
      freezePreparedReference(snapshot, serialized, descriptor);
      continue;
    }
    setCapturedSerializableProperty(serialized, "capturedRoot", root.value);
  }
}

export function freezePreparedReferenceListDescendants(
  snapshot: RuntimeSnapshot,
  receiver: SerializableRuntimeList,
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
      if (
        descriptor.detached ||
        preparedReferenceListIndexPosition(snapshot, descriptor, receiver) === null
      ) {
        continue;
      }
      freezePreparedReference(snapshot, temporary.value, descriptor);
    }
  }
}

function preparedReferenceListIndexPosition(
  snapshot: RuntimeSnapshot,
  descriptor: PreparedReferenceDescriptor,
  receiver: SerializableRuntimeList,
): number | null {
  const root = preparedReferenceRoot(snapshot, descriptor);
  if (!root.found) return null;
  let current = root.value;
  for (let index = 0; index < descriptor.path.length; index += 1) {
    const step = descriptor.path[index]!;
    if (current === receiver) return step.kind === "index" ? index : null;
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
    setCapturedSerializableProperty(serialized, "detached", true);
    return;
  }
  setCapturedSerializableProperty(serialized, "rootFrameId", null);
  setCapturedSerializableProperty(serialized, "rootName", null);
  setCapturedSerializableProperty(serialized, "path", createCapturedSerializableList([]));
  setCapturedSerializableProperty(serialized, "capturedRoot", resolution.value);
  setCapturedSerializableProperty(serialized, "detached", true);
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
    const frame = snapshot.frames.find((candidate) => candidate.id === descriptor.rootFrameId);
    const binding = frame?.bindings.find((candidate) => candidate.name === descriptor.rootName);
    return binding === undefined
      ? { found: false, value: null }
      : { found: true, value: binding.value };
  }
  return { found: true, value: descriptor.capturedRoot };
}

function resolvePreparedReferenceStep(
  snapshot: RuntimeSnapshot,
  value: SerializableRuntimeValue,
  step: PreparedReferenceStep,
): { readonly found: boolean; readonly value: SerializableRuntimeValue } {
  if (step.kind === "index") {
    if ((!isList(value) && !isSet(value)) || step.index < 0 || step.index >= value.items.length) {
      return { found: false, value: null };
    }
    return { found: true, value: value.items[step.index]! };
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
  return { found: false, value: null };
}

function pathStartsWith(
  path: readonly PreparedReferenceStep[],
  prefix: readonly PreparedReferenceStep[],
): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((step, index) => {
    const candidate = path[index];
    return (
      candidate?.kind === step.kind &&
      (step.kind === "property"
        ? candidate.kind === "property" && candidate.name === step.name
        : candidate.kind === "index" && candidate.index === step.index)
    );
  });
}

function allTemporaryCollections(snapshot: RuntimeSnapshot): RuntimeTemporarySnapshot[][] {
  return [snapshot.temporaries, ...snapshot.callFrames.map((frame) => frame.callerTemporaries)];
}

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
