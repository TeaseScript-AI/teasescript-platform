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

/** A press of a control: its first trusted pointer, touch or click event. */
const PRESS = ["pointerdown", "touchstart", "click"];

/**
 * Playable, the Player's own time (`l5-gate.md` part 4, amended): from the navigation start (the page clock's 0) to
 * the frame after `label` (`Start` or `Continue`) is enabled, plus from its press's input event to the frame after the
 * first enabled script control; the enabled → input delay between them is the driver's, reported apart.
 */
export function playable(gate, label) {
  const enabled = gate.states.find(
    (state) => state.start?.enabled === true && state.start.label === label,
  );
  if (enabled?.frame === undefined)
    return { ok: false, reason: `${label} was never shown enabled` };
  const press = inputAfter(gate, enabled.t, PRESS);
  if (press === null) return { ok: false, reason: `no trusted input after ${label} was enabled` };
  const control = firstControlAfter(gate, press.t);
  if (control?.frame === undefined)
    return { ok: false, reason: `no enabled control after ${label}'s input` };
  const inputToControlMs = control.frame - press.ts;
  if (!(inputToControlMs >= 0) || !(press.ts >= enabled.t))
    return { ok: false, reason: "the input's timestamp is outside its boundaries" };
  return {
    ok: true,
    enabledMs: enabled.t,
    enabledFrameMs: enabled.frame,
    inputMs: press.ts,
    enabledToInputMs: press.ts - enabled.frame,
    inputToControlMs,
    playableMs: enabled.frame + inputToControlMs,
  };
}

/**
 * One turn from the input event at or after `sentAt`, the state `before` it shown: feedback is the frame after the
 * first DOM change; settlement is the frame after the first script row or the first state with an enabled control of
 * another action (its serial). `end` is how the driver saw the turn end when it did not settle: `ended` (the script's
 * end), `cut` (nothing to answer for 10 s), or `null`; a turn that neither settled nor ended is not ok.
 */
export function turnTimes(gate, sentAt, before, end = null) {
  const submission = inputAfter(gate, sentAt, ["pointerdown", "touchstart", "keydown"]);
  if (submission === null) return { ok: false, reason: "no input recorded" };
  const change = gate.changes.find((record) => record.t > submission.t);
  const control = gate.states.find(
    (state) =>
      state.t > submission.t && hasEnabledControl(state) && state.control !== before.control,
  );
  const row = gate.rows.find((record) => record.speaker !== "user" && record.t > submission.t);
  const settledAt = Math.min(control?.frame ?? Infinity, row?.frame ?? Infinity);
  const feedbackMs = change?.frame === undefined ? null : change.frame - submission.ts;
  const times = {
    submissionMs: submission.ts,
    feedbackMs,
    firstScriptRowMs: row?.shownFrame === undefined ? null : row.shownFrame - submission.ts,
  };
  if (settledAt === Infinity)
    return end === null
      ? { ok: false, reason: "neither settled nor ended", ...times }
      : { ok: true, end, ...times, settledMs: null };
  return {
    ok: feedbackMs !== null,
    ...times,
    settledMs: settledAt - submission.ts,
    settledBy: settledAt === row?.frame ? "row" : "control",
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

/**
 * The first save after the press at `pressMs`: the first publish transaction that puts this scope's `sessions` record
 * and its `plans` record, to its `complete`; the plan JSON write is not timed apart (`l5-gate.md` part 4). Long tasks in
 * that span, or `null` where the browser does not report them.
 */
export function firstSave(gate, pressMs) {
  const save = gate.transactions.find(
    (transaction) =>
      transaction.start > pressMs &&
      transaction.puts.some((put) => put.store === "plans") &&
      transaction.puts.some((put) => put.store === "sessions"),
  );
  if (save === undefined)
    return { ok: false, reason: "no publish with a session and a plan record after Start" };
  const plan = save.puts.find((put) => put.store === "plans");
  const session = save.puts.find((put) => put.store === "sessions");
  const longTasks = gate.longTasks;
  const blocked =
    longTasks === null
      ? null
      : longTasks.filter(
          (task) => task.start + task.duration > pressMs && task.start < (save.end ?? Infinity),
        );
  return {
    ok: save.outcome === "complete",
    outcome: save.outcome,
    scope: session.scope,
    planScope: plan.scope,
    startToCommitMs: save.end === null ? null : save.end - pressMs,
    transactionMs: save.end === null ? null : save.end - save.start,
    planJsonLength: plan.length,
    longTasksMs: blocked === null ? null : blocked.reduce((sum, task) => sum + task.duration, 0),
    longTaskMaxMs:
      blocked === null || blocked.length === 0
        ? null
        : Math.max(...blocked.map((task) => task.duration)),
    longTasksUnavailable: gate.longTasksUnavailable ?? null,
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
