import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, type ProjectSourceFile } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { RuntimeDebugContext, type RuntimeDebugRecord } from "../src/runtime/debug-trace.js";
import {
  resumeRandomDraw,
  run,
  type RuntimeBuiltinFunction,
  type RuntimeCapabilities,
} from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { recordContinueCapture } from "../src/runtime/operations/continue-capture.js";
import { setDebugMode } from "../src/runtime/operations/debug-mode.js";
import { applyExternalStorageEdit } from "../src/runtime/operations/external-storage-edit.js";
import { pressPermanentButton } from "../src/runtime/operations/press-permanent-button.js";
import {
  listRandomSites,
  pendingRandomDraw,
  RandomDecisionError,
  type RandomChoiceReceipt,
  type RandomControlOptions,
  type RandomDecision,
  type RandomDrawKind,
  type RandomDrawView,
  type RandomOutcome,
} from "../src/runtime/random-control.js";
import {
  createFreshRuntimeSession,
  restoreRuntimeSession,
  RuntimeSessionError,
  type RuntimeSession,
} from "../src/runtime/session.js";
import { createFreshRuntimeSnapshot, type RuntimeSnapshot } from "../src/runtime/state.js";
import { createCheckpoint } from "../src/runtime/checkpoint.js";
import { assertCheckpointRejected } from "./helpers/checkpoint-rejection.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

/*
 * Controlled randomness (docs/RUNTIME.md#controlled-randomness). The central invariant: a pause undoes its unit and
 * resuming executes it again, so pausing at every draw, deciding every draw in a callback, and restoring a checkpoint
 * or forking at every pause all reach exactly the events and state of deciding the same outcomes in one run, and
 * resolving every draw naturally reaches exactly what a run without control reaches.
 */

const IMAGES = [
  { path: "images/a.jpg", keywords: ["room"] },
  { path: "images/b.jpg", keywords: ["room"] },
  { path: "images/c.jpg", keywords: ["room", "dark"] },
];

function project(
  main: string,
  others: Record<string, string> = {},
  builtins: readonly string[] = [],
): InstructionPlan {
  const files: ProjectSourceFile[] = [
    { path: "main.tease", source: main },
    ...Object.entries(others).map(([path, source]) => ({ path, source })),
  ];
  const compiled = compileProject(files, { images: IMAGES, builtins });
  assert.deepEqual(compiled.diagnostics, []);
  return compiled.plan!;
}

/** Scenarios, one per way a unit can reach a draw, with how far each time observation moves. */
interface Scenario {
  readonly plan: InstructionPlan;
  readonly stepMs: number;
  readonly builtins?: () => Readonly<Record<string, RuntimeBuiltinFunction>>;
}

