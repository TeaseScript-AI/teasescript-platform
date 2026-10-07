import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { isRecord } from "../src/ast.ts";
import {
  clockDifferences,
  comparedWith,
  DataFlow,
  type PlanDiagnostic,
} from "../src/explorer-analysis.ts";
import { explore, type CorpusEntry } from "../src/explorer-search.ts";
import {
  EPOCH_MS,
  loadEngine,
  replay,
  Session,
  wallClockOf,
  type Data,
  type Engine,
  type Runtime,
} from "../src/explorer.ts";

const engineResult = await loadEngine().then(
  (engine): { engine: Engine } | { reason: string } => ({ engine }),
  (error: unknown) => ({ reason: error instanceof Error ? error.message : String(error) }),
);

/** The fixture package compiled, with the diagnostics the explorer reads constant conditions from. */
async function fixture(engine: Engine) {
  const source = await readFile(new URL("fixtures/explorer/main.tease", import.meta.url), "utf8");
  const compiled = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
  const { plan } = compiled;
  assert.ok(isRecord(plan));
  const diagnostics: PlanDiagnostic[] = (
    Array.isArray(compiled.diagnostics) ? compiled.diagnostics : []
  )
    .filter(isRecord)
    .map((entry) => {
      const span = isRecord(entry.span) ? entry.span : {};
      const offset = (position: unknown) =>
        isRecord(position) && typeof position.offset === "number" ? position.offset : 0;
      return {
        path: String(entry.path),
        start: offset(span.start),
        end: offset(span.end),
        code: String(entry.code),
        message: String(entry.message),
      };
    });
  // The one-based line of the fixture that holds `text`.
  const lineOf = (text: string) => source.split("\n").findIndex((line) => line.includes(text)) + 1;
  return { source, plan, diagnostics, lineOf };
}

