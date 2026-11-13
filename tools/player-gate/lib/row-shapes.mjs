// The closed shapes of the rows `drive.mjs` writes, one per scenario: every path a row may hold, with its type and
// domain, and the section of the result that owns it (#2122). `records.mjs` parses a row against its shape into the
// validated copy the derivations read; a path no shape declares fails its owning section. The record shapes follow
// their producers: the probe (`probe.mjs`), the CDP account (`cdp.mjs`), the Worker and bridge logs
// (`worker-log.mjs`, `variants/instrumented-client.mjs`), the bridge page (`bridge/page.mjs`) and the scenarios.
// A shape requires a value only where a section is no evidence without it; a field it leaves optional is still
// checked when present, and a derivation that reads it absent meets the strict reader's `MissingEvidence`.

/** A clock reading or a recorded duration, in ms: a number in [0, `Number.MAX_SAFE_INTEGER`]. */
export const time = Object.freeze({ kind: "time" });
/** A signed quantity in ms (a clock offset): a number of at most `Number.MAX_SAFE_INTEGER` either way. */
export const signed = Object.freeze({ kind: "signed" });
/** Any finite number (a coordinate, a battery reading). */
export const real = Object.freeze({ kind: "real" });
/** A count, an identifier or a byte length: a safe integer ≥ 0. */
export const count = Object.freeze({ kind: "count" });
export const string = Object.freeze({ kind: "string" });
export const boolean = Object.freeze({ kind: "boolean" });
/** Any value, not copied: the row's own summaries and the CDP performance metrics, which no derivation reads. */
export const ignored = Object.freeze({ kind: "ignored" });

/** `shape`, or absent or `null`: a record not yet complete when it was read (a frame not drawn, a reply not arrived). */
export const optional = (shape) => Object.freeze({ ...shape, optional: true });
export const object = (fields) => Object.freeze({ kind: "object", fields });
export const array = (element) => Object.freeze({ kind: "array", element });
/** A cached flag or outcome a row carries: validated, kept apart from the copy, only compared with what is derived. */
export const cached = (shape) => Object.freeze({ kind: "cached", shape });
/** A result field the section `name` owns: its failure fails the cells that read that section, and no other. */
export const section = (name, shape) => Object.freeze({ kind: "section", name, shape });
/** A result field the report reads beside the axes (the A/A arm): parsed with the row's header. */
export const header = (shape) => Object.freeze({ kind: "header", shape });

const button = object({ label: string, enabled: boolean, image: optional(string) });
const composer = object({ enabled: boolean, asks: boolean, hint: string, inputMode: string });
/** A probe state (`probe.mjs` `readState`), stamped `t`, with its frame once drawn. */
const state = object({
  t: time,
  frame: optional(time),
  start: optional(object({ label: string, enabled: boolean })),
  control: optional(count),
  buttons: array(button),
  composer: optional(composer),
  ended: boolean,
  failed: boolean,
});
const stamped = (fields = {}) => object({ t: time, frame: optional(time), ...fields });
/** One page's probe records (`probe.mjs`), as `readGate` returns them. */
const gate = object({
  config: optional(
    object({ minimal: boolean, diagnostic: boolean, ignoredError: optional(string) }),
  ),
  states: array(state),
  inputs: array(object({ type: string, t: time, ts: time, trusted: boolean })),
  changes: array(stamped()),
  rows: array(
    object({
      id: string,
      speaker: string,
      t: time,
      frame: optional(time),
      shownFrame: optional(time),
    }),
  ),
  rowChanges: array(stamped({ id: string })),
  transactions: array(
    object({
      stores: optional(array(string)),
      start: time,
      end: optional(time),
      outcome: optional(string),
      // A plan put has no scope and no scene time; an ended transaction's session put requires both, a rule this shape
      // cannot state: `transactionsComplete` (`validate.mjs`) requires them.
      puts: array(
        object({
          store: string,
          scope: optional(string),
          observedMs: optional(time),
          length: optional(count),
        }),
      ),
    }),
  ),
  workers: array(
    object({ url: string, constructed: time, engine: boolean, ready: optional(time) }),
  ),
  longTasks: optional(array(object({ start: time, duration: time }))),
  longTasksUnavailable: optional(string),
  gaps: optional(array(object({ kind: string, at: time, gapMs: time }))),
  lifecycle: optional(array(object({ type: string, t: time, visibility: string }))),
  taps: optional(array(object({ id: count, t: time, ts: time, x: real, y: real }))),
  errors: optional(array(object({ t: time, text: string }))),
  dropped: count,
});

/** A heap reading at a milestone (`scenarios/session.mjs`). */
const heap = object({
  at: string,
  gc: optional(boolean),
  page: object({ usedBytes: count, totalBytes: optional(count) }),
  workers: array(
    object({
      url: string,
      engine: boolean,
      usedBytes: optional(count),
      totalBytes: optional(count),
    }),
  ),
});
/** One request of the CDP byte account (`cdp.mjs`), its phase flags cached. */
const request = object({
  target: string,
  url: string,
  wallTimeMs: time,
  status: optional(count),
  encodedBytes: optional(count),
  decodedBytes: count,
  finished: boolean,
  failed: optional(string),
  fromCache: optional(boolean),
  beforeStartEnabled: cached(boolean),
  beforePlayable: cached(boolean),
});
/** The cold byte page's account (`scenarios/session.mjs` `coldBytes`), with the attempts `drive.mjs` discarded. */
const byteAccount = object({
  ok: ignored,
  marks: object({ startEnabled: time, playable: time, firstSave: optional(time) }),
  requests: array(request),
  workers: optional(array(object({ url: string, errors: array(string) }))),
  discarded: array(object({ open: array(string), requests: ignored })),
});
/** A turn the driver sent (`scenarios/session.mjs`): when, the state before it, and how it ended if it did not settle. */
const turn = object({
  turn: optional(count),
  kind: optional(string),
  of: optional(count),
  sentAt: optional(time),
  before: optional(state),
  end: optional(string),
  reason: optional(string),
  // The turn's own summary, which the report derives again.
  ok: ignored,
  submissionMs: ignored,
  feedbackMs: ignored,
  firstScriptRowMs: ignored,
  settledMs: ignored,
  settledBy: ignored,
});
/** The instrumented port's log (`variants/instrumented-client.mjs`): posts and replies by request ID. */
const bridgeLog = array(
  object({
    dir: string,
    at: time,
    postMs: optional(time),
    id: optional(count),
    op: optional(string),
    session: optional(string),
    atMs: optional(time),
    kind: optional(string),
    ok: optional(boolean),
    size: optional(count),
  }),
);
/** The engine Worker's log (`worker-log.mjs`), on the epoch clock: requests and replies by ID. */
const workerLog = array(
  object({
    dir: string,
    at: time,
    id: optional(count),
    op: optional(string),
    kind: optional(string),
  }),
);

