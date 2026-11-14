// A scripted play of a Tease, the same for today's engine and the three emitted forms, in Node, a page, a Worker or the
// phone (no Node or DOM imports). The host's answers depend only on the action the session waits on, so every engine
// gets the same play. The clock covers only the session's own calls; reading the state for the next answer is outside.

export const FRESH = { seed: 20260713, wallClockMs: Date.UTC(2026, 6, 13, 9, 0, 0) };
export const BUDGET = 2_000_000_000;
const PLACE = new Set(["ownerCallFrameId", "scopeDepth", "loopDepth", "rootScopeId"]);

/**
 * The host's answer: a reading time or a delay at its deadline, a button pressed, a choice's first option, "1" typed, a
 * storage write stored; null for anything else (a media wait, a photo), which ends the play.
 */
export function nextOperation(state) {
  const action = state.foregroundAction;
  if (state.status !== "waiting" || action === null) return null;
  if (action.kind === "chatPacingGate" || action.kind === "delay") return { kind: "time", nowMs: action.deadlineMs };
  if (action.kind === "storageWrite")
    return { kind: "complete", request: { actionId: action.actionId, actionKind: "storageWrite", payload: { kind: "stored" } } };
  if (action.kind !== "interaction") return null;
  const base = { actionId: action.actionId, actionKind: "interaction", interactionKind: action.interactionKind };
  switch (action.interactionKind) {
    case "button":
      return { kind: "complete", request: { ...base, payload: { kind: "activate" } } };
    case "choice":
      return { kind: "complete", request: { ...base, payload: { kind: "selectedOption", optionIndex: 0 } } };
    case "text":
    case "number":
    case "password":
      return { kind: "complete", request: { ...base, payload: { kind: "submittedText", submittedText: "1" } } };
    default:
      return null;
  }
}

/** FNV-1a of a text, as 8 hex digits. */
function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/**
 * Plays `session` (run, then answer and run while it waits) for at most `maxOperations` answers. `state()` reads the
 * session's state. The digest covers what a player sees after every call: events, status, failure, foreground action
 * and generator state, without the interpreter's frame fields, which generated code does not have.
 */
export function play(session, state, maxOperations, now) {
  let ms = 0;
  let maxDriveMs = 0;
  let drives = 0;
  let operations = 0;
  let seen = "";
  const call = (f) => {
    const t0 = now();
    const result = f();
    const dt = now() - t0;
    ms += dt;
    return [result, dt];
  };
  const record = (result) => {
    const s = state();
    seen = fnv(seen + JSON.stringify({ events: result.events, status: s.status, failure: s.failure, foreground: s.foregroundAction, rng: s.rng },
      (key, value) => (PLACE.has(key) ? undefined : value)));
  };
  let [result, dt] = call(() => session.run({ instructionBudget: BUDGET }));
  record(result);
  drives += 1;
  maxDriveMs = dt;
  for (; operations < maxOperations; operations += 1) {
    const operation = nextOperation(state());
    if (operation === null) break;
    [result] = call(() => (operation.kind === "time" ? session.observeTime(operation.nowMs) : session.completeAction(operation.request)));
    record(result);
    [result, dt] = call(() => session.run({ instructionBudget: BUDGET }));
    record(result);
    drives += 1;
    if (dt > maxDriveMs) maxDriveMs = dt;
    if (state().status === "halted" || state().status === "failed") break;
  }
  const s = state();
  return { ms, maxDriveMs, lastDriveMs: dt, drives, operations, digest: seen, status: s.status, waitingOn: s.foregroundAction?.kind ?? null, failure: s.failure?.code ?? null };
}

/**
 * The sessions to play, by name: `engine` (today's runtime) and the three forms: `replay` (every drive runs the
 * program again from its start: its last drive is what one resume after a reload costs), `kept` (kept alive between
 * waits; generators), `resumable` (a save at every wait, each drive continues from it) and `chain` (resumable, every
 * author call on the driver's frame chain).
 */
export function sessions(api, driver) {
  return {
    engine: { create: (plan) => api.createFreshRuntimeSession(plan, FRESH), state: (s) => s.exportSnapshot() },
    replay: { create: (plan) => driver.createEmittedSession(plan, FRESH), state: (s) => s.state },
    kept: { create: (plan) => driver.createGeneratorSession(plan, FRESH), state: (s) => s.state },
    resumable: { create: (plan) => driver.createResumableSession(plan, FRESH), state: (s) => s.state },
    // The resumable form with every author call on the driver's frame chain.
    chain: { create: (plan) => driver.createResumableSession(plan, FRESH, { chain: true }), state: (s) => s.state },
    // The chain form keeping place-free constructs outlined (remedy (a)).
    "chain-structured": { create: (plan) => driver.createResumableSession(plan, FRESH, { chain: true, keepStructure: true }), state: (s) => s.state },
    // The resumable form with remedy (a) and native calls: the baseline for the chain form with (a).
    "resumable-structured": { create: (plan) => driver.createResumableSession(plan, FRESH, { keepStructure: true }), state: (s) => s.state },
  };
}
