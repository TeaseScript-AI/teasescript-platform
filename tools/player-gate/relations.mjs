// The kit's relation inventory (#2122), shared by `records.test.mjs` and `check-sites.test.mjs`: the order relations and
// evidence rules, each with the fixture it applies to (`fixtures.mjs`), the change that breaks it, the cells that must
// fail and the reason they must give.

/**
 * `gate` with every frame from `t` on still pending: the probe has recorded those records, but no frame has run for
 * them yet, which is a page's legitimate tail (`validate.mjs` `framesComplete`).
 */
function pendingFrom(gate, t) {
  for (const list of ["states", "changes", "rowChanges", "rows"])
    for (const record of gate[list]) if (record.t >= t) delete record.frame;
}

/**
 * Family (b): the order relations and evidence rules the validation checks, written here: each with the fixture it
 * applies to, the change that reverses or removes its evidence, the cells that change must fail, and the reason each
 * of them must give (or the cells named sixth, for a field's own reason).
 */
export const RELATIONS = [
  [
    "playable: Start enabled → its input",
    "session chromium main",
    (r) => (r.result.probe.cold.inputs[0].ts = 400),
    ["counts", "timing"],
    "Start enabled → its input runs from 500 to 400",
  ],
  [
    "playable: a state's event → its frame",
    "session chromium main",
    (r) => (r.result.probe.cold.states[0].frame = 490),
    ["counts", "timing"],
    "Start enabled: its event → its frame",
  ],
  [
    "playable: the input → the first control's frame",
    "session chromium main",
    (r) => (r.result.probe.cold.inputs[0].ts = 717),
    ["counts", "timing"],
    "Start's input → the first control's frame",
  ],
  [
    "playable: Start's frame → its input",
    "session chromium main",
    (r) => (r.result.probe.cold.inputs[0].ts = 505),
    ["counts", "timing"],
    "Start's frame → its input",
  ],
  [
    "session: a page's ended transaction has its outcome",
    "session chromium main",
    (r) => (r.result.probe.repeat.transactions[0].outcome = null),
    ["counts", "timing"],
    "the repeat page's transaction 0: its outcome, beside its end",
  ],
  [
    "turn: the input → its feedback frame",
    "session chromium main",
    (r) => (r.result.probe.repeat.inputs[1].ts = 940),
    ["counts", "timing"],
    "the turn's input → its feedback frame",
  ],
  [
    "turn: a change's event → its frame",
    "session chromium main",
    (r) => (r.result.probe.repeat.changes = [{ t: 920, frame: 910 }]),
    ["counts", "timing"],
    "the feedback change: its event → its frame",
  ],
  [
    "turn: the settling event → its frame",
    "session chromium main",
    (r) => (r.result.probe.repeat.states[2].frame = 940),
    ["counts", "timing"],
    "the settling control: its event → its frame",
  ],
  [
    "first save: its start → its commit",
    "session chromium main",
    (r) => (r.result.probe.cold.transactions[0].end = 599),
    ["counts", "timing"],
    "the cold page's transaction 0: its start → its end",
  ],
  [
    "Worker start: construction → ready",
    "session chromium worker",
    (r) => (r.result.probe.cold.workers[0].ready = 90),
    ["counts", "timing"],
    "the engine Worker's start",
  ],
  [
    "Worker start: ready present",
    "session chromium worker",
    (r) => (r.result.probe.cold.workers[0].ready = null),
    ["counts", "timing"],
    "the engine Worker reaching ready",
  ],
  [
    "byte marks: Start enabled → playable",
    "session chromium main",
    (r) => {
      const marks = r.result.bytes.marks;
      [marks.startEnabled, marks.playable] = [marks.playable, marks.startEnabled];
    },
    ["counts"],
    "the byte page's Start enabled → playable",
  ],
  [
    "byte phases: the cached flag against the start",
    "session chromium main",
    (r) => (r.result.bytes.requests[0].beforeStartEnabled = false),
    ["counts"],
    "/player/: its cached beforeStartEnabled (false) is not its start against the mark (true)",
  ],
  [
    // An open request has no length: its served bytes are no count, which the output domain refuses.
    "byte account: every request finished or failed",
    "session chromium main",
    (r) => Object.assign(r.result.bytes.requests[0], { finished: false, encodedBytes: null }),
    ["counts"],
    "served the whole cold page, page, encoded: NaN is no safe integer ≥ 0",
  ],
  [
    "probe records: none dropped",
    "session chromium main",
    (r) => (r.result.probe.repeat.dropped = 1),
    ["counts", "timing"],
    "the repeat page: 1 probe records dropped",
  ],
  [
    "instrumented: a post → its reply",
    "sessionInstrumented chromium worker",
    (r) => (r.result.diagnostics.bridgeLogs.cold[2].at = 519),
    ["counts", "crossClock", "timing"],
    "prepare's round trip runs from 520 to 519",
  ],
  [
    "instrumented: a Worker receipt → its reply",
    "sessionInstrumented chromium worker",
    (r) => (r.result.diagnostics.workerLogs.cold[2].at = 10_520),
    ["counts", "crossClock", "timing"],
    "prepare's handling in the Worker",
  ],
  [
    "bridge: a request → its reply",
    "bridge chromium worker",
    (r) => (r.result.requests[2].replyAt = 199),
    ["crossClock", "timing"],
    "preparePlanText's round trip",
  ],
  [
    "bridge: Worker construction → ready",
    "bridge chromium worker",
    (r) => (r.result.at.workerReady = 39),
    ["crossClock", "timing"],
    "the bridge page's Worker start",
  ],
  [
    "bridge: a Worker receipt → its reply",
    "bridge chromium worker",
    (r) => (r.result.workerLog[2].at = 10_100),
    ["crossClock", "timing"],
    "prepare's handling in the Worker",
  ],
  [
    "taps: the window",
    "taps chromium main",
    (r) => (r.result.window = { fromMs: 100, toMs: 0 }),
    ["counts", "timing"],
    "the taps window",
  ],
  [
    "taps: a tap's event → its handler",
    "taps chromium main",
    (r) => (r.result.deliveries[0].ts = 16),
    ["counts", "timing"],
    "tap 1: its event → its handler",
  ],
  [
    "taps: the sends in order",
    "taps chromium main",
    (r) => (r.result.ledger[1].sentMs = 9),
    ["counts", "timing"],
    "the sends 0 → 1",
  ],
  [
    "keep: a transaction's start → its end",
    "keepHandler chromium",
    (r) => (r.result.transactions[0].end = 150),
    ["timing"],
    "transaction 0: its start → its end",
  ],
  [
    // Sol code r1's witness: an aborted capture without its end, its cached outcome agreeing.
    "keep: a transaction with an outcome has its end",
    "keepHandler chromium",
    (r) => {
      r.result.outcome = "aborted";
      r.result.transactions = [{ ...r.result.transactions[0], end: null, outcome: "abort" }];
    },
    ["timing"],
    "transaction 0: its end, beside its outcome",
  ],
  [
    "keep: an ended transaction has its outcome",
    "keepHandler chromium, an aborted and an open transaction",
    (r) => (r.result.transactions[1].outcome = null),
    ["timing"],
    "transaction 1: its outcome, beside its end",
  ],
  [
    "keep: a committed capture has its end",
    "keepHandler chromium, an aborted and an open transaction",
    (r) => (r.result.transactions[0].end = null),
    ["timing"],
    "transaction 0: its end, beside its outcome",
  ],
  [
    "keep: the page reported hidden (R5-02)",
    "keepHandler chromium",
    (r) => (r.result.lifecycle = [r.result.lifecycle[1]]),
    ["timing"],
    "row.result.lifecycle: a visibilitychange to hidden",
  ],
  [
    "keep: the cached outcome",
    "keepHandler chromium",
    (r) => (r.result.outcome = "aborted"),
    ["timing"],
    "the recorded outcome (aborted) is not its records' (completed)",
  ],
  [
    "durable: the baseline present (R6)",
    "keepDurable pixel",
    (r) => (r.result.baselineMs = null),
    ["timing"],
    "missing evidence: row.result.baselineMs",
  ],
  [
    "durable: the cached outcome",
    "keepDurable pixel",
    (r) => (r.result.outcome = "not durable after 1 s"),
    ["timing"],
    "the recorded outcome (not durable after 1 s) is not its records' (durable after 1 s)",
  ],
  [
    "demo: the cached pass",
    "demo chromium",
    (r) => (r.result.ok = false),
    ["counts", "timing"],
    "the recorded ok (false) is not its records' (true)",
  ],
  [
    "smoke: the cached pass against the exit (R6)",
    "delayedSmoke chromium",
    (r) => (r.result.exit = 1),
    ["timing"],
    "the recorded ok (true) is not its records' (false)",
  ],
  [
    "a sample that must complete and failed",
    "bridge chromium main",
    (r) => (r.ok = false),
    ["counts", "timing"],
    "the sample failed",
  ],
  // The rows the check sites' coverage demands (orchestrator 2's ruling (B)); each reason is its site's message.
  [
    "session: a turn without its records",
    "session chromium main",
    (r) => r.result.turns.push({ turn: 1 }),
    ["counts", "timing"],
    "turn 1: no records of the turn",
  ],
  [
    "session: no turn",
    "session chromium main",
    (r) => (r.result.turns = []),
    ["counts", "timing"],
    "a turn",
  ],
  [
    "playable: Start never shown enabled",
    "session chromium main",
    (r) => (r.result.probe.cold.states[0].start = null),
    ["counts", "timing"],
    "cold playable: Start was never shown enabled",
  ],
  [
    "playable: Start enabled has no frame",
    "session chromium main",
    (r) => pendingFrom(r.result.probe.cold, 500),
    ["counts", "timing"],
    "cold playable: Start enabled has no frame",
  ],
  [
    // Sol code r3's witness: A/A's own playable check, apart from the session's.
    "aa: Start enabled has no frame",
    "aa chromium full",
    (r) => pendingFrom(r.result.probe, 500),
    ["timing"],
    "cold playable: Start enabled has no frame",
  ],
  [
    "playable: no trusted input after Start",
    "session chromium main",
    (r) => r.result.probe.cold.inputs.forEach((input) => (input.trusted = false)),
    ["counts", "timing"],
    "cold playable: no trusted input after Start was enabled",
  ],
  [
    "playable: no control after the input",
    "session chromium main",
    (r) => (r.result.probe.cold.states = [r.result.probe.cold.states[0]]),
    ["counts", "timing"],
    "cold playable: no enabled control after Start's input",
  ],
  [
    "playable: the first control has no frame",
    "session chromium main",
    (r) => pendingFrom(r.result.probe.cold, 700),
    ["counts", "timing"],
    "cold playable: the first control has no frame",
  ],
  [
    "playable: Continue never shown enabled",
    "session chromium main",
    (r) => (r.result.probe.repeat.states[0].start = null),
    ["counts", "timing"],
    "repeat playable: Continue was never shown enabled",
  ],
  [
    "turn: no input recorded",
    "session chromium main",
    (r) => r.result.probe.repeat.inputs.pop(),
    ["counts", "timing"],
    "turn 0: no input recorded",
  ],
  [
    "turn: no DOM change after the input",
    "session chromium main",
    (r) => (r.result.probe.repeat.changes = []),
    ["counts", "timing"],
    "turn 0: no DOM change after the input",
  ],
  [
    "turn: no feedback frame",
    "session chromium main",
    (r) => pendingFrom(r.result.probe.repeat, 920),
    ["counts", "timing"],
    "turn 0: no feedback frame after the input",
  ],
  [
    "turn: neither settled nor ended",
    "session chromium main",
    (r) => {
      r.result.probe.repeat.states.pop();
      r.result.probe.repeat.rowChanges = [];
    },
    ["counts", "timing"],
    "turn 0: neither settled nor ended",
  ],
  [
    // Sol code r2's witness: feedback (961 → 1000) and the settling control (950 → 960) in order, the input after it.
    "turn: the input → its settlement",
    "session chromium main",
    (r) => {
      r.result.probe.repeat.inputs[1].ts = 961;
      r.result.probe.repeat.changes[0].frame = 1000;
    },
    ["counts", "timing"],
    "the turn's input → its settlement",
  ],
  [
    "turn: the input → the first script row shown",
    "session chromium main",
    (r) =>
      r.result.probe.repeat.rows.push({
        id: "m2",
        speaker: "system",
        t: 905,
        frame: 906,
        shownFrame: 898,
      }),
    ["counts", "timing"],
    "the turn's input → the first script row shown",
  ],
  [
    "first save: no publish",
    "session chromium main",
    (r) => (r.result.probe.cold.transactions = []),
    ["counts", "timing"],
    "first save: no publish with a session and a plan record after Start",
  ],
  [
    "first save: not complete",
    "session chromium main",
    (r) => (r.result.probe.cold.transactions[0].outcome = "abort"),
    ["counts", "timing"],
    "first save: the first save abort",
  ],
  [
    "a required field without a value",
    "session chromium worker",
    (r) => (r.result.probe.cold.workers[0].ready = null),
    ["counts", "timing"],
    "Worker: construction → ready (ms)",
    // The field's own cell gives its reason; the counts cell fails with the part it reads.
    ["timing"],
  ],
  [
    "instrumented: the start request's reply",
    "sessionInstrumented chromium worker",
    (r) =>
      (r.result.diagnostics.bridgeLogs.cold = r.result.diagnostics.bridgeLogs.cold.filter(
        (entry) => entry.id !== 2 || entry.dir !== "reply",
      )),
    ["counts", "crossClock", "timing"],
    "a start request with its reply in the cold log",
  ],
  [
    "taps: a CDP send error",
    "taps chromium main",
    (r) => (r.result.cdpErrors = ["Input.dispatchTouchEvent: closed"]),
    ["counts", "timing"],
    "1 CDP send errors",
  ],
  [
    "taps: a delivery no send has",
    "taps chromium main",
    (r) => (r.result.deliveries[1].id = 9),
    ["counts", "timing"],
    "1 taps off their grid point",
  ],
  [
    "taps: a tap off its grid point",
    "taps chromium main",
    (r) => (r.result.deliveries[1].x = 40),
    ["counts", "timing"],
    "1 taps off their grid point",
  ],
  // Sol final r1, F1 and the inventory's scope sites (orchestrator 2's ruling (a)): an ended transaction's session put
  // without its observation or its scope, or a trial without its scope, is no evidence, its cached negative agreeing.
  [
    "keep: a committed session put without its observation (Sol final r1)",
    "keepHandler chromium",
    (r) => {
      r.result.outcome = "not observed within 30 s";
      r.result.transactions[0].puts[0].observedMs = null;
    },
    ["timing"],
    "the trial's transaction 0: a session put's observed scene time",
  ],
  [
    "keep: a committed session put without its scope",
    "keepHandler chromium",
    (r) => {
      r.result.outcome = "not observed within 30 s";
      r.result.transactions[0].puts[0].scope = null;
    },
    ["timing"],
    "the trial's transaction 0: a session put's scope",
  ],
  [
    "keep: the trial without its scope",
    "keepHandler chromium",
    (r) => {
      r.result.outcome = "not observed within 30 s";
      delete r.result.scope;
    },
    ["timing"],
    "missing evidence: row.result.scope",
  ],
  [
    "session: a page's committed session put without its observation",
    "session chromium main",
    (r) => (r.result.probe.cold.transactions[0].puts[0].observedMs = null),
    ["counts", "timing"],
    "the cold page's transaction 0: a session put's observed scene time",
  ],
  // The implied sites' ordering rows (Sol final r1, F3): each breaks both the earlier check and the implied condition,
  // so the earlier check's reason pins which one speaks first.
  [
    "first save: a commit before the press (ordering)",
    "session chromium main",
    (r) => (r.result.probe.cold.transactions[0].end = 554),
    ["counts", "timing"],
    "the cold page's transaction 0: its start → its end",
  ],
  [
    "keep: a commit before the hiding (ordering)",
    "keepHandler chromium",
    (r) => (r.result.transactions[0].end = 99),
    ["timing"],
    "the trial's transaction 0: its start → its end",
  ],
  // The absence sites' witnesses: a value absent where its context requires it makes the cell incomplete.
  [
    "bridge: a request without its reply",
    "bridge chromium worker",
    (r) => (r.result.requests[1].replyAt = null),
    ["timing"],
    "start: request → reply (ms)",
  ],
  [
    "bridge: the Worker's reply absent",
    "bridge chromium worker",
    (r) => r.result.workerLog.splice(2, 1),
    ["timing"],
    "prepare: Worker receipt → reply (ms)",
  ],
  [
    "session: a worker build without its engine Worker's requests",
    "session chromium worker",
    (r) => (r.result.bytes.requests = r.result.bytes.requests.filter((q) => q.target === "page")),
    ["counts"],
    "requests of the engine Worker's target (count)",
  ],
  [
    "heap: the engine Worker's reading absent",
    "session chromium worker",
    (r) => (r.result.memory[0].workers[0].usedBytes = null),
    ["counts"],
    "heap, engine Worker, at Start enabled (bytes)",
  ],
  [
    "instrumented: the probe's gaps absent",
    "sessionInstrumented chromium worker",
    (r) => delete r.result.probe.cold.gaps,
    ["counts", "crossClock", "timing"],
    "missing evidence: row.result.probe.cold.gaps",
  ],
  [
    "first save: still open",
    "session chromium main",
    (r) => Object.assign(r.result.probe.cold.transactions[0], { end: null, outcome: null }),
    ["counts", "timing"],
    "first save: the first save never ended",
  ],
  [
    "first save: long tasks absent where the engine reports them",
    "session chromium main",
    (r) => (r.result.probe.cold.longTasks = null),
    ["timing"],
    "first save: long tasks in that span (ms)",
  ],
  // Sol code r6, F5: the client posts only requests, so a post without its ID is a request lost from the count.
  [
    "instrumented: a posted operation without its request ID",
    "sessionInstrumented chromium worker",
    (r) =>
      r.result.diagnostics.bridgeLogs.repeat.push({
        dir: "post",
        at: 906,
        postMs: 1,
        id: null,
        op: "observeInput",
        session: "s",
        atMs: 21,
      }),
    ["counts", "crossClock", "timing"],
    "a posted request's ID",
  ],
  [
    "instrumented: a posted operation with its request ID deleted",
    "sessionInstrumented chromium worker",
    (r) => delete r.result.diagnostics.bridgeLogs.cold[1].id,
    ["counts", "crossClock", "timing"],
    "the cold log's entry 1: a posted request's ID",
  ],
  // Sol code r7, F6: a state that shows buttons holds its controls root's serial; without it an unchanged action reads
  // as another one, and the turn settles early.
  [
    "turn: the state before without its controls' serial (Sol code r7)",
    "session chromium main",
    (r) => {
      const again = { ...r.result.turns[0].before, t: 910, frame: 915 };
      again.buttons = [{ ...again.buttons[0], label: "Go again" }];
      r.result.probe.repeat.states.splice(2, 0, again);
      r.result.probe.repeat.changes.unshift({ t: 909, frame: 915 });
      r.result.turns[0].before = { ...r.result.turns[0].before, control: null };
    },
    ["counts", "timing"],
    "turn 0's state before: a state with buttons, its controls' serial",
  ],
  [
    "turn: the state before with its controls' serial deleted",
    "session chromium main",
    (r) => {
      const before = { ...r.result.turns[0].before };
      delete before.control;
      r.result.turns[0].before = before;
    },
    ["counts", "timing"],
    "turn 0's state before: a state with buttons, its controls' serial",
  ],
  [
    "probe: a page's state with buttons without its controls' serial",
    "session chromium main",
    (r) =>
      (r.result.probe.repeat.states[2] = { ...r.result.probe.repeat.states[2], control: null }),
    ["counts", "timing"],
    "the repeat page's state 2: a state with buttons, its controls' serial",
  ],
  // Sol code r8, F7: frames arrive in the order they were asked for, so a record without its frame before a later drawn
  // one lost it; a settling candidate filtered out for it would report a later settlement.
  [
    "turn: a control state's frame lost before a later one (Sol code r8)",
    "session chromium main",
    (r) => (r.result.probe.repeat.states[2].frame = null),
    ["counts", "timing"],
    "the repeat page's states 2: its frame, before a later record's",
  ],
  [
    "turn: a control state's frame deleted before a later one",
    "session chromium main",
    (r) => delete r.result.probe.repeat.states[2].frame,
    ["counts", "timing"],
    "the repeat page's states 2: its frame, before a later record's",
  ],
  [
    "turn: a row update's frame lost before a later one (Sol code r8)",
    "session chromium main",
    (r) => Object.assign(r.result.probe.repeat.rowChanges[0], { t: 920, frame: null }),
    ["counts", "timing"],
    "the repeat page's rowChanges 0: its frame, before a later record's",
  ],
  // Sol code r9: a list's order is its records' request order, so a tie in time still orders them; the frame missing
  // before a later drawn record of the same list was lost.
  [
    "turn: a tied control state's frame lost before the next one's (Sol code r9)",
    "session chromium main",
    (r) => {
      const gate = r.result.probe.repeat;
      gate.rowChanges = [];
      gate.states.push({ ...gate.states[2], control: 4, frame: 975 });
      gate.states[2] = { ...gate.states[2], frame: null };
    },
    ["counts", "timing"],
    "the repeat page's states 2: its frame, before a later record's",
  ],
  [
    "turn: a tied row update's frame lost before the next one's (Sol code r9)",
    "session chromium main",
    (r) => {
      const gate = r.result.probe.repeat;
      gate.states[2] = { ...gate.states[2], control: 2 };
      gate.rows.push({ id: "m2", speaker: "system", t: 610, frame: 615, shownFrame: 620 });
      gate.rowChanges.push({ ...gate.rowChanges[0], id: "m2", frame: 990 });
      gate.rowChanges[0] = { ...gate.rowChanges[0], frame: null };
    },
    ["counts", "timing"],
    "the repeat page's rowChanges 0: its frame, before a later record's",
  ],
];

