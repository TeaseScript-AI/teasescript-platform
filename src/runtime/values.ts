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
  readonly items: RuntimeScalar[];
}

export type RuntimeValue =
  | RuntimeScalar
  | RuntimeList
  | RuntimeObject
  | RuntimeSpeaker
  | RuntimeSet;

export type RuntimeValueValidationFailure =
  | "cyclic"
  | "invalid"
  | "setElement";

export class RuntimeCopyError extends Error {
  public constructor() {
    super("Cyclic script values are not supported.");
    this.name = "RuntimeCopyError";
  }
}

export class RuntimeEqualityError extends Error {
  public constructor() {
    super(
      "Equality for object, list, and set values is not accepted in this milestone.",
    );
    this.name = "RuntimeEqualityError";
  }
}

export class RuntimeSetElementError extends Error {
  public constructor() {
    super("Sets may contain only string, boolean, integer, number, or null values.");
    this.name = "RuntimeSetElementError";
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
  assertSetElement(value);
  if (setContains(set, value)) return false;
  set.items.push(value);
  return true;
}

export function removeSetValue(set: RuntimeSet, value: RuntimeValue): boolean {
  assertSetElement(value);
  const index = findValueIndex(set.items, value);
  if (index < 0) return false;
  set.items.splice(index, 1);
  return true;
}

export function setContains(set: RuntimeSet, value: RuntimeValue): boolean {
  assertSetElement(value);
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
  return cloneRuntimeValueInternal(value, new Set<object>());
}

export function validateRuntimeValue(
  value: unknown,
): RuntimeValueValidationFailure | null {
  return validateRuntimeValueInternal(value, new Set<object>());
}

export function isRuntimeValue(value: unknown): value is RuntimeValue {
  return validateRuntimeValue(value) === null;
}

function cloneRuntimeValueInternal(
  value: RuntimeValue,
  active: Set<object>,
): RuntimeValue {
  if (value === null || typeof value !== "object") return value;
  if (value.kind === "speaker") return value;
  if (active.has(value)) throw new RuntimeCopyError();

  active.add(value);
  try {
    switch (value.kind) {
      case "list":
        return createRuntimeList(
          value.items.map((item) => cloneRuntimeValueInternal(item, active)),
        );
      case "set":
        return createRuntimeSet(value.items);
      case "object":
        return createRuntimeObject(
          new Map(
            [...value.properties].map(
              ([name, item]): [string, RuntimeValue] => [
                name,
                cloneRuntimeValueInternal(item, active),
              ],
            ),
          ),
        );
    }
  } finally {
    active.delete(value);
  }
}

function validateRuntimeValueInternal(
  value: unknown,
  active: Set<object>,
): RuntimeValueValidationFailure | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : "invalid";
  }
  if (typeof value !== "object") return "invalid";
  if (active.has(value)) return "cyclic";

  active.add(value);
  try {
    const candidate = value as Partial<RuntimeList>;
    if (candidate.kind === "list") {
      if (!Array.isArray(candidate.items)) return "invalid";
      return validateValues(candidate.items, active);
    }
    if (candidate.kind === "set") {
      if (!Array.isArray(candidate.items)) return "invalid";
      for (const item of candidate.items) {
        if (item !== null && typeof item === "object") return "setElement";
        const failure = validateRuntimeValueInternal(item, active);
        if (failure !== null) return failure;
      }
      return null;
    }
    if (candidate.kind === "object" || candidate.kind === "speaker") {
      const properties = (value as Partial<RuntimeObject>).properties;
      if (!(properties instanceof Map)) return "invalid";
      for (const [name, item] of properties) {
        if (typeof name !== "string") return "invalid";
        const failure = validateRuntimeValueInternal(item, active);
        if (failure !== null) return failure;
      }
      return null;
    }
    return "invalid";
  } finally {
    active.delete(value);
  }
}

function validateValues(
  values: readonly unknown[],
  active: Set<object>,
): RuntimeValueValidationFailure | null {
  for (const value of values) {
    const failure = validateRuntimeValueInternal(value, active);
    if (failure !== null) return failure;
  }
  return null;
}

function assertSetElement(value: RuntimeValue): asserts value is RuntimeScalar {
  if (value !== null && typeof value === "object") {
    throw new RuntimeSetElementError();
  }
}

function findValueIndex(
  items: readonly RuntimeScalar[],
  value: RuntimeScalar,
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
