import type { InstructionPlan } from "../../plan/model.js";
import { GLOBAL_SCOPE_ID } from "../scopes/prepared-references.js";
import type { RuntimeBindingSnapshot, RuntimeSnapshot } from "../snapshot/state.js";
import { findRoot, findScope } from "../scopes/activations.js";

// Which binding a name refers to, and the index that finds it in a large frame.

/**
 * The binding `name` refers to: in the scopes of the running function, or of the root; then for a timer, media, or
 * button block, among the variables it shares with the code that created it (V30 §14); then for a function that is not
 * global, in the root scope of its file; then among the session's globals (ADR 0022 §3, §6).
 */
export function findBinding(
  snapshot: RuntimeSnapshot,
  plan: InstructionPlan,
  name: string,
): RuntimeBindingSnapshot | undefined {
  return findBindingLocation(snapshot, plan, name)?.binding;
}

/** The ID of the scope that `name` refers to, as `findBinding` finds it; `GLOBAL_SCOPE_ID` for a global. */
export function bindingScopeId(
  snapshot: RuntimeSnapshot,
  plan: InstructionPlan,
  name: string,
): number | undefined {
  return findBindingLocation(snapshot, plan, name)?.frame.id;
}

export function findBindingLocation(
  snapshot: RuntimeSnapshot,
  plan: InstructionPlan,
  name: string,
):
  | {
      readonly frame: { readonly id: number; readonly bindings: readonly RuntimeBindingSnapshot[] };
      readonly binding: RuntimeBindingSnapshot;
    }
  | undefined {
  // Code at a file's top level sees its blocks down to its activation's root; a function or block sees its own
  // scopes, then the root of the activation it runs for (ADR 0022 §5).
  const top = snapshot.callFrames.at(-1);
  const minimum = top === undefined ? 0 : top.scopeBaseDepth;
  for (let index = snapshot.frames.length - 1; index >= minimum; index -= 1) {
    const frame = snapshot.frames[index]!;
    const binding = frameBinding(frame.bindings, name);
    if (binding !== undefined) return { frame, binding };
  }
  if (top?.kind === "function" && top.captures.length > 0) {
    const capture = top.captures.find((candidate) => candidate.name === name);
    if (capture !== undefined) {
      const frame = findScope(snapshot, capture.scopeId)!;
      return { frame, binding: frameBinding(frame.bindings, name)! };
    }
  }
  // A function sees the root of the activation it runs for; a global function sees only globals (ADR 0022 §5, §6).
  if (top?.kind === "function" && plan.functions[top.functionId - 1]?.global !== true) {
    const frame = findRoot(snapshot, top.rootScopeId)!;
    const binding = frameBinding(frame.bindings, name);
    if (binding !== undefined) return { frame, binding };
  }
  const binding = frameBinding(snapshot.globals, name);
  return binding === undefined
    ? undefined
    : { frame: { id: GLOBAL_SCOPE_ID, bindings: snapshot.globals }, binding };
}

/** Frames up to this size are scanned; larger frames are looked up through a name index. */
const INDEXED_FRAME_MIN_BINDINGS = 16;

/**
 * Name indexes of large frames, keyed by the frame's bindings array. A frame's bindings are only ever appended and
 * their names never change, so an index extends itself when its frame has grown. A captured or deeply staged
 * snapshot has new arrays and builds its own index. The index is derived data: it finds the same first binding as a
 * scan.
 */
const frameBindingIndexes = new WeakMap<
  readonly RuntimeBindingSnapshot[],
  { indexed: number; readonly byName: Map<string, RuntimeBindingSnapshot> }
>();

function frameBinding(
  bindings: readonly RuntimeBindingSnapshot[],
  name: string,
): RuntimeBindingSnapshot | undefined {
  if (bindings.length <= INDEXED_FRAME_MIN_BINDINGS) {
    return bindings.find((item) => item.name === name);
  }
  let index = frameBindingIndexes.get(bindings);
  if (index === undefined) {
    index = { indexed: 0, byName: new Map() };
    frameBindingIndexes.set(bindings, index);
  }
  for (; index.indexed < bindings.length; index.indexed += 1) {
    const binding = bindings[index.indexed]!;
    if (!index.byName.has(binding.name)) index.byName.set(binding.name, binding);
  }
  return index.byName.get(name);
}