test(
  "the explorer finds both ends, the crash, the inescapable loop, and labels what directed search reaches",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  async () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const { source, plan, diagnostics, lineOf } = await fixture(engine);
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: 60_000,
      maxStates: 5000,
      sources: new Map([["main.tease", source]]),
      diagnostics,
    });

    // Every state the inputs reach is explored, across sessions: "Left" exits, "Right" fails, "Stay" loops.
    assert.equal(result.search.stoppedBy, "exhausted");
    assert.ok(result.endStates.completed >= 1);
    assert.ok(result.endStates.failed >= 1);

    // One crash per code and span, with the path that reaches it; replaying the path fails the same way.
    assert.equal(result.crashes.length, 1);
    const crash = result.crashes[0]!;
    assert.deepEqual([crash.code, crash.path, crash.line], ["TSR025", "main.tease", 12]);
    assert.deepEqual(crash.inputs, [{ kind: "option", index: 1, label: "Right" }]);
    assert.equal(crash.earlier, undefined);
    const replayed = replay(engine, plan, 1, crash.inputs);
    assert.deepEqual(
      replayed.failure && [replayed.failure.code, replayed.failure.line, replayed.failure.column],
      [crash.code, crash.line, crash.column],
    );

    // The button loop after "Stay" repeats one state, in every session, and has no way out: one trap.
    assert.equal(result.traps.length, 1);
    const trap = result.traps[0]!;
    assert.equal(trap.kind, "loop");
    assert.deepEqual(trap.locations, [`main.tease:${lineOf('showButton "Again"')}`]);
    assert.deepEqual(trap.sampleTexts, ["You are stuck."]);
    assert.deepEqual(trap.inputs, [{ kind: "option", index: 2, label: "Stay" }]);

    const ways = result.directed.ways;
    const way = (text: string) => ways.find((entry) => entry.condition === text);
    // Directed search answers the ask with the compared number, far from the ask, and replays the button after it.
    const secret = way("n == 1234");
    assert.deepEqual(
      secret && [secret.way, secret.reach, secret.via, secret.sources, secret.sessions],
      ["true", "play", "directed", ["ask"], 1],
    );
    assert.deepEqual(secret?.repro.inputs.slice(-2), [
      { kind: "text", text: "1234" },
      { kind: "button", label: "Go on" },
    ]);
    // A value the package stores is read in a next session, which starts from what an explored session left.
    const back = way('(load "fixture.visited") == true');
    assert.deepEqual(back && [back.reach, back.sources, back.sessions], ["play", ["storage"], 2]);
    // A count of visits needs a chain of sessions, each from the storage the one before it left.
    const regular = way("visits >= 3");
    assert.deepEqual(regular && [regular.reach, regular.sessions], ["play", 4]);
    assert.ok(result.directed.multiSession.longestChain >= 4);
    const chained = replay(engine, plan, 1, regular?.repro.inputs ?? [], {
      earlier: regular?.repro.earlier ?? [],
    });
    assert.equal(chained.steps.at(-1)?.status, "halted");
    assert.ok(chained.steps.some((step) => step.texts.includes("Regular.")));
    // The late hour is reached by continuing at another wall clock time: a clock way.
    const late = way("getTime().hour >= 22");
    assert.deepEqual(late && [late.reach, late.sources], ["clock", ["clock"]]);

    // Labels: play, clock, and unreachable with a static reason; no stored value is made up.
    const file = result.coverage.files.find((entry) => entry.path === "main.tease")!;
    const range = (text: string) =>
      file.unvisited.find((entry) => {
        const line = lineOf(text);
        const [from = 0, to = from] = entry.lines.split("-").map(Number);
        return line >= from && line <= to;
      });
    assert.equal(range('say "Secret number."'), undefined);
    assert.equal(range('say "Regular."'), undefined);
    assert.equal(range('say "Late."')?.reach, "clock");
    assert.equal(range('say "Never shown."')?.reach, "unreachable");
    assert.equal(range('say "Legacy profile."')?.reach, "unreachable");
    assert.equal(range('say "Level two."')?.reach, "unreachable");
    assert.equal(result.coverage.staticContradictions, 0);
    const branch = (text: string) =>
      result.coverage.unvisitedBranches.find((entry) => entry.condition?.text === text);
    assert.deepEqual(
      [branch('pick == "never"')?.reach, branch('(load "intro.legacy") == true')?.reason],
      ["unreachable", "key never saved in this package: intro.legacy"],
    );
    assert.match(
      branch('(load "fixture.level") == 2')?.reason ?? "",
      /every save of fixture\.level is a literal/u,
    );
    // A stored boolean that no explored session saved: the note shows the constant as the condition writes it.
    assert.equal(
      branch('(load "fixture.badge") == true')?.reason,
      "needs fixture.badge == true; no explored session stored it",
    );
  },
);

test(
  "a run with the corpus of an earlier run goes on from its coverage, and skips entries a reconversion broke",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  async () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const { source, plan, diagnostics } = await fixture(engine);
    const options = { seed: 1, budgetMs: 60_000, diagnostics, sources: new Map() };
    // A first run that a state budget stops early, then a second one with its corpus.
    const first = explore(engine, plan, { ...options, maxStates: 6, corpus: [] });
    assert.equal(first.search.stoppedBy, "maxStates");
    const corpus = first.corpus!.entries;
    const second = explore(engine, plan, { ...options, maxStates: 12, corpus });
    // The replay rebuilds the first run's coverage by applying each corpus input once, fewer steps than the first run
    // took; the second run then covers lines the first did not.
    assert.deepEqual(second.corpus!.coverageAtStart, first.corpus!.coverageAtEnd);
    assert.deepEqual([second.corpus!.replayed, second.corpus!.stale], [corpus.length, 0]);
    const inputs = corpus.flatMap((entry) => [
      ...(entry.earlier ?? []).flatMap((session) => session.inputs),
      ...entry.inputs,
    ]);
    assert.ok(second.corpus!.replaySteps <= inputs.length);
    assert.ok(second.corpus!.replaySteps < first.search.transitions);
    assert.ok(second.coverage.visitedLines > first.coverage.visitedLines);

    // A reconversion renames "Stay": each entry that chooses it is stale, and the others still replay.
    const renamed = source.replace('stay: "Stay"', 'stay: "Remain"');
    const compiled = engine.compileProject([{ path: "main.tease", source: renamed }], {
      builtins: [],
    });
    assert.ok(isRecord(compiled.plan));
    const kept = second.corpus!.entries;
    const third = explore(engine, compiled.plan, { ...options, maxStates: 12, corpus: kept });
    const staying = kept.filter((entry) =>
      [...(entry.earlier ?? []).flatMap((session) => session.inputs), ...entry.inputs].some(
        (input) => input.kind === "option" && input.label === "Stay",
      ),
    );
    assert.ok(staying.length > 0);
    assert.equal(third.corpus!.stale, staying.length);
    assert.ok(third.corpus!.coverageAtStart.visitedLines > first.coverage.visitedLines);
  },
);

