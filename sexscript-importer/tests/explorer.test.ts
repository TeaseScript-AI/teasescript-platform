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
  exactMilliseconds,
  type Goal,
  type PlanDiagnostic,
} from "../src/explorer-analysis.ts";
import { FAR, TreasureMap } from "../src/explorer-guidance.ts";
import { explore, noteOf, type CorpusEntry } from "../src/explorer-search.ts";
import { playtestReport } from "../tools/explore-report.ts";
import { clockModel, flipGap, holdsAt, storedHolds, timeContext } from "../src/explorer-time.ts";
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
    // Room for every entry: one with an earlier session takes the states of both.
    const replay = (realign: boolean) =>
      explore(engine, movedPlan, { ...options, maxStates: 24, corpus, realign }).corpus!;
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
    exportTaggedSnapshot: () => inner.exportTaggedSnapshot(),
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
      createTaggedRuntimeSession: (plan, tagged) =>
        exhaustedAtStay(engine, plan, engine.createTaggedRuntimeSession(plan, tagged)),
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
    // The explorer keeps tagged exports and restores them; here the runtime refuses every state that waits at "Go on".
    let refused = 0;
    const refuse = (json: string) => {
      if (!json.includes('"Go on"')) return;
      refused += 1;
      throw Object.assign(new Error("refused"), { name: "RuntimeDataError" });
    };
    const refusing: Engine = {
      ...engine,
      createRuntimeSession: (target, snapshot) => {
        refuse(JSON.stringify(snapshot));
        return engine.createRuntimeSession(target, snapshot);
      },
      createTaggedRuntimeSession: (target, tagged) => {
        refuse(tagged.json);
        return engine.createTaggedRuntimeSession(target, tagged);
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
      `function askCode {\n${lines(1)}\n  let answer = askInteger prefill: 0\n${lines(100)}\n  return answer\n}\n` +
        'let code = askCode()\nif code == 4321 {\n  say "Opened."\n}\nexit\n',
    );
    const answers = helper.session
      .options(helper.step.runtime)
      .map((input) => (input.kind === "text" ? input.text : input.kind));
    assert.deepEqual(answers, ["0", "1", "-1", "4320", "4321", "4322"]);

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
        'let took = getAbsoluteDateTime().toSeconds()\nshowButton "Edge"\ntook = getAbsoluteDateTime().toSeconds() - took\n' +
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
        'let a = getAbsoluteDateTime().toSeconds()\nshowButton "One"\nlet b = getAbsoluteDateTime().toSeconds()\n' +
          'if b - a < 5 {\n  say "Fast."\n}\nexit\n',
      ).at(-1),
      { kind: "button", label: "One", afterMs: 6000 },
    );
    assert.deepEqual(
      timedStart(
        'let a = getAbsoluteDateTime().toSeconds()\na = 0\nshowButton "Two"\nlet t = getAbsoluteDateTime().toSeconds() - a\n' +
          'if t < 5 {\n  say "Fast."\n}\nexit\n',
      ),
      [{ kind: "button", label: "Two" }],
    );
    // A difference the variable lost before the comparison times nothing either, nor one updated into other units.
    for (const update of ["took = 0", "took = took * 2"])
      assert.deepEqual(
        timedStart(
          'let a = getAbsoluteDateTime().toSeconds()\nshowButton "Three"\nlet took = getAbsoluteDateTime().toSeconds() - a\n' +
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
        sources: new Map([["main.tease", source]]),
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
    // Every line of the script is reached; the compiler's own end after `exit` is no line of it. An `end` the author
    // wrote is, also when the file's text is not at hand to tell them apart.
    const file = spiral.coverage.files[0]!;
    assert.deepEqual(file.unvisited, []);
    const authored = "goto finish\nend\nlabel finish\nexit\n";
    const { plan: ending } = engine.compileProject([{ path: "main.tease", source: authored }], {
      builtins: [],
    });
    assert.ok(isRecord(ending));
    for (const sources of [new Map([["main.tease", authored]]), new Map<string, string>()]) {
      const ended = explore(engine, ending, {
        seed: 1,
        budgetMs: Infinity,
        budgetOps: 200,
        maxStates: 100,
        sources,
        diagnostics: [],
      });
      assert.ok(
        ended.coverage.files[0]!.unvisited.some((range) => range.lines === "2"),
        JSON.stringify(ended.coverage.files[0]),
      );
    }

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
  "a supplied argument skips its default: a function body after a default that always exits is reachable",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const source =
      'function stop(code) {\n  exit\n  return code\n}\nfunction greet(times = stop(1)) {\n  say "Hello."\n' +
      '  return times\n}\nshowButton "Go"\ngreet(times: 2)\nsay "Done."\nexit\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: Infinity,
      budgetOps: 200,
      maxStates: 100,
      sources: new Map(),
      diagnostics: [],
    });
    // Without the skip the body ran though the analysis held it unreachable, and no line could be labelled.
    assert.equal(result.coverage.staticContradictions, 0);
    const unvisited = result.coverage.files[0]!.unvisited;
    assert.deepEqual(
      unvisited.find((range) => range.lines === "3"),
      { lines: "3", reach: "unreachable", reason: "no execution path from the session start" },
    );
  },
);

