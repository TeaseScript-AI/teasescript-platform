import { isPlainRecord } from "../values/plain-data.js";
import { nonNegativeSafeInteger, positiveSafeInteger, hasExactKeys } from "./state.js";
import type { PreparedSayTemporaryOwnership } from "./snapshot-validation-analysis.js";
import { GLOBAL_SCOPE_ID } from "../scopes/prepared-references.js";
import { isOneOf } from "../../plan/validation-support.js";
import { isDictProperty } from "../../dict-operations.js";
import { stringLength } from "../../text-operations.js";
import {
  validateCapturedSerializableValue,
  type SerializableRuntimeValue,
} from "../values/serializable-values.js";
import { isCalendarDuration, isTemporal } from "../values/value-predicates.js";
import { calendarDurationProperty, temporalProperty } from "../values/temporal-operations.js";
import { handleKindOf, isHandleProperty } from "../../handle-members.js";
import { speakerPropertyValue } from "../../speaker-terms.js";
import { serializedScopes } from "../scopes/activation-validation.js";

// The prepared temporaries of a captured snapshot: prepared references with the paths they resolve, and the speaker
// and text a say prepared.

type PreparedReferencePathStep =
  | { readonly kind: "property"; readonly name: string }
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "key"; readonly key: string };

const preparedReferencePropertyNames = Object.freeze([
  "marker",
  "rootFrameId",
  "rootName",
  "path",
  "capturedRoot",
  "detached",
] as const);

export function validatePreparedReferenceTemporaries(
  value: unknown,
  scopesById: ReferenceScopesById,
  speakers: unknown,
  preparedTemporaries: ReadonlyMap<number, boolean> | undefined,
  label: string,
  errors: string[],
): void {
  if (preparedTemporaries === undefined || preparedTemporaries.size === 0 || !Array.isArray(value))
    return;

  for (const temporary of value) {
    if (!isPlainRecord(temporary) || !nonNegativeSafeInteger(temporary.id)) continue;
    const keepsRoot = preparedTemporaries.get(temporary.id);
    if (keepsRoot === undefined) continue;
    const failure = validatePreparedReferenceDescriptor(
      temporary.value,
      scopesById,
      speakers,
      keepsRoot,
    );
    if (failure !== null) {
      errors.push(`${label} contain malformed prepared-reference state: ${failure}`);
    }
  }
}

export function validatePreparedSayTemporaries(
  value: unknown,
  speakers: unknown,
  ownership: PreparedSayTemporaryOwnership | undefined,
  label: string,
  errors: string[],
): void {
  if (ownership === undefined || !Array.isArray(value)) return;
  // The first record of each temporary ID; the temporaries' own checks report duplicates.
  const records = new Map<number, Record<string, unknown>>();
  for (const temporary of value) {
    if (isPlainRecord(temporary) && typeof temporary.id === "number" && !records.has(temporary.id))
      records.set(temporary.id, temporary);
    if (
      !isPlainRecord(temporary) ||
      !nonNegativeSafeInteger(temporary.id) ||
      !("value" in temporary)
    )
      continue;
    let valid = true;
    if (ownership.outputSpeakerIds.has(temporary.id)) {
      valid = validPreparedSayTemporarySpeaker(
        temporary.value,
        speakers,
        ownership.nullableOutputSpeakerIds.has(temporary.id),
        ownership.explicitOutputSpeakerIdentifiers.get(temporary.id),
      );
    } else if (ownership.textIds.has(temporary.id)) {
      valid = typeof temporary.value === "string";
    } else if (ownership.contextualSpeakerIds.has(temporary.id)) {
      valid = validPreparedSayContextualSpeaker(
        temporary.value,
        speakers,
        ownership.nullableContextualSpeakerIds.has(temporary.id),
      );
    }
    if (!valid) errors.push(`${label} contain malformed prepared-say state.`);
  }
  // Each contextual speaker the state holds matches the output speaker it was prepared from, if that is held too.
  for (const [temporaryId, contextual] of records) {
    const outputTemporaryId = ownership.contextualSpeakerSources.get(temporaryId);
    const output = outputTemporaryId === undefined ? undefined : records.get(outputTemporaryId);
    if (output !== undefined && !preparedSaySpeakerValuesMatch(output.value, contextual.value)) {
      errors.push(`${label} contain inconsistent prepared-say speaker state.`);
    }
  }
}

