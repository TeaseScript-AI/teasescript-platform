import {
  EXTERNAL_DATA_DEPTH_MESSAGE,
  EXTERNAL_DATA_WORK_MESSAGE,
  captureExternalData,
  type ExternalDataFailure,
} from "../external-data-limits.js";

export type SerializableRuntimeScalar = string | number | boolean | null;

export interface SerializableRuntimeList {
  readonly kind: "list";
  readonly items: SerializableRuntimeValue[];
}

export interface SerializableRuntimeObject {
  readonly kind: "object";
  readonly properties: SerializableRuntimeProperty[];
}

export interface SerializableRuntimeSet {
  readonly kind: "set";
  readonly items: SerializableRuntimeScalar[];
}

export interface SerializableSpeakerReference {
  readonly kind: "speakerReference";
  readonly speakerId: number;
  readonly identifier: string;
}

export interface SerializableRuntimeRange {
  readonly kind: "range";
  readonly start: number;
  readonly end: number;
  readonly inclusive: boolean;
}

export interface SerializableRuntimeProperty {
  readonly name: string;
  value: SerializableRuntimeValue;
}

export type SerializableRuntimeValue =
  | SerializableRuntimeScalar
  | SerializableRuntimeList
  | SerializableRuntimeObject
  | SerializableRuntimeSet
  | SerializableRuntimeRange
  | SerializableSpeakerReference;

export class SerializableValueError extends Error {
  public constructor(
    readonly code: "cyclic" | "invalid" | "setElement" | "equality",
    message: string,
  ) {
    super(message);
    this.name = "SerializableValueError";
  }
}

export function createSerializableList(
  items: readonly SerializableRuntimeValue[],
): SerializableRuntimeList {
  return cloneSerializableValue({
    kind: "list",
    items: items as SerializableRuntimeValue[],
  }) as SerializableRuntimeList;
}

export function createSerializableObject(
  properties: readonly SerializableRuntimeProperty[],
): SerializableRuntimeObject {
  return cloneSerializableValue({
    kind: "object",
    properties: properties as SerializableRuntimeProperty[],
  }) as SerializableRuntimeObject;
}

export function createSerializableSet(
  items: readonly SerializableRuntimeValue[],
): SerializableRuntimeSet {
  const capture = captureExternalData(items, "$.items");
  if (!capture.ok) throw serializableCaptureError(capture.failure);
  if (!Array.isArray(capture.value)) {
    throw new SerializableValueError("invalid", "Serializable set items must be an array.");
  }

  const seen = new Set<SerializableRuntimeScalar>();
  const capturedItems: SerializableRuntimeScalar[] = [];
  for (let index = 0; index < capture.value.length; index += 1) {
    const item = capture.value[index];
    if (!isScalar(item)) {
      throw new SerializableValueError(
        "setElement",
        "Sets may contain only string, boolean, integer, number, or null values.",
      );
    }
    if (seen.has(item)) continue;
    seen.add(item);
    capturedItems.push(item);
  }
  return { kind: "set", items: capturedItems };
}

export function cloneSerializableValue(
  value: SerializableRuntimeValue,
): SerializableRuntimeValue {
  const captured = captureAndValidateSerializableValue(value);
  if (captured.failure !== null) {
    throw new SerializableValueError(
      captured.failure.includes("cyclic runtime value") ? "cyclic" : "invalid",
      captured.failure,
    );
  }
  return cloneSerializableValueValidated(captured.value!);
}

function cloneSerializableValueValidated(
  value: SerializableRuntimeValue,
): SerializableRuntimeValue {
  if (value === null || typeof value !== "object") return value;
  switch (value.kind) {
    case "range":
      return { ...value };
    case "speakerReference":
      return {
        kind: "speakerReference",
        speakerId: value.speakerId,
        identifier: value.identifier,
      };
    case "list":
      return {
        kind: "list",
        items: value.items.map(cloneSerializableValueValidated),
      };
    case "set":
      return { kind: "set", items: [...value.items] };
    case "object":
      return {
        kind: "object",
        properties: value.properties.map((property) => ({
          name: property.name,
          value: cloneSerializableValueValidated(property.value),
        })),
      };
  }
}

export function getSerializableProperty(
  object: SerializableRuntimeObject,
  name: string,
): SerializableRuntimeValue | undefined {
  return object.properties.find((property) => property.name === name)?.value;
}

export function setSerializableProperty(
  object: SerializableRuntimeObject,
  name: string,
  value: SerializableRuntimeValue,
): void {
  const existing = object.properties.find((property) => property.name === name);
  const copied = cloneSerializableValue(value);
  if (existing === undefined) object.properties.push({ name, value: copied });
  else existing.value = copied;
}

export function addSerializableSetValue(
  set: SerializableRuntimeSet,
  value: SerializableRuntimeValue,
  membership?: Set<SerializableRuntimeScalar>,
): boolean {
  assertSerializableScalar(value);
  const seen = membership ?? new Set(set.items);
  if (seen.has(value)) return false;
  seen.add(value);
  set.items.push(value);
  return true;
}

export function removeSerializableSetValue(
  set: SerializableRuntimeSet,
  value: SerializableRuntimeValue,
): boolean {
  assertSerializableScalar(value);
  const index = set.items.findIndex((item) => item === value);
  if (index < 0) return false;
  set.items.splice(index, 1);
  return true;
}