test(
  "a condition that ands a stored value's test with a call asks no stored value to be true: the temporary the code computes its truth in is no stored value",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const source =
      "function later(stamp) {\n  return stamp - 100\n}\n" +
      'let pick = choose keep: "Keep", drop: "Drop"\nif pick == "keep" {\n  save 500 as "pass.until"\n}\n' +
      'showButton "Check"\nif load("pass.until", default: 0) != 0 and later(load("pass.until", default: 0)) > 1000 {\n' +
      '  say "Still valid."\n}\nexit\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: Infinity,
      budgetOps: 2000,
      maxStates: 100_000,
      sources: new Map([["main.tease", source]]),
      diagnostics: [],
    });
    const missed = result.coverage.unvisitedBranches.filter((entry) => entry.line === 9);
    assert.ok(missed.length > 0);
    for (const entry of missed) {
      assert.ok(!(entry.reason ?? "").includes("== true"), entry.reason);
      assert.ok(
        entry.parts.every((part) => !part.needs.includes("== true")),
        JSON.stringify(entry.parts),
      );
    }
    // The truth of such a temporary depends on the way taken: a skipped part asks nothing of an `else if`'s guard, and
    // parts kept in other temporaries, as `(a and f()) or (b and f())` lowers, ask no stored value to be true either.
    const nested = (condition: string) => {
      const written =
        'function pick(ignore) {\n  return load("right", default: 0)\n}\nsave 0 as "left"\nsave 1 as "right"\n' +
        `save 0 as "third"\nshowButton "Check"\nif ${condition} {\n  say "First."\n} else if load("third", default: 0) > 0 {\n` +
        '  say "Second."\n}\nexit\n';
      const { plan: compiled } = engine.compileProject([{ path: "main.tease", source: written }], {
        builtins: [],
      });
      assert.ok(isRecord(compiled));
      return explore(engine, compiled, {
        seed: 1,
        budgetMs: Infinity,
        budgetOps: 2000,
        maxStates: 100_000,
        sources: new Map([["main.tease", written]]),
        diagnostics: [],
        realign: true,
      }).coverage.unvisitedBranches.flatMap((entry) => entry.parts.map((part) => part.needs));
    };
    for (const needs of [
      nested('load("left", default: 0) > 0 and pick(0) > 0'),
      nested(
        '(load("left", default: 0) > 0 and pick(0) > 0) or (load("third", default: 0) > 0 and pick(0) > 2)',
      ),
      nested('(load("left", default: 0) > 0 and pick(0) > 0) != true'),
    ]) {
      assert.ok(
        needs.every(
          (need) => !/(left|right|third) [!=]= (true|false)|stored right <= 0/u.test(need),
        ),
        JSON.stringify(needs),
      );
    }
    // A stored value the code tests as the last part, or loads with a default a call gives, is asked to be true: the
    // value itself, not every value the temporary held before.
    const tested = nested('pick(0) > 2 and load("flag", default: false)');
    assert.ok(tested.includes("stored flag == true"), JSON.stringify(tested));
    assert.ok(
      tested.every((need) => !need.startsWith("stored right ==")),
      JSON.stringify(tested),
    );
    // In a file after another file's function, the condition's own stores are found.
    const other = 'if load("left", default: 0) > 0 and pick(0) > 0 {\n  say "Both."\n}\nexit\n';
    const { plan: files } = engine.compileProject(
      [
        {
          path: "main.tease",
          source:
            'global function pick(ignore) {\n  return load("right", default: 0)\n}\nsave 1 as "right"\n' +
            'showButton "Go"\ngoto "other.tease"\n',
        },
        { path: "other.tease", source: other },
      ],
      { builtins: [] },
    );
    assert.ok(isRecord(files));
    const across = explore(engine, files, {
      seed: 1,
      budgetMs: Infinity,
      budgetOps: 2000,
      maxStates: 100_000,
      sources: new Map([["other.tease", other]]),
      diagnostics: [],
    }).coverage.unvisitedBranches.flatMap((entry) => entry.parts.map((part) => part.needs));
    assert.ok(
      across.every((need) => !/[!=]= true/u.test(need)),
      JSON.stringify(across),
    );
    // Copies nested deeper than are followed ask nothing either, and what they read stays a dependency; a call's result
    // is what the function returns, not every value its temporary held; a stored value with a fallback call is asked
    // for as well as the call's result; and a key the condition names stays that key, not its pattern.
    const deep = nested(`${"true and (".repeat(9)}pick(0) > 2${")".repeat(9)}`);
    assert.ok(
      deep.every((need) => !/[!=]= true/u.test(need)),
      JSON.stringify(deep),
    );
    const gated = (condition: string) => {
      const written =
        'function ready(ignore) {\n  return load("gate", default: false)\n}\nsave false as "gate"\n' +
        'function count(ignore) {\n  return load("n", default: 0)\n}\nsave randomInteger(0..3) as "n"\n' +
        'function tick(ignore) {\n  return 0\n}\nfunction packed(thing) {\n  return load("pack.${thing}", default: 0) > 0\n}\n' +
        'save 1 as "pack.knife"\n' +
        'save true as "flag"\nlet item = "knife"\nsave true as "gear.knife"\nshowButton "Check"\n' +
        `if ${condition} {\n  say "Through."\n}\nexit\n`;
      const { plan: compiled } = engine.compileProject([{ path: "main.tease", source: written }], {
        builtins: [],
      });
      assert.ok(isRecord(compiled));
      return explore(engine, compiled, {
        seed: 1,
        budgetMs: Infinity,
        budgetOps: 2000,
        maxStates: 100_000,
        sources: new Map([["main.tease", written]]),
        diagnostics: [],
      })
        .coverage.unvisitedBranches.filter(
          (entry) =>
            entry.line === written.split("\n").findIndex((line) => line.startsWith("if ")) + 1,
        )
        .sort((left, right) => left.instruction - right.instruction);
    };
    const needsOf = (entry: { parts: { needs: string }[] } | undefined) =>
      (entry?.parts ?? []).map((part) => part.needs);
    const outer = gated(`${"true and (".repeat(9)}count(0) > 2${")".repeat(9)}`).at(-1);
    assert.ok(outer?.dependsOn.includes("stored n"), JSON.stringify(outer));
    assert.ok(
      needsOf(outer).every((need) => !/[!=]= true/u.test(need)),
      JSON.stringify(outer),
    );
    // The call's own test asks for its result; the whole condition for the result and the stored value.
    const [guard, ...rest] = gated('ready(0) and load("flag", default: false)');
    assert.deepEqual(needsOf(guard), ["stored gate == true"]);
    assert.ok(
      rest.some((entry) => needsOf(entry).includes("stored flag == true")),
      JSON.stringify(rest.map(needsOf)),
    );
    // `flag` is saved true, so the way missed is the false one: the stored value itself is asked for.
    const fallback = gated('load("flag", default: ready(0))').map(needsOf);
    assert.ok(
      fallback.some((needs) => needs.includes("stored flag != true")),
      JSON.stringify(fallback),
    );
    // A fallback whose argument takes many instructions to compute is still read as the load's fallback.
    const far = gated(
      `load("flag", default: ready(${Array(100).fill("tick(0)").join(" + ")}))`,
    ).map(needsOf);
    assert.ok(
      far.some((needs) => needs.includes("stored flag != true")),
      JSON.stringify(far),
    );
    // Keys of one pattern that two parts name are each that key.
    for (const condition of [
      'load("pack.${item}", default: 0) > 2 or packed("gun")',
      'not (load("pack.${item}", default: 0) > 2 or packed("gun")) and ready(0)',
    ]) {
      const both = gated(condition).at(-1);
      assert.deepEqual(
        [...(both?.dependsOn ?? [])].filter((key) => key.startsWith("stored pack")).sort(),
        ["stored pack.gun", "stored pack.knife"],
        condition,
      );
    }
    const keyed = gated('ready(0) and load("gear.${item}", default: false)');
    assert.ok(
      keyed.every(
        (entry) =>
          !(entry.reason ?? "").includes("gear.*") &&
          entry.parts.every((part) => !part.needs.includes("gear.*")),
      ),
      JSON.stringify(keyed.map((entry) => entry.parts)),
    );
  },
);

test(
  "a stored value is measured against a condition's constant only where the condition compares the value itself, not a difference or count computed from it",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const source =
      'let planned: integer = load "trip.planned", default: 400\nlet walked: integer = load "trip.walked", default: 0\n' +
      'let left = 0\nlet stage = 0\nif load("trip.resume", default: false) {\n  stage = toInteger(load("trip.stage", default: 0))\n' +
      '} else {\n  stage = randomInteger(0..3)\n}\nshowButton "Walk"\nwalked += 1\nsave walked as "trip.walked"\n' +
      'left = planned - walked\nif left > 0 {\n  say "More to go."\n}\nif walked > 500 {\n  say "Tired."\n}\n' +
      'if toInteger(load("trip.walked", default: 0)) >= 300 {\n  say "Far."\n}\nswitch stage {\n  case 7 {\n    say "Seven."\n  }\n}\n' +
      "exit\n";
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const missed = explore(engine, plan, {
      seed: 1,
      budgetMs: Infinity,
      budgetOps: 2000,
      maxStates: 100_000,
      sources: new Map([["main.tease", source]]),
      diagnostics: [],
    }).coverage.unvisitedBranches;
    console.log(
      JSON.stringify(
        missed.map((entry) => [
          entry.condition?.text,
          entry.missed,
          entry.reach,
          entry.parts.map((part) => part.needs),
        ]),
      ),
    );
    const needsAt = (text: string) =>
      missed
        .filter((entry) => entry.condition?.text === text)
        .flatMap((entry) => entry.parts.map((part) => part.needs));
    // `left` is planned less walked: neither stored value compared with 0 says how to take the way.
    const left = needsAt("left > 0");
    assert.ok(
      left.includes("stored trip.walked") && left.includes("stored trip.planned"),
      JSON.stringify(left),
    );
    assert.ok(
      left.every((need) => !/trip\.\w+ [<>=!]/u.test(need)),
      JSON.stringify(left),
    );
    // `walked` counts up from the stored value: a count, not the stored value.
    const counted = needsAt("walked > 500");
    assert.ok(
      counted.every((need) => !/trip\.walked [<>=!]/u.test(need)),
      JSON.stringify(counted),
    );
    // The stored value itself, also through `toInteger` and through a variable assigned it or a random draw.
    assert.ok(
      needsAt('toInteger(load("trip.walked", default: 0)) >= 300').includes(
        "stored trip.walked >= 300",
      ),
    );
    assert.ok(needsAt("7").includes("stored trip.stage == 7"), JSON.stringify(needsAt("7")));
  },
);

test("a missed way's note tells what the condition itself needs: a stored value a session left before keys it was copied from, and its own value before its else-if chain's", () => {
  const goal = (
    key: string,
    candidates: Goal["candidates"] = [],
    comparison: Goal["comparison"] = null,
  ): Goal => ({ source: { kind: "storage", key }, candidates, comparison });
  // `level` was copied once from an older key no session stores; a session did store the level the way needs.
  const level = goal("tour.level", [], { operator: "==", constant: 2, shown: 2 });
  const older = goal("tour.oldLevel", [], { operator: "==", constant: 2, shown: 2 });
  assert.equal(
    noteOf({
      goals: [level, older],
      guards: [],
      chains: new Map([
        [
          "tour.level",
          { best: 0, closest: { distance: 0, value: "tour.level = 2", left: { sessions: 1 } } },
        ],
      ]),
      notes: new Map([[older, "needs tour.oldLevel == 2; no explored session stored it"]]),
    }),
    "needs tour.level == 2; a session from storage that has it did not reach the condition",
  );
  // A case of a `switch` on a stored value: its own value, not the other value its earlier case must not have.
  const own = goal("desk.mode", ["inspect"]);
  const earlier = goal("desk.mode", ["x"]);
  assert.equal(
    noteOf({
      goals: [own, earlier],
      guards: [{ goals: [earlier] }],
      chains: new Map(),
      notes: new Map([
        [own, 'needs desk.mode = "inspect"; no explored session stored it'],
        [earlier, 'needs desk.mode = "x"; no explored session stored it'],
      ]),
    }),
    'needs desk.mode = "inspect"; no explored session stored it',
  );
  // A note that no session stored a key, written before a session did, says what the closest stored value is.
  const plugged = goal("room.plugged", [], { operator: "!=", constant: 1, shown: true });
  assert.equal(
    noteOf({
      goals: [plugged],
      guards: [],
      chains: new Map([
        [
          "room.plugged",
          {
            best: 1,
            closest: { distance: 1, value: "room.plugged = true", left: { sessions: 2 } },
          },
        ],
      ]),
      notes: new Map([[plugged, "needs room.plugged != true; no explored session stored it"]]),
    }),
    "needs room.plugged != true; best reached: room.plugged = true after 2 sessions",
  );
  // The condition's own note goes before its chain's, even when only the chain's has progress.
  assert.equal(
    noteOf({
      goals: [own, earlier],
      guards: [{ goals: [earlier] }],
      chains: new Map(),
      notes: new Map([
        [own, 'needs desk.mode = "inspect"; no explored session stored it'],
        [earlier, 'needs desk.mode = "x"; best reached: desk.mode = "y" after 1 session'],
      ]),
    }),
    'needs desk.mode = "inspect"; no explored session stored it',
  );
});

