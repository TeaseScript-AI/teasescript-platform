import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { isRecord } from "../src/ast.ts";
import {
  branchDistance,
  clockDifferences,
  comparedWith,
  conditionDistance,
  conjunctive,
  DataFlow,
  type PlanDiagnostic,
} from "../src/explorer-analysis.ts";
import { FAR, TreasureMap } from "../src/explorer-guidance.ts";
import { explore, type CorpusEntry } from "../src/explorer-search.ts";
import { clockModel, holdsAt, storedHolds, timeContext } from "../src/explorer-time.ts";
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
    const back = way('(load "fixture.visited", default: false) == true');
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
      [
        branch('pick == "never"')?.reach,
        branch('(load "intro.legacy", default: false) == true')?.reason,
      ],
      ["unreachable", "key never saved in this package: intro.legacy"],
    );
    assert.match(
      branch('(load "fixture.level", default: 0) == 2')?.reason ?? "",
      /every save of fixture\.level is a literal/u,
    );
    // A stored boolean that no explored session saved: the note shows the constant as the condition writes it.
    assert.equal(
      branch('(load "fixture.badge", default: false) == true')?.reason,
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
    // On the same plan, entries replay as they are: nothing is realigned, and no step more is taken.
    const same = (realign: boolean) =>
      explore(engine, plan, { ...options, maxStates: 12, corpus, realign }).corpus!;
    assert.deepEqual([same(true).realigned, same(true).replaySteps], [0, same(false).replaySteps]);
    // The reconversion asks for a timed button first, and lists "Right" before "Left".
    const moved = source
      .replace(
        'say "Welcome."',
        'say "Welcome."\nlet spent = showButton "Ready"\nif spent > 30 s {\n  say "Slow."\n}',
      )
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
    // Entries that share a moved option ("Count" and "Stay" swap) each count as realigned, also when one before
    // already applied it.
    const { plan: swappedPlan } = engine.compileProject(
      [
        {
          path: "main.tease",
          source: source.replace('stay: "Stay", count: "Count"', 'count: "Count", stay: "Stay"'),
        },
      ],
      { builtins: [] },
    );
    assert.ok(isRecord(swappedPlan));
    const counting = corpus.filter((entry) =>
      [...(entry.earlier ?? []), entry].some((part) =>
        part.inputs.some(
          (input) => input.kind === "option" && (input.label === "Count" || input.label === "Stay"),
        ),
      ),
    ).length;
    assert.ok(counting >= 3);
    const swapped = explore(engine, swappedPlan, {
      ...options,
      maxStates: 12,
      corpus,
      realign: true,
    }).corpus!;
    assert.deepEqual([swapped.stale, swapped.realigned], [0, counting]);

    // An earlier condition of an `else if` chain is read from stored values, an unset key by its load's default.
    const { plan: guarded } = engine.compileProject(
      [
        {
          path: "main.tease",
          source: 'if (load "a", default: true) == true {\n  say "A."\n}\nexit\n',
        },
      ],
      { builtins: [] },
    );
    assert.ok(isRecord(guarded));
    const condition = (Array.isArray(guarded.instructions) ? guarded.instructions : [])
      .filter(isRecord)
      .find((instruction) => instruction.kind === "jumpIfFalse")!.condition;
    assert.equal(storedHolds(condition, new Map()), true);
    assert.equal(storedHolds(condition, new Map([["a", false]])), false);
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
    exportSnapshot: () => inner.exportSnapshot(),
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
    // A time divided by ten seconds is compared in tens of seconds.
    assert.deepEqual(
      timedStart(
        'let limit = 5\nif (showButton "Check") / 10 s > limit {\n  say "Slow."\n}\nexit\n',
      ).at(-1),
      { kind: "button", label: "Check", afterMs: 51_000 },
    );
    // Both clock reads kept in variables time the button between them; a read the variable lost times nothing.
    assert.deepEqual(
      timedStart(
        'let a = getTimestamp().toSeconds()\nshowButton "One"\nlet b = getTimestamp().toSeconds()\n' +
          'if b - a < 5 {\n  say "Fast."\n}\nexit\n',
      ).at(-1),
      { kind: "button", label: "One", afterMs: 6000 },
    );
    assert.deepEqual(
      timedStart(
        'let a = getTimestamp().toSeconds()\na = 0\nshowButton "Two"\nlet t = getTimestamp().toSeconds() - a\n' +
          'if t < 5 {\n  say "Fast."\n}\nexit\n',
      ),
      [{ kind: "button", label: "Two" }],
    );
    // A difference the variable lost before the comparison times nothing either, nor one updated into other units.
    for (const update of ["took = 0", "took = took * 2"])
      assert.deepEqual(
        timedStart(
          'let a = getTimestamp().toSeconds()\nshowButton "Three"\nlet took = getTimestamp().toSeconds() - a\n' +
            `${update}\nif took < 5 {\n  say "Fast."\n}\nexit\n`,
        ),
        [{ kind: "button", label: "Three" }],
        update,
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
  "with forward time, the player continues just past when a clock condition read after a prompt comes out the other way: an hour, a minute, a month, a window of elapsed time, a helper's hour, also without cells",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const cases: [string, string, boolean][] = [
      ["hour", 'showButton "Check"\nif getDateTime().hour >= 22 {\n  say "Hit."\n}\nexit\n', true],
      [
        "minute",
        'showButton "Check"\nif getDateTime().minute == 30 {\n  say "Hit."\n}\nexit\n',
        true,
      ],
      [
        "month",
        'showButton "Check"\nif getDateTime().month == 11 {\n  say "Hit."\n}\nexit\n',
        true,
      ],
      [
        "window",
        'let start = getTimestamp()\nshowButton "Go"\nlet took = (getTimestamp() - start) / 1 s\n' +
          'if took >= 300 and took < 600 {\n  say "Hit."\n}\nexit\n',
        true,
      ],
      [
        "helper",
        'function hourNow {\n  return getDateTime().hour\n}\nshowButton "Check"\nif hourNow() == 17 {\n' +
          '  say "Hit."\n}\nexit\n',
        true,
      ],
      [
        "exact elapsed",
        'let start = getTimestamp().toSeconds()\nshowButton "Go"\nlet took = getTimestamp().toSeconds() - start\n' +
          'if took == 300 {\n  say "Hit."\n}\nexit\n',
        true,
      ],
      ["session start", 'if getDateTime().hour >= 22 {\n  say "Hit."\n}\nexit\n', true],
      [
        "updated straight on",
        'let start = getTimestamp().toMilliseconds()\nshowButton "Go"\n' +
          'let took = getTimestamp().toMilliseconds() - start\ntook = took / 1000\nif took > 600 {\n  say "Hit."\n}\nexit\n',
        true,
      ],
      [
        "converted comparison",
        "global function sexscriptLegacyCompare(left, right) {\n  if left == null {\n    if right == null {\n" +
          "      return 0\n    }\n    return -1\n  }\n  if right == null {\n    return 1\n  }\n  if left < right {\n" +
          '    return -1\n  }\n  if left > right {\n    return 1\n  }\n  return 0\n}\nshowButton "Check"\n' +
          'let minute = getDateTime().minute\nif sexscriptLegacyCompare(minute, 37) == 0 {\n  say "Hit."\n}\nexit\n',
        true,
      ],
      [
        "converted timestamp equality",
        "global function sexscriptLegacyCompare(left, right) {\n  if left == null {\n    if right == null {\n" +
          "      return 0\n    }\n    return -1\n  }\n  if right == null {\n    return 1\n  }\n  if left < right {\n" +
          '    return -1\n  }\n  if left > right {\n    return 1\n  }\n  return 0\n}\nshowButton "Check"\n' +
          'if sexscriptLegacyCompare(getTimestamp().toSeconds(), 1790943000) == 0 {\n  say "Hit."\n}\nexit\n',
        true,
      ],
      [
        "time taken against a bound from the clock",
        "function limit {\n  return getTimestamp().toSeconds() - 1790946000\n}\nlet start = getTimestamp().toSeconds()\n" +
          'showButton "Check"\nlet took = getTimestamp().toSeconds() - start\ntook = took * 2\nlet bound = limit()\n' +
          'if took <= bound and took >= 0 {\n  say "Hit."\n}\nexit\n',
        true,
      ],
      [
        "time kept through a function",
        'function stamp {\n  return getTimestamp()\n}\nlet start = stamp()\nshowButton "Go"\n' +
          'if (getTimestamp() - start) / 1 s >= 300 {\n  say "Hit."\n}\nexit\n',
        true,
      ],
      [
        "repeated without cells",
        'let n = 0\nwhile n < 2 {\n  showButton "Go"\n  n += 1\n}\nif getDateTime().hour >= 22 {\n' +
          '  say "Hit."\n}\nexit\n',
        false,
      ],
    ];
    for (const [name, source, cells] of cases) {
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan), name);
      const result = explore(engine, plan, {
        seed: 1,
        budgetMs: 60_000,
        maxStates: 2000,
        sources: new Map(),
        diagnostics: [],
        later: true,
        cells,
      });
      assert.equal(result.search.stoppedBy, "exhausted", name);
      const hit = source.split("\n").findIndex((line) => line.includes('"Hit."')) + 1;
      assert.ok(
        !result.coverage.files[0]!.unvisited.some((range) => {
          const [from = 0, to = from] = range.lines.split("-").map(Number);
          return hit >= from && hit <= to;
        }),
        name,
      );
      assert.equal(result.coverage.reach.clock, 0, name);
    }

    // A variable computed from the clock in two ways, or updated from itself, cannot be computed again: its comparison
    // reads as unknown, whatever the variable holds in the state.
    for (const update of ["hour = getDateTime().hour + 1", "hour += 100"]) {
      const source = `let hour = getDateTime().hour\nshowButton "Go"\n${update}\nif hour == 14 {\n  say "Hit."\n}\nexit\n`;
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan));
      const instructions = Array.isArray(plan.instructions)
        ? plan.instructions.filter(isRecord)
        : [];
      const model = clockModel(plan, instructions);
      const [comparison] = [...model.comparisons.values()][0]!;
      const bound = timeContext({ globals: [{ name: "hour", value: 14 }] });
      assert.equal(holdsAt(comparison!, model, bound, EPOCH_MS), undefined, update);
    }
    // A return window learned in an earlier session, from a time away the session computes when it starts: a next
    // session starts inside it, after "too soon" and before "too late", which neither a minute nor a day later is; also
    // when a visit outside it leaves the storage as it was, so that the window is learned from the same storage.
    // And from a session that saves before its last prompt, which completes with the storage a state before it left.
    for (const [outside, bye] of [
      ["", ""],
      ["    exit\n", ""],
      ["", 'showButton "Bye"\n'],
    ]) {
      const source =
        'let last = load "last", default: 0\nlet away = getTimestamp().toSeconds() - last\nshowButton "Go"\n' +
        `if last > 0 {\n  if away < 7200 {\n    say "Too soon."\n${outside}` +
        `  } else if away > 18000 {\n    say "Too late."\n${outside}  } else {\n    say "Welcome back."\n  }\n}\n` +
        `save getTimestamp().toSeconds() as "last"\n${bye}exit\n`;
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan));
      const result = explore(engine, plan, {
        seed: 1,
        budgetMs: 60_000,
        maxStates: 2000,
        sources: new Map(),
        diagnostics: [],
        later: true,
      });
      const welcome = source.split("\n").findIndex((line) => line.includes("Welcome back.")) + 1;
      assert.ok(
        !result.coverage.files[0]!.unvisited.some((range) => {
          const [from = 0, to = from] = range.lines.split("-").map(Number);
          return welcome >= from && welcome <= to;
        }),
        `${outside}${bye}`,
      );
      assert.equal(result.coverage.reach.clock, 0);
    }
    // A condition that also compares how long the player took, inline, with a value from the clock is not only timed by
    // the player: it keeps forward time.
    {
      const source =
        "function limit {\n  return getTimestamp().toSeconds() - 1790946000\n}\nlet start = getTimestamp().toSeconds()\n" +
        'showButton "Check"\nlet bound = limit()\nif (getTimestamp().toSeconds() - start) <= bound and ' +
        '(getTimestamp().toSeconds() - start) >= 0 {\n  say "Hit."\n}\nexit\n';
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan));
      const instructions = Array.isArray(plan.instructions)
        ? plan.instructions.filter(isRecord)
        : [];
      const condition = instructions.findLastIndex(
        (instruction) => instruction.kind === "jumpIfFalse",
      );
      const differences = clockDifferences(new DataFlow(plan, instructions), instructions);
      assert.ok(differences.length > 0);
      assert.ok(differences.every((difference) => !difference.conditions.includes(condition)));
    }
    // A value a session sets before it reads the clock, through a function that only computes it (the converted load
    // helper, with a key from a variable set once), is read from the storage where a state has no value for it yet. A
    // function with an effect, or one that would not end, is not run.
    {
      const helpers =
        "global function sexscriptLegacyValue(value) {\n  return value\n}\n" +
        "global function sexscriptLegacyLoadInteger(key, whenMissing = null) {\n  let value = load key, default: null\n" +
        "  if value == null {\n    return whenMissing\n  }\n  return sexscriptLegacyValue(toInteger(value))\n}\n" +
        'function noisy(key) {\n  say "Loading."\n  return load key, default: 0\n}\n' +
        "let offset = 0\nfunction shifted(key) {\n  offset = 1\n  return load key, default: 0\n}\n" +
        "function forever(n) {\n  return forever(n + 1)\n}\n";
      for (const [load, expected] of [
        ['sexscriptLegacyLoadInteger("${scriptText}.last")', [false, true]],
        ['noisy("${scriptText}.last")', [undefined, undefined]],
        ['shifted("${scriptText}.last")', [undefined, undefined]],
        ["forever(1)", [undefined, undefined]],
      ] as const) {
        const source =
          `${helpers}showButton "Start"\nlet scriptText = "dc"\nlet last = ${load}\nshowButton "Go"\n` +
          'if getTimestamp().toSeconds() - last > 3600 {\n  say "Hit."\n}\nexit\n';
        const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
        assert.ok(isRecord(plan));
        const instructions = Array.isArray(plan.instructions)
          ? plan.instructions.filter(isRecord)
          : [];
        const model = clockModel(plan, instructions);
        const [comparison] = [...model.comparisons.values()].at(-1) ?? [];
        assert.ok(comparison !== undefined, load);
        const stored = timeContext({ scriptStorage: [{ key: "dc.last", value: EPOCH_MS / 1000 }] });
        assert.deepEqual(
          [60, 7200].map((seconds) =>
            holdsAt(comparison, model, stored, EPOCH_MS + seconds * 1000),
          ),
          expected,
          load,
        );
      }
    }
    // Updates from itself compose with the clock read before them: one that adds 1 at 17:00 compares 18, also after
    // forty doublings, each computed once; a literal between them ends that.
    const doubled = Array.from({ length: 40 }, () => "h = h + h\n").join("");
    for (const [updates, expected] of [
      ["h = h + 1\n", true],
      [`h = h - 17\n${doubled}h = h + 18\n`, true],
      ["h = 0\nh = h + 1\n", undefined],
    ] as const) {
      const source = `let h = getDateTime().hour\n${updates}showButton "Go"\nif h == 18 {\n  say "Hit."\n}\nexit\n`;
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan));
      const instructions = Array.isArray(plan.instructions)
        ? plan.instructions.filter(isRecord)
        : [];
      const model = clockModel(plan, instructions);
      const [comparison] = [...model.comparisons.values()][0] ?? [];
      assert.ok(comparison !== undefined, updates);
      const atFive = EPOCH_MS + 5 * 3_600_000;
      assert.equal(holdsAt(comparison, model, timeContext({}), atFive), expected, updates);
    }
  },
);

