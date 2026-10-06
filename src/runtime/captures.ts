import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan } from "../source.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
import type { RuntimeSnapshot } from "./state.js";

/*
 * Shared variables of blocks (V30 §14). A timer expiry block, media block, or permanent button block uses the
 * function, loop, and block variables of the code that created it as that code does: one variable, not a copy. When
 * the resource is created, each name its blocks use is resolved to the scope that holds it. The resource, each of its
 * queued blocks, and its running block record those scopes by ID. A scope stays where it is while its code runs; when
 * that code leaves it, the scope moves to the retained scopes if a resource or queued block still uses it, and it goes
 * once nothing does. Each scope exists once, so every user of a variable sees its current value.
 */

/** A variable that a block shares with the code that created it: its name and the scope that holds it. */
export interface RuntimeCaptureSnapshot {
  readonly name: string;
  readonly scopeId: number;
}

export function cloneCaptures(
  captures: readonly RuntimeCaptureSnapshot[],
): RuntimeCaptureSnapshot[] {
  return captures.map((capture) => ({ name: capture.name, scopeId: capture.scopeId }));
}

/**
 * The variables a resource being created shares, by name: in the scopes of the running code down to its function or
 * activation root, then those the running block itself shares.
 */
export function resolveCaptures(
  snapshot: RuntimeSnapshot,
  names: readonly string[],
  span: SourceSpan | PlanSourceLocation,
): RuntimeCaptureSnapshot[] {
  if (names.length === 0) return [];
  const top = snapshot.callFrames.at(-1);
  const minimum = top === undefined ? 0 : top.scopeBaseDepth;
  return names.map((name) => {
    for (let index = snapshot.frames.length - 1; index >= minimum; index -= 1) {
      const frame = snapshot.frames[index]!;
      if (frame.file === null && frame.bindings.some((binding) => binding.name === name))
        return { name, scopeId: frame.id };
    }
    const shared =
      top?.kind === "function" ? top.captures.find((capture) => capture.name === name) : undefined;
    if (shared === undefined) {
      throw new RuntimeFault("TSR006", `Unknown identifier '${name}'.`, copySpan(span));
    }
    return { name, scopeId: shared.scopeId };
  });
}

/** The scopes whose variables live resources and queued blocks share. */
function resourceCaptureScopes(snapshot: RuntimeSnapshot): Set<number> {
  const scopes = new Set<number>();
  const add = (captures: readonly RuntimeCaptureSnapshot[]): void => {
    for (const capture of captures) scopes.add(capture.scopeId);
  };
  for (const action of snapshot.backgroundActions) {
    if (action.kind === "timer") add(action.timer.captures);
    else if (action.kind === "media") add(action.media.captures);
    else if (action.kind === "permanentButton") add(action.button.captures);
  }
  for (const invocation of snapshot.pendingTimerHandlers) add(invocation.captures);
  return scopes;
}

/**
 * Leaves the scopes from `depth` up. A block, loop, or function scope whose variables a live resource or queued block
 * shares is retained; a running block cannot share a scope of code that started after it. Activation roots are the
 * caller's to retain.
 */
export function leaveScopes(snapshot: RuntimeSnapshot, depth: number): void {
  let shared: Set<number> | undefined;
  for (let index = depth; index < snapshot.frames.length; index += 1) {
    const frame = snapshot.frames[index]!;
    if (frame.file !== null || frame.bindings.length === 0) continue;
    shared ??= resourceCaptureScopes(snapshot);
    if (shared.has(frame.id)) snapshot.retainedScopes.push(frame);
  }
  snapshot.frames.length = Math.min(depth, snapshot.frames.length);
}

/**
 * Drops the retained scopes nothing can reach anymore. A retained root stays while a running or queued block, a
 * block of a running timer or media, a shown permanent button, or a function frame runs in it; a retained block,
 * loop, or function scope stays while one of those shares its variables. Roots are dropped only with `roots`.
 */
export function sweepRetainedScopes(snapshot: RuntimeSnapshot, roots: boolean): void {
  if (snapshot.retainedScopes.length === 0) return;
  if (!roots && snapshot.retainedScopes.every((scope) => scope.file !== null)) return;
  const referenced = resourceCaptureScopes(snapshot);
  for (const frame of snapshot.callFrames) {
    if (frame.kind !== "function") continue;
    referenced.add(frame.rootScopeId);
    for (const capture of frame.captures) referenced.add(capture.scopeId);
  }
  for (const invocation of snapshot.pendingTimerHandlers) referenced.add(invocation.rootScopeId);
  for (const action of snapshot.backgroundActions) {
    const owner =
      action.kind === "timer"
        ? action.timer.handlerFunctionId === null
          ? null
          : action.timer.rootScopeId
        : action.kind === "media"
          ? action.media.handlerRootScopeId
          : action.kind === "permanentButton"
            ? action.button.rootScopeId
            : null;
    if (owner !== null) referenced.add(owner);
  }
  let kept = 0;
  for (const scope of snapshot.retainedScopes) {
    if (referenced.has(scope.id) || (!roots && scope.file !== null))
      snapshot.retainedScopes[kept++] = scope;
  }
  snapshot.retainedScopes.length = kept;
}
