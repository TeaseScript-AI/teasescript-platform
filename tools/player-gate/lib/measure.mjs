// The report's fields, derived from the probe's records (`probe.mjs`). Every time is on the page clock, in ms from the
// page's time origin; a "frame" is the `requestAnimationFrame` callback after an event, a frame-callback bound, not a
// display time. The derivations read records through the strict reader (`evidence.mjs`): a missing required value
// throws, a value that may truly be absent is read with `nullable`, and every interval is a `span`.
import { crossClock, nullable, span } from "./evidence.mjs";

/** Whether `state` shows a control the player can answer now, as `hasEnabledControl` (`player.mjs`) reads it. */
function answerable(state) {
  const composer = nullable(state, "composer");
  return (
    nullable(state, "start") === null &&
    (state.buttons.some((button) => button.enabled) ||
      (composer !== null && composer.enabled === true && composer.asks === true))
  );
}

/** A record's frame after its event: `null` until its frame ran, else the frame, which must not precede the event. */
function frameOf(record, what) {
  const frame = nullable(record, "frame");
  if (frame !== null) span(record.t, frame, `${what}: its event → its frame`);
  return frame;
}

/** The first probe state after `after` that shows an enabled control, or `null`. */
export function firstControlAfter(gate, after) {
  return gate.states.find((state) => state.t > after && answerable(state)) ?? null;
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
  const enabled = gate.states.find((state) => {
    const start = nullable(state, "start");
    return start !== null && start.enabled === true && start.label === label;
  });
  if (enabled === undefined) return { ok: false, reason: `${label} was never shown enabled` };
  const enabledFrame = frameOf(enabled, `${label} enabled`);
  if (enabledFrame === null) return { ok: false, reason: `${label} enabled has no frame` };
  const press = inputAfter(gate, enabled.t, PRESS);
  if (press === null) return { ok: false, reason: `no trusted input after ${label} was enabled` };
  const control = firstControlAfter(gate, press.t);
  if (control === null) return { ok: false, reason: `no enabled control after ${label}'s input` };
  const controlFrame = frameOf(control, "the first control");
  if (controlFrame === null) return { ok: false, reason: "the first control has no frame" };
  span(enabled.t, press.ts, `${label} enabled → its input`);
  const inputToControlMs = span(
    press.ts,
    controlFrame,
    `${label}'s input → the first control's frame`,
  );
  return {
    ok: true,
    enabledMs: enabled.t,
    enabledFrameMs: enabledFrame,
    inputMs: press.ts,
    enabledToInputMs: span(enabledFrame, press.ts, `${label}'s frame → its input`),
    inputToControlMs,
    playableMs: enabledFrame + inputToControlMs,
  };
}

/**
 * When a turn settled, from the probe's records `gate`: its submission is the first trusted pointer, touch or Enter
 * input at or after `sentAt`; it settles at the earliest of the frame after a state with an enabled control of another
 * action than `beforeControl` (its serial), a new script row's first positive-opacity frame (`shownFrame`), and the
 * frame after a change of a script row already shown before the submission (an updated message). User echoes never
 * settle a turn. `settledAt` is `null` until one of them has its frame. The driver's wait runs this same function in the
 * page (`SETTLED`), so it uses nothing outside its own body; `read` reads a value that may be absent (`nullable` in the
 * derivations, a plain read in the page).
 */
export function turnSettlement(
  gate,
  sentAt,
  beforeControl,
  read = (record, key) => record[key] ?? null,
) {
  const submission =
    gate.inputs.find(
      (input) =>
        input.t >= sentAt &&
        input.trusted &&
        (input.type === "pointerdown" || input.type === "touchstart" || input.type === "keydown"),
    ) ?? null;
  if (submission === null) return { submission: null, settledAt: null, by: null, event: null };
  const after = submission.t;
  // An answerable control, as `hasEnabledControl` reads a state.
  const answerable = (state) => {
    const composer = read(state, "composer");
    return (
      read(state, "start") === null &&
      (state.buttons.some((button) => button.enabled) ||
        (composer !== null && composer.enabled === true && composer.asks === true))
    );
  };
  const rows = new Map(gate.rows.map((row) => [row.id, row]));
  const events = [
    ...gate.states
      .filter(
        (state) =>
          state.t > after &&
          answerable(state) &&
          read(state, "control") !== beforeControl &&
          read(state, "frame") !== null,
      )
      .map((state) => ({ by: "control", t: state.t, at: read(state, "frame") })),
    ...gate.rows
      .filter((row) => row.speaker !== "user" && row.t > after && read(row, "shownFrame") !== null)
      .map((row) => ({ by: "row", t: row.t, at: read(row, "shownFrame") })),
    ...(read(gate, "rowChanges") ?? [])
      .filter((change) => {
        const row = rows.get(change.id);
        const shown = row === undefined ? null : read(row, "shownFrame");
        return (
          row !== undefined &&
          row.speaker !== "user" &&
          shown !== null &&
          shown < after &&
          change.t > after &&
          read(change, "frame") !== null
        );
      })
      .map((change) => ({ by: "row update", t: change.t, at: read(change, "frame") })),
  ].sort((a, b) => a.at - b.at);
  const event = events[0] ?? null;
  return { submission, settledAt: event?.at ?? null, by: event?.by ?? null, event };
}

/** `turnSettlement` as a page source over `window.__gate`: whether the turn sent at `sentAt` has settled. */
export const SETTLED = (sentAt, beforeControl) =>
  `(${turnSettlement})(window.__gate, ${sentAt}, ${JSON.stringify(beforeControl)}).settledAt !== null`;