test(
  "a missed way reports what it depends on, the code behind it, and each part it needs, met or not, with the closest state to the unmet one: a capped counter stays flat, a rising one is still improving",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const source =
      'let points = 0\nlet rounds = 0\nwhile true {\n  let pick = choose train: "Train", leave: "Leave"\n' +
      '  if pick == "leave" {\n    exit\n  }\n  rounds += 1\n  if points < 3 {\n    points += 1\n  }\n' +
      '  if points >= 5 {\n    say "Master."\n    say "You did it."\n  }\n  if points >= 2 and rounds >= 200 {\n' +
      '    say "Two hundred."\n  }\n}\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: Infinity,
      budgetOps: 400,
      maxStates: 100_000,
      sources: new Map(),
      diagnostics: [],
    });
    const branch = (line: number) =>
      result.coverage.unvisitedBranches.find((entry) => entry.line === line);
    // `points` stops at 3: the closest state is 3 away by 2, and no state came closer later on.
    const capped = branch(12);
    assert.deepEqual(capped && [capped.dependsOn, capped.behindLines], [["points"], 2]);
    assert.deepEqual(capped?.best && [capped.best.needs, capped.best.value, capped.best.distance], [
      "points >= 5",
      3,
      2,
    ]);
    assert.equal(capped?.best?.trend, "flat");
    assert.deepEqual(
      capped?.parts.map((part) => [part.needs, part.status]),
      [["points >= 5", "unmet"]],
    );
    // `rounds` rises with every round: still closer at the end of the run. The part on `points` was met: it is not
    // what keeps the way closed.
    const rising = branch(16);
    assert.deepEqual(rising && [rising.dependsOn, rising.behindLines], [["points", "rounds"], 1]);
    assert.deepEqual(
      rising?.parts.map((part) => [part.needs, part.status]),
      [
        ["points >= 2", "met"],
        ["rounds >= 200", "unmet"],
      ],
    );
    assert.equal(rising?.best?.needs, "rounds >= 200");
    assert.equal(rising?.best?.trend, "improving");
    assert.ok(Number(rising?.best?.value ?? 0) > 10);
  },
);

test(
  "a missed switch case names what the switch compares, and the hour of day when it reads exactly that; each line not reached counts once, under the missed way with the most code behind it, and the creator's report adds up",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const source =
      'function encore {\n  say "Bow."\n  say "Wave."\n  say "Leave the stage."\n}\nlet volume = 2\n' +
      'let pick = choose soft: "Soft", softer: "Softer"\nif pick == "softer" {\n  volume = 1\n}\n' +
      'if volume > 50 {\n  say "Too loud."\n  encore()\n}\nswitch volume {\n  case 7..=9 {\n    say "Loud."\n' +
      '    say "Very loud."\n    encore()\n  }\n  default {\n    say "Quiet."\n  }\n}\n' +
      'let hourNow = getDateTime().hour\nshowButton "Check"\nswitch hourNow {\n  case 25 {\n    say "Never."\n  }\n' +
      '  default {\n    say "Any time."\n  }\n}\nexit\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: Infinity,
      budgetOps: 2000,
      maxStates: 100_000,
      later: true,
      sources: new Map([["main.tease", source]]),
      diagnostics: [],
    });
    const branch = (line: number) =>
      result.coverage.unvisitedBranches.find((entry) => entry.line === line);
    const loud = branch(11);
    const ranged = branch(16);
    const hour = branch(28);
    assert.deepEqual(ranged && [ranged.case, ranged.subject, ranged.clockPart], [
      "range",
      "volume",
      undefined,
    ]);
    assert.deepEqual(hour && [hour.case, hour.subject, hour.clockPart], [
      "value",
      "hourNow",
      "hour",
    ]);
    // `encore` waits behind both missed ways; its four lines (its own and three) count under the case, which has more
    // behind it.
    assert.ok(loud !== undefined && ranged !== undefined);
    assert.equal(ranged.ownLines, ranged.behindLines);
    assert.equal(loud.ownLines, loud.behindLines - 4);
    assert.equal(
      result.coverage.unvisitedBranches.reduce((sum, entry) => sum + entry.ownLines, 0),
      result.coverage.reach.unknown,
    );
    const report = playtestReport(
      JSON.parse(JSON.stringify({ unit: "stage", compile: { ok: true }, ...result })),
    );
    assert.match(report, /`volume` in `7\.\.=9`, 7 lines behind it/u);
    assert.match(report, /the hour of day is 25 \(`hourNow` is `25`\)/u);
    const unreached = /- Lines not reached: (\d+)\n((?: {2}- .*: \d+\n)+)/u.exec(report);
    assert.ok(unreached !== null, report);
    assert.equal(
      [...unreached[2]!.matchAll(/: (\d+)\n/gu)].reduce((sum, [, lines]) => sum + Number(lines), 0),
      Number(unreached[1]),
    );
  },
);

test(
  "the creator's report words each kind of missed way as the script writes it: an if on a call, several values, a case that always matched, a clock range up to its end, arithmetic on the clock, a switch on a draw, and a loop never entered",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const source =
      'function level {\n  return 1\n}\nlet volume = 2\nlet pick = choose soft: "Soft", softer: "Softer"\n' +
      'if pick == "softer" {\n  volume = 1\n}\nif level() == 5 {\n  say "Five."\n}\nswitch volume {\n  case 7, 8 {\n' +
      '    say "Seven or eight."\n  }\n  default {\n    say "Other."\n  }\n}\nlet steady = 3\nswitch steady {\n' +
      '  case 3 {\n    say "Steady."\n  }\n  default {\n    say "Never steady."\n  }\n}\n' +
      'let hourNow = getDateTime().hour\nshowButton "Check"\nswitch hourNow {\n  case 25..30 {\n    say "Late."\n  }\n' +
      '  default {\n    say "Any."\n  }\n}\nswitch getDateTime().hour + 100 {\n  case 5 {\n    say "Shifted."\n  }\n' +
      '  default {\n    say "Unshifted."\n  }\n}\nswitch randomInteger(0..3) {\n  case 7 {\n    say "Lucky."\n  }\n' +
      '  default {\n    say "Unlucky."\n  }\n}\nwhile volume > 50 {\n  volume -= 1\n}\nexit\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: Infinity,
      budgetOps: 3000,
      maxStates: 100_000,
      later: true,
      sources: new Map([["main.tease", source]]),
      diagnostics: [],
    });
    const report = playtestReport(
      JSON.parse(JSON.stringify({ unit: "dial", compile: { ok: true }, ...result })),
    );
    for (const entry of [
      "`level() == 5` being true",
      "`volume` is one of `7, 8`",
      "`steady` is not `3`",
      "the hour of day is 25–29 (`hourNow` in `25..30`)",
      "`getDateTime().hour + 100` is `5`",
      "entering the loop on `volume > 50`",
    ])
      assert.ok(report.includes(entry), `${entry}\n${report}`);
    assert.ok(!report.includes("the hour of day is 5"), report);
    const random = /### Behind a random draw[^#]*/u.exec(report)?.[0] ?? "";
    assert.ok(random.includes("`randomInteger(0..3)` is `7`"), report);
  },
);

