import type { RuntimeSnapshot } from "../../../src/runtime/snapshot/state.js";

/**
 * What both sides give after an operation: its semantic outcome (`null` for `run`) and events, and the state in today's
 * snapshot shape with the block a running expiry block suspended. The session result's execution count and instruction
 * trace are the interpreter's, so no side gives them.
 */
export interface SideRecord {
  readonly outcome: unknown;
  readonly events: readonly unknown[];
  readonly snapshot: RuntimeSnapshot;
  /** `view()`'s `suspendedAction` and `suspendedAtMs`, which live in the call frames the projection drops. */
  readonly interrupt: { readonly action: unknown; readonly atMs: number | null };
}

/**
 * Where today's interpreter keeps its own place, which generated code does not have. The projection removes these and
 * nothing else, so a field nobody listed is compared.
 */
const INTERPRETER_TOP_LEVEL = new Set([
  "nextInstruction",
  "frames",
  "loopFrames",
  "temporaries",
  "callFrames",
  "retainedScopes",
  "nextScopeId",
  "nextCallFrameId",
  // A known hole until S5, when generated code keeps globals in today's form (README).
  "globals",
]);
const INTERPRETER_ANY_RECORD = new Set([
  "owningInstruction",
  "continuationInstruction",
  "ownerCallFrameId",
  "scopeDepth",
  "loopDepth",
  "rootScopeId",
  "destinationTemporary",
  "captures",
]);
/** Only in a media record, which `mediaId` and `cues` mark. */
const INTERPRETER_MEDIA = "handlerRootScopeId";

/** Plain data, as the projection copies it. */
export type PlainData =
  null | boolean | number | string | PlainData[] | { [key: string]: PlainData };

export interface ProjectedRecord {
  readonly outcome: PlainData;
  readonly events: PlainData;
  readonly state: PlainData;
  readonly interrupt: { readonly action: PlainData; readonly atMs: number | null };
}

/**
 * The record without the interpreter's place. Plan block IDs (`handlerFunctionId`, cues' `functionId`,
 * `finishFunctionId`) stay: they name blocks, so routing to another block differs. Script values never meet a removed
 * key, since object properties and dict keys are data (`properties[].name`, `entries[].key`). The projected
 * `interactionResultHandoff` is `{ actionKind, actionId, result }`, the result an answer leaves for its instruction.
 */
export function projectRecord(record: SideRecord): ProjectedRecord {
  return {
    outcome: project(record.outcome, false),
    events: project(record.events, false),
    state: project(record.snapshot, true),
    interrupt: { action: project(record.interrupt.action, false), atMs: record.interrupt.atMs },
  };
}

type Container = PlainData[] | { [key: string]: PlainData };

/** A projected copy, built without recursion on the JavaScript call stack, so deep values do not exhaust it. */
function project(value: unknown, topLevel: boolean): PlainData {
  const work: Array<readonly [object, Container, boolean]> = [];
  const root = shell(value, topLevel, work);
  while (work.length > 0) {
    const [from, into, top] = work.pop()!;
    const media = !Array.isArray(from) && "mediaId" in from && "cues" in from;
    for (const [key, item] of Object.entries(from)) {
      if (
        !Array.isArray(from) &&
        (INTERPRETER_ANY_RECORD.has(key) ||
          (top && INTERPRETER_TOP_LEVEL.has(key)) ||
          (media && key === INTERPRETER_MEDIA))
      )
        continue;
      const copied = shell(item, false, work);
      if (Array.isArray(into)) into.push(copied);
      // Defined, not assigned, so that a key such as `__proto__` stays an own key and is compared.
      else
        Object.defineProperty(into, key, {
          value: copied,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
  }
  return root;
}

/**
 * `value` as it is when it holds nothing, else an empty copy queued on `work` to be filled. Plain data is `null`, text,
 * numbers, booleans, and the containers `isPlainContainer` admits. Anything else (`undefined`, a function, a sparse
 * array, a class instance, a `Map`, a `Date`, ...) is a defect of the side that gave it, not something to compare.
 */
function shell(
  value: unknown,
  top: boolean,
  work: Array<readonly [object, Container, boolean]>,
): PlainData {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (typeof value !== "object" || !isPlainContainer(value))
    throw new TypeError(`A compared record holds a value outside plain data (${describe(value)}).`);
  const copy: Container = Array.isArray(value) ? [] : {};
  work.push([value, copy, top]);
  return copy;
}

/**
 * Whether `value` is a container of plain data: an array (of any prototype, as the engine's own capture admits its
 * arrays) whose own keys are exactly its indices and `length`, or an object whose prototype is `Object.prototype` or
 * `null` and whose own keys are all text. Every element and property must be an enumerable data property, so that the
 * copy, which reads them all, holds everything the container holds.
 */
function isPlainContainer(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (keys.length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1)
      if (!isPlainProperty(Reflect.getOwnPropertyDescriptor(value, String(index)))) return false;
    return true;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return keys.every(
    (key) =>
      typeof key === "string" && isPlainProperty(Reflect.getOwnPropertyDescriptor(value, key)),
  );
}

function isPlainProperty(descriptor: PropertyDescriptor | undefined): boolean {
  return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor;
}

function describe(value: unknown): string {
  if (typeof value !== "object" || value === null) return typeof value;
  if (Array.isArray(value))
    return "an array with holes, other keys, or hidden or accessor elements";
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? "an object with symbol keys, or hidden or accessor properties"
    : "an object of another prototype";
}
