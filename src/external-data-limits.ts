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

interface PathNode {
  readonly parent: PathNode | null;
  readonly segment: string;
}

type WorkItem =
  | {
      readonly kind: "visit";
      readonly value: unknown;
      readonly depth: number;
      readonly path: PathNode | null;
    }
  | {
      readonly kind: "iterate";
      readonly value: object;
      readonly depth: number;
      readonly path: PathNode | null;
      readonly keys: Iterator<string>;
    }
  | {
      readonly kind: "leave";
      readonly value: object;
    };

export function findExternalDataFailure(
  value: unknown,
  rootPath = "$",
): ExternalDataFailure | null {
  const active = new Set<object>();
  const work: WorkItem[] = [
    { kind: "visit", value, depth: 0, path: null },
  ];
  let visited = 0;

  while (work.length > 0) {
    const item = work.pop()!;
    if (item.kind === "leave") {
      active.delete(item.value);
      continue;
    }
    if (item.kind === "iterate") {
      let next: IteratorResult<string>;
      try {
        next = item.keys.next();
      } catch {
        return failure("nonJsonSafeValue", item.path, rootPath);
      }
      if (next.done) continue;
      work.push(item);
      const key = next.value;
      let nested: unknown;
      try {
        nested = (item.value as Record<string, unknown>)[key];
      } catch {
        return failure("nonJsonSafeValue", item.path, rootPath);
      }
      work.push({
        kind: "visit",
        value: nested,
        depth: item.depth + 1,
        path: {
          parent: item.path,
          segment: pathSegment(item.value, key),
        },
      });
      continue;
    }

    visited += 1;
    if (visited > MAX_EXTERNAL_RUNTIME_DATA_WORK) {
      return failure("work", item.path, rootPath);
    }
    if (item.depth > MAX_EXTERNAL_RUNTIME_DATA_DEPTH) {
      return failure("depth", item.path, rootPath);
    }

    const current = item.value;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        return failure("nonFiniteNumber", item.path, rootPath);
      }
      continue;
    }
    if (typeof current !== "object") {
      return failure("nonJsonSafeValue", item.path, rootPath);
    }
    if (active.has(current)) {
      return failure("cycle", item.path, rootPath);
    }
    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(current);
    } catch {
      return failure("nonJsonSafeValue", item.path, rootPath);
    }
    if (
      !Array.isArray(current) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      return failure("nonPlainObject", item.path, rootPath);
    }

    active.add(current);
    work.push({ kind: "leave", value: current });
    work.push({
      kind: "iterate",
      value: current,
      depth: item.depth,
      path: item.path,
      keys: enumerableOwnKeys(current),
    });
  }

  return null;
}

function* enumerableOwnKeys(value: object): Generator<string> {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) yield key;
  }
}

function failure(
  kind: ExternalDataFailureKind,
  path: PathNode | null,
  rootPath: string,
): ExternalDataFailure {
  return Object.freeze({ kind, path: formatPath(path, rootPath) });
}

function pathSegment(parent: object, key: string): string {
  if (Array.isArray(parent) && /^(0|[1-9]\d*)$/.test(key)) {
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