/** Every scenario's own summary fields at the result's top level, which the report never reads. */
const summaries = (...keys) => Object.fromEntries(keys.map((key) => [key, ignored]));

/** A session's result fields; the headline session's also hold its byte account (`extra`), the instrumented its logs. */
const sessionFields = {
  // The row's own `ok` (the header's) decides whether a sample that must complete failed; this one is a summary.
  ok: ignored,
  probe: section("timing", object({ cold: gate, repeat: gate })),
  turns: section("timing", array(turn)),
  memory: section("bytes", array(heap)),
  errors: ignored,
  ...summaries("cold", "repeat", "firstSave", "worker", "metrics"),
};

const keepTrial = object({
  ok: section("timing", ignored),
  outcome: section("timing", cached(string)),
  scope: section("timing", string),
  baselineMs: section("timing", time),
  lifecycle: section("timing", array(object({ type: string, t: time, visibility: string }))),
  transactions: section("timing", gate.fields.transactions),
  ...summaries("completed", "froze", "boundaryMs", "hiddenToCommitMs", "hiddenAt"),
});

const taps = object({
  ok: ignored,
  window: section("timing", object({ fromMs: time, toMs: time })),
  clock: section("timing", object({ offsetMs: signed, uncertaintyMs: time })),
  ledger: section("timing", array(object({ id: count, x: real, y: real, sentMs: time }))),
  deliveries: section("timing", array(object({ id: count, t: time, ts: time, x: real, y: real }))),
  cdpErrors: section("timing", array(string)),
  rectangle: ignored,
  overflow: ignored,
  ...summaries(
    "sent",
    "sentInAll",
    "answered",
    "unanswered",
    "outside",
    "delay",
    "within16",
    "cadence",
  ),
});

/** The row's header: the axes and the run facts the report prints. Each scenario's result shape is beside it. */
const HEADER = {
  scenario: string,
  script: string,
  route: string,
  backend: string,
  engine: string,
  sample: optional(count),
  build: string,
  commit: optional(string),
  version: optional(string),
  battery: optional(object({ acPowered: boolean, level: real, temperatureC: real })),
  hostPolicy: optional(string),
  ok: cached(boolean),
};

export const SHAPES = {
  session: {
    header: HEADER,
    result: object({ ...sessionFields, bytes: section("bytes", optional(byteAccount)) }),
  },
  sessionInstrumented: {
    header: HEADER,
    result: object({
      ...sessionFields,
      diagnostics: section(
        "diagnostics",
        object({
          bridgeLogs: object({ cold: bridgeLog, repeat: bridgeLog }),
          workerLogs: optional(object({ cold: optional(workerLog), repeat: optional(workerLog) })),
          timeOrigins: object({ cold: time, repeat: time }),
          ...summaries("cold", "repeat", "turns", "workerSide", "gaps"),
        }),
      ),
    }),
  },
  aa: {
    header: HEADER,
    result: object({
      ok: ignored,
      arm: header(string),
      probe: section("timing", gate),
      errors: ignored,
      ...summaries("cold"),
    }),
  },
  bridge: {
    header: HEADER,
    result: object({
      ok: ignored,
      at: section(
        "timing",
        object({ workerConstructed: optional(time), workerReady: optional(time) }),
      ),
      requests: section(
        "timing",
        array(
          object({ op: string, id: count, postAt: time, postMs: time, replyAt: optional(time) }),
        ),
      ),
      workerLog: section("timing", optional(workerLog)),
      timeOrigin: section("timing", optional(time)),
      inputUnits: section("input", count),
      inputBytes: section("input", count),
      ...summaries("script", "route", "backend", "workerSide", "error"),
    }),
  },
  taps: { header: HEADER, result: taps },
  bridgeTaps: { header: HEADER, result: taps },
  keepHandler: { header: HEADER, result: keepTrial },
  keepCompletion: { header: HEADER, result: keepTrial },
  keepDurable: {
    header: HEADER,
    result: object({
      ok: section("timing", ignored),
      outcome: section("timing", cached(string)),
      baselineMs: section("timing", time),
      storedMs: section("timing", optional(time)),
      ...summaries("completed"),
    }),
  },
  demo: {
    header: HEADER,
    result: object({
      ok: section("timing", cached(boolean)),
      errors: section("timing", array(string)),
      turns: section("timing", count),
      failed: section("timing", boolean),
      ...summaries("ended", "last", "rows"),
    }),
  },
  delayedSmoke: {
    header: { ...HEADER, delayMs: time },
    result: object({ ok: section("timing", cached(boolean)), exit: section("timing", count) }),
  },
};