const SCENARIOS: Readonly<Record<string, () => Scenario>> = {
  /** Every expression draw, without a change before it in its instruction. */
  expressions: () => ({
    stepMs: 2000,
    plan: project(
      [
        'let items = ["a", "b", "c", "d"]',
        "let total = randomInteger(1..=6) + randomInteger(1..=6)",
        "let flip = chance(30)",
        "let pick = items.random",
        "let member = set[10, 20, 30].random",
        'let weighted = randomWeighted(dict{ "x": 3, "y": 0, "z": 1 })',
        'let objects = [{ name: "p", w: 2 }, { name: "q", w: 5 }]',
        'let heavy = randomWeighted(objects, weight: "w").name',
        "let normal = randomNormal(10, 2)",
        "let beta = randomBeta(2, 5)",
        "let pert = randomPert(1, 2, 3)",
        "let unit = random()",
        "let nested = [[1, 2], [3, 4]]",
        "nested.random.add(9)",
        "items.shuffle()",
        'showImage tagged "room"',
        'say "${total} ${flip} ${pick} ${member} ${weighted} ${heavy} ${normal} ${beta} ${pert} ${unit} ${items.join()}"',
        "exit",
      ].join("\n"),
    ),
  }),
  /** A collection change and a warning before later draws of the same instruction. */
  changeBeforeDraw: () => ({
    stepMs: 2000,
    plan: project(
      [
        "let items = [1, 2, 3, 4, 5]",
        "let pair = [items.removeFirst(), randomInteger(1..=6), items.remove(99), items.random]",
        'say "${pair[0]} ${pair[1]} ${pair[3]} ${items.length}"',
        "exit",
      ].join("\n"),
    ),
  }),
  /** A timer whose operands change state before it draws its ranged duration. */
  timerOperands: () => ({
    stepMs: 2000,
    plan: project(
      [
        'let labels = ["first", "second", "third"]',
        "let t = timer(duration: 1..=2, async: true, label: labels.removeFirst())",
        'say "${labels.length} ${t.label}"',
        "wait 3 s",
        "exit",
      ].join("\n"),
    ),
  }),
  /** A blocking timer whose operands change state before it draws its ranged duration. */
  blockingTimer: () => ({
    stepMs: 2000,
    plan: project(
      [
        'let labels = ["first", "second", "third"]',
        'let shown = ["visible", "hidden", "mystery"]',
        "timer(duration: 1..=2, display: shown.removeFirst(), label: labels.removeFirst())",
        "timer 1..=3",
        'say "${labels.length} ${shown.length}", instant',
        "exit",
      ].join("\n"),
    ),
  }),
  /** A host builtin called before a draw of the same instruction. */
  builtinBeforeDraw: () => ({
    stepMs: 2000,
    builtins: () => {
      let count = 0;
      return { counter: () => (count += 1) };
    },
    plan: project(
      [
        "let a = counter() + randomInteger(1..=6) + counter()",
        "let b = counter()",
        'say "${a} ${b}"',
        "exit",
      ].join("\n"),
      {},
      ["counter"],
    ),
  }),
  /** Draws inside a staged say. */
  stagedSay: () => ({
    stepMs: 2000,
    plan: project(
      [
        'let colors = ["red", "green", "blue"]',
        'say "${colors} then ${randomInteger(1..=3)} then ${colors}"',
        "exit",
      ].join("\n"),
    ),
  }),
  /** A permanent button removed before a draw of the same instruction. */
  buttonBeforeDraw: () => ({
    stepMs: 2000,
    plan: project(
      [
        'let b = showPermanentButton "Stop" {',
        "}",
        "let gone = [removePermanentButton(b), randomInteger(1..=4)]",
        'say "${gone[1]}"',
        "exit",
      ].join("\n"),
    ),
  }),
  /** Glob transfers, and a glob fallback at an end that first stops the timer of the file it leaves. */
  transfers: () => ({
    stepMs: 2000,
    plan: project('fallback "rooms/*.tease"\ncall "rooms/*.tease"\nend', {
      "rooms/a.tease": 'timer async 5 { say "late" }\nsay "a ${random()}"\nend',
      "rooms/b.tease": 'say "b"\nend',
      "rooms/c.tease": 'say "c"\nexit',
    }),
  }),
  /** Repeating ranged rounds during catch-up, and `remaining = 0` ending a round at once. */
  timerRounds: () => ({
    stepMs: 1500,
    plan: project(
      [
        'let items = ["x", "y"]',
        "let t = timer(duration: 1..=3, async: true, repeat: true) {",
        '  say "tick ${items}"',
        "}",
        "wait 4 s",
        "t.remaining = 0 s",
        "wait 4 s",
        "t.stop()",
        "exit",
      ].join("\n"),
    ),
  }),
  /** A while loop whose first condition draws after the loop frame is pushed. */
  whileLoop: () => ({
    stepMs: 2000,
    plan: project('let n = 0\nwhile chance(60) {\n  n += 1\n}\nsay "${n}"\nexit'),
  }),
  /** A timer block whose return catches up a ranged round that became due meanwhile. */
  blockReturn: () => ({
    stepMs: 20_000,
    plan: project(
      [
        'timer async 1 { say "block" }',
        "let r = timer(duration: 2..=3, async: true, repeat: true)",
        "wait 9 s",
        "r.stop()",
        "exit",
      ].join("\n"),
    ),
  }),
};

type Resolve = (draw: RandomDrawView) => "natural" | RandomOutcome;

const natural: Resolve = () => "natural";

/** A fixed outcome other than the natural one where the support allows it. */
const forced: Resolve = (draw) => {
  const support = draw.support;
  switch (support.kind) {
    case "unit":
      return { kind: "number", value: 0.5 };
    case "chance":
      return { kind: "boolean", value: support.percent >= 100 };
    case "integer":
      return { kind: "number", value: support.max };
    case "candidates":
      return { kind: "index", index: support.candidates.length - 1 };
    case "weighted":
      return { kind: "index", index: support.weights.findIndex((weight) => weight > 0) };
    case "normal":
      return { kind: "number", value: support.mean + support.spread };
    case "beta":
      return { kind: "number", value: 0.25 };
    case "pert":
      return { kind: "number", value: support.mostLikely };
    case "order":
      return {
        kind: "order",
        order: support.items.map((_, index) => support.items.length - 1 - index),
      };
  }
};

interface Driven {
  readonly events: readonly InterpreterEvent[];
  readonly snapshot: string;
  readonly receipts: readonly RandomChoiceReceipt[];
  readonly pauses: readonly RandomDrawView[];
  readonly records: readonly RuntimeDebugRecord[];
}

type Mode = "plain" | "callback" | "callbackCheckpoint" | "pause" | "pauseCheckpoint" | "pauseFork";

