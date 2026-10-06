import { hasExactKeys, nonNegativeSafeInteger } from "../plan/validation-support.js";
import type { SnapshotValidationAnalysis } from "./snapshot-validation-analysis.js";

/**
 * Restore validation for the variables blocks share with the code that created them (V30 §14). Each resource, queued
 * block, and running block names the variables its plan instruction lists, each in a block, loop, or function scope
 * that holds it. A retained scope of that kind exists only while one of them shares it. Settled handle records keep
 * their list without owning its scopes.
 */
export function validateCaptureState(
  snapshot: Record<string, unknown>,
  analysis: SnapshotValidationAnalysis | undefined,
  errors: string[],
): void {
  const frames = Array.isArray(snapshot.frames) ? snapshot.frames : [];
  const retained = Array.isArray(snapshot.retainedScopes) ? snapshot.retainedScopes : [];
  /** Each scope by ID, with its depth on the stack, or -1 when retained. */
  const scopes = new Map<
    number,
    { readonly frame: Record<string, unknown>; readonly depth: number }
  >();
  [...frames, ...retained].forEach((frame, index) => {
    if (isPlainRecord(frame) && nonNegativeSafeInteger(frame.id))
      scopes.set(frame.id, { frame, depth: index < frames.length ? index : -1 });
  });
  const shared = new Set<number>();
  let malformed = false;
  let unresolved = false;
  const check = (
    list: unknown,
    functionId: unknown,
    live: boolean,
    /** For a running block: the depth its own scopes start at, which it cannot share. */
    below: number = Number.POSITIVE_INFINITY,
  ): void => {
    const captures = captureList(list);
    const expected =
      nonNegativeSafeInteger(functionId) && analysis !== undefined
        ? (analysis.handlerCaptures.get(functionId) ?? [])
        : functionId === null
          ? []
          : undefined;
    if (
      captures === null ||
      (expected !== undefined &&
        (captures.length !== expected.length ||
          captures.some((capture, index) => capture.name !== expected[index])))
    ) {
      malformed = true;
      return;
    }
    if (!live) return;
    for (const { name, scopeId } of captures) {
      const scope = scopes.get(scopeId);
      if (
        scope === undefined ||
        scope.frame.file !== null ||
        scope.frame.shared !== true ||
        scope.depth >= below ||
        !Array.isArray(scope.frame.bindings) ||
        !scope.frame.bindings.some((binding) => isPlainRecord(binding) && binding.name === name)
      ) {
        unresolved = true;
        continue;
      }
      shared.add(scopeId);
    }
  };
  for (const action of Array.isArray(snapshot.backgroundActions)
    ? snapshot.backgroundActions
    : []) {
    if (!isPlainRecord(action)) continue;
    if (action.kind === "timer" && isPlainRecord(action.timer)) {
      check(action.timer.captures, action.timer.handlerFunctionId, true);
    } else if (action.kind === "media" && isPlainRecord(action.media)) {
      check(action.media.captures, mediaFunctionId(action.media), true);
    } else if (action.kind === "permanentButton" && isPlainRecord(action.button)) {
      check(action.button.captures, action.button.handlerFunctionId, true);
    }
  }
  for (const timer of Array.isArray(snapshot.settledTimers) ? snapshot.settledTimers : [])
    if (isPlainRecord(timer)) check(timer.captures, timer.handlerFunctionId, false);
  for (const media of Array.isArray(snapshot.settledMedia) ? snapshot.settledMedia : [])
    if (isPlainRecord(media)) check(media.captures, mediaFunctionId(media), false);
  for (const invocation of Array.isArray(snapshot.pendingTimerHandlers)
    ? snapshot.pendingTimerHandlers
    : [])
    if (isPlainRecord(invocation)) check(invocation.captures, invocation.handlerFunctionId, true);
  for (const frame of Array.isArray(snapshot.callFrames) ? snapshot.callFrames : []) {
    if (!isPlainRecord(frame) || frame.kind !== "function") continue;
    const definition = nonNegativeSafeInteger(frame.functionId)
      ? analysis?.functionsById.get(frame.functionId)
      : undefined;
    // An ordinary function shares nothing.
    check(
      frame.captures,
      definition?.handler === null ? null : frame.functionId,
      true,
      nonNegativeSafeInteger(frame.scopeBaseDepth) ? frame.scopeBaseDepth : 0,
    );
  }
  if (malformed) errors.push("Runtime shared block variables are malformed.");
  if (unresolved) errors.push("Runtime shared block variable has no scope that holds it.");
  if (
    retained.some(
      (frame) =>
        isPlainRecord(frame) &&
        frame.file === null &&
        !(nonNegativeSafeInteger(frame.id) && shared.has(frame.id)),
    )
  ) {
    errors.push("Runtime retained scope is not shared by any block.");
  }
}

function captureList(value: unknown): { name: string; scopeId: number }[] | null {
  if (!Array.isArray(value)) return null;
  const names = new Set<string>();
  const captures: { name: string; scopeId: number }[] = [];
  for (const capture of value) {
    if (
      !isPlainRecord(capture) ||
      !hasExactKeys(capture, ["name", "scopeId"]) ||
      typeof capture.name !== "string" ||
      capture.name.length === 0 ||
      names.has(capture.name) ||
      !nonNegativeSafeInteger(capture.scopeId)
    )
      return null;
    names.add(capture.name);
    captures.push({ name: capture.name, scopeId: capture.scopeId });
  }
  return captures;
}

/** A block of the media, whose instruction names its shared variables; `null` without a valid one. */
function mediaFunctionId(media: Record<string, unknown>): number | null {
  const cue = Array.isArray(media.cues) ? media.cues[0] : undefined;
  const functionId = isPlainRecord(cue) ? cue.functionId : media.finishFunctionId;
  return nonNegativeSafeInteger(functionId) ? functionId : null;
}

/** Whether two shared-variable lists are the same. */
export function sameCaptures(left: unknown, right: unknown): boolean {
  const first = captureList(left);
  const second = captureList(right);
  return (
    first !== null &&
    second !== null &&
    first.length === second.length &&
    first.every(
      (capture, index) =>
        capture.name === second[index]!.name && capture.scopeId === second[index]!.scopeId,
    )
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