test(
  "with progress leads, a loop that needs a hundred rounds to cross a compared constant is followed to it beside a wide tree of choices",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    // "Tree" offers six rounds of three choices that conditions compare, so many states and cells; "Count" needs a
    // hundred presses before "Done.".
    const rounds = Array.from(
      { length: 6 },
      (_, index) =>
        `  let pick${index} = choose a: "A${index}", b: "B${index}", c: "C${index}"\n` +
        `  if pick${index} == "a" {\n    say "a${index}"\n  }\n  showButton "Next${index}"\n`,
    ).join("");
    const source =
      `let side = choose tree: "Tree", count: "Count"\nif side == "tree" {\n${rounds}  exit\n}\n` +
      'let count = 0\nwhile count < 100 {\n  showButton "Stroke"\n  count += 1\n}\nsay "Done."\nexit\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: Infinity,
      budgetOps: 2400,
      maxStates: 100_000,
      sources: new Map(),
      diagnostics: [],
      progressLeads: true,
    });
    const done = source.split("\n").findIndex((line) => line.includes('say "Done."')) + 1;
    const file = result.coverage.files.find((entry) => entry.path === "main.tease")!;
    assert.ok(
      !file.unvisited.some((range) => {
        const [from = 0, to = from] = range.lines.split("-").map(Number);
        return done >= from && done <= to;
      }),
    );
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

    // Five asks each compare their own `answer` with their own word, and an object property named `length` is read as
    // the property: every word is answered.
    const asks = Array.from(
      { length: 5 },
      (_, index) =>
        `function ask${index} {\n  let word = "word${index}"\n  let answer = askText "Say ${index}"\n` +
        `  if answer == word {\n    say "Hit ${index}."\n  }\n}\n`,
    ).join("");
    // Asks whose comparisons read other variables come first, and the last compares its answer far after the ask: its
    // own comparison still counts before theirs. Each of two timers keeps the word its call was given.
    const far = Array.from({ length: 100 }, (_, index) => `  say "Line ${index}."\n`).join("");
    const own = Array.from(
      { length: 5 },
      (_, index) =>
        `function own${index} {\n  let word${index} = "own${index}"\n  let answer = askText "Own ${index}"\n` +
        `${index === 4 ? far : ""}  if answer == word${index} {\n    say "Own hit ${index}."\n  }\n}\n`,
    ).join("");
    const kept =
      'function arm(word) {\n  timer async 1 s {\n    let answer = askText "Say"\n    if answer == word {\n' +
      '      if word == kept[0] {\n        say "Kept one."\n      }\n      say "Kept."\n    }\n  }\n}\n' +
      'let kept = ["one", "two"]\narm(kept[0])\narm(kept[1])\nwait 5 s\n';
    const words =
      `${asks}${own}ask0()\nask1()\nask2()\nask3()\nask4()\nown0()\nown1()\nown2()\nown3()\nown4()\n${kept}` +
      'let info = { length: "secret" }\nlet reply = askText "Say it"\nif reply == info.length {\n  say "Secret."\n}\n' +
      "exit\n";
    const { plan: wordPlan } = engine.compileProject([{ path: "main.tease", source: words }], {
      builtins: [],
    });
    assert.ok(isRecord(wordPlan));
    const said = explore(engine, wordPlan, {
      seed: 1,
      budgetMs: 60_000,
      maxStates: 5000,
      sources: new Map(),
      diagnostics: [],
      comparedAnswers: true,
    });
    assert.equal(said.search.stoppedBy, "exhausted");
    assert.deepEqual(
      said.coverage.files[0]!.unvisited.filter((range) => range.reach === "unknown"),
      [],
    );
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
    // Sessions by number: first sessions (also those started later or at another clock), and next ones from what
    // sessions stored; each counts its completions.
    const { started, completed } = result.search.bySession;
    assert.ok(started[0]! >= 1 && started.length >= 2);
    assert.equal(
      started.reduce((sum, value) => sum + value, 0),
      result.search.sessions,
    );
    assert.equal(completed.length, started.length);
    assert.equal(
      completed.reduce((sum, value) => sum + value, 0),
      result.endStates.completed,
    );
    // The corpus keeps the path, with its later input, and replaying it says "Late.".
    const kept = result.corpus!.entries.find((entry) =>
      entry.inputs.some((input) => input.kind === "later"),
    )!;
    const replayed = replay(engine, plan, 1, kept.inputs, {
      earlier: kept.earlier ?? [],
      wallClockMs: kept.wallClockMs ?? EPOCH_MS,
    });
    assert.ok(replayed.steps.some((step) => step.texts.includes("Late.")));
    // A corpus replays it too, with or without realignment.
    for (const realign of [false, true]) {
      const again = explore(engine, plan, {
        seed: 1,
        budgetMs: 60_000,
        maxStates: 5000,
        sources: new Map([["main.tease", source]]),
        diagnostics,
        later: true,
        realign,
        corpus: [kept],
      }).corpus!;
      assert.deepEqual([again.replayed, again.stale], [1, 0]);
    }
    // A next session starts after the clock where the session it continues ended.
    const back = result.directed.ways.find((entry) => entry.sessions === 2)!;
    const earlier = replay(engine, plan, 1, back.repro.earlier![0]!.inputs);
    assert.ok(back.repro.wallClockMs! > wallClockOf(earlier.snapshot));
    // Replayed from a corpus, that next session is play; one that starts at the very clock its origin ended at is not.
    const startCoverage = (wallClockMs: number) =>
      explore(engine, plan, {
        seed: 1,
        budgetMs: 60_000,
        maxStates: 5000,
        sources: new Map([["main.tease", source]]),
        diagnostics,
        later: true,
        corpus: [{ ...back.repro, wallClockMs, seed: 1, reason: "coverage" }],
      }).corpus!.coverageAtStart.visitedLines;
    assert.ok(
      startCoverage(wallClockOf(earlier.snapshot)) < startCoverage(back.repro.wallClockMs!),
    );

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

