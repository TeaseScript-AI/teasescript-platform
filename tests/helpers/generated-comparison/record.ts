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
 * Whether `value` is a dense array with no other own keys, or an object with no symbol keys whose prototype is an
 * `Object.prototype` or `null`. An object's prototype is judged by the depth of its chain, not by identity: a
 * snapshot's arrays and objects need not have this realm's prototypes.
 */
function isPlainContainer(value: object): boolean {
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1)
      if (!Object.hasOwn(value, index)) return false;
    return true;
  }
  return prototypeDepth(value) <= 1 && Object.getOwnPropertySymbols(value).length === 0;
}

/** How many prototypes stand between `value` and the end of its chain: 1 for a plain object, more for a class's. */
function prototypeDepth(value: object): number {
  let depth = 0;
  for (
    let at: object | null = Object.getPrototypeOf(value);
    at !== null;
    at = Object.getPrototypeOf(at)
  )
    depth += 1;
  return depth;
}

function describe(value: unknown): string {
  if (typeof value !== "object" || value === null) return typeof value;
  return Array.isArray(value)
    ? "an array with holes or other keys"
    : (value.constructor?.name ?? "an object");
}
