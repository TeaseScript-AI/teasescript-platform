import {
  recordValidationTestMaximum,
  recordValidationTestWork,
} from "./validation-testing.js";

export type ExternalDataFailureKind =
  | "nonFiniteNumber"
  | "nonJsonSafeValue"
  | "cycle"
  | "nonPlainObject";

export interface ExternalDataFailure {
  readonly kind: ExternalDataFailureKind;
  readonly path: string;
}

export type ExternalDataCaptureResult =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly failure: ExternalDataFailure;
    };

export interface ExternalDataCaptureOptions {
  readonly freezeCapturedContainers?: boolean;
}

const CAPTURED_ARRAY_PROTOTYPE = createCapturedArrayPrototype();

interface PathNode {
  readonly parent: PathNode | null;
  readonly segment: string;
}

interface AssignmentTarget {
  readonly container: unknown[] | Record<string, unknown>;
  readonly key: string;
  /** Non-null only for a known numeric element of an engine-created array. */
  readonly arrayIndex: number | null;
}

type WorkItem =
  | {
      readonly kind: "visit";
      readonly value: unknown;
      readonly depth: number;
      readonly path: PathNode | null;
      readonly target: AssignmentTarget | null;
    }
  | {
      readonly kind: "iterate";
      readonly value: object;
      readonly captured: unknown[] | Record<string, unknown>;
      readonly depth: number;
      readonly path: PathNode | null;
      readonly keys: readonly (string | symbol)[];
      readonly index: number;
      readonly array: boolean;
      readonly arrayLength: number | null;
    }
  | {
      readonly kind: "leave";
      readonly value: object;
      readonly captured: unknown[] | Record<string, unknown>;
    };

/**
 * Captures an externally supplied JSON-like graph into stable plain data while
 * rejecting accessors, cycles, unsupported values, prototypes, and sparse or
 * otherwise non-canonical arrays. Proxy traps are observed only during this
 * capture; the returned graph retains no caller-controlled proxy, accessor,
 * or prototype behavior.
 */
