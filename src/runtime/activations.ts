import type {
  RuntimeCallFrameSnapshot,
  RuntimeFrameSnapshot,
  RuntimeScopeFrameSnapshot,
  RuntimeSnapshot,
} from "./state.js";

/**
 * Activations (ADR 0022 §5): each entry into a file has a root scope with its own top-level variables. The base
 * activation's root is `frames[0]`; a file call's is `frames[scopeBaseDepth]`. Functions and blocks see the root they
 * captured; code at a file's top level sees the root of the activation it runs in.
 */

/** The innermost function or block frame, when the running code is one. */
export function activeFunctionFrame(snapshot: {
  readonly callFrames: readonly RuntimeFrameSnapshot[];
}): RuntimeCallFrameSnapshot | undefined {
  const top = snapshot.callFrames.at(-1);
  return top?.kind === "function" ? top : undefined;
}

/** The running expiry or cue block, which interrupts the story at most once at a time. */
export function interruptFrame(snapshot: {
  readonly callFrames: readonly RuntimeFrameSnapshot[];
}): RuntimeCallFrameSnapshot | undefined {
  for (const frame of snapshot.callFrames) {
    if (frame.kind === "function" && frame.timerInterruption !== null) return frame;
  }
  return undefined;
}

/** Whether a block is running, which keeps queued blocks waiting. */
export function interruptRunning(snapshot: {
  readonly callFrames: readonly RuntimeFrameSnapshot[];
}): boolean {
  return interruptFrame(snapshot) !== undefined;
}

/** The index of the innermost file call, or -1 in the base activation. */
export function innermostFileCallIndex(snapshot: {
  readonly callFrames: readonly RuntimeFrameSnapshot[];
}): number {
  for (let index = snapshot.callFrames.length - 1; index >= 0; index -= 1) {
    if (snapshot.callFrames[index]!.kind === "file") return index;
  }
  return -1;
}

/** Where the running activation's root stands in `frames`. */
function currentRootDepth(snapshot: Pick<RuntimeSnapshot, "callFrames">): number {
  const index = innermostFileCallIndex(snapshot);
  const call = snapshot.callFrames[index];
  return call?.kind === "file" ? call.scopeBaseDepth : 0;
}

/** The root whose top-level names the running code sees. */
export function contextRootId(snapshot: Pick<RuntimeSnapshot, "callFrames" | "frames">): number {
  const top = snapshot.callFrames.at(-1);
  return top?.kind === "function"
    ? top.rootScopeId
    : snapshot.frames[currentRootDepth(snapshot)]!.id;
}

/** An activation root on the stack or retained for its blocks. */
export function findRoot(
  snapshot: Pick<RuntimeSnapshot, "frames" | "retainedScopes">,
  id: number,
): RuntimeScopeFrameSnapshot | undefined {
  for (const frame of snapshot.frames) if (frame.id === id && frame.file !== null) return frame;
  return snapshot.retainedScopes.find((frame) => frame.id === id);
}

/** A scope on the stack or a retained root, by ID: where a prepared reference's binding lives. */
export function findScope(
  snapshot: Pick<RuntimeSnapshot, "frames" | "retainedScopes">,
  id: number,
): RuntimeScopeFrameSnapshot | undefined {
  return (
    snapshot.frames.find((frame) => frame.id === id) ??
    snapshot.retainedScopes.find((frame) => frame.id === id)
  );
}
