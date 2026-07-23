export type RuntimeScalar = string | number | boolean | null;

export interface RuntimeList {
  readonly kind: "list";
  readonly items: RuntimeValue[];
}

export interface RuntimeObject {
  readonly kind: "object";
  readonly properties: Map<string, RuntimeValue>;
}

export interface RuntimeSpeaker {
  readonly kind: "speaker";
  readonly identifier: string;
  readonly properties: Map<string, RuntimeValue>;
}

export interface RuntimeSet {
  readonly kind: "set";
  readonly items: RuntimeValue[];
}

export type RuntimeValue =
  | RuntimeScalar
  | RuntimeList
  | RuntimeObject
  | RuntimeSpeaker
  | RuntimeSet;

export class RuntimeEqualityError extends Error {
  public constructor() {
    super(
      "Equality for object, list, and set values is not accepted in this milestone.",
    );
    this.name = "RuntimeEqualityError";
  }
}

export function createRuntimeList(items: readonly RuntimeValue[]): RuntimeList {
  return { kind: "list", items: [...items] };
}

export function createRuntimeObject(
  properties: ReadonlyMap<string, RuntimeValue>,
): RuntimeObject {
  return { kind: "object", properties: new Map(properties) };
}

export function createRuntimeSpeaker(identifier: string): RuntimeSpeaker {
  return { kind: "speaker", identifier, properties: new Map() };
}

export function createRuntimeSet(items: readonly RuntimeValue[]): RuntimeSet {
  const set: RuntimeSet = { kind: "set", items: [] };
  for (const value of items) addSetValue(set, value);
  return set;
}

export function addSetValue(set: RuntimeSet, value: RuntimeValue): boolean {
  if (setContains(set, value)) return false;
  set.items.push(cloneRuntimeValue(value));
  return true;
}

export function removeSetValue(set: RuntimeSet, value: RuntimeValue): boolean {
  const index = findValueIndex(set.items, value);
  if (index < 0) return false;
  set.items.splice(index, 1);
  return true;
}

export function setContains(set: RuntimeSet, value: RuntimeValue): boolean {
  return findValueIndex(set.items, value) >= 0;
}

export function runtimeEquals(
  left: RuntimeValue,
  right: RuntimeValue,
): boolean {
  if (typeof left !== typeof right) return false;
  if (isComposite(left) || isComposite(right)) {
    if (
      typeof left === "object" &&
      left !== null &&
      typeof right === "object" &&
      right !== null &&
      left.kind === "speaker" &&
      right.kind === "speaker"
    ) {
      return left === right;
    }
    throw new RuntimeEqualityError();
  }
  return left === right;
}

export function cloneRuntimeValue(value: RuntimeValue): RuntimeValue {
  if (value === null || typeof value !== "object") return value;
  switch (value.kind) {
    case "speaker":
      return value;
    case "list":
      return createRuntimeList(value.items.map(cloneRuntimeValue));
    case "set":
      return {
        kind: "set",
        items: value.items.map(cloneRuntimeValue),
      };
    case "object":
      return createRuntimeObject(
        new Map(
          [...value.properties].map(
            ([name, item]): [string, RuntimeValue] => [
              name,
              cloneRuntimeValue(item),
            ],
          ),
        ),
      );
  }
}

export function isRuntimeValue(value: unknown): value is RuntimeValue {
  return isRuntimeValueInternal(value, new Set<object>());
}

function isRuntimeValueInternal(
  value: unknown,
  active: Set<object>,
): value is RuntimeValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (active.has(value)) return false;
  active.add(value);
  const candidate = value as Partial<RuntimeList>;
  let valid = false;
  if (candidate.kind === "list" || candidate.kind === "set") {
    valid =
      Array.isArray(candidate.items) &&
      candidate.items.every((item) => isRuntimeValueInternal(item, active));
  } else if (candidate.kind === "object" || candidate.kind === "speaker") {
    const properties = (value as Partial<RuntimeObject>).properties;
    valid =
      properties instanceof Map &&
      [...properties].every(
        ([name, item]) =>
          typeof name === "string" && isRuntimeValueInternal(item, active),
      )
  }
  active.delete(value);
  return valid;
}

function findValueIndex(
  items: readonly RuntimeValue[],
  value: RuntimeValue,
): number {
  for (let index = 0; index < items.length; index += 1) {
    if (runtimeEquals(items[index]!, value)) return index;
  }
  return -1;
}

function isComposite(value: RuntimeValue): value is Exclude<
  RuntimeValue,
  RuntimeScalar
> {
  return typeof value === "object" && value !== null;
}
