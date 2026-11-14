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

/**
 * The record without the interpreter's place. Plan block IDs (`handlerFunctionId`, cues' `functionId`,
 * `finishFunctionId`) stay: they name blocks, so routing to another block differs. Script values never meet a removed
 * key, since object properties and dict keys are data (`properties[].name`, `entries[].key`). The projected
 * `interactionResultHandoff` is `{ actionKind, actionId, result }`, the result an answer leaves for its instruction.
 */
export function projectRecord(record: SideRecord): unknown {
  return {
    outcome: project(record.outcome, false),
    events: project(record.events, false),
    state: project(record.snapshot, true),
    interrupt: { action: project(record.interrupt.action, false), atMs: record.interrupt.atMs },
  };
}

/** A projected copy, built without recursion on the JavaScript call stack, so deep values do not exhaust it. */
function project(value: unknown, topLevel: boolean): unknown {
  if (value === null || typeof value !== "object") return value;
  const root: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
  const work: Array<readonly [object, unknown[] | Record<string, unknown>, boolean]> = [
    [value, root, topLevel],
  ];
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
      let copied: unknown = item;
      if (item !== null && typeof item === "object") {
        copied = Array.isArray(item) ? [] : {};
        work.push([item, copied as unknown[] | Record<string, unknown>, false]);
      }
      if (Array.isArray(into)) into.push(copied);
      else into[key] = copied;
    }
  }
  return root;
}