test(
  "the closest state to a missed way's part is read where the condition's function runs, as a value of the constant's type, and of alternatives the nearest unmet one keeps the way closed",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const source =
      'let rounds = 0\nlet far = 0\nlet flag = 1\nfunction low {\n  let points = 0\n  showButton "Low"\n' +
      '  if points >= 5 {\n    say "Low."\n  }\n}\nfunction high {\n  let points = 99\n  showButton "High"\n}\n' +
      'while true {\n  let pick = choose go: "Go", leave: "Leave"\n  if pick == "leave" {\n    exit\n  }\n' +
      '  rounds += 1\n  low()\n  high()\n  if far >= 10000 or rounds >= 200 {\n    say "Either."\n  }\n' +
      '  if flag == true {\n    say "Flag."\n  }\n  switch pick {\n    case "never" {\n      say "Never."\n    }\n  }\n}\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: Infinity,
      budgetOps: 600,
      maxStates: 100_000,
      sources: new Map([["main.tease", source]]),
      diagnostics: [],
    });
    const branch = (line: number) =>
      result.coverage.unvisitedBranches.find((entry) => entry.line === line);
    const shown = (line: number) =>
      branch(line)?.parts.map((part) => [part.needs, part.status, part.closest?.value]);
    // `high` holds its own `points` at 99: only `low`'s count, while `low` runs.
    assert.deepEqual(shown(7), [["points >= 5", "unmet", 0]]);
    assert.deepEqual(branch(7)?.best && [branch(7)!.best!.value, branch(7)!.best!.trend], [
      0,
      "flat",
    ]);
    // Either part opens the way: the rising one is what to watch, not the one far away.
    assert.deepEqual(
      shown(23)?.map(([needs, status]) => [needs, status]),
      [
        ["far >= 10000", "unmet"],
        ["rounds >= 200", "unmet"],
      ],
    );
    assert.deepEqual(branch(23)?.best && [branch(23)!.best!.needs, branch(23)!.best!.trend], [
      "rounds >= 200",
      "improving",
    ]);
    // A whole number compared with `true` is never `true`: no closest value is made up.
    assert.deepEqual(shown(26), [["flag == true", "unmeasured", undefined]]);
    assert.equal(branch(26)?.best, undefined);
    assert.deepEqual(branch(30) && [branch(30)!.case, branch(30)!.subject], ["value", "pick"]);
  },
);

test(
  "a comparison of two variables is measured as their difference: read where the condition's function runs, it reports the closest difference and its trend, and each closer one is progress until stalled",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    // `warmUp` holds its own `reps` above its `target`: only `lift`'s pair counts, while `lift` runs.
    const source =
      'function warmUp(target) {\n  let reps = 99\n  showButton "Warm up"\n}\nfunction lift(target) {\n' +
      '  let reps = 0\n  while true {\n    let pick = choose more: "More", stop: "Stop"\n' +
      '    if pick == "stop" {\n      return\n    }\n    reps += 1\n    if reps >= target {\n' +
      '      say "Set done."\n    }\n  }\n}\nwarmUp(1)\nlift(1000)\nexit\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const run = (untilStalled: boolean, budgetOps: number) =>
      explore(engine, plan, {
        seed: 1,
        budgetMs: Infinity,
        budgetOps,
        maxStates: Number.MAX_SAFE_INTEGER,
        sources: new Map(),
        diagnostics: [],
        untilStalled,
      });
    const set = run(false, 600).coverage.unvisitedBranches.find((entry) => entry.line === 13);
    assert.deepEqual(
      set?.parts.map((part) => [part.needs, part.status]),
      [["reps - target >= 0", "unmet"]],
    );
    const best = set?.best;
    assert.equal(best?.needs, "reps - target >= 0");
    assert.equal(best?.trend, "improving");
    assert.ok(typeof best?.value === "number" && best.value > -1000 && best.value < 0);
    assert.equal(best?.distance, -Number(best?.value));
    // Every round brings the pair closer: only the cap ends the run.
    const capped = run(true, 6000).search;
    assert.equal(capped.audit?.result, "capped");
    assert.ok((capped.audit?.progress.closer ?? 0) > 100);
  },
);

test(
  "a key a helper loads by a template, also through a helper it calls, is the one key its argument names at the condition, so other keys of the template are no closest storage",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const source =
      'global ROPE = "rope"\nglobal KNIFE = "knife"\nfunction owns(item) {\n' +
      '  return packed(item) or load("gear.${item}", default: false) == true\n}\n' +
      'function packed(thing) {\n  return load("pack.${thing}", default: false) == true\n}\n' +
      'let pick = choose rope: "Rope", knife: "Knife"\nif pick == "rope" {\n  save true as "gear.${ROPE}"\n' +
      '} else {\n  save false as "gear.${KNIFE}"\n}\nshowButton "Next"\nif owns(KNIFE) {\n' +
      '  say "Sharp."\n}\nexit\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: Infinity,
      budgetOps: 2000,
      maxStates: 100_000,
      sources: new Map(),
      diagnostics: [],
    });
    // Also through the helper `owns` calls with its own parameter.
    const sharp = result.coverage.unvisitedBranches.find((entry) => entry.line === 16);
    assert.deepEqual(sharp?.dependsOn, ["stored gear.knife", "stored pack.knife"]);
    assert.deepEqual(
      sharp?.parts.map((part) => [part.needs, part.status, part.closest?.value]),
      [
        ["stored gear.knife == true", "unmet", "gear.knife = false"],
        ["stored pack.knife == true", "unmeasured", undefined],
      ],
    );
  },
);

test(
  "until stalled, a run ends complete when nothing is left to try, as a spiral when one place took the work since the last progress, and capped while a counter still comes closer",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const run = (source: string, budgetOps?: number) => {
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan));
      return explore(engine, plan, {
        seed: 1,
        budgetMs: Infinity,
        ...(budgetOps === undefined ? {} : { budgetOps }),
        maxStates: Number.MAX_SAFE_INTEGER,
        sources: new Map(),
        diagnostics: [],
        untilStalled: true,
      }).search;
    };
    const complete = run(
      'let pick = choose a: "A", b: "B"\nif pick == "a" {\n  say "A."\n} else {\n  say "B."\n}\nexit\n',
    );
    assert.deepEqual([complete.stoppedBy, complete.audit?.result], ["exhausted", "complete"]);
    // Every press of "Again" is a new state, and nothing reads the count: no progress after the first round.
    const loop =
      'let count = 0\nwhile true {\n  let pick = choose again: "Again", leave: "Leave"\n  if pick == "leave" {\n' +
      "    exit\n  }\n  count += 1\n";
    const spiral = run(`${loop}}\n`);
    assert.equal(spiral.stoppedBy, "stalled");
    assert.equal(spiral.audit?.result, "spiral");
    assert.deepEqual(
      spiral.audit?.spiral && [spiral.audit.spiral.location, spiral.audit.spiral.share],
      ["main.tease:3", 100],
    );
    assert.ok(spiral.operations - spiral.audit!.lastProgressAt >= spiral.audit!.window);
    // A missed way needs the count at a million: every round is closer, so only the cap ends the run.
    const capped = run(`${loop}  if count >= 1000000 {\n    say "Done."\n  }\n}\n`, 25_000);
    assert.equal(capped.audit?.result, "capped");
    assert.ok((capped.audit?.progress.closer ?? 0) > 1000);
    // Once play takes a way, coming closer to its other comparison is no progress; the way still missed is flat.
    const reached = run(
      `${loop}  if count >= 1000000 or count >= 100 {\n    say "Hundred."\n  }\n  if count < 0 {\n    say "Never."\n  }\n}\n`,
      100_000,
    );
    assert.equal(reached.audit?.result, "spiral");
    // A way on the line of its condition stays unknown when nothing is left to try: not complete.
    const hidden = run(
      'let n = askInteger "Number?", prefill: 0\nif n * n == 1522756 { say "Hit." }\nexit\n',
    );
    assert.deepEqual([hidden.stoppedBy, hidden.audit?.result], ["exhausted", "stalled"]);
  },
);

test(
  "a long run of waits with nothing else to do takes one cell however far it goes, so its passes do not look new, and an endless one is still a trap",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const run = (source: string, followChains = false) => {
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan));
      return explore(engine, plan, {
        seed: 1,
        budgetMs: Infinity,
        budgetOps: 20_000,
        maxStates: 100_000,
        sources: new Map(),
        diagnostics: [],
        followChains,
      });
    };
    // Every hundred strokes the explorer records a state with nothing to do but wait; a stroke's place in the loop is
    // no place the player chose, so twice the strokes make no more cells.
    const strokes = (count: number) =>
      run(
        'let pick = choose punish: "Punish", leave: "Leave"\nif pick == "leave" {\n  exit\n}\n' +
          `for stroke in 1..=${count} {\n  wait 1 s\n}\nsay "Done."\nexit\n`,
      );
    const strokesFollowed = (count: number) =>
      run(
        'let pick = choose punish: "Punish", leave: "Leave"\nif pick == "leave" {\n  exit\n}\n' +
          `for stroke in 1..=${count} {\n  wait 1 s\n}\nsay "Done."\nexit\n`,
        true,
      );
    const short = strokes(500);
    const long = strokes(1000);
    assert.ok(long.search.states > short.search.states);
    assert.equal(long.search.cells?.cells, short.search.cells?.cells);
    assert.equal(long.coverage.percent, short.coverage.percent);
    // Waiting forever is still a loop the player cannot leave.
    const endless = run(
      'let pick = choose stay: "Stay", leave: "Leave"\nif pick == "leave" {\n  exit\n}\nwhile true {\n  wait 1 s\n}\n',
    );
    assert.deepEqual(
      endless.traps.map((trap) => trap.kind),
      ["loop"],
    );
    // Following such runs at once still ends in a run that never ends, within its share, and finds the same trap.
    const followed = run(
      'let pick = choose stay: "Stay", leave: "Leave"\nif pick == "leave" {\n  exit\n}\nwhile true {\n  wait 1 s\n}\n',
      true,
    );
    assert.equal(followed.search.stoppedBy, "operations");
    assert.deepEqual(
      followed.traps.map((trap) => trap.kind),
      ["loop"],
    );
    // And the run of strokes is followed to what comes after it, as without following.
    assert.equal(strokesFollowed(1000).coverage.percent, long.coverage.percent);
  },
);

