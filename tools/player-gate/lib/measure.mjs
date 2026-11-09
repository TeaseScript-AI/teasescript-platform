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
  // Every endpoint finite and in order: enabled, its frame; the input after enabled; the control's frame after it.
  const ordered = [enabled.t, enabled.frame, press.ts, control.t, control.frame].every(
    Number.isFinite,
  );
  if (
    !ordered ||
    enabled.frame < enabled.t ||
    press.ts < enabled.t ||
    control.frame < control.t ||
    inputToControlMs < 0
  )
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
 * When a turn settled, from the probe's records `gate`: its submission is the first trusted pointer, touch or Enter
 * input at or after `sentAt`; it settles at the earliest of the frame after a state with an enabled control of another
 * action than `beforeControl` (its serial), a new script row's first positive-opacity frame (`shownFrame`), and the
 * frame after a change of a script row already shown before the submission (an updated message). User echoes never
 * settle a turn. `settledAt` is `null` until one of them has its frame. The driver's wait runs this same function in the
 * page (`SETTLED`), so it uses nothing outside its own body.
 */
export function turnSettlement(gate, sentAt, beforeControl) {
  const submission =
    gate.inputs.find(
      (input) =>
        input.t >= sentAt &&
        input.trusted &&
        (input.type === "pointerdown" || input.type === "touchstart" || input.type === "keydown"),
    ) ?? null;
  if (submission === null) return { submission: null, settledAt: null, by: null };
  const after = submission.t;
  // An answerable control, as `hasEnabledControl` reads a state.
  const answerable = (state) =>
    state.start === null &&
    (state.buttons.some((button) => button.enabled) ||
      (state.composer?.enabled === true && state.composer.asks));
  const rows = new Map(gate.rows.map((row) => [row.id, row]));
  const events = [
    ...gate.states
      .filter(
        (state) =>
          state.t > after &&
          answerable(state) &&
          state.control !== beforeControl &&
          state.frame !== undefined,
      )
      .map((state) => ({ by: "control", at: state.frame })),
    ...gate.rows
      .filter((row) => row.speaker !== "user" && row.t > after && row.shownFrame !== undefined)
      .map((row) => ({ by: "row", at: row.shownFrame })),
    ...(gate.rowChanges ?? [])
      .filter((change) => {
        const row = rows.get(change.id);
        return (
          row !== undefined &&
          row.speaker !== "user" &&
          row.shownFrame !== undefined &&
          row.shownFrame < after &&
          change.t > after &&
          change.frame !== undefined
        );
      })
      .map((change) => ({ by: "row update", at: change.frame })),
  ].sort((a, b) => a.at - b.at);
  return { submission, settledAt: events[0]?.at ?? null, by: events[0]?.by ?? null };
}

/** `turnSettlement` as a page source over `window.__gate`: whether the turn sent at `sentAt` has settled. */
export const SETTLED = (sentAt, beforeControl) =>
  `(${turnSettlement})(window.__gate, ${sentAt}, ${JSON.stringify(beforeControl)}).settledAt !== null`;

/**
 * One turn from the input event at or after `sentAt`, the state `before` it shown: feedback is the frame after the
 * first DOM change; settlement is `turnSettlement`'s. `end` is how the driver saw the turn end when it did not settle:
 * `ended` (the script's end), `cut` (nothing to answer and no change for 10 s), or `null`; a turn that neither settled
 * nor ended is not ok, and so is one whose times run backwards.
 */
export function turnTimes(gate, sentAt, before, end = null) {
  const { submission, settledAt, by } = turnSettlement(gate, sentAt, before.control);
  if (submission === null) return { ok: false, reason: "no input recorded" };
  const change = gate.changes.find((record) => record.t > submission.t);
  const row = gate.rows.find(
    (record) =>
      record.speaker !== "user" && record.t > submission.t && record.shownFrame !== undefined,
  );
  const feedbackMs = change?.frame === undefined ? null : change.frame - submission.ts;
  const times = {
    submissionMs: submission.ts,
    feedbackMs,
    firstScriptRowMs: row === undefined ? null : row.shownFrame - submission.ts,
  };
  // `null >= 0` holds in JavaScript: a missing feedback must fail before the comparison.
  if (!(Number.isFinite(feedbackMs) && feedbackMs >= 0))
    return { ok: false, reason: "no feedback after the input", ...times };
  if (settledAt === null)
    return end === null
      ? { ok: false, reason: "neither settled nor ended", ...times }
      : { ok: true, end, ...times, settledMs: null };
  const settledMs = settledAt - submission.ts;
  if (!(Number.isFinite(settledMs) && settledMs >= 0))
    return { ok: false, reason: "settled before its input", ...times };
  return { ok: true, ...times, settledMs, settledBy: by };
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
  // Its endpoints must be finite and in order: the press, then the transaction's start, then its commit.
  const ordered =
    Number.isFinite(pressMs) &&
    Number.isFinite(save.start) &&
    Number.isFinite(save.end) &&
    pressMs < save.start &&
    save.start <= save.end;
  if (save.outcome === "complete" && !ordered)
    return {
      ok: false,
      reason: "the publish's start and commit are not after the press, in order",
    };
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
  // A `ready` before its construction is no start.
  if (worker.ready !== null && !(worker.ready >= worker.constructed))
    return { constructedMs: worker.constructed, readyMs: null, startMs: null };
  return {
    constructedMs: worker.constructed,
    readyMs: worker.ready,
    startMs: worker.ready === null ? null : worker.ready - worker.constructed,
  };
}

/** Each request in `log` (the instrumented variant's) with its reply: op, ID, post and reply times, round trip. */
export function requestsOf(log) {
  const replies = new Map(
    log.filter((entry) => entry.dir === "reply").map((entry) => [entry.id, entry]),
  );
  return log
    .filter((entry) => entry.dir === "post")
    .map((post) => {
      const reply = replies.get(post.id);
      return {
        op: post.op,
        id: post.id,
        postAt: post.at,
        postMs: post.postMs,
        replyAt: reply?.at ?? null,
        rttMs: reply === undefined ? null : reply.at - post.at,
        ...(reply?.size === undefined ? {} : { replySize: reply.size }),
      };
    });
}

/** The engine Worker's handling and the delivery latency per request, from its injected log and the page's posts. */
export function workerSideOf(workerLog, requests, timeOrigin) {
  if (workerLog === null) return null;
  return requests.map((request) => {
    const receipt = workerLog.find((entry) => entry.dir === "request" && entry.id === request.id);
    const reply = workerLog.find((entry) => entry.dir === "reply" && entry.id === request.id);
    return {
      op: request.op,
      id: request.id,
      deliveryMs: receipt === undefined ? null : receipt.at - (timeOrigin + request.postAt),
      handlingMs: receipt === undefined || reply === undefined ? null : reply.at - receipt.at,
    };
  });
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