function preparedSaySpeakerValuesMatch(output: unknown, contextual: unknown): boolean {
  if (output === null || contextual === null) return output === contextual;
  const outputProperties = serializedObjectPropertyMap(output);
  if (outputProperties === null || !isPlainRecord(contextual)) return false;
  return (
    outputProperties.get("speakerId") === contextual.speakerId &&
    outputProperties.get("identifier") === contextual.identifier
  );
}

function validPreparedSayTemporarySpeaker(
  value: unknown,
  speakers: unknown,
  allowsNull: boolean,
  expectedIdentifier: string | undefined,
): boolean {
  if (value === null) return allowsNull;
  const properties = serializedObjectPropertyMap(value);
  if (
    properties === null ||
    properties.size !== 6 ||
    !["identifier", "displayName", "color", "font", "avatar", "speakerId"].every((name) =>
      properties.has(name),
    )
  )
    return false;
  const identifier = properties.get("identifier");
  const displayName = properties.get("displayName");
  const color = properties.get("color");
  const font = properties.get("font");
  const avatar = properties.get("avatar");
  const speakerId = properties.get("speakerId");
  if (
    typeof identifier !== "string" ||
    typeof displayName !== "string" ||
    (typeof color !== "string" && color !== null) ||
    (typeof font !== "string" && font !== null) ||
    (typeof avatar !== "string" && avatar !== null) ||
    !positiveSafeInteger(speakerId)
  )
    return false;
  return (
    (expectedIdentifier === undefined || identifier === expectedIdentifier) &&
    Array.isArray(speakers) &&
    speakers.some(
      (speaker) =>
        isPlainRecord(speaker) && speaker.id === speakerId && speaker.identifier === identifier,
    )
  );
}

function validPreparedSayContextualSpeaker(
  value: unknown,
  speakers: unknown,
  allowsNull: boolean,
): boolean {
  if (value === null) return allowsNull;
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["kind", "speakerId", "identifier"]) ||
    value.kind !== "speakerReference" ||
    !positiveSafeInteger(value.speakerId) ||
    typeof value.identifier !== "string"
  )
    return false;
  return (
    Array.isArray(speakers) &&
    speakers.some(
      (speaker) =>
        isPlainRecord(speaker) &&
        speaker.id === value.speakerId &&
        speaker.identifier === value.identifier,
    )
  );
}

/** `keepsRoot`: whether the plan keeps a copy of the root of an attached reference in this temporary. */
function validatePreparedReferenceDescriptor(
  value: unknown,
  scopesById: ReferenceScopesById,
  speakers: unknown,
  keepsRoot: boolean,
): string | null {
  const properties = serializedObjectPropertyMap(value);
  if (
    properties === null ||
    properties.size !==
      preparedReferencePropertyNames.length - (properties.has("capturedRoot") ? 0 : 1) ||
    preparedReferencePropertyNames.some((name) => name !== "capturedRoot" && !properties.has(name))
  ) {
    return "the descriptor must contain exactly the supported fields.";
  }

  const marker = properties.get("marker");
  const rootFrameId = properties.get("rootFrameId");
  const rootName = properties.get("rootName");
  const pathValue = properties.get("path");
  const capturedRoot = properties.get("capturedRoot");
  const detached = properties.get("detached");
  if (marker !== "preparedReference") {
    return "the descriptor marker is invalid.";
  }
  if (
    rootFrameId !== null &&
    rootFrameId !== GLOBAL_SCOPE_ID &&
    !nonNegativeSafeInteger(rootFrameId)
  ) {
    return "the root frame ID must be a non-negative integer, the globals' scope ID, or null.";
  }
  if (rootName !== null && (typeof rootName !== "string" || rootName.length === 0)) {
    return "the root name must be a non-empty string or null.";
  }
  if ((rootFrameId === null) !== (rootName === null)) {
    return "the root frame ID and root name must both be present or both be null.";
  }
  if (typeof detached !== "boolean") {
    return "the detached flag must be boolean.";
  }
  if (rootFrameId === null && detached !== true) {
    return "a descriptor without a binding root must be detached.";
  }
  // A detached reference is its captured root; an attached one keeps a copy exactly where the plan does.
  if ((capturedRoot !== undefined) !== (detached || keepsRoot)) {
    return detached || keepsRoot
      ? "the captured root is missing."
      : "an attached descriptor keeps a captured root where the plan keeps none.";
  }

  const path = parsePreparedReferencePath(pathValue);
  if (path === null) return "the descriptor path is malformed.";
  if (capturedRoot !== undefined && !preparedReferencePathResolves(capturedRoot, path, speakers)) {
    return "the captured root does not satisfy the prepared path.";
  }

  if (rootFrameId !== null && rootName !== null) {
    const binding = serializedFrameBinding(scopesById, rootFrameId, rootName);
    if (!binding.found) {
      return "the binding root does not exist in the serialized scope frames.";
    }
    // A reference that keeps a copy of its root is detached at its next use once its path leads nowhere from its
    // variable. A dict's `keys` and `values` are made anew at each read, so no change of the dict detaches a reference
    // through them before that use.
    if (
      !detached &&
      capturedRoot === undefined &&
      !preparedReferencePathResolves(binding.value, path, speakers)
    ) {
      return "the attached binding root does not satisfy the prepared path.";
    }
  }

  return null;
}