test(
  "with realignment, corpus entries go on past a reconversion that moved an option or added a button",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  async () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const { source, plan, diagnostics } = await fixture(engine);
    const options = { seed: 1, budgetMs: 60_000, diagnostics, sources: new Map() };
    const corpus = explore(engine, plan, { ...options, maxStates: 12, corpus: [] }).corpus!.entries;
    // The reconversion asks for a button first, and lists "Right" before "Left".
    const moved = source
      .replace('say "Welcome."', 'say "Welcome."\nshowButton "Ready"')
      .replace('left: "Left", right: "Right"', 'right: "Right", left: "Left"');
    const { plan: movedPlan } = engine.compileProject([{ path: "main.tease", source: moved }], {
      builtins: [],
    });
    assert.ok(isRecord(movedPlan));
    const replay = (realign: boolean) =>
      explore(engine, movedPlan, { ...options, maxStates: 12, corpus, realign }).corpus!;
    const strict = replay(false);
    const realigned = replay(true);
    const withInputs = corpus.filter(
      (entry) => entry.inputs.length > 0 || entry.earlier !== undefined,
    );
    assert.equal(strict.stale, withInputs.length);
    assert.equal(realigned.stale, 0);
    assert.equal(realigned.realigned, withInputs.length);
    assert.ok(realigned.coverageAtStart.visitedLines > strict.coverageAtStart.visitedLines);
  },
);

test(
  "a work budget ends the search after that many runtime operations, the same way each time, and shows where expansions waited",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  async () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const { plan, diagnostics, lineOf } = await fixture(engine);
    const run = () => {
      const { search, ...rest } = explore(engine, plan, {
        seed: 1,
        budgetMs: Infinity,
        budgetOps: 60,
        maxStates: 5000,
        sources: new Map(),
        diagnostics,
      });
      const { elapsedMs: _elapsed, cpuMs: _cpu, ...work } = search;
      return { search: work, ...rest };
    };
    const first = run();
    assert.equal(first.search.stoppedBy, "operations");
    assert.ok(first.search.operations >= 60);
    assert.deepEqual(run(), first);
    // Each typed answer to the ask before "Go on" leads to its own state there, so most expansions wait at that button.
    const [top] = first.search.expansionsByPrompt;
    assert.deepEqual(top && [top.location, top.prompt, top.percent], [
      `main.tease:${lineOf('showButton "Go on"')}`,
      "[Go on]",
      Math.round((top!.expansions / first.search.expanded) * 1000) / 10,
    ]);
    assert.ok(top!.percent > 50);

    // The budget also ends a corpus replay between its sessions, which need no inputs: the entry is kept unreplayed.
    const sessions: CorpusEntry = {
      seed: 1,
      reason: "coverage",
      earlier: Array.from({ length: 10 }, () => ({ inputs: [] })),
      inputs: [],
    };
    const replayed = explore(engine, plan, {
      seed: 1,
      budgetMs: Infinity,
      budgetOps: 3,
      maxStates: 5000,
      sources: new Map(),
      diagnostics,
      corpus: [sessions],
    });
    assert.equal(replayed.search.stoppedBy, "operations");
    assert.equal(replayed.corpus!.replayed, 0);
    // Entries kept unreplayed come last in the corpus to keep.
    assert.deepEqual(replayed.corpus!.entries.at(-1), sessions);
  },
);