/** Each `ms` field's relations, written here: a field that reports an interval names the relation that orders it. */
export const FIELD_RELATIONS = {
  "playable, the Player's own time (headline)": [
    "playable: a state's event → its frame",
    "playable: the input → the first control's frame",
  ],
  "navigation → the frame after": ["playable: a state's event → its frame"],
  "input → the frame after the first control": ["playable: the input → the first control's frame"],
  "enabled → its input": [
    "playable: Start enabled → its input",
    "playable: Start's frame → its input",
  ],
  "Worker: construction → ready": [
    "Worker start: construction → ready",
    "bridge: Worker construction → ready",
  ],
  // The first save is the first transaction to start after the press (`firstSave`), so its start → end orders it.
  "first save: Start's input → commit": ["first save: its start → its commit"],
  "first save: long tasks in that span": ["first save: its start → its commit"],
  "turn: input → feedback frame": ["turn: the input → its feedback frame"],
  "turn: input → settled frame": ["turn: the settling event → its frame"],
  "diagnostic: ": [
    "instrumented: a post → its reply",
    "instrumented: a Worker receipt → its reply",
  ],
  ": request → reply": ["bridge: a request → its reply"],
  "prepare: Worker receipt → reply": ["bridge: a Worker receipt → its reply"],
  "prepare: post duration": ["a recorded duration: family (a)'s refused values"],
  "delay, ": ["taps: a tap's event → its handler"],
  "send cadence, median": ["taps: the sends in order"],
  "clock offset uncertainty": ["a recorded duration: family (a)'s refused values"],
  // A capture counts only when it started after the hiding (`hiddenCapture`), so its start → end orders it.
  "hidden → commit": ["keep: a transaction's start → its end"],
};