function decision(outcome: "natural" | RandomOutcome) {
  return outcome === "natural"
    ? ({ kind: "natural" } as const)
    : ({ kind: "choose", outcome } as const);
}

function controlFor(mode: Mode, resolve: Resolve): RandomControlOptions | undefined {
  if (mode === "plain") return undefined;
  if (mode === "callback" || mode === "callbackCheckpoint")
    return { decide: (draw) => decision(resolve(draw)) };
  return {};
}

/**
 * Drives a scenario through a session to its end: runs, resolves every paused draw with `resolve`, and observes time
 * whenever it waits. `pauseCheckpoint` continues each pause from a JSON checkpoint, `pauseFork` from a fork, and
 * `callbackCheckpoint` continues from a JSON checkpoint after every host operation.
 */
function drive(scenario: Scenario, mode: Mode, resolve: Resolve, trace = false): Driven {
  const capabilities: RuntimeCapabilities =
    scenario.builtins === undefined ? {} : { builtins: scenario.builtins() };
  const randomControl = controlFor(mode, resolve);
  const debugTrace = trace ? new RuntimeDebugContext() : undefined;
  const traceOptions = debugTrace === undefined ? {} : { debugTrace };
  let session: RuntimeSession = createFreshRuntimeSession(
    scenario.plan,
    { seed: 0x2468ace1 },
    { capabilities, ...(randomControl === undefined ? {} : { randomControl }) },
  );
  const events: InterpreterEvent[] = [];
  const receipts: RandomChoiceReceipt[] = [];
  const pauses: RandomDrawView[] = [];
  let now = 0;
  const take = (result: {
    readonly events: readonly InterpreterEvent[];
    readonly randomChoices?: readonly RandomChoiceReceipt[];
  }) => {
    events.push(...result.events);
    receipts.push(...(result.randomChoices ?? []));
    if (mode === "callbackCheckpoint")
      session = restoreRuntimeSession(JSON.parse(JSON.stringify(session.exportCheckpoint())), {
        capabilities,
        ...(randomControl === undefined ? {} : { randomControl }),
      });
  };
  for (let round = 0; round < 2000; round += 1) {
    take(session.run(traceOptions));
    const paused = session.view().randomDraw;
    if (paused !== null) {
      pauses.push(paused);
      if (mode === "pauseCheckpoint")
        session = restoreRuntimeSession(JSON.parse(JSON.stringify(session.exportCheckpoint())), {
          capabilities,
          randomControl: {},
        });
      if (mode === "pauseFork") session = session.fork();
      const resolved = session.resumeRandomDraw(
        { drawId: paused.drawId, outcome: resolve(paused) },
        traceOptions,
      );
      assert.equal(resolved.outcome.kind, "resolved");
      take(resolved);
      continue;
    }
    const view = session.view();
    if (view.status === "halted" || view.status === "failed" || view.runnable) {
      if (view.runnable) continue;
      break;
    }
    now += scenario.stepMs;
    take(session.observeTime(now, [], traceOptions));
  }
  assert.ok(["halted", "failed"].includes(session.view().status), "the scenario ends");
  const records: RuntimeDebugRecord[] = [];
  if (debugTrace !== undefined)
    for (let id = 1; id < 100_000; id += 1) {
      const record = debugTrace.record(id);
      if (record !== null) records.push(record);
      else if (id > (debugTrace.status().lastRecord ?? 0)) break;
    }
  return { events, snapshot: JSON.stringify(session.exportSnapshot()), receipts, pauses, records };
}

/** The same drive through the snapshot API, pausing at every draw. */
function driveSnapshots(scenario: Scenario, resolve: Resolve): Driven {
  const capabilities: RuntimeCapabilities =
    scenario.builtins === undefined ? {} : { builtins: scenario.builtins() };
  let snapshot: RuntimeSnapshot = createFreshRuntimeSnapshot(scenario.plan, { seed: 0x2468ace1 });
  const events: InterpreterEvent[] = [];
  const receipts: RandomChoiceReceipt[] = [];
  const pauses: RandomDrawView[] = [];
  let now = 0;
  for (let round = 0; round < 2000; round += 1) {
    const ran = run(scenario.plan, snapshot, capabilities, { randomControl: {} });
    snapshot = ran.snapshot;
    events.push(...ran.events);
    receipts.push(...(ran.randomChoices ?? []));
    const paused = pendingRandomDraw(snapshot);
    if (paused !== null) {
      pauses.push(paused);
      const resolved = resumeRandomDraw(
        scenario.plan,
        snapshot,
        { drawId: paused.drawId, outcome: resolve(paused) },
        capabilities,
        { randomControl: {} },
      );
      snapshot = resolved.snapshot;
      events.push(...resolved.events);
      receipts.push(...(resolved.randomChoices ?? []));
      continue;
    }
    if (snapshot.status === "halted" || snapshot.status === "failed") break;
    now += scenario.stepMs;
    const observed = observeTime(scenario.plan, snapshot, now, [], { randomControl: {} });
    snapshot = observed.snapshot;
    events.push(...observed.events);
    receipts.push(...(observed.randomChoices ?? []));
  }
  return { events, snapshot: JSON.stringify(snapshot), receipts, pauses, records: [] };
}

