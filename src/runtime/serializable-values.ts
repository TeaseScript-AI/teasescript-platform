import type { RuntimeValue } from "./values.js";
import {
  createRuntimeList,
  createRuntimeObject,
  createRuntimeSet,
  createRuntimeSpeaker,
} from "./values.js";

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
  return { kind: "list", items: items.map(cloneSerializableValue) };
}

export function createSerializableObject(
  properties: readonly SerializableRuntimeProperty[],
): SerializableRuntimeObject {
  return {
    kind: "object",
    properties: properties.map((property) => ({
      name: property.name,
      value: cloneSerializableValue(property.value),
    })),
  };
}

export function createSerializableSet(
  items: readonly SerializableRuntimeValue[],
): SerializableRuntimeSet {
  const set: SerializableRuntimeSet = { kind: "set", items: [] };
  for (const item of items) addSerializableSetValue(set, item);
  return set;
}

export function cloneSerializableValue(
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
      return { kind: "list", items: value.items.map(cloneSerializableValue) };
    case "set":
      return { kind: "set", items: [...value.items] };
    case "object":
      return {
        kind: "object",
        properties: value.properties.map((property) => ({
          name: property.name,
          value: cloneSerializableValue(property.value),
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
): boolean {
  assertSerializableScalar(value);
  if (set.items.some((item) => item === value)) return false;
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
  return set.items.some((item) => item === value);
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

export function fromHostRuntimeValue(value: RuntimeValue): SerializableRuntimeValue {
  return fromHostValueInternal(value, new Set<object>());
}

export function toHostRuntimeValue(value: SerializableRuntimeValue): RuntimeValue {
  if (value === null || typeof value !== "object") return value;
  switch (value.kind) {
    case "range":
      throw new SerializableValueError(
        "invalid",
        "Legacy host runtime values do not support ranges.",
      );
    case "list":
      return createRuntimeList(value.items.map(toHostRuntimeValue));
    case "set":
      return createRuntimeSet(value.items);
    case "object":
      return createRuntimeObject(
        new Map(
          value.properties.map((property) => [
            property.name,
            toHostRuntimeValue(property.value),
          ]),
        ),
      );
    case "speakerReference":
      return createRuntimeSpeaker(value.identifier);
  }
}

export function validateSerializableValue(
  value: unknown,
  path = "$",
): string | null {
  return validateSerializableValueInternal(value, path, new Set<object>());
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
    return Number.isInteger(value.speakerId) &&
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
    const seen: SerializableRuntimeScalar[] = [];
    for (let index = 0; index < value.items.length; index += 1) {
      const item = value.items[index];
      if (!isScalar(item)) return `${path}.items[${index}] is not a scalar.`;
      if (seen.some((seenItem) => seenItem === item)) {
        return `${path}.items contains a duplicate scalar.`;
      }
      seen.push(item);
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

function fromHostValueInternal(
  value: RuntimeValue,
  active: Set<object>,
): SerializableRuntimeValue {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new SerializableValueError("invalid", "Runtime numbers must be finite.");
    }
    return value;
  }
  if (active.has(value)) {
    throw new SerializableValueError("cyclic", "Cyclic script values are not supported.");
  }
  active.add(value);
  try {
    switch (value.kind) {
      case "speaker":
        return {
          kind: "speakerReference",
          speakerId: 0,
          identifier: value.identifier,
        };
      case "list":
        return {
          kind: "list",
          items: value.items.map((item) => fromHostValueInternal(item, active)),
        };
      case "set":
        return createSerializableSet(
          value.items.map((item) => fromHostValueInternal(item, active)),
        );
      case "object":
        return {
          kind: "object",
          properties: [...value.properties].map(([name, item]) => ({
            name,
            value: fromHostValueInternal(item, active),
          })),
        };
    }
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
