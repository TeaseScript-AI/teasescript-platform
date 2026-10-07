import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { isRecord } from "../src/ast.ts";
import type { PlanDiagnostic } from "../src/explorer-analysis.ts";
import { explore } from "../src/explorer-search.ts";
import { loadEngine, replay, type Engine } from "../src/explorer.ts";

const engineResult = await loadEngine().then(
  (engine): { engine: Engine } | { reason: string } => ({ engine }),
  (error: unknown) => ({ reason: error instanceof Error ? error.message : String(error) }),
);

/** The fixture package compiled, with the diagnostics the explorer reads constant conditions from. */
async function fixture(engine: Engine) {
  const source = await readFile(new URL("fixtures/explorer/main.tease", import.meta.url), "utf8");
  const compiled = engine.call("compileProject", [{ path: "main.tease", source }], {
    builtins: [],
  });
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
  },
);

test(
  "a runtime operation that throws is no crash, and its input list replays the throw",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  async () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    // Stands in for a runtime that rejects its own snapshot (TSR101) when the player picks "Stay".
    const failing: Engine = {
      ...engine,
      call: (name, ...args) => {
        const request = args[2];
        if (
          name === "completeAction" &&
          isRecord(request) &&
          isRecord(request.payload) &&
          request.payload.optionIndex === 2
        )
          throw new Error("TSR101 Malformed runtime snapshot.");
        return engine.call(name, ...args);
      },
    };
    const { plan, diagnostics } = await fixture(engine);
    const result = explore(failing, plan, {
      seed: 1,
      budgetMs: 60_000,
      maxStates: 5000,
      sources: new Map(),
      diagnostics,
    });

    assert.ok(result.search.engineErrors.count >= 1);
    assert.equal(result.crashes.length, 1);
    const first = result.search.engineErrors.first!;
    assert.deepEqual(first.inputs, [{ kind: "option", index: 2, label: "Stay" }]);
    assert.equal(replay(failing, plan, 1, first.inputs).error, first.message);
  },
);