function said(driven: Driven): string[] {
  return driven.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

for (const [name, make] of Object.entries(SCENARIOS)) {
  test(`${name}: resolving every draw naturally reaches what a run without control reaches`, () => {
    const scenario = make();
    const plain = drive(scenario, "plain", natural);
    for (const mode of [
      "callback",
      "callbackCheckpoint",
      "pause",
      "pauseCheckpoint",
      "pauseFork",
    ] as const) {
      const controlled = drive(scenario, mode, natural);
      assert.deepEqual(controlled.events, plain.events, `${mode}: events`);
      assert.equal(controlled.snapshot, plain.snapshot, `${mode}: final state`);
      assert.deepEqual(controlled.receipts, [], `${mode}: a natural draw is no input`);
    }
    assert.ok(drive(scenario, "pause", natural).pauses.length > 0, "the scenario draws");
  });

  test(`${name}: chosen outcomes reach the same events and state however the draws are decided`, () => {
    const scenario = make();
    const decided = drive(scenario, "callback", forced);
    assert.ok(decided.receipts.length > 0, "the scenario chooses outcomes");
    for (const mode of ["callbackCheckpoint", "pause", "pauseCheckpoint", "pauseFork"] as const) {
      const paused = drive(scenario, mode, forced);
      assert.deepEqual(paused.events, decided.events, `${mode}: events`);
      assert.equal(paused.snapshot, decided.snapshot, `${mode}: final state`);
      assert.deepEqual(paused.receipts, decided.receipts, `${mode}: receipts`);
    }
    const snapshots = driveSnapshots(scenario, forced);
    assert.deepEqual(snapshots.events, decided.events, "snapshot API: events");
    assert.equal(snapshots.snapshot, decided.snapshot, "snapshot API: final state");
    assert.deepEqual(snapshots.receipts, decided.receipts, "snapshot API: receipts");
    assert.equal(
      JSON.parse(decided.snapshot).randomControl?.forcedChoices,
      decided.receipts.length,
      "the state counts the chosen outcomes",
    );
  });
}

test("every paused draw names a site that listRandomSites lists, counted from 1", () => {
  for (const make of Object.values(SCENARIOS)) {
    const scenario = make();
    const sites = new Map(listRandomSites(scenario.plan).map((site) => [site.id, site]));
    for (const draw of drive(scenario, "pause", natural).pauses) {
      const site = sites.get(draw.site);
      assert.ok(site !== undefined, `${draw.site} is listed`);
      assert.ok(site?.kinds.includes(draw.kind) === true, `${draw.site} lists ${draw.kind}`);
    }
  }
  const plan = compileValidPlan("let x = randomInteger(1..=6) + randomInteger(1..=6)\nexit");
  assert.deepEqual(
    listRandomSites(plan).map((site) => site.id),
    ["main.tease:1:9", "main.tease:1:32"],
    "two draws on one line are two sites",
  );
});

test("a site ends where its draw's source ends, so a host can mark the draw", () => {
  const source =
    "let items = [1, 2]\nlet x = randomInteger(1..=6) + items.random\nlet y = chance(\n  25\n)\nexit";
  const lines = source.split("\n");
  const marked = listRandomSites(compileValidPlan(source)).map((site) =>
    site.line === site.endLine
      ? lines[site.line - 1]!.slice(site.column - 1, site.endColumn - 1)
      : `${lines[site.line - 1]!.slice(site.column - 1)}…${lines[site.endLine - 1]!.slice(0, site.endColumn - 1)}`,
  );
  assert.deepEqual(marked, ["randomInteger(1..=6)", "items.random", "chance(…)"]);
});

test("a builtin the unit called before a pause is not called again when it resumes, also after a restore", () => {
  const scenario = SCENARIOS.builtinBeforeDraw!();
  let calls = 0;
  const builtins = { counter: () => (calls += 1) };
  const session = createFreshRuntimeSession(
    scenario.plan,
    {},
    { capabilities: { builtins }, randomControl: {} },
  );
  session.run();
  const paused = session.view().randomDraw!;
  assert.equal(calls, 1, "the first counter() ran before the draw");
  const restored = restoreRuntimeSession(JSON.parse(JSON.stringify(session.exportCheckpoint())), {
    capabilities: { builtins },
  });
  restored.resumeRandomDraw({ drawId: paused.drawId, outcome: "natural" });
  restored.run();
  assert.equal(calls, 3, "resuming called only the counter() after the draw, then the next one");
  const plain = drive(scenario, "plain", natural);
  assert.deepEqual(said(drive(scenario, "pauseCheckpoint", natural)), said(plain));
});

test("a restore without the builtins resumes a draw after a builtin's recorded call, and refuses a new call", () => {
  const resumedWithout = (source: string) => {
    const plan = compileValidPlan(source, { builtins: ["counter"] });
    const session = createFreshRuntimeSession(
      plan,
      {},
      { capabilities: { builtins: { counter: () => 10 } }, randomControl: {} },
    );
    session.run();
    const paused = session.view().randomDraw!;
    const restored = restoreRuntimeSession(JSON.parse(JSON.stringify(session.exportCheckpoint())));
    const resumed = restored.resumeRandomDraw({
      drawId: paused.drawId,
      outcome: { kind: "number", value: 6 },
    });
    assert.deepEqual(resumed.outcome, { kind: "resolved", forced: true }, source);
    return { restored, resumed };
  };
  // The counter() before the draw returns its recorded result, so the restored session needs no counter.
  const recorded = resumedWithout('say "${counter() + randomInteger(1..=6)}", instant\nexit');
  assert.deepEqual(
    recorded.resumed.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["16"],
  );
  assert.equal(recorded.restored.view().status, "halted");
  // The counter() after it is a new call, which a session without the builtin refuses.
  const unrecorded = resumedWithout(
    'say "${counter() + randomInteger(1..=6) + counter()}", instant\nexit',
  );
  assert.equal(unrecorded.restored.view().failure?.code, "TSR011");
});

test("a change before a draw in the same instruction happens once, with its warning", () => {
  const scenario = SCENARIOS.changeBeforeDraw!();
  const paused = drive(scenario, "pause", forced);
  assert.deepEqual(said(paused), ["1 6 5 4"]);
  assert.equal(
    paused.events.filter((event) => event.kind === "developerWarning").length,
    1,
    "list.remove(99) warned once",
  );
});

test("a chosen outcome replaces only the result: the generator advances as for the natural draw", () => {
  const plan = compileValidPlan("let x = randomNormal(0, 1)\nlet y = randomBeta(2, 2)\nexit");
  const plain = createFreshRuntimeSession(plan, { seed: 7 });
  plain.run();
  const chosen = createFreshRuntimeSession(
    plan,
    { seed: 7 },
    {
      randomControl: {
        decide: () => ({ kind: "choose", outcome: { kind: "number", value: 0.5 } }),
      },
    },
  );
  const result = chosen.run();
  assert.equal(result.randomChoices?.length, 2);
  assert.equal(chosen.exportSnapshot().rng.state, plain.exportSnapshot().rng.state);
  assert.deepEqual(
    chosen.exportSnapshot().frames[0]!.bindings.map((binding) => binding.value),
    [0.5, 0.5],
  );
});

test("the debug trace records each draw once, however it was decided", () => {
  for (const name of ["expressions", "stagedSay", "changeBeforeDraw", "timerRounds"]) {
    const scenario = SCENARIOS[name]!();
    const decided = drive(scenario, "callback", forced, true);
    const paused = drive(scenario, "pause", forced, true);
    assert.deepEqual(paused.records, decided.records, `${name}: trace records`);
    const randomRecords = decided.records.filter((record) => record.kind === "random");
    assert.equal(randomRecords.length, paused.pauses.length, `${name}: one record per draw`);
    assert.equal(
      randomRecords.filter((record) => record.detail?.kind === "random" && record.detail.forced)
        .length,
      decided.receipts.length,
      `${name}: each chosen outcome marks its record`,
    );
  }
});

test("while a draw is paused, every other host operation changes nothing", () => {
  const plan = project(
    [
      'let b = showPermanentButton "B" {',
      "}",
      "let t = timer(duration: 1..=2, async: true, repeat: true)",
      'let answer = choose "A", "B"',
      "wait 10 s",
      "exit",
    ].join("\n"),
  );
  const session = createFreshRuntimeSession(
    plan,
    {},
    { randomControl: { filter: { kinds: ["timerRepeat"] } } },
  );
  session.run();
  const question = session.view().foregroundAction!;
  session.observeTime(5000);
  const paused = session.view().randomDraw;
  assert.equal(paused?.kind, "timerRepeat");
  const before = JSON.stringify(session.exportSnapshot());
  const refused = { kind: "randomDrawPending", drawId: paused!.drawId };
  assert.deepEqual(session.observeTime(9000).outcome, refused);
  assert.deepEqual(
    session.completeAction({ actionId: question.actionId, result: "Bo" }).outcome,
    refused,
  );
  assert.deepEqual(session.pressPermanentButton(1).outcome, refused);
  assert.deepEqual(session.setDebugMode(true).outcome, refused);
  assert.deepEqual(session.applyExternalStorageEdit({ key: "k", value: 1 }).outcome, refused);
  assert.deepEqual(
    session.recordContinueCapture({ boundaryMs: 5000, context: null, epochMs: null }).outcome,
    refused,
  );
  assert.equal(session.run().instructionsExecuted, 0);
  assert.equal(session.view().runnable, false);
  assert.equal(JSON.stringify(session.exportSnapshot()), before);
  // The snapshot API refuses alike.
  const snapshot = session.exportSnapshot();
  assert.deepEqual(observeTime(plan, snapshot, 9000).outcome, refused);
  assert.deepEqual(
    completeAction(plan, snapshot, { actionId: question.actionId, result: "Bo" }).outcome,
    refused,
  );
  assert.deepEqual(pressPermanentButton(plan, snapshot, 1).outcome, refused);
  assert.deepEqual(setDebugMode(plan, snapshot, true).outcome, refused);
  assert.deepEqual(
    applyExternalStorageEdit(plan, snapshot, { key: "k", value: 1 }).outcome,
    refused,
  );
  assert.deepEqual(
    recordContinueCapture(plan, snapshot, { boundaryMs: 5000, context: null, epochMs: null })
      .outcome,
    refused,
  );
});

test("a resolution that does not fit the paused draw changes nothing", () => {
  const plan = project(
    [
      'let w = randomWeighted(dict{ "a": 1, "b": 0 })',
      "let c = chance(0)",
      "let items = [1, 2, 3]",
      "items.shuffle()",
      "let u = random()",
      "exit",
    ].join("\n"),
  );
  const session = createFreshRuntimeSession(plan, {}, { randomControl: {} });
  assert.deepEqual(session.resumeRandomDraw({ drawId: 1, outcome: "natural" }).outcome, {
    kind: "noPendingDraw",
  });
  session.run();
  const refusals: [string, RandomOutcome | "natural", number?][] = [
    ["randomWeighted", { kind: "index", index: 1 }],
    ["randomWeighted", { kind: "index", index: 2 }],
    ["randomWeighted", { kind: "number", value: 0 }],
    ["chance", { kind: "boolean", value: true }],
    ["shuffle", { kind: "order", order: [0, 0, 1] }],
    ["shuffle", { kind: "order", order: [0, 1] }],
    ["random", { kind: "number", value: 1 }],
    ["random", { kind: "number", value: Number.NaN }],
  ];
  for (const kind of ["randomWeighted", "chance", "shuffle", "random"]) {
    const paused = session.view().randomDraw!;
    assert.equal(paused.kind, kind);
    const before = JSON.stringify(session.exportSnapshot());
    for (const [, outcome] of refusals.filter(([refusedKind]) => refusedKind === kind)) {
      assert.equal(
        session.resumeRandomDraw({ drawId: paused.drawId, outcome }).outcome.kind,
        "invalidOutcome",
      );
    }
    assert.deepEqual(
      session.resumeRandomDraw({ drawId: paused.drawId + 1, outcome: "natural" }).outcome,
      { kind: "staleDraw", drawId: paused.drawId },
    );
    assert.equal(session.resumeRandomDraw({ outcome: "natural" }).outcome.kind, "invalidOutcome");
    assert.equal(JSON.stringify(session.exportSnapshot()), before);
    session.resumeRandomDraw({ drawId: paused.drawId, outcome: "natural" });
  }
  assert.equal(session.view().status, "halted");
});

test("a filter decides only the sites and kinds it names", () => {
  const unknownKinds: RandomDrawKind[] = JSON.parse('["dice"]');
  const plan = compileValidPlan(
    "let a = randomInteger(1..=6)\nlet b = randomInteger(1..=6)\nlet c = chance(50)\nexit",
  );
  const [first, second] = listRandomSites(plan);
  const sites = (randomControl: RandomControlOptions) => {
    const session = createFreshRuntimeSession(plan, {}, { randomControl });
    const reached: string[] = [];
    for (session.run(); session.view().randomDraw !== null; session.run()) {
      const draw = session.view().randomDraw!;
      reached.push(`${draw.site} ${draw.kind}`);
      session.resumeRandomDraw({ drawId: draw.drawId, outcome: "natural" });
    }
    return reached;
  };
  assert.deepEqual(sites({ filter: { sites: [second!.id] } }), [`${second!.id} randomInteger`]);
  assert.deepEqual(sites({ filter: { kinds: ["chance"] } }), ["main.tease:3:9 chance"]);
  assert.deepEqual(sites({ filter: { sites: [first!.id], kinds: ["chance"] } }), []);
  assert.deepEqual(sites({ filter: { sites: [] } }), []);
  assert.equal(sites({}).length, 3);
  assert.throws(
    () =>
      createFreshRuntimeSession(
        plan,
        {},
        { randomControl: { filter: { sites: ["main.tease:9:9"] } } },
      ),
    TypeError,
  );
  assert.throws(
    () =>
      createFreshRuntimeSession(plan, {}, { randomControl: { filter: { kinds: unknownKinds } } }),
    TypeError,
  );
  assert.throws(
    () =>
      createFreshRuntimeSession(
        plan,
        {},
        { capabilities: { random: { next: () => 0.5 } }, randomControl: {} },
      ),
    TypeError,
  );
});

test("a callback's invalid outcome pauses the draw instead, and its exception ends the session", () => {
  const plan = compileValidPlan("let a = randomInteger(1..=6)\nexit");
  const refused = createFreshRuntimeSession(
    plan,
    {},
    {
      randomControl: { decide: () => ({ kind: "choose", outcome: { kind: "number", value: 7 } }) },
    },
  );
  const result = refused.run();
  const paused = refused.view().randomDraw!;
  assert.equal(result.randomRefusal?.drawId, paused.drawId);
  assert.match(result.randomRefusal!.message, /1 through 6/);
  const thrown = new Error("explorer bug");
  const failing = createFreshRuntimeSession(
    plan,
    {},
    {
      randomControl: {
        decide: () => {
          throw thrown;
        },
      },
    },
  );
  assert.throws(
    () => failing.run(),
    (error: unknown) => error instanceof RandomDecisionError && error.cause === thrown,
  );
  assert.throws(() => failing.view(), RuntimeSessionError);
});

test("an exception from reading a decision ends the operation as one from decide does", () => {
  const thrown = new Error("explorer bug");
  const throwing = <T extends object>(value: T, field: string): T =>
    Object.defineProperty(value, field, {
      get() {
        throw thrown;
      },
    });
  // At a built-in draw and at a collection draw alike, from the decision or from its outcome.
  for (const source of ["let a = random()\nexit", "let a = [1, 2, 3].random\nexit"]) {
    for (const decide of [
      (): RandomDecision => throwing({ kind: "natural" }, "kind"),
      (): RandomDecision =>
        throwing({ kind: "choose", outcome: { kind: "index", index: 0 } }, "outcome"),
      (): RandomDecision => ({
        kind: "choose",
        outcome: throwing<RandomOutcome>({ kind: "index", index: 0 }, "kind"),
      }),
    ]) {
      const session = createFreshRuntimeSession(
        compileValidPlan(source),
        {},
        { randomControl: { decide } },
      );
      assert.throws(
        () => session.run(),
        (error: unknown) => error instanceof RandomDecisionError && error.cause === thrown,
        source,
      );
    }
  }
});

test("a run keeps its instruction budget across pauses", () => {
  const plan = compileValidPlan(
    "let n = 0\nwhile n < 1000 {\n  n += randomInteger(1..=2)\n}\nexit",
  );
  const plain = createFreshRuntimeSession(plan, {});
  plain.run({ instructionBudget: 40 });
  const paused = createFreshRuntimeSession(plan, {}, { randomControl: {} });
  paused.run({ instructionBudget: 40 });
  while (paused.view().randomDraw !== null)
    paused.resumeRandomDraw({ drawId: paused.view().randomDraw!.drawId, outcome: "natural" });
  assert.equal(paused.view().failure?.code, "TSR037");
  assert.equal(JSON.stringify(paused.exportSnapshot()), JSON.stringify(plain.exportSnapshot()));
});

test("restore rejects a pending draw that the engine could not have made", () => {
  const plan = compileValidPlan("let a = randomInteger(1..=6)\nexit");
  const session = createFreshRuntimeSession(plan, {}, { randomControl: {} });
  session.run();
  const checkpoint = JSON.stringify(createCheckpoint(plan, session.exportSnapshot()));
  assert.doesNotThrow(() => restoreRuntimeSession(JSON.parse(checkpoint)));
  const changes = [
    (pending: { draw: Record<string, unknown> }) =>
      (pending.draw.natural = { kind: "number", value: 6 }),
    (pending: { draw: Record<string, unknown> }) => (pending.draw.site = "main.tease:9:9"),
    (pending: { draw: Record<string, unknown> }) =>
      (pending.draw.support = { kind: "integer", min: 6, max: 1 }),
    (pending: Record<string, unknown>) => (pending.root = "dueWork"),
    (pending: Record<string, unknown>) => (pending.instructionsUsed = -1),
  ];
  for (const change of changes) {
    const corrupt = JSON.parse(checkpoint);
    change(corrupt.snapshot.randomControl.pending);
    assertCheckpointRejected(corrupt, "TSK002");
  }
  // Another site of the plan passes restore, and fails once resuming meets the draw at its own site.
  const twoSites = compileValidPlan(
    "let a = randomInteger(1..=6)\nlet b = randomInteger(1..=6)\nexit",
  );
  const first = createFreshRuntimeSession(twoSites, {}, { randomControl: {} });
  first.run();
  const moved = JSON.parse(JSON.stringify(first.exportCheckpoint()));
  moved.snapshot.randomControl.pending.draw.site = listRandomSites(twoSites)[1]!.id;
  const restored = restoreRuntimeSession(moved);
  assert.throws(
    () =>
      restored.resumeRandomDraw({ drawId: restored.view().randomDraw!.drawId, outcome: "natural" }),
    (error: unknown) => error instanceof Error && error.name === "RuntimeDataError",
  );
});

test("a paused step or single instruction finishes as that operation would have", () => {
  const plan = compileValidPlan(
    'let a = randomInteger(1..=6)\nsay "${a}"\nlet b = randomInteger(1..=6)\nsay "${b}"\nexit',
  );
  const plain = createFreshRuntimeSession(plan, {});
  const paused = createFreshRuntimeSession(plan, {}, { randomControl: {} });
  const plainStep = plain.stepToEvent();
  assert.equal(paused.stepToEvent().instructionsExecuted, 0);
  const resumed = paused.resumeRandomDraw({
    drawId: paused.view().randomDraw!.drawId,
    outcome: "natural",
  });
  assert.deepEqual(resumed.events, plainStep.events, "the step stops at its event");
  assert.equal(resumed.instructionsExecuted, plainStep.instructionsExecuted);
  assert.equal(paused.view().nextInstruction, plain.view().nextInstruction);

  const plainOne = plain.executeInstruction();
  assert.equal(paused.executeInstruction().instructionsExecuted, 0);
  const one = paused.resumeRandomDraw({
    drawId: paused.view().randomDraw!.drawId,
    outcome: "natural",
  });
  assert.equal(one.instructionsExecuted, 1, "only the paused instruction runs");
  assert.equal(paused.view().nextInstruction, plain.view().nextInstruction);
  assert.deepEqual(one.events, plainOne.events);
});

test("an earlier chosen outcome restored outside its draw's support fails cleanly on resume", () => {
  const plan = compileValidPlan(
    "let items = [1, 2, 3]\nlet pair = [items.random, randomInteger(1..=6)]\nexit",
  );
  const session = createFreshRuntimeSession(
    plan,
    {},
    {
      randomControl: {
        filter: { kinds: ["collectionRandom", "randomInteger"] },
        decide: (draw) =>
          draw.kind === "collectionRandom"
            ? { kind: "choose", outcome: { kind: "index", index: 2 } }
            : { kind: "suspend" },
      },
    },
  );
  session.run();
  const checkpoint = JSON.parse(JSON.stringify(session.exportCheckpoint()));
  assert.equal(checkpoint.snapshot.randomControl.pending.forced.length, 1);
  checkpoint.snapshot.randomControl.pending.forced[0].outcome.index = 7;
  const restored = restoreRuntimeSession(checkpoint);
  const drawId = restored.view().randomDraw!.drawId;
  assert.throws(
    () => restored.resumeRandomDraw({ drawId, outcome: "natural" }),
    (error: unknown) => error instanceof Error && error.name === "RuntimeDataError",
  );
});

test("a repeating timer's rounds draw at a listed site, also from a restored record that holds a range", () => {
  const plan = project(
    "let t = timer(duration: 2, async: true, repeat: true)\nwait 5 s\nt.stop()\nexit",
  );
  const session = createFreshRuntimeSession(plan, { seed: 123 });
  session.run();
  // Restore admits a repeating timer record with a range whatever its duration was written as.
  const checkpoint = JSON.parse(JSON.stringify(session.exportCheckpoint()));
  const timer = checkpoint.snapshot.backgroundActions.find(
    (action: { kind: string }) => action.kind === "timer",
  ).timer;
  Object.assign(timer, {
    range: { start: 1, end: 3, inclusive: true },
    repeatDurationMs: null,
    anchoredRounds: null,
  });
  const restored = restoreRuntimeSession(checkpoint, { randomControl: {} });
  restored.observeTime(2000);
  const draw = restored.view().randomDraw!;
  assert.equal(draw.kind, "timerRepeat");
  assert.ok(listRandomSites(plan).some((site) => site.id === draw.site));
  assert.doesNotThrow(() => restoreRuntimeSession(restored.exportCheckpoint()));
  assert.equal(
    restored.resumeRandomDraw({ drawId: draw.drawId, outcome: "natural" }).outcome.kind,
    "resolved",
  );
});
