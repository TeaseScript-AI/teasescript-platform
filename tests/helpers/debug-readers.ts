import assert from "node:assert/strict";

import { instructionSourcePath, type InstructionPlan } from "../../src/plan/model.js";
import {
  interactionDeadlineMs,
  type RuntimeForegroundActionSnapshot,
} from "../../src/runtime/actions/model.js";
import { hatch } from "../../player/engine-bridge/in-process.js";
import { instructionFacts } from "../../player/engine-bridge/instruction-facts.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { PlayerRuntimeSession } from "../../player/runtime/runtime-adapter.js";
import {
  playerRuntimeCalls,
  playerRuntimeDebugCountdown,
  playerRuntimeDebugNow,
  type PlayerDebugCall,
  type PlayerDebugSourceLocation,
  type PlayerDebugTimer,
  type PlayerRuntimeDebugCountdown,
  type PlayerRuntimeDebugNow,
  type PlayerSession,
} from "../../player/runtime/runtime-view.js";

/*
 * Player Debug's readers as tests use them (L5f). The readers run in the main realm on a published view; this file
 * gives them an adapter session's view, as its publication carries it, and compares each result with the frozen oracle
 * below: the readers as they were before L5f moved them (`player/runtime/runtime-adapter.ts` at d6e83b181, lines 646–923,
 * verbatim but for their names), which read the plan itself, not the instruction facts a publication carries.
 */

/** `session`'s view as its publication carries it, with the call view (`calls`) or without it. */
function viewOf(
  session: PlayerRuntimeSession,
  calls = true,
): Pick<PlayerSession, "state" | "instructions" | "callView"> {
  const { calls: active, ...state } = session.state;
  return {
    state,
    instructions: instructionFacts(session, calls),
    callView: calls ? { calls: active } : null,
  };
}

/** Debug's Now view of `session` at `nowMs`, which must equal the oracle's. */
export function debugNow(session: PlayerRuntimeSession, nowMs: number): PlayerRuntimeDebugNow {
  const view = playerRuntimeDebugNow(viewOf(session), nowMs);
  assert.deepEqual(view, planDebugNow(session, nowMs));
  return view!;
}

/** `session`'s active calls, which must equal the oracle's. */
export function debugCalls(session: PlayerRuntimeSession): readonly PlayerDebugCall[] {
  const calls = playerRuntimeCalls(viewOf(session));
  assert.deepEqual(calls, planCalls(session));
  return calls!;
}

/** `session`'s Debug countdown, from the critical view alone, which must equal the oracle's. */
export function debugCountdown(session: PlayerRuntimeSession): PlayerRuntimeDebugCountdown | null {
  const countdown = playerRuntimeDebugCountdown(viewOf(session, false));
  assert.deepEqual(countdown, planDebugCountdown(session));
  return countdown;
}

/**
 * What Debug's readers give for a published session, with its instruction facts and call view, comparable across
 * backends. Without the call view the call readers give `null` and the facts name only the critical set: the owners
 * of the media, the foreground and the suspended action. In-process, each result also equals the oracle's on the
 * host's own session, with the call view, or for the countdown always.
 */
export function viewed(session: PlayerSession) {
  const result = {
    instructions: session.instructions,
    callView: session.callView,
    countdown: playerRuntimeDebugCountdown(session),
    calls: playerRuntimeCalls(session),
    now: playerRuntimeDebugNow(session, 0),
  };
  const { state } = session;
  if (session.callView === null) {
    assert.equal(result.calls, null);
    assert.equal(result.now, null);
    const critical = new Set([
      ...state.backgroundActions.filter((a) => a.kind === "media").map((a) => a.owningInstruction),
      ...(state.foregroundAction === null ? [] : [state.foregroundAction.owningInstruction]),
      ...(state.suspendedAction === null ? [] : [state.suspendedAction.owningInstruction]),
    ]);
    assert.deepEqual(new Set(Object.keys(session.instructions).map(Number)), critical);
  }
  if (inProcess(session))
    hatch(session, (held) => {
      // The host's latest publication is the store's: the same revision.
      assert.equal(held.revision, session.revision);
      // Each fact is its plan instruction's: its file, line and kind, a `wait` giving its command.
      for (const [index, fact] of Object.entries(session.instructions)) {
        const instruction = held.plan.instructions[Number(index)];
        assert.deepEqual(
          fact,
          instruction === undefined
            ? { path: instructionSourcePath(held.plan, Number(index)), line: 0, kind: "end" }
            : {
                path: instructionSourcePath(held.plan, Number(index)),
                line: instruction.span.sl + 1,
                kind: instruction.kind === "wait" ? instruction.command : instruction.kind,
              },
          `instruction ${index}`,
        );
      }
      assert.deepEqual(result.countdown, planDebugCountdown(held));
      if (session.callView !== null) {
        assert.deepEqual(session.callView.calls, held.state.calls);
        assert.deepEqual(result.calls, planCalls(held));
        assert.deepEqual(result.now, planDebugNow(held, 0));
      }
    });
  return result;
}

