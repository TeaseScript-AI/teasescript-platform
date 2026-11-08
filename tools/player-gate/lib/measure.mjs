// The report's fields, derived from the probe's records (`probe.mjs`). Every time is on the page clock, in ms from the
// page's time origin; a "frame" is the `requestAnimationFrame` callback after an event, a frame-callback bound, not a
// display time.
import { hasEnabledControl } from "./player.mjs";

/** The first probe state after `after` that shows an enabled control, or `null`. */
export function firstControlAfter(gate, after) {
  return gate.states.find((state) => state.t > after && hasEnabledControl(state)) ?? null;
}

/** The first trusted input event of `types` at or after `after`. */
export function inputAfter(gate, after, types) {
  return (
    gate.inputs.find((input) => input.t >= after && input.trusted && types.includes(input.type)) ??
    null
  );
}

/**
 * Playable after pressing the start page's button: from the press (the first trusted pointer or click event after
 * `pressedAt`) to the frame after the first enabled control. `from` is the press's own time, or the navigation start.
 */
export function playable(gate, pressedAt) {
  const pressEvent = inputAfter(gate, pressedAt, ["pointerdown", "click"]);
  const startEnabled = gate.states.find((state) => state.start?.enabled === true);
  if (pressEvent === null) return { ok: false, reason: "no press recorded" };
  const control = firstControlAfter(gate, pressEvent.t);
  if (control === null || control.frame === undefined)
    return { ok: false, reason: "no enabled control after the press" };
  return {
    ok: true,
    startEnabledMs: startEnabled?.t ?? null,
    startEnabledFrameMs: startEnabled?.frame ?? null,
    pressMs: pressEvent.ts,
    controlMs: control.t,
    playableMs: control.frame,
    pressToPlayableMs: control.frame - pressEvent.ts,
  };
}

/** The controls a state shows, as one comparable text. */
const fingerprint = (state) => JSON.stringify([state.buttons, state.composer?.hint ?? null]);

/**
 * One turn from the input event at or after `sentAt`: feedback is the frame after the first DOM change; settlement is
 * the frame after the first enabled control that is new, a script row having appeared since or other controls shown.
 */
export function turnTimes(gate, sentAt, before) {
  const submission = inputAfter(gate, sentAt, ["pointerdown", "keydown"]);
  if (submission === null) return { ok: false, reason: "no input recorded" };
  const change = gate.states.find((state) => state.t > submission.t);
  const settled = gate.states.find(
    (state) =>
      state.t > submission.t &&
      hasEnabledControl(state) &&
      (fingerprint(state) !== fingerprint(before) ||
        gate.rows.some(
          (row) => row.speaker !== "user" && row.t > submission.t && row.t <= state.t,
        )),
  );
  const scriptRow = gate.rows.find((row) => row.speaker !== "user" && row.t > submission.t);
  // The driver waited for this turn: without a new control it ended the path (nothing left to answer).
  if (settled === undefined || settled.frame === undefined)
    return {
      ok: true,
      endedPath: true,
      submissionMs: submission.ts,
      feedbackMs: change?.frame === undefined ? null : change.frame - submission.ts,
      settledMs: null,
    };
  return {
    ok: true,
    submissionMs: submission.ts,
    feedbackMs: change?.frame === undefined ? null : change.frame - submission.ts,
    firstScriptRowMs:
      scriptRow?.shownFrame === undefined ? null : scriptRow.shownFrame - submission.ts,
    settledMs: settled.frame - submission.ts,
    ended: settled.ended,
  };
}

/** The `sessions` publish transactions of scope `scope` (any scope when `null`) that committed after `after`. */
export function publishesAfter(gate, after, scope = null) {
  return gate.transactions.filter(
    (transaction) =>
      transaction.start > after &&
      transaction.outcome === "complete" &&
      transaction.puts.some(
        (put) => put.store === "sessions" && (scope === null || put.scope === scope),
      ),
  );
}

/** The first save after the press at `pressMs`: the first committed publish that also writes the plan record. */
export function firstSave(gate, pressMs, longTasks) {
  const save = gate.transactions.find(
    (transaction) =>
      transaction.start > pressMs && transaction.puts.some((put) => put.store === "plans"),
  );
  if (save === undefined) return { ok: false, reason: "no publish with a plan record after Start" };
  const plan = save.puts.find((put) => put.store === "plans");
  const session = save.puts.find((put) => put.store === "sessions");
  const blocked =
    longTasks === null
      ? null
      : longTasks.filter(
          (task) => task.start + task.duration > pressMs && task.start < (save.end ?? Infinity),
        );
  return {
    ok: save.outcome === "complete",
    outcome: save.outcome,
    scope: session?.scope ?? null,
    startToCommitMs: save.end === null ? null : save.end - pressMs,
    transactionMs: save.end === null ? null : save.end - save.start,
    planJsonLength: plan.length,
    longTasksMs: blocked === null ? null : blocked.reduce((sum, task) => sum + task.duration, 0),
    longTaskMaxMs:
      blocked === null || blocked.length === 0
        ? null
        : Math.max(...blocked.map((task) => task.duration)),
  };
}

/** The engine Worker's start: its construction to its `ready`, or `null` for a page without one. */
export function workerStart(gate) {
  const worker = gate.workers.find((record) => record.engine);
  if (worker === undefined) return null;
  return {
    constructedMs: worker.constructed,
    readyMs: worker.ready,
    startMs: worker.ready === null ? null : worker.ready - worker.constructed,
  };
}

/** The median and range of `values`, the report's form for each cell. */
export function summarize(values) {
  const sorted = values
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0, median: null, min: null, max: null };
  const middle = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { n: sorted.length, median, min: sorted[0], max: sorted.at(-1) };
}