test(
  "the branch distance of a condition sums the parts its way needs all of, takes the nearest of alternatives, and counts satisfied and unreadable atoms as nothing",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const conditionOf = (text: string) => {
      const source = `let a = 0\nlet b = 0\nlet c = 0\nlet half = 0\nlet name = ""\nlet flag = 0\nif ${text} {\n  say "Hit."\n}\nexit\n`;
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan));
      const instructions = Array.isArray(plan.instructions)
        ? plan.instructions.filter(isRecord)
        : [];
      return instructions.find((instruction) => instruction.kind === "jumpIfFalse")!.condition;
    };
    const values = new Map<string, number | string | boolean>([
      ["a", 3],
      ["b", 10],
      ["half", 0.5],
      ["name", "foobar"],
    ]);
    const read = (subject: unknown) =>
      isRecord(subject) && subject.kind === "identifier"
        ? values.get(String(subject.name))
        : undefined;
    const measure = (text: string, wanted = true) =>
      conditionDistance(conditionOf(text), wanted, read);
    // Both parts: 2 short of 5, and 4 over 6; a satisfied part adds nothing, nor does one that cannot be read.
    assert.deepEqual(measure("a >= 5 and b <= 6"), { unsatisfied: 2, sum: 6 });
    assert.deepEqual(measure("a >= 1 and b <= 6"), { unsatisfied: 1, sum: 4 });
    assert.deepEqual(measure("a >= 5 and c == 1"), { unsatisfied: 1, sum: 2 });
    // Either part: the one with fewer atoms unsatisfied, then the nearer.
    assert.deepEqual(measure("(a >= 5 and b <= 6) or a == 2"), { unsatisfied: 1, sum: 1 });
    // A false way of an `or` needs both parts false.
    assert.equal(conjunctive(conditionOf("a == 3 or b == 10"), false), true);
    assert.equal(conjunctive(conditionOf("a == 3 or b == 10"), true), false);
    assert.deepEqual(measure("a == 3 or b == 10", false), { unsatisfied: 2, sum: 2 });
    // An atom counts as it holds: a fraction above 0, a text that contains another.
    assert.deepEqual(measure('half > 0 and name.contains("foo")'), { unsatisfied: 0, sum: 0 });
    assert.deepEqual(measure('name.contains("foo")', false), { unsatisfied: 1, sum: 1 });
    // A number is not a boolean, as the runtime compares.
    values.set("flag", 1);
    assert.deepEqual(measure("flag == true"), { unsatisfied: 1, sum: 1 });
    // Fewer atoms unsatisfied come first, however far the one left is; a step of one still counts far away.
    assert.ok(
      branchDistance({ unsatisfied: 1, sum: 2e9 }) < branchDistance({ unsatisfied: 2, sum: 1 }),
    );
    assert.ok(
      branchDistance({ unsatisfied: 1, sum: 1e12 - 1 }) <
        branchDistance({ unsatisfied: 1, sum: 1e12 }),
    );
  },
);

