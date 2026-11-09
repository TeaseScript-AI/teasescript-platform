// The cost report's one deciding function over its cells (`cells.mjs`), the report's refusals (`report.mjs`), and the
// derivations whose boundaries Sol code r1 challenged (`lib/measure.mjs`, `scenarios/keep.mjs`), on synthetic records.
import assert from "node:assert/strict";
import test from "node:test";
import { AXES, allCells, cellName, classify } from "./cells.mjs";
import { buildReport } from "./report.mjs";
import { playable, turnTimes } from "./lib/measure.mjs";
import { hiddenCapture } from "./scenarios/keep.mjs";
import { releaser } from "./lib/release.mjs";
import { clearOriginsThrough } from "./lib/cdp.mjs";

test("every cell is decided in both phases, and every axis value is required somewhere", () => {
  for (const phase of ["r0", "r1"]) {
    const required = allCells().filter((cell) => classify(cell, phase).required);
    for (const [axis, values] of Object.entries(AXES))
      for (const value of values)
        assert.ok(
          required.some((cell) => cell[axis] === value),
          `${phase}: no required cell has ${axis} '${value}'`,
        );
  }
});

test("the exclusions name their reasons, and the Worker Player waits for r1", () => {
  const decide = (cell, phase = "r1") =>
    classify(
      { script: "DisciplineClinic", route: "source", backend: "main", engine: "chromium", ...cell },
      phase,
    );
  assert.equal(decide({ scenario: "taps", engine: "firefox" }).reason, "no CDP touch input");
  assert.equal(
    decide({ scenario: "session", route: "plan" }).reason,
    "the full Player prepares source only",
  );
  assert.equal(decide({ scenario: "bridge", route: "plan" }).required, true);
  assert.equal(decide({ scenario: "session", backend: "worker" }, "r0").rule, "worker Player");
  assert.equal(decide({ scenario: "session", backend: "worker" }, "r1").required, true);
  assert.equal(decide({ scenario: "bridge", backend: "worker" }, "r0").required, true);
  assert.equal(
    decide({ scenario: "keepDurable", script: "CelebWorship", engine: "pixel" }).required,
    true,
  );
  assert.equal(decide({ scenario: "keepDurable", script: "CelebWorship" }).rule, "phone only");
});

test("a value outside the axes is refused, never skipped", () => {
  assert.throws(
    () =>
      classify(
        {
          scenario: "session",
          script: "CelebWorship",
          route: "source",
          backend: "main",
          engine: "safari",
        },
        "r0",
      ),
    /no value of the axis 'engine'/u,
  );
  assert.throws(
    () =>
      classify(
        {
          scenario: "session",
          script: "CelebWorship",
          route: "source",
          backend: "main",
          engine: "pixel",
        },
        "r2",
      ),
    /no phase/u,
  );
});

const row = (cell, ok, result = {}) => ({
  route: "source",
  backend: "main",
  script: "CelebWorship",
  version: "1",
  build: "dist/player-app",
  commit: null,
  ok,
  result,
  ...cell,
});
const name = (cell) =>
  cellName({
    scenario: "session",
    script: "CelebWorship",
    route: "source",
    backend: "main",
    engine: "chromium",
    ...cell,
  });

test("the report fails on a row for an excluded cell", () => {
  assert.throws(
    () =>
      buildReport(
        [row({ scenario: "taps", engine: "webkit", script: "DisciplineClinic" }, true)],
        "r0",
      ),
    /excluded cell/u,
  );
});

/**
 * A page's probe records, as `readGate` returns them, of a page whose `label` button is enabled at 500 ms and pressed at
 * 555 ms, whose first control (serial 2) shows at 716 ms, and whose turn input at 899 ms is followed by a change and a
 * control of another action (serial 3) at 960 ms; with the cold page's first save and, on a worker build, the engine
 * Worker's start.
 */