export function captureExternalData(
  value: unknown,
  rootPath = "$",
  options?: ExternalDataCaptureOptions,
): ExternalDataCaptureResult {
  const active = new Set<object>();
  const work: WorkItem[] = [
    { kind: "visit", value, depth: 0, path: null, target: null },
  ];
  let capturedRoot: unknown;

  while (work.length > 0) {
    const item = work.pop()!;
    if (item.kind === "leave") {
      if (options?.freezeCapturedContainers) Object.freeze(item.captured);
      active.delete(item.value);
      continue;
    }

    if (item.kind === "iterate") {
      if (item.index >= item.keys.length) {
        if (item.array && item.captured.length !== item.arrayLength) {
          return captureFailure("nonJsonSafeValue", item.path, rootPath);
        }
        continue;
      }
      work.push({ ...item, index: item.index + 1 });

      const key = item.keys[item.index]!;
      if (item.array && key === "length") continue;

      recordValidationTestWork("externalCaptureDescriptors");

      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Reflect.getOwnPropertyDescriptor(item.value, key);
      } catch {
        return captureFailure("nonJsonSafeValue", item.path, rootPath);
      }
      if (descriptor === undefined) {
        return captureFailure("nonJsonSafeValue", item.path, rootPath);
      }

      let arrayIndex: number | null = null;
      if (item.array && typeof key === "string") {
        arrayIndex = canonicalArrayIndex(key);
        if (arrayIndex === null) {
          return captureFailure("nonJsonSafeValue", item.path, rootPath);
        } else if (arrayIndex >= item.arrayLength!) {
          return captureFailure("nonJsonSafeValue", item.path, rootPath);
        }
      }

      if (!descriptor.enumerable) {
        if (item.array) {
          return captureFailure("nonJsonSafeValue", item.path, rootPath);
        }
        continue;
      }
      if (typeof key === "symbol") {
        return captureFailure("nonJsonSafeValue", item.path, rootPath);
      }

      const nestedPath: PathNode = {
        parent: item.path,
        segment: pathSegment(item.array, key),
      };
      if (!("value" in descriptor)) {
        return captureFailure("nonJsonSafeValue", nestedPath, rootPath);
      }

      work.push({
        kind: "visit",
        value: descriptor.value,
        depth: item.depth + 1,
        path: nestedPath,
        target: { container: item.captured, key, arrayIndex },
      });
      continue;
    }

    recordValidationTestWork("externalCaptureVisits");
    recordValidationTestMaximum("externalCaptureMaximumDepth", item.depth);

    const current = item.value;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      assignCaptured(item.target, current, (captured) => {
        capturedRoot = captured;
      });
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        return captureFailure("nonFiniteNumber", item.path, rootPath);
      }
      assignCaptured(item.target, current, (captured) => {
        capturedRoot = captured;
      });
      continue;
    }
    if (typeof current !== "object") {
      return captureFailure("nonJsonSafeValue", item.path, rootPath);
    }
    if (active.has(current)) {
      return captureFailure("cycle", item.path, rootPath);
    }

    let array: boolean;
    try {
      array = Array.isArray(current);
    } catch {
      return captureFailure("nonJsonSafeValue", item.path, rootPath);
    }

    let prototype: object | null = null;
    if (!array) {
      try {
        prototype = Reflect.getPrototypeOf(current);
      } catch {
        return captureFailure("nonJsonSafeValue", item.path, rootPath);
      }
      if (prototype !== Object.prototype && prototype !== null) {
        return captureFailure("nonPlainObject", item.path, rootPath);
      }
    }

    let arrayLength: number | null = null;
    if (array) {
      let lengthDescriptor: PropertyDescriptor | undefined;
      try {
        lengthDescriptor = Reflect.getOwnPropertyDescriptor(current, "length");
      } catch {
        return captureFailure("nonJsonSafeValue", item.path, rootPath);
      }
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        return captureFailure("nonJsonSafeValue", item.path, rootPath);
      }
      arrayLength = lengthDescriptor.value;
    }

    let keys: readonly (string | symbol)[];
    try {
      keys = Reflect.ownKeys(current);
    } catch {
      return captureFailure("nonJsonSafeValue", item.path, rootPath);
    }
    if (array && keys.length !== arrayLength! + 1) {
      return captureFailure("nonJsonSafeValue", item.path, rootPath);
    }
    const captured = array
      ? createCapturedArray(arrayLength!)
      : (Object.create(prototype) as Record<string, unknown>);
    assignCaptured(item.target, captured, (root) => {
      capturedRoot = root;
    });

    active.add(current);
    work.push({ kind: "leave", value: current, captured });
    work.push({
      kind: "iterate",
      value: current,
      captured,
      depth: item.depth,
      path: item.path,
      keys,
      index: 0,
      array,
      arrayLength,
    });
  }

  return Object.freeze({ ok: true, value: capturedRoot });
}

function assignCaptured(
  target: AssignmentTarget | null,
  value: unknown,
  setRoot: (value: unknown) => void,
): void {
  if (target === null) {
    setRoot(value);
    return;
  }
  if (target.arrayIndex !== null) {
    (target.container as unknown[])[target.arrayIndex] = value;
    return;
  }
  Reflect.defineProperty(target.container, target.key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function captureFailure(
  kind: ExternalDataFailureKind,
  path: PathNode | null,
  rootPath: string,
): ExternalDataCaptureResult {
  return Object.freeze({
    ok: false,
    failure: Object.freeze({ kind, path: formatPath(path, rootPath) }),
  });
}

function pathSegment(parentIsArray: boolean, key: string): string {
  if (parentIsArray && /^(0|[1-9]\d*)$/.test(key)) {
    return `[${key}]`;
  }
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `.${key}`
    : `[${JSON.stringify(key)}]`;
}

export function createCapturedArray(length: number): unknown[] {
  const captured = new Array<unknown>(length);
  Object.setPrototypeOf(captured, CAPTURED_ARRAY_PROTOTYPE);
  return captured;
}

function createCapturedArrayPrototype(): object {
  const prototype = Object.create(null) as object;
  for (const key of Reflect.ownKeys(Array.prototype)) {
    if (typeof key === "string" && canonicalArrayIndex(key) !== null) continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(Array.prototype, key);
    if (descriptor !== undefined) {
      Reflect.defineProperty(prototype, key, descriptor);
    }
  }
  return Object.freeze(prototype);
}

function canonicalArrayIndex(key: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(key)) return null;
  const index = Number(key);
  return Number.isSafeInteger(index) && index < 0xffff_ffff ? index : null;
}

function formatPath(path: PathNode | null, rootPath: string): string {
  const segments: string[] = [];
  for (let current = path; current !== null; current = current.parent) {
    segments.push(current.segment);
  }
  segments.reverse();
  return `${rootPath}${segments.join("")}`;
}