/** Whether `value` is a published session as the Player holds it: with its connection, lineage and call view. */
function isPublished(
  value: PlayerRuntimeSession | null,
): value is PlayerRuntimeSession & PlayerSession {
  return value !== null && "connection" in value && "lineage" in value && "callView" in value;
}

/**
 * The composable's shown session `value`, which a test's host interface types as an adapter session for the facade's
 * ops, as the published session it is.
 */
export function published(value: PlayerRuntimeSession | null): PlayerSession {
  assert.ok(isPublished(value), "a published session");
  return value;
}

/** Whether `session` belongs to an in-process backend, whose host's sessions `hatch` reads. */
function inProcess(session: PlayerSession): boolean {
  try {
    return hatch(session, () => true);
  } catch {
    return false;
  }
}

/** Starts or ends `session`'s call view; returns its latest publication after the reply merged. */
export async function viewCalls(
  bridge: PlayerBridge,
  session: PlayerSession,
  on: boolean,
): Promise<PlayerSession> {
  const merged = await bridge.viewCalls(session, on);
  assert.ok(merged !== null, "the reply is of the store's latest publication");
  assert.equal(merged, bridge.latest(session));
  return merged;
}

/**
 * `value` without its entries named `keys` (its `viewed` ones), at any depth: what a tape shows of the critical view
 * alone.
 */
export function withoutViews<T>(value: T, keys: readonly string[] = ["viewed"]): T {
  if (Array.isArray(value)) {
    // EVIDENCE: fixture: an array maps to an array of the same items' copies, for a deep comparison only.
    return value.map((item: unknown) => withoutViews(item, keys)) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  // EVIDENCE: fixture: the copy has the same entries but `keys`, for a deep comparison only.
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !keys.includes(key))
      .map(([key, item]) => [key, withoutViews(item, keys)]),
  ) as T;
}

// The oracle: the readers before L5f, verbatim but for their names.

function planDebugCountdown(
  session: Pick<PlayerRuntimeSession, "plan" | "state">,
): PlayerRuntimeDebugCountdown | null {
  const { state: snapshot } = session;
  if (snapshot.status !== "running" && snapshot.status !== "waiting") return null;
  const foreground = snapshot.foregroundAction;
  let countdown: PlayerRuntimeDebugCountdown | null = null;
  if (foreground?.kind === "interaction") {
    const deadlineMs = interactionDeadlineMs(foreground);
    if (deadlineMs !== null) countdown = { kind: "button", deadlineMs };
  } else if (foreground?.kind === "delay") {
    const owner = session.plan.instructions[foreground.owningInstruction];
    if (owner?.kind === "wait" && owner.command === "wait")
      countdown = { kind: "wait", deadlineMs: foreground.deadlineMs };
  } else if (foreground?.kind === "chatPacingGate") {
    countdown = { kind: "pacing", deadlineMs: foreground.deadlineMs };
  }
  return countdown === null ? null : Object.freeze(countdown);
}

function debugLocation(
  plan: InstructionPlan,
  instruction: number,
  line = plan.instructions[instruction]!.span.sl + 1,
): PlayerDebugSourceLocation {
  return Object.freeze({ path: instructionSourcePath(plan, instruction), line });
}

function debugWaitKind(plan: InstructionPlan, action: RuntimeForegroundActionSnapshot) {
  switch (action.kind) {
    case "delay": {
      const owner = plan.instructions[action.owningInstruction];
      return owner?.kind === "wait" && owner.command === "wait" ? "wait" : "timer";
    }
    case "interaction":
      return action.interactionKind === "button" ||
        action.interactionKind === "choice" ||
        action.interactionKind === "image" ||
        action.interactionKind === "popup" ||
        action.interactionKind === "url" ||
        action.interactionKind === "export"
        ? action.interactionKind
        : "input";
    case "chatPacingGate":
      return "pacing";
    case "mediaPlayback":
      return "media";
    case "storageWrite":
      return "save";
    case "capture":
      return "photo";
    case "fileStore":
      return "file";
    case "lock":
      return action.call === "encryptText" || action.call === "encryptFile" ? "lock" : "unlock";
  }
}

/**
 * The active calls, innermost first, also of a failed session, where they are the calls the error happened in. Work is
 * proportional to the call depth.
 */