function pageRecords(label, { worker = false, longTasks = [] } = {}) {
  const state = (t, frame, extra) => ({
    t,
    frame,
    start: null,
    control: null,
    buttons: [],
    composer: null,
    ended: false,
    failed: false,
    ...extra,
  });
  const button = (control) => ({ control, buttons: [{ label: "Go", enabled: true }] });
  return {
    states: [
      state(500, 510, { start: { label, enabled: true } }),
      state(700, 716, button(2)),
      state(950, 960, button(3)),
    ],
    inputs: [
      { type: "pointerdown", t: 560, ts: 555, trusted: true },
      { type: "pointerdown", t: 900, ts: 899, trusted: true },
    ],
    changes: [{ t: 920, frame: 930 }],
    rows: [],
    rowChanges: [],
    transactions: [
      {
        start: 600,
        end: 630,
        outcome: "complete",
        puts: [
          { store: "sessions", scope: "s", observedMs: 1, length: 5 },
          { store: "plans", scope: "s", observedMs: null, length: 10 },
        ],
      },
    ],
    workers: worker
      ? [{ url: "engine.worker.js", engine: true, constructed: 100, ready: 150 }]
      : [],
    gaps: [],
    longTasks,
    errors: [],
  };
}

/** A complete headline session on `engine` and `backend`, its records as a session row keeps them. */
function sessionResult({ engine = "chromium", backend = "main" } = {}) {
  const cdp = engine === "chromium" || engine === "pixel";
  const worker = backend === "worker";
  const longTasks = cdp ? [] : null;
  const heap = (at) => ({
    at,
    page: { usedBytes: 1 },
    workers: worker ? [{ url: "engine.worker.js", engine: true, usedBytes: 2 }] : [],
  });
  const cold = pageRecords("Start", { worker, longTasks });
  const repeat = pageRecords("Continue", { worker, longTasks });
  return {
    probe: { cold, repeat },
    turns: [{ turn: 0, ok: true, sentAt: 880, before: repeat.states[1], end: null }],
    ...(cdp
      ? {
          memory: ["startEnabled", "playable", "firstSave", "afterTurns", "end"].map(heap),
          bytes: {
            requests: [
              {
                target: "page",
                finished: true,
                failed: null,
                encodedBytes: 7,
                decodedBytes: 14,
                beforeStartEnabled: true,
                beforePlayable: true,
              },
              ...(worker
                ? [
                    {
                      target: "engine.worker.js",
                      finished: true,
                      failed: null,
                      encodedBytes: 3,
                      decodedBytes: 6,
                    },
                  ]
                : []),
            ],
          },
        }
      : {}),
  };
}
const ARTIFACTS = [{ build: "main", files: [], totals: {} }];