test(
  "a chain toward a stored count repeats the route with the most progress per operation over whole sessions, whether its sessions are short or long, measures the others now and then, tries another when one stops helping, and reports its routes",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const run = (source: string, need = "visits >= 40") => {
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan));
      const result = explore(engine, plan, {
        seed: 1,
        budgetMs: Infinity,
        budgetOps: 3000,
        maxStates: 100_000,
        sources: new Map([["main.tease", source]]),
        diagnostics: [],
      });
      const way = [...result.directed.ways, ...result.coverage.unvisitedBranches].find(
        (entry) =>
          (typeof entry.condition === "string" ? entry.condition : entry.condition?.text) === need,
      );
      return { way, chain: way?.chains?.[0] };
    };
    // The short way adds one visit after one press; the long way adds `gain` after `presses` presses.
    const ways = (presses: number, gain: number, need: number) =>
      'let visits = load "fixture.visits", default: 0\n' +
      'let pick = choose long: "Long way", short: "Short way", leave: "Leave"\n' +
      `if pick == "long" {\n  for step in 1..=${presses} {\n    showButton "Step"\n  }\n` +
      `  save visits + ${gain} as "fixture.visits"\n}\n` +
      'if pick == "short" {\n  showButton "Go"\n  save visits + 1 as "fixture.visits"\n}\n' +
      `if visits >= ${need} {\n  say "Regular."\n}\nexit\n`;
    // Two visits for twenty presses: the short way does more per operation, though less per session.
    const twoWays = run(ways(20, 2, 40));
    assert.equal(twoWays.way?.reach, "play");
    assert.equal(twoWays.chain?.key, "fixture.visits");
    assert.ok((twoWays.chain?.sessions ?? 0) >= 30);
    // The route repeated is the short way, two inputs; the long way was replayed too, as another route.
    assert.deepEqual(
      twoWays.chain?.route && [
        twoWays.chain.route.at.startsWith("Short way"),
        twoWays.chain.route.inputs,
      ],
      [true, 2],
    );
    assert.ok(
      twoWays.chain?.routes.some((route) => route.at.startsWith("Long way") && route.sessions > 0),
    );
    assert.ok(
      twoWays.chain?.switches.some((change) => change.reason === "another route, measured again"),
    );
    assert.equal(twoWays.chain?.result, "reached");
    // Five visits for four presses: now the long way does more per operation, and it is the one repeated.
    const fiveWays = run(ways(4, 5, 100), "visits >= 100");
    assert.equal(fiveWays.way?.reach, "play");
    assert.ok(fiveWays.chain?.route?.at.startsWith("Long way"));
    const [long, short] = ["Long way", "Short way"].map((name) =>
      fiveWays.chain?.routes.find((route) => route.at.startsWith(name)),
    );
    assert.ok(short !== undefined && long !== undefined && short.sessions > 0);
    assert.ok(long.progressPer1000Operations > short.progressPer1000Operations);
    // The cheap way stops adding at fifteen; the other way, fifteen presses for two, still adds: once the cheap way brings
    // the count no closer, the other way is replayed, and the chain goes on with it.
    const cheapStops = run(
      'let visits = load "fixture.visits", default: 0\nif visits >= 40 {\n  say "Regular."\n  exit\n}\n' +
        'let pick = choose cheap: "Cheap", other: "Other", leave: "Leave"\n' +
        'if pick == "cheap" {\n  showButton "Go"\n  if visits < 15 {\n    save visits + 1 as "fixture.visits"\n  }\n}\n' +
        'if pick == "other" {\n  for step in 1..=15 {\n    showButton "Step"\n  }\n  save visits + 2 as "fixture.visits"\n}\nexit\n',
    );
    assert.equal(cheapStops.way?.reach, "play");
    assert.ok(cheapStops.chain?.route?.at.startsWith("Other"));
    assert.ok(
      cheapStops.chain?.routes.some((route) => route.at.startsWith("Cheap") && route.failures > 0),
    );
    // A session that counts without any input is a route of no inputs, measured like any other.
    const noInputs = run(
      'let visits = load "fixture.visits", default: 0\nsave visits + 1 as "fixture.visits"\n' +
        'if visits >= 40 {\n  say "Regular."\n}\nexit\n',
    );
    assert.equal(noInputs.way?.reach, "play");
    assert.deepEqual(
      noInputs.chain?.route && [noInputs.chain.route.inputs, noInputs.chain.route.sessions > 0],
      [0, true],
    );
  },
);

test(
  "the report gives what each session number added: its operations, the lines it reached first, the lines only a first session ran, and those it never ran",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    // A greeting only a new player gets; one from the second visit on; one from the third on.
    const source =
      'let visits = load "fixture.visits", default: 0\nif visits == 0 {\n  say "Welcome, new player."\n}\n' +
      'if visits >= 1 {\n  say "Welcome back."\n}\nif visits >= 2 {\n  say "Third time."\n}\n' +
      'save visits + 1 as "fixture.visits"\nexit\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: Infinity,
      budgetOps: 3000,
      maxStates: 100_000,
      sources: new Map([["main.tease", source]]),
      diagnostics: [],
    });
    const { bySession } = result.search;
    const sum = (values: readonly number[]) => values.reduce((all, value) => all + value, 0);
    // Every operation went to a session number, and every line play reached to the one that reached it first.
    assert.equal(sum(bySession.operations), result.search.operations);
    assert.equal(sum(bySession.linesFirst), result.coverage.visitedLines);
    // The second and third visits each reached their greeting first; only the new player's greeting is first-only.
    const firstSession = result.coverage.visitedLines - 2;
    assert.deepEqual(bySession.linesFirst.slice(0, 3), [firstSession, 1, 1]);
    assert.deepEqual(result.coverage.bySession.least.slice(0, 3), [firstSession, 1, 1]);
    assert.equal(result.coverage.bySession.onlyFirst, 1);
    assert.deepEqual(result.coverage.bySession.files, [
      { path: "main.tease", onlyFirst: 1, notFirst: 2 },
    ]);
  },
);

test(
  "with depth phases, a new player's first session goes first until it levels off, then the next session numbers get play work, so content behind steps that reach nothing new in later sessions is reached",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    // The first visit goes round a menu without end; the second and third visits each need six presses that run the
    // same code again before their content.
    const source =
      'let visits = load "fx.visits", default: 0\nif visits == 0 {\n  say "Welcome."\n  let rounds = 0\n' +
      '  let going = true\n  while going {\n    let pick = choose again: "Again", done: "Done"\n' +
      '    if pick == "done" {\n      going = false\n    }\n    rounds += 1\n  }\n}\n' +
      'if visits >= 1 {\n  for step in 1..=6 {\n    showButton "Next"\n  }\n  say "Return content."\n}\n' +
      'if visits >= 2 {\n  for step in 1..=6 {\n    showButton "On"\n  }\n  say "Third visit."\n}\n' +
      'save visits + 1 as "fx.visits"\nexit\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: Infinity,
      budgetOps: 4000,
      maxStates: 100_000,
      sources: new Map([["main.tease", source]]),
      diagnostics: [],
      cells: true,
      depthPhases: true,
    });
    const visited = (text: string) => {
      const line = source.split("\n").findIndex((written) => written.includes(text)) + 1;
      const file = result.coverage.files.find((entry) => entry.path === "main.tease");
      return !(file?.unvisited ?? []).some(({ lines }) => {
        const [from = 0, to = from] = lines.split("-").map(Number);
        return from <= line && line <= to;
      });
    };
    assert.ok(visited("Return content."));
    assert.ok(visited("Third visit."));
    const phases = result.search.phases;
    assert.ok(phases !== undefined);
    // Session 2 opened after session 1 had play work, and session 3 after session 2; each reached its own lines first.
    const [first, second = null, third = null] = phases.openedAt;
    assert.ok(first === 0 && second !== null && third !== null && second > 0 && third > second);
    assert.ok(phases.playGain[1]! > 0 && phases.playGain[2]! > 0);
    // A session number that reached nothing new opens no deeper one.
    assert.ok(phases.openedAt.length < 6);
  },
);