function planCalls(
  session: Pick<PlayerRuntimeSession, "plan" | "state">,
): readonly PlayerDebugCall[] {
  const { plan, state: snapshot } = session;
  // Each frame runs in the file that the next inner frame was called from, the innermost in the next statement's file.
  const calls: PlayerDebugCall[] = [];
  let runningIn = instructionSourcePath(plan, snapshot.nextInstruction);
  for (const call of [...snapshot.calls].reverse()) {
    const from =
      call.interruption === null
        ? debugLocation(plan, call.returnInstruction, call.callSiteSpan.start.line + 1)
        : debugLocation(plan, call.returnInstruction);
    calls.push(
      Object.freeze({
        kind: call.kind === "file" ? "file" : (call.interruption ?? "function"),
        name: call.kind === "file" ? runningIn : call.functionName,
        from,
      }),
    );
    runningIn = from.path;
  }
  return Object.freeze(calls);
}

/**
 * Where the session is, for Player Debug's Now view at display scene time `nowMs`: the next statement, the statement
 * whose foreground action it waits for, the active calls, every timer, hidden ones included, and the active media. Paths are package
 * paths, relative to the folder of the entry script. Read-only and derived on demand; it adds nothing to the session.
 */
function planDebugNow(
  session: Pick<PlayerRuntimeSession, "plan" | "state">,
  nowMs: number,
): PlayerRuntimeDebugNow {
  const { plan, state: snapshot } = session;
  const now = Math.max(snapshot.observedSessionTimeMs, nowMs);
  const active = snapshot.status === "running" || snapshot.status === "waiting";
  const foreground = snapshot.foregroundAction;

  const timers: PlayerDebugTimer[] = [];
  const delays = [
    ...(foreground === null ? [] : [{ action: foreground, suspended: false }]),
    ...(snapshot.suspendedAction === null
      ? []
      : [{ action: snapshot.suspendedAction, suspended: true }]),
  ];
  for (const { action, suspended } of delays) {
    if (action.kind !== "delay" || debugWaitKind(plan, action) !== "timer") continue;
    timers.push({
      actionId: action.actionId,
      blocking: true,
      display: action.display,
      label: action.label,
      repeat: false,
      state: suspended ? "suspended" : "running",
      remainingMs: Math.max(
        0,
        action.deadlineMs - (suspended ? (snapshot.suspendedAtMs ?? now) : now),
      ),
      startedAt: debugLocation(plan, action.owningInstruction),
    });
  }
  for (const action of snapshot.backgroundActions) {
    if (action.kind !== "timer") continue;
    const timer = action.timer;
    timers.push({
      actionId: action.actionId,
      blocking: false,
      display: timer.display,
      label: timer.label,
      repeat: timer.repeat,
      state: timer.deadlineMs === null ? "paused" : "running",
      remainingMs:
        timer.deadlineMs === null ? (timer.remainingMs ?? 0) : Math.max(0, timer.deadlineMs - now),
      startedAt: debugLocation(plan, action.owningInstruction),
    });
  }

  const mediaOwners = new Map<number, number>();
  for (const action of snapshot.backgroundActions)
    if (action.kind === "media") mediaOwners.set(action.media.mediaId, action.owningInstruction);
  const media = snapshot.media.map((projection) =>
    Object.freeze({
      mediaId: projection.mediaId,
      media: projection.media,
      source: projection.source,
      loaded: projection.loaded,
      state: projection.state,
      playheadMs: projection.playheadMs,
      startedAt: debugLocation(plan, mediaOwners.get(projection.mediaId)!),
    }),
  );

  return Object.freeze({
    next: active ? debugLocation(plan, snapshot.nextInstruction) : null,
    waitingAt:
      active && foreground !== null
        ? Object.freeze({
            kind: debugWaitKind(plan, foreground),
            at: debugLocation(plan, foreground.owningInstruction),
            ...(foreground.kind === "lock"
              ? {
                  // The password field of `password: askPassword(...)` is a password opener, not the dialog.
                  lock: Object.freeze({
                    dialog:
                      foreground.phase === "ask" &&
                      (foreground.passwordField === null || foreground.choices.length > 0),
                    password: foreground.password !== null || foreground.passwordField !== null,
                    publicKeys: foreground.publicKeys.length,
                    key: foreground.key !== null,
                    timeLockMs: foreground.timeLockMs,
                    choices: foreground.choices,
                  }),
                }
              : {}),
          })
        : null,
    calls: active ? planCalls(session) : Object.freeze([]),
    timers: Object.freeze(
      active
        ? timers.sort((left, right) => left.actionId - right.actionId).map((t) => Object.freeze(t))
        : [],
    ),
    media: Object.freeze(active ? media : []),
  });
}