/**
 * A runtime session whose state keeps as few event sequences as it can once the player picks "Stay": the step then
 * throws inside the runtime (`nextEventSequence cannot be advanced`) and ends the session, as a runtime that fails on
 * its own state would. Every later call of that session throws `RuntimeSessionError`.
 */
function exhaustedAtStay(engine: Engine, plan: Data, runtime: Runtime): Runtime {
  let inner = runtime;
  const exhausted = (): Runtime => {
    const snapshot = inner.exportTrustedSnapshot();
    // The runtime refuses a state without room for the events its pending actions still need.
    for (let left = 1; left < 100; left += 1) {
      try {
        return engine.createRuntimeSession(plan, {
          ...snapshot,
          nextEventSequence: Number.MAX_SAFE_INTEGER - left,
        });
      } catch {
        continue;
      }
    }
    throw new Error("No state with few event sequences left was accepted.");
  };
  return {
    call: (name, ...args) => {
      const request = args[0];
      if (
        name === "completeAction" &&
        isRecord(request) &&
        isRecord(request.payload) &&
        request.payload.optionIndex === 2
      )
        inner = exhausted();
      return inner.call(name, ...args);
    },
    project: (name) => inner.project(name),
    view: () => inner.view(),
    callReturnInstructions: () => inner.callReturnInstructions(),
    exportTrustedSnapshot: () => inner.exportTrustedSnapshot(),
    fork: () => exhaustedAtStay(engine, plan, inner.fork()),
  };
}

test(
  "a runtime operation that throws is no crash, the search goes on beside it, and its input list replays the throw",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  async () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const failing: Engine = {
      ...engine,
      createFreshRuntimeSession: (plan, fresh) =>
        exhaustedAtStay(engine, plan, engine.createFreshRuntimeSession(plan, fresh)),
      createRuntimeSession: (plan, snapshot) =>
        exhaustedAtStay(engine, plan, engine.createRuntimeSession(plan, snapshot)),
    };
    const { plan, diagnostics, lineOf } = await fixture(engine);
    // A session used again after its operation threw would throw RuntimeSessionError out of `explore`.
    const result = explore(failing, plan, {
      seed: 1,
      budgetMs: 60_000,
      maxStates: 5000,
      sources: new Map(),
      diagnostics,
    });

    assert.ok(result.search.engineErrors.count >= 1);
    const first = result.search.engineErrors.first!;
    assert.match(first.message, /^RuntimeDataError: .*nextEventSequence/u);
    assert.deepEqual(first.inputs, [{ kind: "option", index: 2, label: "Stay" }]);
    assert.equal(replay(failing, plan, 1, first.inputs).error, first.message);
    // "Count", tried after "Stay" from the same state, is explored as without the throw.
    assert.equal(result.crashes.length, 1);
    const file = result.coverage.files.find((entry) => entry.path === "main.tease")!;
    const unvisited = (text: string) =>
      file.unvisited.some((entry) => {
        const [from = 0, to = from] = entry.lines.split("-").map(Number);
        return lineOf(text) >= from && lineOf(text) <= to;
      });
    assert.equal(unvisited('say "Secret number."'), false);
    assert.equal(unvisited('say "You are stuck."'), true);
  },
);

test(
  "a stored state the runtime refuses to restore is an engine error with its path, and the search goes on beside it",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  async () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const { plan, diagnostics } = await fixture(engine);
    // The explorer keeps trusted exports, which the runtime checks only when a session restores one; here it refuses
    // every state that waits at "Go on".
    let refused = 0;
    const refusing: Engine = {
      ...engine,
      createRuntimeSession: (target, snapshot) => {
        if (JSON.stringify(snapshot).includes('"Go on"')) {
          refused += 1;
          throw Object.assign(new Error("refused"), { name: "RuntimeDataError" });
        }
        return engine.createRuntimeSession(target, snapshot);
      },
    };
    const result = explore(refusing, plan, {
      seed: 1,
      budgetMs: 60_000,
      maxStates: 5000,
      sources: new Map(),
      diagnostics,
    });
    assert.equal(result.search.stoppedBy, "exhausted");
    assert.ok(refused > 0);
    assert.equal(result.search.engineErrors.count, refused);
    assert.equal(result.search.engineErrors.first?.message, "RuntimeDataError: refused");
    assert.equal(result.search.engineErrors.first?.inputs[0]?.kind, "option");
    assert.ok(result.endStates.completed >= 1);
  },
);