test("a sample counts only with every required field that applies; missing evidence is incomplete", () => {
  const complete = buildReport(
    [
      row({ scenario: "session", engine: "chromium" }, true, sessionResult()),
      row({ scenario: "session", engine: "firefox" }, true, sessionResult({ engine: "firefox" })),
    ],
    "r0",
    ARTIFACTS,
  );
  assert.ok(name({}) in complete.summary);
  // Firefox has no CDP: its bytes, heap and long tasks do not apply and are left out, not printed as a dash.
  assert.ok(name({ engine: "firefox" }) in complete.summary);
  assert.ok(
    !Object.keys(complete.summary[name({ engine: "firefox" })]).some((label) =>
      label.startsWith("heap"),
    ),
  );

  // An ok row with no measurements, the R1-02 probe: incomplete, with what is missing.
  const empty = buildReport(
    [row({ scenario: "session", engine: "chromium" }, true)],
    "r0",
    ARTIFACTS,
  );
  const line = empty.incomplete.find((text) => text.includes(name({})));
  assert.match(line, /0 complete; missing: the probe's records of both pages; .*cold: playable/u);
  // A missing heap milestone or an unfinished request is missing evidence too.
  const noHeap = sessionResult();
  noHeap.memory = noHeap.memory.filter((reading) => reading.at !== "startEnabled");
  const unfinished = sessionResult();
  unfinished.bytes.requests.push({
    target: "page",
    finished: false,
    failed: null,
    encodedBytes: null,
  });
  for (const result of [noHeap, unfinished])
    assert.ok(
      buildReport(
        [row({ scenario: "session", engine: "chromium" }, true, result)],
        "r0",
        ARTIFACTS,
      ).incomplete.some((text) => text.includes(name({}))),
    );
  // Each of these alone leaves the sample incomplete, since every field is derived again from the records (Sol code r2
  // and r3's reproductions): a failed turn; a missing byte length; no probe records; emptied cold states; no
  // transactions; only aborted ones; a change stamped before the turn's input; summaries that claim otherwise.
  const variants = {
    failedTurn: (r) => r.turns.push({ ok: false, reason: "Turn 1 did not settle" }),
    noLength: (r) => delete r.bytes.requests[0].encodedBytes,
    noProbe: (r) => delete r.probe,
    emptiedStates: (r) => (r.probe.cold.states = []),
    noTransactions: (r) => (r.probe.cold.transactions = []),
    aborted: (r) =>
      (r.probe.cold.transactions = r.probe.cold.transactions.map((t) => ({
        ...t,
        outcome: "abort",
      }))),
    feedbackBeforeInput: (r) => (r.probe.repeat.changes = [{ t: 920, frame: 800 }]),
    // A second turn without feedback: the median of the first would hide it (Sol code r4, R4-01).
    missingFeedback: (r) => {
      r.probe.repeat.inputs.push({ type: "pointerdown", t: 1000, ts: 999, trusted: true });
      r.probe.repeat.states.push({ ...r.probe.repeat.states[2], t: 1050, frame: 1060, control: 4 });
      r.turns.push({ turn: 1, ok: true, sentAt: 990, before: r.probe.repeat.states[2], end: null });
    },
    // A commit stamped before its own start (Sol code r4).
    reversedSave: (r) => (r.probe.cold.transactions[0].end = 0),
  };
  for (const [what, change] of Object.entries(variants)) {
    const result = sessionResult();
    change(result);
    // A summary the row carries is never read.
    result.firstSave = { ok: true, startToCommitMs: 1 };
    assert.ok(
      buildReport(
        [row({ scenario: "session", engine: "chromium" }, true, result)],
        "r0",
        ARTIFACTS,
      ).incomplete.some((text) => text.includes(name({}))),
      what,
    );
  }
  // No artifact inventory: incomplete.
  assert.ok(buildReport([], "r0").incomplete.includes("- artifacts: no inventory given"));
});

test("a worker build needs its engine Worker's start and heap; the A/A run needs both arms", () => {
  const cell = { scenario: "session", engine: "chromium", backend: "worker" };
  const withoutWorker = sessionResult({ backend: "worker" });
  withoutWorker.probe.cold.workers = [];
  const report = buildReport([row(cell, true, withoutWorker)], "r1", ARTIFACTS);
  assert.match(
    report.incomplete.find((text) => text.includes(name({ backend: "worker" }))),
    /Worker: construction → ready/u,
  );
  const aa = (arm) =>
    row({ scenario: "aa", engine: "chromium" }, true, { arm, probe: pageRecords("Start") });
  const one = buildReport([aa("full"), aa("full")], "r0", ARTIFACTS);
  assert.ok(one.incomplete.some((text) => text.includes("no complete minimal arm")));
  const both = buildReport([aa("full"), aa("minimal")], "r0", ARTIFACTS);
  assert.ok(!both.incomplete.some((text) => text.includes(name({ scenario: "aa" }))));
  // An A/A arm with emptied states has no playable time.
  const emptied = aa("minimal");
  emptied.result.probe.states = [];
  assert.ok(
    buildReport([aa("full"), emptied], "r0", ARTIFACTS).incomplete.some((text) =>
      text.includes("no complete minimal arm"),
    ),
  );
});

test("the instrumented Worker cell needs its logs, not the headline's byte account; emptied records refuse it", () => {
  const cell = { scenario: "sessionInstrumented", engine: "chromium", backend: "worker" };
  const instrumented = () => {
    const result = sessionResult({ backend: "worker" });
    delete result.bytes;
    const log = [
      { dir: "post", at: 520, postMs: 1, id: 1, op: "prepare" },
      { dir: "reply", at: 530, id: 1 },
      { dir: "post", at: 540, postMs: 1, id: 2, op: "start" },
      { dir: "reply", at: 545, id: 2 },
      { dir: "post", at: 600, postMs: 1, id: 3, op: "continue" },
      { dir: "reply", at: 602, id: 3 },
    ];
    const workerLog = [
      { dir: "request", at: 10_521, id: 1, op: "prepare" },
      { dir: "reply", at: 10_529, id: 1 },
      { dir: "request", at: 10_541, id: 2, op: "start" },
      { dir: "reply", at: 10_544, id: 2 },
    ];
    result.diagnostics = {
      bridgeLogs: { cold: log, repeat: log },
      workerLogs: { cold: workerLog, repeat: workerLog },
      timeOrigins: { cold: 10_000, repeat: 10_000 },
    };
    return result;
  };
  const named = name({ scenario: "sessionInstrumented", backend: "worker" });
  assert.ok(
    !buildReport([row(cell, true, instrumented())], "r1", ARTIFACTS).incomplete.some((text) =>
      text.includes(named),
    ),
  );
  for (const change of [
    (r) => (r.diagnostics.workerLogs.cold = []),
    (r) => delete r.diagnostics.timeOrigins,
    (r) => (r.diagnostics.bridgeLogs.cold = []),
  ]) {
    const result = instrumented();
    change(result);
    assert.ok(
      buildReport([row(cell, true, result)], "r1", ARTIFACTS).incomplete.some((text) =>
        text.includes(named),
      ),
    );
  }
});

test("a keep trial's recorded outcome must be its records' own", () => {
  const cell = { scenario: "keepHandler", engine: "chromium" };
  const trial = (records) =>
    row(cell, true, {
      outcome: "completed",
      hiddenAt: 100,
      scope: "s",
      baselineMs: 5,
      lifecycle: [{ type: "visibilitychange", t: 100, visibility: "hidden" }],
      transactions: [
        {
          start: 200,
          end: 300,
          outcome: "complete",
          puts: [{ store: "sessions", scope: "s", observedMs: 9 }],
        },
      ],
      ...records,
    });
  const named = name({ scenario: "keepHandler" });
  assert.ok(
    !buildReport([trial({})], "r0", ARTIFACTS).incomplete.some((text) => text.includes(named)),
  );
  // No transactions, or no hiding in the lifecycle records (Sol code r4): the outcome is not the records' own.
  for (const records of [{ transactions: [] }, { lifecycle: [] }])
    assert.ok(
      buildReport([trial(records)], "r0", ARTIFACTS).incomplete.some((text) =>
        text.includes(named),
      ),
      JSON.stringify(records),
    );
});

test("playable is the Player's own two intervals, and a timestamp outside its boundaries is refused", () => {
  const state = (t, frame, extra) => ({
    t,
    frame,
    start: null,
    control: null,
    buttons: [],
    composer: null,
    ...extra,
  });
  const gate = {
    states: [
      state(500, 510, { start: { label: "Start", enabled: true } }),
      state(700, 716, { control: 2, buttons: [{ label: "Go", enabled: true }] }),
    ],
    inputs: [{ type: "pointerdown", t: 560, ts: 555, trusted: true }],
  };
  assert.deepEqual(playable(gate, "Start"), {
    ok: true,
    enabledMs: 500,
    enabledFrameMs: 510,
    inputMs: 555,
    enabledToInputMs: 45,
    inputToControlMs: 161,
    playableMs: 671,
  });
  // An input stamped before Start was enabled is outside the boundaries.
  const early = { ...gate, inputs: [{ type: "pointerdown", t: 560, ts: 400, trusted: true }] };
  assert.equal(playable(early, "Start").ok, false);
});

test("a turn settles at an enabled control of another action, even with the same label; neither settled nor ended fails", () => {
  const next = (control, t) => ({
    t,
    frame: t + 10,
    start: null,
    control,
    buttons: [{ label: "Next", enabled: true }],
    composer: null,
  });
  const before = next(1, 100);
  const gate = {
    states: [before, next(2, 300)],
    changes: [{ t: 250, frame: 262 }],
    rows: [],
    inputs: [{ type: "pointerdown", t: 201, ts: 200, trusted: true }],
  };
  assert.deepEqual(turnTimes(gate, 150, before), {
    ok: true,
    submissionMs: 200,
    feedbackMs: 62,
    firstScriptRowMs: null,
    settledMs: 110,
    settledBy: "control",
  });
  const unsettled = { ...gate, states: [before] };
  assert.equal(turnTimes(unsettled, 150, before).ok, false);
  assert.equal(turnTimes(unsettled, 150, before, "ended").end, "ended");
});

test("a hidden capture counts only while hidden; one committed after resume is its own outcome", () => {
  const gate = (end) => ({
    lifecycle: [{ type: "visibilitychange", t: 30_100, visibility: "visible" }],
    transactions: [
      {
        start: end - 50,
        end,
        outcome: "complete",
        puts: [{ store: "sessions", scope: "s", observedMs: 9 }],
      },
    ],
  });
  const resumed = hiddenCapture(gate(30_200), 100, "s", 5);
  assert.equal(resumed.kept, undefined);
  assert.notEqual(resumed.keptAfterResume, undefined);
  assert.notEqual(hiddenCapture(gate(20_000), 100, "s", 5).kept, undefined);
});

test("a run's release clears the Pixel's origins before it closes the browser, goes on past a failure, and runs once", async () => {
  const steps = [];
  const run = {
    opened: {
      clearOrigins: async (origins) => steps.push(`clear ${origins.join(",")}`),
      close: async () => {
        steps.push("close");
        throw new Error("lost");
      },
    },
    origins: ["http://localhost:1"],
    reverses: [1],
    removeReverse: (port) => steps.push(`reverse ${port}`),
    hosts: [{ close: async () => steps.push("host") }],
  };
  const release = releaser(run);
  const [first, second] = await Promise.all([release(), release()]);
  assert.equal(first, second);
  assert.deepEqual(steps, ["clear http://localhost:1", "close", "reverse 1", "host"]);
  assert.deepEqual(first, [{ step: "browser", error: "lost" }]);
});

test("a hidden capture committed after the 30 s but before the page showed again is late, not after resume", () => {
  const gate = {
    lifecycle: [{ type: "visibilitychange", t: 32_000, visibility: "visible" }],
    transactions: [
      {
        start: 30_400,
        end: 30_500,
        outcome: "complete",
        puts: [{ store: "sessions", scope: "s", observedMs: 9 }],
      },
    ],
  };
  const found = hiddenCapture(gate, 100, "s", 5);
  assert.equal(found.kept, undefined);
  assert.equal(found.keptAfterResume, undefined);
  assert.notEqual(found.keptLate, undefined);
});

test("a turn settles at an update of a message shown before it, and a new row at its first positive-opacity frame", () => {
  const before = {
    t: 100,
    frame: 110,
    start: null,
    control: 1,
    buttons: [{ label: "Next", enabled: true }],
    composer: null,
  };
  const base = {
    states: [before],
    changes: [{ t: 250, frame: 262 }],
    inputs: [{ type: "pointerdown", t: 201, ts: 200, trusted: true }],
  };
  const updated = turnTimes(
    {
      ...base,
      rows: [{ id: "m1", speaker: "mistress", t: 50, frame: 60, shownFrame: 70 }],
      rowChanges: [{ id: "m1", t: 250, frame: 262 }],
    },
    150,
    before,
  );
  assert.equal(updated.settledBy, "row update");
  assert.equal(updated.settledMs, 62);
  const entering = turnTimes(
    {
      ...base,
      rows: [{ id: "m2", speaker: "mistress", t: 220, frame: 230, shownFrame: 600 }],
      rowChanges: [],
    },
    150,
    before,
  );
  assert.equal(entering.settledMs, 400);
  // An update of a row not yet shown at the input settles nothing; the row settles when it shows.
  const unseen = turnTimes(
    {
      ...base,
      rows: [{ id: "m3", speaker: "mistress", t: 50, frame: 60, shownFrame: 600 }],
      rowChanges: [{ id: "m3", t: 250, frame: 262 }],
    },
    150,
    before,
  );
  assert.equal(unseen.ok, false);
});

test("clearing the run's origins attempts each origin and the cache after an earlier failure", async () => {
  const sent = [];
  const cdp = {
    send: async (method, params) => {
      sent.push(params?.origin ?? method);
      if (params?.origin === "http://localhost:1") throw new Error("gone");
    },
  };
  await assert.rejects(
    clearOriginsThrough(cdp, ["http://localhost:1", "http://localhost:2"]),
    /localhost:1: gone/u,
  );
  assert.deepEqual(sent, ["http://localhost:1", "http://localhost:2", "Network.clearBrowserCache"]);
});