test(
  "with depth phases, a next session still comes after a first session that ends in its first step, and in a return window a later session reads",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const missed = (source: string) => {
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan));
      const result = explore(engine, plan, {
        seed: 1,
        budgetMs: Infinity,
        budgetOps: 100,
        maxStates: 100_000,
        sources: new Map([["main.tease", source]]),
        diagnostics: [],
        cells: true,
        later: true,
        depthPhases: true,
      });
      return result.coverage.files.flatMap((file) =>
        file.unvisited.filter((range) => range.reach === "unknown").map((range) => range.lines),
      );
    };
    // The first session saves and ends without an input: the second is still started from what it saved.
    assert.deepEqual(
      missed(
        'let events = load "events", default: []\nif events.contains("saved") {\n  say "Welcome back."\n}\n' +
          'save ["saved"] as "events"\nexit\n',
      ),
      [],
    );
    // The window the player must come back in is read by a later session: next sessions start in it too.
    assert.deepEqual(
      missed(
        'let last = load "last", default: 0\nlet away = getAbsoluteDateTime().toSeconds() - last\nshowButton "Go"\n' +
          'if last > 0 {\n  if away >= 7200 and away <= 18000 {\n    say "Welcome back."\n  }\n  exit\n}\n' +
          'save getAbsoluteDateTime().toSeconds() as "last"\nexit\n',
      ),
      [],
    );
  },
);

test(
  "forward time reads an exact span, a day as 24 hours, and leaves a calendar one unknown: calendar days and months last as long as the date makes them",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const holds = (span: string) => {
      const source =
        'let start = getAbsoluteDateTime()\nshowButton "Go"\n' +
        `if getAbsoluteDateTime() - start >= ${span} {\n  say "Later."\n}\nexit\n`;
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan));
      const instructions = Array.isArray(plan.instructions)
        ? plan.instructions.filter(isRecord)
        : [];
      const model = clockModel(plan, instructions);
      const [comparison] = [...model.comparisons.values()][0] ?? [];
      assert.ok(comparison !== undefined, span);
      const kept = timeContext({
        globals: [
          { name: "start", value: { kind: "absoluteDateTime", epochMilliseconds: EPOCH_MS } },
        ],
      });
      return [3600, 40 * 3600].map((seconds) =>
        holdsAt(comparison, model, kept, EPOCH_MS + seconds * 1000),
      );
    };
    assert.deepEqual(holds("36 h"), [false, true]);
    // A day is 24 hours.
    assert.deepEqual(holds("1 day"), [false, true]);
    // Calendar spans, as the time model writes them and as plans before it did (`1 day` then had `days: 1` and no
    // milliseconds): read as no time at all, they would hold at once; they are not read.
    assert.equal(
      exactMilliseconds({ kind: "calendarDuration", months: 0, days: 2, milliseconds: 0 }),
      null,
    );
    assert.equal(exactMilliseconds({ kind: "duration", milliseconds: 0, days: 2 }), null);
    assert.equal(exactMilliseconds({ kind: "duration", milliseconds: 0, months: 1 }), null);
    assert.equal(exactMilliseconds({ kind: "duration", milliseconds: 129_600_000 }), 129_600_000);
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
        'let start = getAbsoluteDateTime()\nshowButton "Go"\nlet took = (getAbsoluteDateTime() - start) / 1 s\n' +
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
        'let start = getAbsoluteDateTime().toSeconds()\nshowButton "Go"\nlet took = getAbsoluteDateTime().toSeconds() - start\n' +
          'if took == 300 {\n  say "Hit."\n}\nexit\n',
        true,
      ],
      ["session start", 'if getDateTime().hour >= 22 {\n  say "Hit."\n}\nexit\n', true],
      [
        "updated straight on",
        'let start = getAbsoluteDateTime().toMilliseconds()\nshowButton "Go"\n' +
          'let took = getAbsoluteDateTime().toMilliseconds() - start\ntook = took / 1000\nif took > 600 {\n  say "Hit."\n}\nexit\n',
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
          'if sexscriptLegacyCompare(getAbsoluteDateTime().toSeconds(), 1790943000) == 0 {\n  say "Hit."\n}\nexit\n',
        true,
      ],
      [
        "time taken against a bound from the clock",
        "function limit {\n  return getAbsoluteDateTime().toSeconds() - 1790946000\n}\nlet start = getAbsoluteDateTime().toSeconds()\n" +
          'showButton "Check"\nlet took = getAbsoluteDateTime().toSeconds() - start\ntook = took * 2\nlet bound = limit()\n' +
          'if took <= bound and took >= 0 {\n  say "Hit."\n}\nexit\n',
        true,
      ],
      [
        "time kept through a function",
        'function stamp {\n  return getAbsoluteDateTime()\n}\nlet start = stamp()\nshowButton "Go"\n' +
          'if (getAbsoluteDateTime() - start) / 1 s >= 300 {\n  say "Hit."\n}\nexit\n',
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
        'let last = load "last", default: 0\nlet away = getAbsoluteDateTime().toSeconds() - last\nshowButton "Go"\n' +
        `if last > 0 {\n  if away < 7200 {\n    say "Too soon."\n${outside}` +
        `  } else if away > 18000 {\n    say "Too late."\n${outside}  } else {\n    say "Welcome back."\n  }\n}\n` +
        `save getAbsoluteDateTime().toSeconds() as "last"\n${bye}exit\n`;
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
        "function limit {\n  return getAbsoluteDateTime().toSeconds() - 1790946000\n}\nlet start = getAbsoluteDateTime().toSeconds()\n" +
        'showButton "Check"\nlet bound = limit()\nif (getAbsoluteDateTime().toSeconds() - start) <= bound and ' +
        '(getAbsoluteDateTime().toSeconds() - start) >= 0 {\n  say "Hit."\n}\nexit\n';
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
          'if getAbsoluteDateTime().toSeconds() - last > 3600 {\n  say "Hit."\n}\nexit\n';
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
  "a key template stays a pattern where a helper rebinds the parameter that names its key, or where its result also reads the template another way",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const source =
      'global KNIFE = "knife"\nlet kind = choose rope: "Rope", saw: "Saw"\n' +
      'let spare = load("gear.${kind}", default: false)\n' +
      'function owns(item) {\n  return load("gear.${item}", default: false) == true\n}\n' +
      'function plural(item) {\n  item = "${item}s"\n  return load("gear.${item}", default: false) == true\n}\n' +
      "function either(item) {\n  return owns(item) or spare == true\n}\n" +
      'showButton "Go"\nif owns(KNIFE) {\n  say "One."\n}\nif plural(KNIFE) {\n  say "Two."\n}\n' +
      'if either(KNIFE) {\n  say "Three."\n}\nexit\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const instructions = Array.isArray(plan.instructions) ? plan.instructions.filter(isRecord) : [];
    const flow = new DataFlow(plan, instructions);
    const keys = instructions.flatMap((instruction, index) =>
      instruction.kind === "jumpIfFalse" && flow.functionAt(index) === 0
        ? [flow.keyAt("gear.\u0000", instruction.condition, index).replaceAll("\u0000", "*")]
        : [],
    );
    // `owns` names its key; `plural` rebinds `item` first; `either` also reads `spare`, which any key of it may be.
    assert.deepEqual(keys, ["gear.knife", "gear.*", "gear.*"]);
  },
);

test(
  "with progress leads, a loop that runs until one variable reaches another is followed to its end beside a wide tree of choices",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    // As above, but the climb ends where `height` reaches `summit`, a variable: no constant to come closer to.
    const branches = Array.from(
      { length: 6 },
      (_, index) =>
        `  let path${index} = choose left: "L${index}", right: "R${index}", back: "B${index}"\n` +
        `  if path${index} == "left" {\n    say "left${index}"\n  }\n  showButton "On${index}"\n`,
    ).join("");
    const source =
      `let way = choose trail: "Trail", climb: "Climb"\nif way == "trail" {\n${branches}  exit\n}\n` +
      'let height = 0\nlet summit = 60 + 40\nwhile height < summit {\n  showButton "Step"\n  height += 1\n}\n' +
      'say "Summit."\nexit\n';
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
    const summit = source.split("\n").findIndex((line) => line.includes('say "Summit."')) + 1;
    const file = result.coverage.files.find((entry) => entry.path === "main.tease")!;
    assert.ok(
      !file.unvisited.some((range) => {
        const [from = 0, to = from] = range.lines.split("-").map(Number);
        return summit >= from && summit <= to;
      }),
    );
  },
);

test(
  "a typed number is not answered with a million unless large answers are on: a script that counts to the answer without a range check would play on for ever",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const source =
      'let laps = askInteger "How many laps, 1 to 5?", prefill: 2\nlet lap = 0\nwhile lap < laps * 100 {\n' +
      '  showButton "Run"\n  lap += 1\n}\nsay "Finish line."\nexit\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const answers = (large: boolean) => {
      const session = new Session(engine, plan, 1);
      session.largeAnswers = large;
      return session
        .options(session.start().runtime)
        .map((input) => (input.kind === "text" ? input.text : input.kind));
    };
    assert.ok(!answers(false).includes("1000000"), answers(false).join(","));
    assert.ok(answers(true).includes("1000000"), answers(true).join(","));
  },
);