test(
  "the inputs of a state come from its runtime session: a caller's compared constants, a compared duration, the time a timed button is compared with, and the wait a block interrupted",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const start = (source: string) => {
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan));
      const session = new Session(engine, plan, 1);
      return { session, step: session.start() };
    };
    // The ask is far from the comparison, which is next to where the helper returns.
    const lines = (from: number) =>
      Array.from({ length: 45 }, (_, index) => `  say "Line ${from + index}."`).join("\n");
    const helper = start(
      `function askCode {\n${lines(1)}\n  let answer = askInteger default: 0\n${lines(100)}\n  return answer\n}\n` +
        'let code = askCode()\nif code == 4321 {\n  say "Opened."\n}\nexit\n',
    );
    const answers = helper.session
      .options(helper.step.runtime)
      .map((input) => (input.kind === "text" ? input.text : input.kind));
    assert.deepEqual(answers, ["0", "1", "-1", "1000000", "4320", "4321", "4322"]);

    // A button whose time the script compares with a duration can also be pressed just after it.
    const begged = start(
      'let beg = showButton "Beg"\nif beg >= 15 s {\n  say "Begged."\n}\nexit\n',
    );
    assert.deepEqual(begged.session.options(begged.step.runtime), [
      { kind: "button", label: "Beg" },
      { kind: "button", label: "Beg", afterMs: 16_000 },
    ]);

    // A button the code times by reading the clock before and after it, or whose time it compares with a value of the
    // state, can also be pressed just after the compared time.
    const timedStart = (source: string) => {
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan));
      const session = new Session(engine, plan, 1);
      const instructions = Array.isArray(plan.instructions)
        ? plan.instructions.filter(isRecord)
        : [];
      const flow = new DataFlow(plan, instructions);
      session.clockDifferences.push(...clockDifferences(flow, instructions));
      for (const [button, expressions] of comparedWith(flow, instructions, "timed"))
        session.timedWith.set(button, expressions);
      const step = session.start();
      return session.options(step.runtime, step.runtime.view(), () => step.snapshot);
    };
    assert.deepEqual(
      timedStart(
        'let took = getTimestamp().toSeconds()\nshowButton "Edge"\ntook = getTimestamp().toSeconds() - took\n' +
          'if took < 5 {\n  say "Too fast."\n}\nexit\n',
      ),
      [
        { kind: "button", label: "Edge" },
        { kind: "button", label: "Edge", afterMs: 6000 },
      ],
    );
    assert.deepEqual(
      timedStart(
        'let count = 40\nif (showButton "Done") / 1 s > count {\n  say "Good."\n}\nexit\n',
      ).at(-1),
      { kind: "button", label: "Done", afterMs: 41_000 },
    );

    // A timer block interrupts a wait with a button: the player can also wait for the end of the interrupted wait.
    const timed = start('timer async 1 s {\n  showButton "Hit"\n}\nwait 10 s\nsay "Done."\nexit\n');
    assert.deepEqual(timed.session.options(timed.step.runtime), [
      { kind: "button", label: "Hit" },
      { kind: "wait", untilMs: 10_000 },
    ]);
  },
);