test(
  "the map of a plan counts the decisions from each instruction to the nearest code not reached, through calls and a next session, past constant conditions",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const source =
      'function deep {\n  say "Deep."\n}\nlet pick = choose a: "A", b: "B"\nif pick == "b" {\n  let more = choose c: "C", d: "D"\n' +
      '  if more == "d" {\n    deep()\n  }\n}\nif false {\n  say "Never."\n}\nsay "End."\nexit\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const instructions = Array.isArray(plan.instructions) ? plan.instructions.filter(isRecord) : [];
    const index = (kind: string, text?: string) =>
      instructions.findIndex(
        (instruction) =>
          instruction.kind === kind &&
          (text === undefined || JSON.stringify(instruction).includes(text)),
      );
    const deep = index("say", "Deep.");
    const never = index("say", "Never.");
    const first = index("interaction");
    const constant = index("jumpIfFalse", '"value":false');
    const map = new TreasureMap(plan, instructions, new Map([[constant, false]]));
    // Only the deep text is not reached: from the first prompt, its answer, the condition after it, the second
    // prompt's answer, and the condition before the call are four decisions.
    map.update((at) => at === deep);
    assert.equal(map.distances[deep], 0);
    assert.equal(map.distances[first], 4);
    // After the end of the session, the next one starts: three decisions more than from the start.
    assert.equal(map.distances[index("exit")], 3 + map.distances[0]!);
    // Code behind a condition the plan knows is false is not on the way to anything.
    map.update((at) => at === never);
    assert.equal(map.distances[first], FAR);
    // A function's unreached code and the unreached code its call goes on with make one region, through its return.
    const call = index("callFunction");
    const back = Number(instructions[call]!.returnInstruction);
    const unreached = new Set([deep, deep + 1, back]);
    const regions = map.regions((at) => unreached.has(at));
    assert.deepEqual(regions, [[deep, deep + 1, back].sort((left, right) => left - right)]);
    // With the function's return reached, its code and the call's continuation are apart.
    const apart = map.regions((at) => at === deep || at === back);
    assert.equal(apart.length, 2);
  },
);