export function serializableSetContains(
  set: SerializableRuntimeSet,
  value: SerializableRuntimeValue,
): boolean {
  assertSerializableScalar(value);
  return new Set(set.items).has(value);
}

export function serializableEquals(
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
): boolean {
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return left === right;
  if (typeof left !== "object" || typeof right !== "object") return left === right;
  if (left.kind === "speakerReference" && right.kind === "speakerReference") {
    return left.speakerId === right.speakerId;
  }
  throw new SerializableValueError(
    "equality",
    "Equality for object, list, and set values is not accepted in this milestone.",
  );
}

export function validateSerializableValue(
  value: unknown,
  path = "$",
): string | null {
  return captureAndValidateSerializableValue(value, path).failure;
}

interface CapturedSerializableValueResult {
  readonly value: SerializableRuntimeValue | null;
  readonly failure: string | null;
}

function captureAndValidateSerializableValue(
  value: unknown,
  path = "$",
): CapturedSerializableValueResult {
  const capture = captureExternalData(value, path);
  if (!capture.ok) {
    return Object.freeze({
      value: null,
      failure: serializableExternalDataFailureMessage(capture.failure),
    });
  }
  const failure = validateSerializableValueInternal(
    capture.value,
    path,
    new Set<object>(),
  );
  return Object.freeze({
    value: failure === null ? capture.value as SerializableRuntimeValue : null,
    failure,
  });
}

function validateSerializableValueInternal(
  value: unknown,
  path: string,
  active: Set<object>,
): string | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : `${path} must be a finite number.`;
  }
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
    return `${path} is not a JSON-safe runtime value.`;
  }
  if (active.has(value)) return `${path} contains a cyclic runtime value.`;
  active.add(value);
  try {
    if (value.kind === "speakerReference") {
      return Number.isSafeInteger(value.speakerId) &&
        (value.speakerId as number) >= 0 &&
        typeof value.identifier === "string" &&
        value.identifier.length > 0
        ? null
        : `${path} contains a malformed speaker reference.`;
    }
    if (value.kind === "range") {
      return typeof value.start === "number" &&
        Number.isFinite(value.start) &&
        typeof value.end === "number" &&
        Number.isFinite(value.end) &&
        typeof value.inclusive === "boolean"
        ? null
        : `${path} contains a malformed range.`;
    }
    if (value.kind === "list") {
      if (!Array.isArray(value.items)) return `${path}.items must be an array.`;
      return validateValueArray(value.items, `${path}.items`, active);
    }
    if (value.kind === "set") {
      if (!Array.isArray(value.items)) return `${path}.items must be an array.`;
      const seen = new Set<SerializableRuntimeScalar>();
      for (let index = 0; index < value.items.length; index += 1) {
        const item = value.items[index];
        if (!isScalar(item)) return `${path}.items[${index}] is not a scalar.`;
        if (seen.has(item)) return `${path}.items contains a duplicate scalar.`;
        seen.add(item);
      }
      return null;
    }
    if (value.kind === "object") {
      if (!Array.isArray(value.properties)) return `${path}.properties must be an array.`;
      const names = new Set<string>();
      for (let index = 0; index < value.properties.length; index += 1) {
        const property = value.properties[index];
        const propertyPath = `${path}.properties[${index}]`;
        if (
          !isPlainRecord(property) ||
          typeof property.name !== "string" ||
          property.name.length === 0
        ) {
          return `${propertyPath} is malformed.`;
        }
        if (names.has(property.name)) return `${propertyPath}.name is duplicated.`;
        names.add(property.name);
        const failure = validateSerializableValueInternal(
          property.value,
          `${propertyPath}.value`,
          active,
        );
        if (failure !== null) return failure;
      }
      return null;
    }
    return `${path}.kind is unsupported.`;
  } finally {
    active.delete(value);
  }
}

function assertSerializableScalar(
  value: SerializableRuntimeValue,
): asserts value is SerializableRuntimeScalar {
  if (value !== null && typeof value === "object") {
    throw new SerializableValueError(
      "setElement",
      "Sets may contain only string, boolean, integer, number, or null values.",
    );
  }
}

function validateValueArray(
  values: readonly unknown[],
  path: string,
  active: Set<object>,
): string | null {
  for (let index = 0; index < values.length; index += 1) {
    const failure = validateSerializableValueInternal(
      values[index],
      `${path}[${index}]`,
      active,
    );
    if (failure !== null) return failure;
  }
  return null;
}

function serializableCaptureError(
  failure: ExternalDataFailure,
): SerializableValueError {
  const message = serializableExternalDataFailureMessage(failure);
  return new SerializableValueError(
    failure.kind === "cycle" ? "cyclic" : "invalid",
    message,
  );
}

function serializableExternalDataFailureMessage(
  failure: ExternalDataFailure,
): string {
  switch (failure.kind) {
    case "depth":
      return EXTERNAL_DATA_DEPTH_MESSAGE;
    case "work":
      return EXTERNAL_DATA_WORK_MESSAGE;
    case "nonFiniteNumber":
      return `${failure.path} must be a finite number.`;
    case "cycle":
      return `${failure.path} contains a cyclic runtime value.`;
    case "nonJsonSafeValue":
    case "nonPlainObject":
      return `${failure.path} is not a JSON-safe runtime value.`;
  }
}

function isScalar(value: unknown): value is SerializableRuntimeScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
