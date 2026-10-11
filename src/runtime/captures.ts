import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan } from "../source.js";
import { internalFault, RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
import type { RuntimeScopeFrameSnapshot, RuntimeSnapshot } from "./state.js";

/*
 * Shared variables of blocks (V30 §14). A timer expiry block, media block, or permanent button block uses the
 * function, loop, and block variables of the code that created it as that code does: one variable, not a copy. When
 * the resource is created, each name its blocks use is resolved to the scope that holds it. The resource, each of its
 * queued blocks, and its running block record those scopes by ID. A scope stays where it is while its code runs; when
 * that code leaves it, the scope moves to the retained scopes if a resource or queued block still uses it, with only the
 * variables they use, and it goes once nothing does. Each scope exists once, so every user of a variable sees its
 * current value.
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
      if (frame.file === null && frame.bindings.some((binding) => binding.name === name)) {
        frame.shared = true;
        return { name, scopeId: frame.id };
      }
    }
    const shared =
      top?.kind === "function" ? top.captures.find((capture) => capture.name === name) : undefined;
    if (shared === undefined) {
      throw new RuntimeFault(
        "TSR006",
        internalFault(`The plan uses the name '${name}' but does not declare it.`),
        copySpan(span),
      );
    }
    return { name, scopeId: shared.scopeId };
  });
}

/** The variables that live resources and queued blocks share, by the ID of the scope that holds them. */
function resourceCaptures(snapshot: RuntimeSnapshot): Map<number, Set<string>> {
  const shared = new Map<number, Set<string>>();
  for (const action of snapshot.backgroundActions) {
    if (action.kind === "timer") addCaptures(shared, action.timer.captures);
    else if (action.kind === "media") addCaptures(shared, action.media.captures);
    else if (action.kind === "permanentButton") addCaptures(shared, action.button.captures);
  }
  for (const invocation of snapshot.pendingTimerHandlers) addCaptures(shared, invocation.captures);
  return shared;
}

function addCaptures(
  shared: Map<number, Set<string>>,
  captures: readonly RuntimeCaptureSnapshot[],
): void {
  for (const capture of captures) {
    let names = shared.get(capture.scopeId);
    if (names === undefined) shared.set(capture.scopeId, (names = new Set()));
    names.add(capture.name);
  }
}

/**
 * The scope with only the variables that something shares, in their order. A scope that loses variables gets a new
 * bindings list: the evaluator's name index of a list assumes that it only grows.
 */
function keepShared(
  scope: RuntimeScopeFrameSnapshot,
  names: ReadonlySet<string>,
): RuntimeScopeFrameSnapshot {
  if (scope.bindings.every((binding) => names.has(binding.name))) return scope;
  return { ...scope, bindings: scope.bindings.filter((binding) => names.has(binding.name)) };
}

/**
 * Leaves the scopes from `depth` up. A block, loop, or function scope whose variables a live resource or queued block
 * shares is retained with only those variables; nothing else can reach the others, since a scope never returns to the
 * stack and a block creates resources that share only its own variables. A running block cannot share a scope of code
 * that started after it. Activation roots are the caller's to retain.
 */
export function leaveScopes(snapshot: RuntimeSnapshot, depth: number): void {
  let shared: Map<number, Set<string>> | undefined;
  for (let index = depth; index < snapshot.frames.length; index += 1) {
    const frame = snapshot.frames[index]!;
    if (frame.shared !== true) continue;
    shared ??= resourceCaptures(snapshot);
    const names = shared.get(frame.id);
    if (names !== undefined) snapshot.retainedScopes.push(keepShared(frame, names));
  }
  snapshot.frames.length = Math.min(depth, snapshot.frames.length);
}

/**
 * Drops the retained scopes and variables nothing can reach anymore. A retained root stays while a running or queued
 * block, a block of a running timer or media, a shown permanent button, or a function frame runs in it; a retained
 * block, loop, or function scope stays with the variables that one of those shares. Roots are dropped only with `roots`.
 */
export function sweepRetainedScopes(snapshot: RuntimeSnapshot, roots: boolean): void {
  if (snapshot.retainedScopes.length === 0) return;
  if (!roots && snapshot.retainedScopes.every((scope) => scope.file !== null)) return;
  const shared = resourceCaptures(snapshot);
  const referencedRoots = new Set<number>();
  for (const frame of snapshot.callFrames) {
    if (frame.kind !== "function") continue;
    referencedRoots.add(frame.rootScopeId);
    addCaptures(shared, frame.captures);
  }
  for (const invocation of snapshot.pendingTimerHandlers)
    referencedRoots.add(invocation.rootScopeId);
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
    if (owner !== null) referencedRoots.add(owner);
  }
  let kept = 0;
  for (const scope of snapshot.retainedScopes) {
    if (scope.file !== null) {
      if (!roots || referencedRoots.has(scope.id)) snapshot.retainedScopes[kept++] = scope;
      continue;
    }
    const names = shared.get(scope.id);
    if (names !== undefined) snapshot.retainedScopes[kept++] = keepShared(scope, names);
  }
  snapshot.retainedScopes.length = kept;
}
