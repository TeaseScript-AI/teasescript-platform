// The cost report's one deciding function over its cells (`cells.mjs`), the report's refusals (`report.mjs`), and the
// derivations whose boundaries Sol code r1 challenged (`lib/measure.mjs`, `scenarios/keep.mjs`), on synthetic records.
import assert from "node:assert/strict";
import test from "node:test";
import { AXES, allCells, cellName, classify } from "./cells.mjs";
import { buildReport } from "./report.mjs";
import { playable, turnTimes } from "./lib/measure.mjs";
import {
  MissingEvidence,
  NULLABLE,
  nullable,
  ReversedInterval,
  strictRecord,
} from "./lib/evidence.mjs";
import { hiddenCapture, keepOutcome } from "./scenarios/keep.mjs";
import { readFileSync } from "node:fs";
import ts from "typescript";
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
    // A session row always keeps its heap readings, none where the engine has no CDP (`scenarios/session.mjs`).
    memory: [],
    ...(cdp
      ? {
          memory: ["startEnabled", "playable", "firstSave", "afterTurns", "end"].map(heap),
          bytes: {
            discarded: [],
            // The cold byte page's marks and its requests' starts, epoch ms (`scenarios/session.mjs` `coldBytes`).
            marks: { startEnabled: 10_500, playable: 10_716, firstSave: 10_630 },
            requests: [
              {
                url: "/player/",
                target: "page",
                wallTimeMs: 10_000,
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
                      url: "engine.worker.js",
                      target: "engine.worker.js",
                      wallTimeMs: 10_600,
                      finished: true,
                      failed: null,
                      encodedBytes: 3,
                      decodedBytes: 6,
                      beforeStartEnabled: false,
                      beforePlayable: true,
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
  assert.match(line, /1 failing the validation; missing evidence: row.result.probe/u);
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
  // One failing sample beside good ones fails the cell: it is never left out of a median for the others to stand for it.
  const bad = sessionResult();
  bad.probe.cold.transactions[0].end = 0;
  const mixed = buildReport(
    [
      row({ scenario: "session", engine: "chromium" }, true, sessionResult()),
      row({ scenario: "session", engine: "chromium" }, true, bad),
    ],
    "r0",
    ARTIFACTS,
  );
  assert.ok(!(name({}) in mixed.summary));
  assert.ok(mixed.incomplete.some((text) => text.includes(name({})) && text.includes("1 failing")));
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
  assert.ok(one.incomplete.some((text) => text.includes("no minimal arm")));
  const both = buildReport([aa("full"), aa("minimal")], "r0", ARTIFACTS);
  assert.ok(!both.incomplete.some((text) => text.includes(name({ scenario: "aa" }))));
  // An A/A arm with emptied states has no playable time.
  const emptied = aa("minimal");
  emptied.result.probe.states = [];
  assert.ok(
    buildReport([aa("full"), emptied], "r0", ARTIFACTS).incomplete.some(
      (text) =>
        text.includes(name({ scenario: "aa" })) && text.includes("1 failing the validation"),
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
  // An input stamped before Start was enabled is a reversed interval.
  const early = { ...gate, inputs: [{ type: "pointerdown", t: 560, ts: 400, trusted: true }] };
  assert.throws(() => playable(early, "Start"), ReversedInterval);
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
    rowChanges: [],
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
    rowChanges: [],
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

test("an unvalidated cell's numbers stay out of the headline summary, and its gap is declared with its issue", () => {
  const cell = { scenario: "keepHandler", engine: "chromium" };
  const report = buildReport(
    [
      row(cell, true, {
        outcome: "completed",
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
      }),
    ],
    "r0",
    ARTIFACTS,
  );
  const named = name({ scenario: "keepHandler" });
  assert.ok(!(named in report.summary));
  assert.ok(named in report.unvalidated);
  assert.match(
    report.text,
    /## Declared gaps[\s\S]*`keepHandler` \(every required cell\): R5-02.*#2122.*before the activation PR's R1 run/u,
  );
});

test("a measured failure is a value: the delayed smoke failing at 50 and 250 ms is a complete cell with its findings", () => {
  const smoke = (delayMs, ok) => ({
    scenario: "delayedSmoke",
    script: "smoke",
    route: "source",
    backend: "main",
    engine: "chromium",
    delayMs,
    version: null,
    build: `delayed ${delayMs} ms`,
    commit: null,
    ok,
    result: { ok, exit: ok ? 0 : 1 },
  });
  const report = buildReport(
    [smoke(0, true), smoke(50, false), smoke(250, false)],
    "r0",
    ARTIFACTS,
  );
  const named = cellName({
    scenario: "delayedSmoke",
    script: "smoke",
    route: "source",
    backend: "main",
    engine: "chromium",
  });
  assert.ok(named in report.summary);
  assert.match(
    report.text,
    /Result: passes at 0 ms; fails at 50 ms \(the smoke's own wait, #2125\) and at 250 ms \(the Player's scene clock, the stutter track, #2126: scene time advances 100 ms per bridge round trip \(about 0\.4× wall at 250 ms\); affects waits, pacing and timers\)\./u,
  );
  // A missing exit status is a record that fails, not a measured failure.
  const broken = smoke(50, false);
  delete broken.result.exit;
  assert.ok(
    buildReport([smoke(0, true), broken, smoke(250, false)], "r0", ARTIFACTS).incomplete.some(
      (text) => text.includes(named),
    ),
  );
});

/** A delayed-smoke row at `delayMs`, with its exit status and its cached flags. */
const smokeRow = (delayMs, exit, ok = exit === 0) => ({
  scenario: "delayedSmoke",
  script: "smoke",
  route: "source",
  backend: "main",
  engine: "chromium",
  delayMs,
  version: null,
  build: `delayed ${delayMs} ms`,
  commit: null,
  ok,
  result: { ok, exit },
});

test("Sol code r6's five witnesses each make their cell incomplete through the strict reader", () => {
  const incompleteIn = (cell, rows) =>
    buildReport(rows, "r1", ARTIFACTS).incomplete.some((text) => text.includes(name(cell)));
  const session = (change, options) => {
    const result = sessionResult(options);
    change(result);
    return result;
  };
  // A null `ts` on a turn's input; a feedback frame before its change; a Worker without its construction time.
  assert.ok(
    incompleteIn({}, [
      row(
        { scenario: "session", engine: "chromium" },
        true,
        session((r) => (r.probe.repeat.inputs[1].ts = null)),
      ),
    ]),
  );
  assert.ok(
    incompleteIn({}, [
      row(
        { scenario: "session", engine: "chromium" },
        true,
        session((r) => (r.probe.repeat.changes = [{ t: 920, frame: 910 }])),
      ),
    ]),
  );
  assert.ok(
    incompleteIn({ backend: "worker" }, [
      row(
        { scenario: "session", engine: "chromium", backend: "worker" },
        true,
        session((r) => (r.probe.cold.workers[0].constructed = null), { backend: "worker" }),
      ),
    ]),
  );
  // A durable trial without its baseline is missing evidence, not "not durable".
  const durable = { scenario: "keepDurable", script: "CelebWorship", engine: "pixel" };
  assert.ok(
    incompleteIn(durable, [
      row(durable, false, { outcome: "not durable after 1 s", baselineMs: null, storedMs: 9 }),
    ]),
  );
  assert.throws(
    () => keepOutcome("keepDurable", strictRecord({ baselineMs: null, storedMs: 9 })),
    MissingEvidence,
  );
  // A smoke row whose exit says failed while its cached flags say passed.
  const smoke = { scenario: "delayedSmoke", script: "smoke", engine: "chromium" };
  assert.ok(incompleteIn(smoke, [smokeRow(0, 0), smokeRow(50, 1, true), smokeRow(250, 1)]));
});

test("Sol code r5's witnesses stay caught or labelled: a reversed bridge round trip fails, an empty lifecycle stays unvalidated", () => {
  const cell = { scenario: "bridge", script: "CelebWorship", route: "plan", engine: "chromium" };
  const bridgeRow = (replyAt) =>
    row(cell, true, {
      requests: [{ op: "prepare", id: 1, postAt: 100, postMs: 1, replyAt }],
      at: {},
      inputUnits: 1,
      inputBytes: 1,
    });
  assert.ok(
    buildReport([bridgeRow(99)], "r0", ARTIFACTS).incomplete.some(
      (text) => text.includes(name(cell)) && text.includes("reversed interval"),
    ),
  );
  const handler = { scenario: "keepHandler", engine: "chromium" };
  const report = buildReport(
    [
      row(handler, false, {
        outcome: "the page never reported hidden",
        scope: "s",
        baselineMs: 5,
        lifecycle: [],
        transactions: [],
      }),
    ],
    "r0",
    ARTIFACTS,
  );
  assert.ok(name(handler) in report.unvalidated);
  assert.ok(!(name(handler) in report.summary));
});

/**
 * The reader boundary, from the parsed source (orchestrator 2's ruling after Sol code r8): raw records exist only as
 * `deriveSample`'s second parameter, found by the function's declaration, never by the parameter's name (Sol code r9);
 * every binding that holds it is tainted. The guard fails closed: no single `deriveSample` declaration, or one whose
 * signature is not `(cell, row)` with a plain identifier for the row, is reported as "raw root not found". Any use of a tainted binding
 * is a violation (a dot or bracket read, a destructuring pattern, `in`, a spread, a call such as `Object.keys` or
 * `Reflect.get`, an assignment or a return) except passing it to `strictRecord` or `nullable`, the reader's calls; and
 * a plain alias (`const copy = row`) is itself tainted. Every subtraction in the scanned code must be one of `allowed`.
 */
function readerViolations(
  text,
  file,
  allowedSubtractions = [],
  expectRoot = file === "validate.mjs",
) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const violations = [];
  let roots = 0;
  const at = (node, what) =>
    violations.push(
      `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${what}`,
    );
  const walk = (node, visit) => {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  };
  walk(source, (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.MinusToken) {
      const text = node.getText(source);
      if (!allowedSubtractions.includes(text)) at(node, `a subtraction outside span: '${text}'`);
    }
    if (ts.isIdentifier(node) && ["RAW", "PATH"].includes(node.text))
      at(node, "a read past the reader");
    if (!ts.isFunctionDeclaration(node) || node.name?.text !== "deriveSample") return;
    roots += 1;
    const raw = node.parameters[1];
    if (
      node.parameters.length !== 2 ||
      raw === undefined ||
      !ts.isIdentifier(raw.name) ||
      raw.initializer !== undefined
    ) {
      at(node, "raw root not found: deriveSample's signature is not (cell, row)");
      return;
    }
    const tainted = new Set([raw.name.text]);
    const READER = new Set(["strictRecord", "nullable"]);
    // Aliases first, to a fixed point; then every other use of a tainted name.
    for (let grew = true; grew;) {
      grew = false;
      walk(node.body, (inner) => {
        if (
          ts.isVariableDeclaration(inner) &&
          ts.isIdentifier(inner.name) &&
          inner.initializer !== undefined &&
          ts.isIdentifier(inner.initializer) &&
          tainted.has(inner.initializer.text) &&
          !tainted.has(inner.name.text)
        ) {
          tainted.add(inner.name.text);
          grew = true;
        }
      });
    }
    walk(node.body, (inner) => {
      if (!ts.isIdentifier(inner) || !tainted.has(inner.text)) return;
      const parent = inner.parent;
      if (ts.isVariableDeclaration(parent) && parent.name === inner) return;
      if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === inner &&
        ts.isIdentifier(parent.name)
      )
        return;
      if (
        ts.isCallExpression(parent) &&
        parent.arguments[0] === inner &&
        ts.isIdentifier(parent.expression) &&
        READER.has(parent.expression.text)
      )
        return;
      const form = ts.isPropertyAccessExpression(parent)
        ? "a dot read"
        : ts.isElementAccessExpression(parent)
          ? "a bracket read"
          : ts.isVariableDeclaration(parent)
            ? "a destructuring pattern"
            : ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword
              ? "an `in` test"
              : ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)
                ? "a spread"
                : ts.isCallExpression(parent)
                  ? `a call of ${parent.expression.getText(source)}`
                  : `a ${ts.SyntaxKind[parent.kind]}`;
      at(inner, `a raw read of '${inner.text}': ${form}`);
    });
  });
  if (expectRoot && roots !== 1)
    violations.push(`${file}: raw root not found: ${roots} deriveSample declarations, not one`);
  return violations;
}

const DERIVATION_SOURCES = () => ({
  "validate.mjs": readFileSync(new URL("./validate.mjs", import.meta.url), "utf8"),
  "lib/measure.mjs": readFileSync(new URL("./lib/measure.mjs", import.meta.url), "utf8"),
  "scenarios/keep.mjs": `${hiddenCapture}\n${keepOutcome}`,
});
// The subtractions that are no intervals: two sort comparators and the median's neighbour index.
const NO_INTERVALS = ["a.at - b.at", "a - b", "middle - 1"];

test("every derivation reads a row only through the strict reader, and span is its only timestamp subtraction", () => {
  for (const [file, text] of Object.entries(DERIVATION_SOURCES()))
    assert.deepEqual(readerViolations(text, file, NO_INTERVALS), [], file);
});

test("the reader guard fails every raw-read form at the wrapping site, and the public report still fails a witness", () => {
  const original = DERIVATION_SOURCES()["validate.mjs"];
  const site = "DERIVE[cell.scenario](strict.result, cell, problems)";
  assert.ok(original.includes(site), "the wrapping site is where the mutants expect it");
  const mutants = {
    dot: site.replace("strict.result", "row.result"),
    bracket: site.replace("strict.result", 'row["result"]'),
    destructuring: `(() => { const { result } = row; return DERIVE[cell.scenario](result, cell, problems); })()`,
    reflect: site.replace("strict.result", 'Reflect.get(row, "result")'),
    alias: `(() => { const copy = row; return DERIVE[cell.scenario](copy["result"], cell, problems); })()`,
    keys: site.replace("strict.result", "row[Object.keys(row)[0]]"),
    spread: site.replace("strict.result", "{ ...row }.result"),
    in: site.replace("strict.result", '"result" in row ? strict.result : strict.result'),
  };
  // Renaming the raw parameter must not switch the guard off (Sol code r9): the rename plus a bracket read.
  const renamed = original
    .replace(
      "export function deriveSample(cell, row) {",
      "export function deriveSample(cell, rawRow) {",
    )
    .replace('strictRecord(row, "row")', 'strictRecord(rawRow, "row")')
    .replace(site, site.replace("strict.result", 'rawRow["result"]'));
  assert.ok(renamed.includes("deriveSample(cell, rawRow)") && renamed.includes('rawRow["result"]'));
  assert.ok(
    readerViolations(renamed, "validate.mjs", NO_INTERVALS).some((violation) =>
      violation.includes("a raw read of 'rawRow': a bracket read"),
    ),
    "the rename-plus-bracket mutant passed the guard",
  );
  // No root, or an unexpected signature: the guard fails closed.
  for (const broken of [
    original.replace(
      "export function deriveSample(cell, row) {",
      "export function sampleOf(cell, row) {",
    ),
    original.replace(
      "export function deriveSample(cell, row) {",
      "export function deriveSample({ result }) {",
    ),
  ])
    assert.ok(
      readerViolations(broken, "validate.mjs", NO_INTERVALS).some((violation) =>
        violation.includes("raw root not found"),
      ),
    );
  for (const [form, mutant] of Object.entries(mutants))
    assert.ok(
      readerViolations(original.replace(site, mutant), "validate.mjs", NO_INTERVALS).some(
        (violation) => violation.includes("a raw read of"),
      ),
      `the ${form} mutant passed the guard`,
    );
  // Sol code r6's durable-baseline witness, through the public report: a missing baseline fails its cell.
  const durable = { scenario: "keepDurable", script: "CelebWorship", engine: "pixel" };
  assert.ok(
    buildReport(
      [row(durable, true, { outcome: "durable after 1 s", baselineMs: null, storedMs: 9 })],
      "r1",
      ARTIFACTS,
    ).incomplete.some((text) => text.includes(name(durable))),
  );
});

test("byte phases derive from each request's start and the page's marks: Sol code r8's four witnesses fail the cell", () => {
  const incomplete = (change) => {
    const result = sessionResult();
    change(result);
    return buildReport(
      [row({ scenario: "session", engine: "chromium" }, true, result)],
      "r0",
      ARTIFACTS,
    ).incomplete.some((text) => text.includes(name({})));
  };
  assert.equal(
    incomplete(() => {}),
    false,
    "intact evidence is complete",
  );
  const page = (r) => r.bytes.requests[0];
  assert.ok(
    incomplete((r) => delete page(r).beforeStartEnabled),
    "the cached flag deleted",
  );
  assert.ok(
    incomplete((r) => (page(r).beforeStartEnabled = false)),
    "the flag false, the start before the mark",
  );
  assert.ok(
    incomplete((r) => (page(r).wallTimeMs = null)),
    "the request's start missing",
  );
  assert.ok(
    incomplete((r) => delete r.bytes.marks),
    "the page's marks missing",
  );
});

test("nullable reads only the fields that may truly be absent", () => {
  assert.equal(nullable({ frame: null }, "frame"), null);
  assert.throws(
    () => nullable({ beforeStartEnabled: true }, "beforeStartEnabled"),
    /no field that may be absent/u,
  );
  for (const reason of Object.values(NULLABLE))
    assert.ok(typeof reason === "string" && reason.length > 0);
});
