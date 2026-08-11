import {
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
  return captured.value!;
}

/** Clones already captured/validated engine data without a second validation pass. */
export function cloneCapturedSerializableValue(
  value: SerializableRuntimeValue,
): SerializableRuntimeValue {
  if (isScalar(value)) return value;
  const root = cloneSerializableNode(value);
  if (value.kind !== "list" && value.kind !== "object") return root;

  type CompositeValue = SerializableRuntimeList | SerializableRuntimeObject;
  const work: Array<readonly [CompositeValue, CompositeValue]> = [[
    value,
    root as CompositeValue,
  ]];
  while (work.length > 0) {
    const [source, target] = work.pop()!;
    if (source.kind === "list") {
      const targetItems = (target as SerializableRuntimeList).items;
      for (let index = 0; index < source.items.length; index += 1) {
        const nested = source.items[index]!;
        const cloned = cloneSerializableNode(nested);
        targetItems[index] = cloned;
        if (typeof nested === "object" && nested !== null &&
          (nested.kind === "list" || nested.kind === "object")) {
          work.push([nested, cloned as CompositeValue]);
        }
      }
      continue;
    }
    const targetProperties = (target as SerializableRuntimeObject).properties;
    for (let index = 0; index < source.properties.length; index += 1) {
      const property = source.properties[index]!;
      const cloned = cloneSerializableNode(property.value);
      targetProperties[index] = { name: property.name, value: cloned };
      const nested = property.value;
      if (typeof nested === "object" && nested !== null &&
        (nested.kind === "list" || nested.kind === "object")) {
        work.push([nested, cloned as CompositeValue]);
      }
    }
  }
  return root;
}

function cloneSerializableNode(
  value: SerializableRuntimeValue,
): SerializableRuntimeValue {
  if (isScalar(value)) return value;
  switch (value.kind) {
    case "range":
      return { ...value };
    case "speakerReference":
      return { ...value };
    case "set":
      return { kind: "set", items: [...value.items] };
    case "list":
      return { kind: "list", items: new Array(value.items.length) };
    case "object":
      return { kind: "object", properties: new Array(value.properties.length) };
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

/** Validates data that has already passed stable external capture. */
export function validateCapturedSerializableValue(
  value: unknown,
  path = "$",
): string | null {
  return validateSerializableValueInternal(value, path);
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
  );
  return Object.freeze({
    value: failure === null ? capture.value as SerializableRuntimeValue : null,
    failure,
  });
}

function validateSerializableValueInternal(
  value: unknown,
  rootPath: string,
): string | null {
  interface ValuePath {
    readonly parent: ValuePath | null;
    readonly segment: string;
  }
  type ValidationWork =
    | { readonly kind: "value"; readonly value: unknown; readonly path: ValuePath | null }
    | {
        readonly kind: "list";
        readonly values: readonly unknown[];
        readonly index: number;
        readonly path: ValuePath | null;
      }
    | {
        readonly kind: "object";
        readonly properties: readonly unknown[];
        readonly index: number;
        readonly names: Set<string>;
        readonly path: ValuePath | null;
      }
    | { readonly kind: "leave"; readonly value: object };

  const active = new Set<object>();
  const work: ValidationWork[] = [{ kind: "value", value, path: null }];
  const nestedPath = (parent: ValuePath | null, segment: string): ValuePath => ({ parent, segment });
  const formatPath = (path: ValuePath | null): string => {
    const segments: string[] = [];
    for (let current = path; current !== null; current = current.parent) {
      segments.push(current.segment);
    }
    return `${rootPath}${segments.reverse().join("")}`;
  };

  while (work.length > 0) {
    const item = work.pop()!;
    if (item.kind === "leave") {
      active.delete(item.value);
      continue;
    }
    if (item.kind === "list") {
      if (item.index >= item.values.length) continue;
      work.push({ ...item, index: item.index + 1 });
      work.push({
        kind: "value",
        value: item.values[item.index],
        path: nestedPath(item.path, `.items[${item.index}]`),
      });
      continue;
    }
    if (item.kind === "object") {
      if (item.index >= item.properties.length) continue;
      const property = item.properties[item.index];
      const propertyPath = nestedPath(item.path, `.properties[${item.index}]`);
      if (!isPlainRecord(property) || typeof property.name !== "string" || property.name.length === 0) {
        return `${formatPath(propertyPath)} is malformed.`;
      }
      if (item.names.has(property.name)) return `${formatPath(propertyPath)}.name is duplicated.`;
      item.names.add(property.name);
      work.push({ ...item, index: item.index + 1 });
      work.push({
        kind: "value",
        value: property.value,
        path: nestedPath(propertyPath, ".value"),
      });
      continue;
    }

    const current = item.value;
    const path = (): string => formatPath(item.path);
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return `${path()} must be a finite number.`;
      continue;
    }
    if (!isPlainRecord(current) || typeof current.kind !== "string") {
      return `${path()} is not a JSON-safe runtime value.`;
    }
    if (active.has(current)) return `${path()} contains a cyclic runtime value.`;

    if (current.kind === "speakerReference") {
      if (
        !Number.isSafeInteger(current.speakerId) ||
        (current.speakerId as number) < 0 ||
        typeof current.identifier !== "string" ||
        current.identifier.length === 0
      ) return `${path()} contains a malformed speaker reference.`;
      continue;
    }
    if (current.kind === "range") {
      if (
        typeof current.start !== "number" ||
        !Number.isFinite(current.start) ||
        typeof current.end !== "number" ||
        !Number.isFinite(current.end) ||
        typeof current.inclusive !== "boolean"
      ) return `${path()} contains a malformed range.`;
      continue;
    }
    if (current.kind === "set") {
      if (!Array.isArray(current.items)) return `${path()}.items must be an array.`;
      const seen = new Set<SerializableRuntimeScalar>();
      for (let index = 0; index < current.items.length; index += 1) {
        const nested = current.items[index];
        if (!isScalar(nested)) return `${path()}.items[${index}] is not a scalar.`;
        if (seen.has(nested)) return `${path()}.items contains a duplicate scalar.`;
        seen.add(nested);
      }
      continue;
    }
    if (current.kind === "list") {
      if (!Array.isArray(current.items)) return `${path()}.items must be an array.`;
      active.add(current);
      work.push({ kind: "leave", value: current });
      work.push({ kind: "list", values: current.items, index: 0, path: item.path });
      continue;
    }
    if (current.kind === "object") {
      if (!Array.isArray(current.properties)) return `${path()}.properties must be an array.`;
      active.add(current);
      work.push({ kind: "leave", value: current });
      work.push({ kind: "object", properties: current.properties, index: 0, names: new Set(), path: item.path });
      continue;
    }
    return `${path()}.kind is unsupported.`;
  }
  return null;
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