function serializedObjectPropertyMap(value: unknown): ReadonlyMap<string, unknown> | null {
  if (!isPlainRecord(value) || value.kind !== "object" || !Array.isArray(value.properties)) {
    return null;
  }
  const output = new Map<string, unknown>();
  for (const property of value.properties) {
    if (
      !isPlainRecord(property) ||
      typeof property.name !== "string" ||
      property.name.length === 0 ||
      output.has(property.name)
    ) {
      return null;
    }
    output.set(property.name, property.value);
  }
  return output;
}

function serializedDictEntryMap(value: unknown): ReadonlyMap<string, unknown> | null {
  if (!isPlainRecord(value) || value.kind !== "dict" || !Array.isArray(value.entries)) return null;
  const output = new Map<string, unknown>();
  for (const entry of value.entries) {
    if (!isPlainRecord(entry) || typeof entry.key !== "string" || output.has(entry.key))
      return null;
    output.set(entry.key, entry.value);
  }
  return output;
}

function parsePreparedReferencePath(value: unknown): readonly PreparedReferencePathStep[] | null {
  if (!isPlainRecord(value) || value.kind !== "list" || !Array.isArray(value.items)) {
    return null;
  }
  const output: PreparedReferencePathStep[] = [];
  for (const item of value.items) {
    const properties = serializedObjectPropertyMap(item);
    if (properties === null) return null;
    const kind = properties.get("kind");
    if (kind === "property" && properties.size === 2 && properties.has("name")) {
      const name = properties.get("name");
      if (typeof name !== "string" || name.length === 0) return null;
      output.push({ kind, name });
      continue;
    }
    if (kind === "key" && properties.size === 2 && properties.has("key")) {
      const key = properties.get("key");
      if (typeof key !== "string") return null;
      output.push({ kind, key });
      continue;
    }
    if (kind === "index" && properties.size === 2 && properties.has("index")) {
      const index = properties.get("index");
      if (!nonNegativeSafeInteger(index)) return null;
      output.push({ kind, index });
      continue;
    }
    return null;
  }
  return output;
}

function serializedFrameBinding(
  scopesById: ReferenceScopesById,
  frameId: number,
  name: string,
): { readonly found: boolean; readonly value: unknown } {
  const frame = scopesById.get(frameId);
  if (frame === undefined || !Array.isArray(frame.bindings)) {
    return { found: false, value: null };
  }
  const binding = frame.bindings.find(
    (candidate) => isPlainRecord(candidate) && candidate.name === name && "value" in candidate,
  );
  return isPlainRecord(binding)
    ? { found: true, value: binding.value }
    : { found: false, value: null };
}