test(
  "with cells, a loop that keeps making states no condition tells apart does not starve another way, and a cell is where a state waits with the buckets of what conditions compare",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const run = (source: string, budgetOps: number) => {
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan));
      return explore(engine, plan, {
        seed: 1,
        budgetMs: Infinity,
        budgetOps,
        maxStates: 5000,
        sources: new Map(),
        diagnostics: [],
        cells: true,
      });
    };
    // "Spiral" counts forever, every state new; "Tour" needs eight steps of code it already ran. The counts above 0 are
    // one cell, which the search expands less often as it goes, so the tour, a cell per pass, gets to its end.
    const spiral = run(
      'let count = 0\nlet side = choose spiral: "Spiral", tour: "Tour"\nif side == "spiral" {\n' +
        '  while count >= 0 {\n    showButton "Again"\n    count += 1\n  }\n}\n' +
        'for pass in 1..=8 {\n  showButton "Step"\n}\nsay "Reached."\nexit\n',
      40,
    );
    assert.equal(spiral.search.stoppedBy, "operations");
    const file = spiral.coverage.files[0]!;
    assert.deepEqual(
      file.unvisited.map((range) => range.reach),
      ["unreachable"],
    );

    // `n` is compared with 3 and 100: "Go" with `n` below 3, at 3, and between 3 and 100 are three cells, after the two
    // passes of "Round"; `n` changed bucket twice.
    const counted = run(
      'let n = 0\nfor pass in 1..=2 {\n  showButton "Round"\n}\nwhile n < 100 {\n  showButton "Go"\n  n += 1\n' +
        '  if n == 3 {\n    say "Three."\n  }\n}\nexit\n',
      80,
    );
    assert.deepEqual(counted.search.cells, { slots: 1, cells: 5, values: 3, transitions: 2 });
  },
);

test(
  "with compared answers, a typed ask is also answered with what the code compares the answer with in that state, such as the line to type",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const source =
      'let lines = ["I will obey.", "I am sorry."]\nlet count = 0\nwhile count < 2 {\n  let line = lines[count]\n' +
      '  let typed = askText "Type: ${line}"\n  if typed == line {\n    count += 1\n  } else {\n    say "Wrong."\n  }\n}\n' +
      'say "Done."\nexit\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: 60_000,
      maxStates: 5000,
      sources: new Map(),
      diagnostics: [],
      comparedAnswers: true,
    });
    // Each pass asks for another line; typing it is the only way out of the loop.
    assert.equal(result.search.stoppedBy, "exhausted");
    assert.equal(result.endStates.completed, 1);
    assert.ok(result.crashes.length === 0 && result.traps.length === 0);
  },
);

test(
  "with forward time, the late hour is play: the player continues when a clock condition comes out the other way, later sessions start after the clock their origin ended at, and a later gap must be positive",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  async () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const { source, plan, diagnostics, lineOf } = await fixture(engine);
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: 60_000,
      maxStates: 5000,
      sources: new Map([["main.tease", source]]),
      diagnostics,
      later: true,
      corpus: [],
    });
    assert.equal(result.search.stoppedBy, "exhausted");
    // The late hour is play: before the button after which the hour is read, the player continues at 22:01.
    const file = result.coverage.files.find((entry) => entry.path === "main.tease")!;
    const late = lineOf('say "Late."');
    assert.ok(
      !file.unvisited.some((range) => {
        const [from = 0, to = from] = range.lines.split("-").map(Number);
        return late >= from && late <= to;
      }),
    );
    assert.equal(result.coverage.reach.clock, 0);
    // The corpus keeps the path, with its later input, and replaying it says "Late.".
    const kept = result.corpus!.entries.find((entry) =>
      entry.inputs.some((input) => input.kind === "later"),
    )!;
    const replayed = replay(engine, plan, 1, kept.inputs, {
      earlier: kept.earlier ?? [],
      wallClockMs: kept.wallClockMs ?? EPOCH_MS,
    });
    assert.ok(replayed.steps.some((step) => step.texts.includes("Late.")));
    // A next session starts after the clock where the session it continues ended.
    const back = result.directed.ways.find((entry) => entry.sessions === 2)!;
    const earlier = replay(engine, plan, 1, back.repro.earlier![0]!.inputs);
    assert.ok(back.repro.wallClockMs! > wallClockOf(earlier.snapshot));

    // Continuing later moves the clock forward by the gap; a gap that is not positive is rejected.
    const session = new Session(engine, plan, 1);
    const start = session.start();
    const now = wallClockOf(start.snapshot);
    assert.equal(
      session.apply(start.runtime.fork(), { kind: "later", afterMs: -3_600_000 }, false),
      null,
    );
    const moved = session.apply(start.runtime, { kind: "later", afterMs: 3_600_000 }, false);
    assert.equal(wallClockOf(moved!.snapshot), now + 3_600_000);
  },
);