test(
  "code without comparisons added near an ask leaves its typed answers as they were: the constants compared nearby, and the expressions compared with the answer, in the same order",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const compile = (source: string) => {
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan));
      return plan;
    };
    // A list and a loop of says, as a conversion may write a random line.
    const filler =
      'for verse in [["Hum."], ["Sing.", "Clap."]].random {\n  say verse\n}\nlet colours = ["red", "green", "blue"]\n' +
      'say colours.random\nsay "Ready?"\nsay "Steady."\n';
    // The ask is far from any comparison; its caller compares on both sides of where the helper returns.
    const pause = (from: number) =>
      Array.from({ length: 45 }, (_, index) => `  say "Pause ${from + index}."`).join("\n");
    const nearby = (extra: string) => {
      const session = new Session(
        engine,
        compile(
          `function pickMood {\n${pause(1)}\n  let picked = askInteger prefill: 0\n${pause(100)}\n  return picked\n}\n` +
            `let level = 1\nif level > 7 {\n  say "Too high."\n}\n${extra}let mood = pickMood()\nif mood == 3 {\n` +
            '  say "Three."\n} else if mood == 6 {\n  say "Six."\n} else if mood == 9 {\n  say "Nine."\n}\nexit\n',
        ),
        1,
      );
      return session.options(session.start().runtime);
    };
    assert.deepEqual(nearby(filler), nearby(""));
    assert.deepEqual(
      nearby("").map((input) => (input.kind === "text" ? input.text : input.kind)),
      ["0", "1", "-1", "6", "7", "8", "2", "3", "4", "5"],
    );
    // The answer is compared before the ask (in `judge`) and after it (in `review`); the filler goes after the ask only.
    const compared = (extra: string) => {
      const plan = compile(
        "let last = 0\nlet low = 10\nlet high = 20\nlet first = 30\nlet second = 40\nlet third = 50\n" +
          'function judge {\n  if last < low {\n    say "Low."\n  }\n  if last > high {\n    say "High."\n  }\n}\n' +
          `function pickMood {\n  let picked = askInteger prefill: 0\n  last = picked\n${extra}  return picked\n}\n` +
          'function review {\n  if last == first {\n    say "First."\n  }\n  if last == second {\n    say "Second."\n  }\n' +
          '  if last == third {\n    say "Third."\n  }\n}\npickMood()\nreview()\njudge()\nexit\n',
      );
      const instructions = Array.isArray(plan.instructions)
        ? plan.instructions.filter(isRecord)
        : [];
      return [...comparedWith(new DataFlow(plan, instructions), instructions, "asks").values()].map(
        (expressions) =>
          expressions.map((expression) => (isRecord(expression) ? expression.name : null)),
      );
    };
    assert.deepEqual(compared(filler), compared(""));
    assert.deepEqual(compared(""), [["high", "first", "low", "second"]]);
    // A comparison just before the ask and one just after are equally near: the code compares the answer with `before`
    // to leave the loop, and with `after` inside it.
    const looped = compile(
      "let before = 10\nlet after = 20\nlet answer = 0\nwhile answer != before {\n" +
        '  answer = askInteger prefill: 0\n  if answer == after {\n    say "After."\n  }\n}\nsay "Out."\nexit\n',
    );
    const loopedInstructions = Array.isArray(looped.instructions)
      ? looped.instructions.filter(isRecord)
      : [];
    assert.deepEqual(
      [
        ...comparedWith(
          new DataFlow(looped, loopedInstructions),
          loopedInstructions,
          "asks",
        ).values(),
      ].map((expressions) =>
        expressions.map((expression) => (isRecord(expression) ? expression.name : null)),
      ),
      [["before", "after"]],
    );
    // A helper's ask looks for constants in its own function, not in the function laid out next to it.
    const helper = new Session(
      engine,
      compile(
        "function pickMood {\n  let picked = askInteger prefill: 0\n  return picked\n}\nfunction other(x) {\n" +
          '  if x == 50 {\n    say "Fifty."\n  }\n  if x == 60 {\n    say "Sixty."\n  }\n  if x == 70 {\n' +
          '    say "Seventy."\n  }\n}\nlet mood = pickMood()\nif mood == 3 {\n  say "Three."\n} else if mood == 6 {\n' +
          '  say "Six."\n} else if mood == 9 {\n  say "Nine."\n}\nother(1)\nexit\n',
      ),
      1,
    );
    const answers = helper
      .options(helper.start().runtime)
      .map((input) => (input.kind === "text" ? input.text : input.kind));
    assert.ok(
      ["3", "6", "9"].every((answer) => answers.includes(answer)),
      answers.join(","),
    );
    assert.ok(!answers.includes("50"), answers.join(","));
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

test(
  "with random choices, other outcomes of a draw are steps of play with chosen random outcomes, which repros, the corpus, and replays keep",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const source =
      'showButton "Go"\nif chance(25) {\n  say "Lucky."\n}\nlet roll = randomInteger(1..=3)\nif roll == 1 {\n' +
      '  say "One."\n} else if roll == 2 {\n  say "Two."\n} else {\n  say "Three."\n}\nexit\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const lineOf = (text: string) =>
      source.split("\n").findIndex((line) => line.includes(text)) + 1;
    const said = ["Lucky.", "One.", "Two.", "Three."].map(lineOf);
    const run = (randomChoices: boolean, corpus: readonly CorpusEntry[] = []) =>
      explore(engine, plan, {
        seed: 1,
        budgetMs: 60_000,
        maxStates: 5000,
        sources: new Map([["main.tease", source]]),
        diagnostics: [],
        corpus,
        randomChoices,
      });
    const unvisited = (result: ReturnType<typeof run>) =>
      said.filter((line) =>
        result.coverage.files[0]!.unvisited.some((range) => {
          const [from, to = from] = range.lines.split("-").map(Number);
          return line >= from! && line <= to!;
        }),
      );
    // Natural play takes one outcome of each draw: at least two of the texts are missed.
    const plain = run(false);
    assert.ok(unvisited(plain).length >= 2);
    assert.equal(plain.coverage.reach.chosen, undefined);
    const chosen = run(true);
    assert.equal(chosen.search.stoppedBy, "exhausted");
    assert.deepEqual(unvisited(chosen), []);
    assert.ok(chosen.coverage.reach.chosen! >= 2);
    assert.equal(chosen.coverage.unvisitedBranches.length, 0);
    // The corpus keeps the paths with chosen outcomes: only the outcomes chosen, each another than natural play's, and
    // a replay takes the same way each time.
    const entries = chosen.corpus?.entries ?? [];
    const natural = replay(engine, plan, 1, [{ kind: "button", label: "Go" }]).steps.at(-1)!.texts;
    const forced = entries.filter((entry) =>
      entry.inputs.some((input) => input.random !== undefined),
    );
    assert.ok(forced.length >= 2);
    const probe = new Session(engine, plan, 1);
    probe.randomChoices = true;
    const started = probe.start();
    const draws = probe.apply(started.runtime, { kind: "button", label: "Go" }, false)!.draws;
    const naturalOf = new Map(draws.map((draw) => [draw.drawId, JSON.stringify(draw.natural)]));
    assert.equal(naturalOf.size, 2);
    for (const entry of forced) {
      for (const choice of entry.inputs.flatMap((input) => input.random ?? []))
        assert.notEqual(JSON.stringify(choice.outcome), naturalOf.get(choice.drawId));
      const replayed = replay(engine, plan, 1, entry.inputs);
      const texts = replayed.steps.at(-1)!.texts;
      assert.equal(replayed.error, null);
      assert.notDeepEqual(texts, natural);
      assert.deepEqual(replay(engine, plan, 1, entry.inputs).steps.at(-1)!.texts, texts);
    }
    // A run without random choices replays them, as play with chosen outcomes.
    const resumed = run(false, entries);
    assert.deepEqual(unvisited(resumed), []);
    assert.ok(resumed.coverage.reach.chosen! >= 2);
  },
);