function preparedReferencePathResolves(
  root: unknown,
  path: readonly PreparedReferencePathStep[],
  speakers: unknown,
): boolean {
  let current = root;
  for (const step of path) {
    if (step.kind === "index") {
      // Only a list is addressed by position; a set member is read as a copy.
      if (
        !isPlainRecord(current) ||
        current.kind !== "list" ||
        !Array.isArray(current.items) ||
        step.index >= current.items.length
      ) {
        return false;
      }
      current = current.items[step.index];
      continue;
    }
    if (step.kind === "key") {
      const entries = serializedDictEntryMap(current);
      if (entries === null || !entries.has(step.key)) return false;
      current = entries.get(step.key);
      continue;
    }

    if (isPlainRecord(current) && current.kind === "object") {
      const properties = serializedObjectPropertyMap(current);
      if (properties === null || !properties.has(step.name)) return false;
      current = properties.get(step.name);
      continue;
    }
    if (
      isPlainRecord(current) &&
      isOneOf(current.kind, ["list", "set"]) &&
      Array.isArray(current.items)
    ) {
      if (step.name !== "length") return false;
      current = current.items.length;
      continue;
    }
    if (isPlainRecord(current) && current.kind === "dict" && Array.isArray(current.entries)) {
      const entries = serializedDictEntryMap(current);
      if (entries === null || !isDictProperty(step.name)) return false;
      // `keys` and `values` read new lists derived from the entries (see `DICT_PROPERTIES`).
      switch (step.name) {
        case "length":
          current = entries.size;
          break;
        case "keys":
          current = { kind: "list", items: [...entries.keys()] };
          break;
        case "values":
          current = { kind: "list", items: [...entries.values()] };
          break;
        default: {
          const unhandled: never = step.name;
          throw new Error(`Dict property '${String(unhandled)}' has no implementation.`);
        }
      }
      continue;
    }
    if (
      isPlainRecord(current) &&
      current.kind === "speakerReference" &&
      nonNegativeSafeInteger(current.speakerId)
    ) {
      const property = serializedSpeakerProperty(speakers, current.speakerId, step.name);
      if (!property.found) return false;
      current = property.value;
      continue;
    }
    current = derivedProperty(current, step.name);
    if (current === undefined) return false;
  }
  return true;
}

/**
 * A property that the runtime reads from a value that does not hold it (`Evaluator.#getProperty`): one derived from a
 * text, a calendar duration, or a date or time, or state of a timer, media, or camera handle (see `HANDLE_MEMBERS`);
 * `undefined` when the value has no such property. A handle's property depends on that state, so it stands as an empty
 * text here: only a text has a property of its own, `length`, which the runtime checks again when it resolves the
 * reference. A reference detaches a message's text (`Evaluator.#runMachine`), so no path steps through it.
 */
function derivedProperty(value: unknown, name: string): SerializableRuntimeValue | undefined {
  if (typeof value === "string") return name === "length" ? stringLength(value) : undefined;
  if (validateCapturedSerializableValue(value) !== null) return undefined;
  // EVIDENCE: validation: validateCapturedSerializableValue accepted this captured value above.
  const runtimeValue = value as SerializableRuntimeValue;
  if (isCalendarDuration(runtimeValue)) return calendarDurationProperty(runtimeValue, name);
  if (isTemporal(runtimeValue)) return temporalProperty(runtimeValue, name);
  const handle = handleKindOf(runtimeValue);
  return handle !== null && handle !== "messageHandle" && isHandleProperty(handle, name)
    ? ""
    : undefined;
}

function serializedSpeakerProperty(
  speakers: unknown,
  speakerId: number,
  name: string,
): { readonly found: boolean; readonly value: unknown } {
  if (!Array.isArray(speakers)) return { found: false, value: null };
  const speaker = speakers.find(
    (candidate) => isPlainRecord(candidate) && candidate.id === speakerId,
  );
  if (!isPlainRecord(speaker) || !Array.isArray(speaker.properties)) {
    return { found: false, value: null };
  }
  const properties = speaker.properties;
  const value = speakerPropertyValue((candidateName) => {
    const property = properties.find(
      (candidate) =>
        isPlainRecord(candidate) && candidate.name === candidateName && "value" in candidate,
    );
    return isPlainRecord(property) ? property.value : undefined;
  }, name);
  return value === undefined ? { found: false, value: null } : { found: true, value };
}

/**
 * The scopes a prepared reference may have as its root: the scope frames and retained roots, then the session's globals under
 * {@link GLOBAL_SCOPE_ID}.
 */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: boundary: the scope frames remain unvalidated until the reference checks read them.
export function referenceScopes(snapshot: Record<string, unknown>): unknown {
  return Array.isArray(snapshot.frames)
    ? [
        ...serializedScopes(snapshot),
        { id: GLOBAL_SCOPE_ID, bindings: Array.isArray(snapshot.globals) ? snapshot.globals : [] },
      ]
    : snapshot.frames;
}

/** Each of the {@link referenceScopes} by its ID, the first with that ID; built once per validation. */
export type ReferenceScopesById = ReadonlyMap<number, Record<string, unknown>>;

export function referenceScopesById(scopes: unknown): ReferenceScopesById {
  const byId = new Map<number, Record<string, unknown>>();
  if (!Array.isArray(scopes)) return byId;
  for (const scope of scopes) {
    if (isPlainRecord(scope) && typeof scope.id === "number" && !byId.has(scope.id))
      byId.set(scope.id, scope);
  }
  return byId;
}