test(
  "with conjunctive steering and guidance, the fixture is explored as fully as without",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  async () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const { source, plan, diagnostics } = await fixture(engine);
    const run = (steering: boolean) =>
      explore(engine, plan, {
        seed: 1,
        budgetMs: 60_000,
        maxStates: 5000,
        sources: new Map([["main.tease", source]]),
        diagnostics,
        later: true,
        conjunctive: steering,
        guidance: steering,
      });
    const plain = run(false);
    const steered = run(true);
    assert.equal(steered.search.stoppedBy, "exhausted");
    assert.equal(steered.coverage.visitedLines, plain.coverage.visitedLines);
    // A way that needs both counters is steered to by their summed distance.
    const both =
      'let a = 0\nlet b = 0\nwhile true {\n  let pick = choose up: "A", down: "B", stop: "Stop"\n' +
      '  if pick == "up" {\n    a += 1\n  } else if pick == "down" {\n    b += 1\n  } else {\n    exit\n  }\n' +
      '  if a >= 3 and b >= 2 {\n    say "Both."\n    exit\n  }\n}\n';
    const { plan: bothPlan } = engine.compileProject([{ path: "main.tease", source: both }], {
      builtins: [],
    });
    assert.ok(isRecord(bothPlan));
    const counted = explore(engine, bothPlan, {
      seed: 1,
      budgetMs: 60_000,
      maxStates: 5000,
      sources: new Map(),
      diagnostics: [],
      conjunctive: true,
      guidance: true,
    });
    assert.ok(counted.endStates.completed > 0);
    assert.ok(
      !counted.coverage.files[0]!.unvisited.some((range) => range.lines.split("-").includes("13")),
    );
  },
);
