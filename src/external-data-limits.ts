export const MAX_EXTERNAL_RUNTIME_DATA_DEPTH = 128;
export const MAX_EXTERNAL_RUNTIME_DATA_WORK = 100_000;

export const EXTERNAL_DATA_DEPTH_MESSAGE =
  "External runtime data exceeds the supported nesting depth.";
export const EXTERNAL_DATA_WORK_MESSAGE =
  "External runtime data exceeds the supported validation-work limit.";

export type ExternalDataFailureKind =
  | "depth"
  | "work"
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

interface PathNode {
  readonly parent: PathNode | null;
  readonly segment: string;
}

interface AssignmentTarget {
  readonly container: unknown[] | Record<string, unknown>;
  readonly key: string;
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
    }
  | {
      readonly kind: "leave";
      readonly value: object;
    };

/**
 * Captures an externally supplied JSON-like graph into stable plain data while
 * enforcing the shared depth/work limits. Enumerable accessors are rejected
 * without invocation. Proxy traps are observed only during this capture; the
 * returned graph retains no proxy, accessor, or prototype behavior.
 */
export function captureExternalData(
  value: unknown,
  rootPath = "$",
): ExternalDataCaptureResult {
  const active = new Set<object>();
  const work: WorkItem[] = [
    { kind: "visit", value, depth: 0, path: null, target: null },
  ];
  let visited = 0;
  let capturedRoot: unknown;

  while (work.length > 0) {
    const item = work.pop()!;
    if (item.kind === "leave") {
      active.delete(item.value);
      continue;
    }

    if (item.kind === "iterate") {
      if (item.index >= item.keys.length) continue;
      work.push({ ...item, index: item.index + 1 });

      const key = item.keys[item.index]!;
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Reflect.getOwnPropertyDescriptor(item.value, key);
      } catch {
        return captureFailure("nonJsonSafeValue", item.path, rootPath);
      }
      if (descriptor === undefined) {
        return captureFailure("nonJsonSafeValue", item.path, rootPath);
      }

      if (item.array && key === "length") {
        if (
          !("value" in descriptor) ||
          typeof descriptor.value !== "number" ||
          !Number.isSafeInteger(descriptor.value) ||
          descriptor.value < 0
        ) {
          return captureFailure("nonJsonSafeValue", item.path, rootPath);
        }
        try {
          Reflect.defineProperty(item.captured, "length", {
            value: descriptor.value,
            writable: true,
            enumerable: false,
            configurable: false,
          });
        } catch {
          return captureFailure("nonJsonSafeValue", item.path, rootPath);
        }
        continue;
      }

      if (!descriptor.enumerable) continue;
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
        target: { container: item.captured, key },
      });
      continue;
    }

    visited += 1;
    if (visited > MAX_EXTERNAL_RUNTIME_DATA_WORK) {
      return captureFailure("work", item.path, rootPath);
    }
    if (item.depth > MAX_EXTERNAL_RUNTIME_DATA_DEPTH) {
      return captureFailure("depth", item.path, rootPath);
    }

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

    let keys: readonly (string | symbol)[];
    try {
      keys = Reflect.ownKeys(current);
    } catch {
      return captureFailure("nonJsonSafeValue", item.path, rootPath);
    }
    if (keys.length > MAX_EXTERNAL_RUNTIME_DATA_WORK + 1) {
      return captureFailure("work", item.path, rootPath);
    }

    const captured = array
      ? []
      : (Object.create(prototype) as Record<string, unknown>);
    assignCaptured(item.target, captured, (root) => {
      capturedRoot = root;
    });

    active.add(current);
    work.push({ kind: "leave", value: current });
    work.push({
      kind: "iterate",
      value: current,
      captured,
      depth: item.depth,
      path: item.path,
      keys,
      index: 0,
      array,
    });
  }

  return Object.freeze({ ok: true, value: capturedRoot });
}

export function findExternalDataFailure(
  value: unknown,
  rootPath = "$",
): ExternalDataFailure | null {
  const capture = captureExternalData(value, rootPath);
  return capture.ok ? null : capture.failure;
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

function formatPath(path: PathNode | null, rootPath: string): string {
  const segments: string[] = [];
  for (let current = path; current !== null; current = current.parent) {
    segments.push(current.segment);
  }
  segments.reverse();
  return `${rootPath}${segments.join("")}`;
}