test(
  "play with chosen random outcomes stays apart across sessions and from play's states, follows directed steps too, and replays only as recorded",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const compile = (source: string) => {
      const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
      assert.ok(isRecord(plan));
      return plan;
    };
    const run = (source: string, randomChoices: boolean, corpus: readonly CorpusEntry[] = []) =>
      explore(engine, compile(source), {
        seed: 1,
        budgetMs: 60_000,
        budgetOps: 5000,
        maxStates: 2000,
        sources: new Map([["main.tease", source]]),
        diagnostics: [],
        corpus,
        randomChoices,
      });
    const covers = (result: ReturnType<typeof run>, line: number) =>
      !result.coverage.files[0]!.unvisited.some((range) => {
        const [from, to = from] = range.lines.split("-").map(Number);
        return line >= from! && line <= to!;
      });
    const forcedOf = (result: ReturnType<typeof run>) =>
      result.corpus!.entries.find((entry) => entry.inputs.some((input) => input.random))!;
    // A corpus path whose earlier session chose the outcome its storage keeps: the next session's crash is chosen play's.
    const lucky =
      'if (load "won", default: false) == true {\n  let zero = load "zero", default: 0\n  let boom = 1 / zero\n  exit\n}\n' +
      'showButton "Go"\nif chance(25) == false {\n  save true as "won"\n}\nexit\n';
    const luck = run(lucky, true);
    const won = forcedOf(luck);
    const later = run(lucky, false, [{ seed: 1, reason: "coverage", earlier: [won], inputs: [] }]);
    assert.equal(later.crashes.length, 1);
    assert.equal(later.crashes[0]!.chosen, true);
    assert.equal(later.crashes[0]!.earlier?.[0]?.inputs[0]?.random?.length, 1);
    // A state chosen play reached first that play reaches too is play's own state, and so is the crash after it.
    const shared =
      'showButton "Go"\nif chance(25) {\n  say "Lucky."\n}\nshowButton "Next"\nlet zero = load "zero", default: 0\n' +
      "let boom = 1 / zero\nexit\n";
    const chosen = run(shared, true);
    const forced = forcedOf(chosen);
    const merged = run(shared, false, [{ ...forced, inputs: forced.inputs.slice(0, 1) }]);
    assert.equal(merged.crashes[0]!.chosen, undefined);
    assert.deepEqual(
      merged.crashes[0]!.inputs.map((input) => input.random),
      [undefined, undefined],
    );
    // The corpus counts chosen play's coverage too, and keeps it: replayed without random choices, it covers as much.
    assert.ok(luck.coverage.reach.chosen! > 0);
    assert.equal(luck.corpus!.coverageAtEnd.percent, luck.coverage.percent);
    assert.equal(
      run(lucky, false, luck.corpus!.entries).corpus!.coverageAtStart.percent,
      luck.coverage.percent,
    );
    // A path with an outcome recorded for a draw it does not make is a stale entry, which leaves no coverage.
    const [taken] = forced.inputs[0]!.random!;
    const unmatched = [
      { ...forced.inputs[0]!, random: [taken!, { ...taken!, drawId: taken!.drawId + 1 }] },
    ];
    const stale = run(shared, false, [{ seed: 1, reason: "coverage", inputs: unmatched }]);
    assert.equal(stale.corpus!.stale, 1);
    assert.equal(stale.coverage.reach.chosen, 0);
    // A step directed search takes offers its draws' other outcomes too: the compared number is too far from the ask
    // for its answers, so that only a directed attempt gives it.
    const padding = Array.from({ length: 60 }, (_, index) => `say "Padding ${index}."\n`).join("");
    const directed =
      `let n = askInteger prefill: 0\n${padding}if n == 1234 {\n  if chance(25) {\n    say "Lucky."\n  } else {\n` +
      '    say "Unlucky."\n  }\n}\nexit\n';
    const steered = run(directed, true);
    assert.ok(steered.directed.attempts > 0);
    assert.ok(steered.directed.ways.some((way) => way.reach === "chosen"));
    assert.ok(covers(steered, 64) && covers(steered, 66));
  },
);

test(
  "with forward time, time logic a creator writes by hand is read with no converter helper: a return window through a helper function of their own is reached in each of its parts, as play",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const source =
      'let last = load "visit", default: 0\nfunction hoursSince(stamp) {\n  return (getAbsoluteDateTime().toSeconds() - stamp) / 3600\n}\n' +
      'showButton "Hello"\nif last == 0 {\n  say "First visit."\n} else if hoursSince(last) < 2 {\n  say "Back so soon?"\n' +
      '} else if hoursSince(last) > 48 {\n  say "Where have you been?"\n} else {\n  say "Welcome back."\n}\n' +
      'save getAbsoluteDateTime().toSeconds() as "visit"\nexit\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: 60_000,
      maxStates: 2000,
      sources: new Map([["main.tease", source]]),
      diagnostics: [],
      later: true,
    });
    const lineOf = (text: string) =>
      source.split("\n").findIndex((line) => line.includes(text)) + 1;
    for (const text of ["First visit.", "Back so soon?", "Where have you been?", "Welcome back."]) {
      const line = lineOf(text);
      assert.ok(
        !result.coverage.files[0]!.unvisited.some((range) => {
          const [from = 0, to = from] = range.lines.split("-").map(Number);
          return line >= from && line <= to;
        }),
        text,
      );
    }
    assert.equal(result.coverage.reach.clock, 0);
    // The model reads both comparisons through the helper: back from a visit just now, "so soon" ends two hours later.
    const instructions = Array.isArray(plan.instructions) ? plan.instructions.filter(isRecord) : [];
    const model = clockModel(plan, instructions);
    assert.equal(model.comparisons.size, 2);
    const [soon] = [...model.comparisons.values()][0]!;
    const visited = timeContext({ scriptStorage: [{ key: "visit", value: EPOCH_MS / 1000 }] });
    assert.equal(holdsAt(soon!, model, visited, EPOCH_MS), true);
    const gap = flipGap(soon!, model, visited, EPOCH_MS)!;
    assert.ok(gap >= 2 * 3_600_000 && gap <= 2 * 3_600_000 + 120_000, String(gap));
    // A creator's own comparison helper of two values: the moment they are equal, which sampling by minutes would miss,
    // is where the two values meet.
    const deadline = EPOCH_MS / 1000 + 4321;
    const ordered = engine.compileProject(
      [
        {
          path: "main.tease",
          source:
            "function orderOf(a, b) {\n  if a < b {\n    return -1\n  }\n  if a > b {\n    return 1\n  }\n  return 0\n}\n" +
            `showButton "Wait"\nif orderOf(getAbsoluteDateTime().toSeconds(), ${deadline}) == 0 {\n  say "Now."\n}\nexit\n`,
        },
      ],
      { builtins: [] },
    ).plan;
    assert.ok(isRecord(ordered));
    const orderedModel = clockModel(
      ordered,
      Array.isArray(ordered.instructions) ? ordered.instructions.filter(isRecord) : [],
    );
    const [equal] = [...orderedModel.comparisons.values()][0]!;
    assert.equal(flipGap(equal!, orderedModel, timeContext({}), EPOCH_MS), 4_321_000);
  },
);

test(
  "with quit-anywhere next visits, a player who quits after a save comes back with it: a return only such a visit reaches is play, and its path replays",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    // The only way to complete removes the save again, and the stored value is read through a function of the script.
    const source =
      'function loadNumber(key) {\n  let value = load key, default: 0\n  return value\n}\nlet version = loadNumber("version")\n' +
      'if version > 0 {\n  say "Welcome back."\n  exit\n}\nshowButton "Start"\nsave 1 as "version"\n' +
      'let pick = choose stay: "Stay", leave: "Leave"\nif pick == "leave" {\n  delete "version"\n  exit\n}\n' +
      'while true {\n  showButton "Again"\n}\n';
    const { plan } = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    assert.ok(isRecord(plan));
    const run = (quitAnywhere: boolean) =>
      explore(engine, plan, {
        seed: 1,
        budgetMs: 60_000,
        budgetOps: 3000,
        maxStates: 2000,
        sources: new Map([["main.tease", source]]),
        diagnostics: [],
        later: true,
        quitAnywhere,
      });
    const welcome = source.split("\n").findIndex((line) => line.includes("Welcome back.")) + 1;
    const reached = (result: ReturnType<typeof run>) =>
      !result.coverage.files[0]!.unvisited.some((range) => {
        const [from = 0, to = from] = range.lines.split("-").map(Number);
        return welcome >= from && welcome <= to;
      });
    assert.equal(reached(run(false)), false);
    const quit = run(true);
    assert.ok(reached(quit));
    assert.equal(quit.coverage.reach.clock, 0);
    assert.ok(quit.search.quitVisits! >= 1);
    // The way back has its path: the earlier session up to where the player quit, which replays to the same text.
    const way = quit.directed.ways.find(
      (entry) => entry.line === welcome - 1 && entry.way === "true",
    )!;
    assert.equal(way.reach, "play");
    assert.equal(way.repro.earlier?.length, 1);
    const replayed = replay(engine, plan, 1, way.repro.inputs, {
      ...(way.repro.earlier === undefined ? {} : { earlier: way.repro.earlier }),
      ...(way.repro.wallClockMs === undefined ? {} : { wallClockMs: way.repro.wallClockMs }),
    });
    assert.deepEqual(replayed.earlier, ["waiting"]);
    assert.ok(replayed.steps.some((step) => step.texts.includes("Welcome back.")));
  },
);