/**
 * One turn from the input event at or after `sentAt`, the state `before` it shown: feedback is the frame after the
 * first DOM change; settlement is `turnSettlement`'s. `end` is how the driver saw the turn end when it did not settle:
 * `ended` (the script's end), `cut` (nothing to answer and no change for 10 s), or `null`; a turn that neither settled
 * nor ended is not ok. Every interval is a `span`, so a missing or reversed endpoint throws.
 */
export function turnTimes(gate, sentAt, before, end = null) {
  const { submission, event } = turnSettlement(gate, sentAt, nullable(before, "control"), nullable);
  if (submission === null) return { ok: false, reason: "no input recorded" };
  const change = gate.changes.find((record) => record.t > submission.t);
  if (change === undefined) return { ok: false, reason: "no DOM change after the input" };
  const feedbackFrame = frameOf(change, "the feedback change");
  if (feedbackFrame === null) return { ok: false, reason: "no feedback frame after the input" };
  const row = gate.rows.find(
    (record) =>
      record.speaker !== "user" &&
      record.t > submission.t &&
      nullable(record, "shownFrame") !== null,
  );
  const times = {
    submissionMs: submission.ts,
    feedbackMs: span(submission.ts, feedbackFrame, "the turn's input → its feedback frame"),
    firstScriptRowMs:
      row === undefined
        ? null
        : span(submission.ts, row.shownFrame, "the turn's input → the first script row shown"),
  };
  if (event === null)
    return end === null
      ? { ok: false, reason: "neither settled nor ended", ...times }
      : { ok: true, end, ...times, settledMs: null };
  span(event.t, event.at, `the settling ${event.by}: its event → its frame`);
  return {
    ok: true,
    ...times,
    settledMs: span(submission.ts, event.at, "the turn's input → its settlement"),
    settledBy: event.by,
  };
}

/** The `sessions` publish transactions of scope `scope` (any scope when `null`) that committed after `after`. */
export function publishesAfter(gate, after, scope = null) {
  return gate.transactions.filter(
    (transaction) =>
      transaction.start > after &&
      nullable(transaction, "outcome") === "complete" &&
      transaction.puts.some(
        (put) => put.store === "sessions" && (scope === null || nullable(put, "scope") === scope),
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
  const outcome = nullable(save, "outcome");
  if (outcome !== "complete")
    return { ok: false, outcome, reason: `the first save ${outcome ?? "never ended"}` };
  const plan = save.puts.find((put) => put.store === "plans");
  const session = save.puts.find((put) => put.store === "sessions");
  const longTasks = nullable(gate, "longTasks");
  const blocked =
    longTasks === null
      ? null
      : longTasks.filter((task) => task.start + task.duration > pressMs && task.start < save.end);
  return {
    ok: true,
    outcome,
    scope: nullable(session, "scope"),
    planScope: nullable(plan, "scope"),
    startToCommitMs: span(pressMs, save.end, "Start's input → the first save's commit"),
    transactionMs: span(save.start, save.end, "the first save's transaction"),
    planJsonLength: plan.length,
    longTasksMs: blocked === null ? null : blocked.reduce((sum, task) => sum + task.duration, 0),
    longTaskMaxMs:
      blocked === null || blocked.length === 0
        ? null
        : Math.max(...blocked.map((task) => task.duration)),
    longTasksUnavailable: nullable(gate, "longTasksUnavailable"),
  };
}

/** The engine Worker's start: its construction to its `ready` (`null` until ready), or `null` for a page without one. */
export function workerStart(gate) {
  const worker = gate.workers.find((record) => record.engine);
  if (worker === undefined) return null;
  const ready = nullable(worker, "ready");
  return {
    constructedMs: worker.constructed,
    readyMs: ready,
    startMs: ready === null ? null : span(worker.constructed, ready, "the engine Worker's start"),
  };
}

/** Each request in `log` (the instrumented variant's) with its reply: op, ID, post and reply times, round trip. */
export function requestsOf(log) {
  // A message outside a request (the Worker's `ready`, a delivery) has no ID: it may truly be absent.
  const replies = new Map(
    log
      .filter((entry) => entry.dir === "reply" && nullable(entry, "id") !== null)
      .map((entry) => [entry.id, entry]),
  );
  return log
    .filter((entry) => entry.dir === "post" && nullable(entry, "id") !== null)
    .map((post) => {
      const reply = replies.get(post.id) ?? null;
      return {
        op: nullable(post, "op"),
        id: post.id,
        postAt: post.at,
        postMs: nullable(post, "postMs"),
        replyAt: reply === null ? null : reply.at,
        rttMs:
          reply === null ? null : span(post.at, reply.at, `${nullable(post, "op")}'s round trip`),
        replySize: reply === null ? null : nullable(reply, "size"),
      };
    });
}

/** The engine Worker's handling and the delivery latency per request, from its injected log and the page's posts. */
export function workerSideOf(workerLog, requests, timeOrigin) {
  // A scenario's live call has no log on a page without an engine Worker.
  if (workerLog === null) return null;
  return requests.map((request) => {
    const receipt = workerLog.find(
      (entry) => entry.dir === "request" && nullable(entry, "id") === request.id,
    );
    const reply = workerLog.find(
      (entry) => entry.dir === "reply" && nullable(entry, "id") === request.id,
    );
    return {
      op: request.op,
      id: request.id,
      deliveryMs:
        receipt === undefined
          ? null
          : crossClock(timeOrigin + request.postAt, receipt.at, `${request.op}'s delivery`),
      handlingMs:
        receipt === undefined || reply === undefined
          ? null
          : span(receipt.at, reply.at, `${request.op}'s handling in the Worker`),
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
