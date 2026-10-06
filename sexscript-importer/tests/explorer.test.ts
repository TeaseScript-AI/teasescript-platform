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
  const diagnostics: PlanDiagnostic[] = (Array.isArray(compiled.diagnostics) ? compiled.diagnostics : [])
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
  return { source, plan, diagnostics };
}

test(
  "the explorer finds both ends, the crash, the inescapable loop, and labels what directed search reaches",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  async () => {
    assert.ok("engine" in engineResult);
    const { engine } = engineResult;
    const { source, plan, diagnostics } = await fixture(engine);
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: 60_000,
      maxStates: 2000,
      sources: new Map([["main.tease", source]]),
      diagnostics,
    });

    // Every state the inputs reach is explored: "Left" exits, "Right" fails, "Stay" loops, "Count" counts and exits.
    assert.equal(result.search.stoppedBy, "exhausted");
    assert.ok(result.endStates.completed >= 1);
    assert.ok(result.endStates.failed >= 1);

    // One crash per code and span, with the path that reaches it; replaying the path fails the same way.
    assert.equal(result.crashes.length, 1);
    const crash = result.crashes[0]!;
    assert.deepEqual([crash.code, crash.path, crash.line, crash.seeded], ["TSR025", "main.tease", 12, false]);
    assert.deepEqual(crash.inputs, [{ kind: "option", index: 1, label: "Right" }]);
    const replayed = replay(engine, plan, 1, crash.inputs);
    assert.deepEqual(
      replayed.failure && [replayed.failure.code, replayed.failure.line, replayed.failure.column],
      [crash.code, crash.line, crash.column],
    );

    // The button loop after "Stay" repeats one state (its action IDs and event numbers differ), which has no way out.
    assert.equal(result.traps.length, 1);
    const trap = result.traps[0]!;
    assert.equal(trap.kind, "loop");
    assert.deepEqual(trap.locations, ["main.tease:86"]);
    assert.deepEqual(trap.sampleTexts, ["You are stuck."]);
    assert.deepEqual(trap.inputs, [{ kind: "option", index: 2, label: "Stay" }]);

    // Directed search answers the ask with the compared number, far from the ask: reached by play.
    const ways = result.directed.ways;
    const secret = ways.find((way) => way.line === 76);
    assert.deepEqual(
      secret && [secret.way, secret.reach, secret.via, secret.sources],
      ["true", "play", "directed", ["ask"]],
    );
    assert.ok(secret?.repro.inputs.some((input) => input.kind === "text" && input.text === "1234"));
    // A value only an earlier session could have stored: reached with seeded storage, and its repro replays there.
    const back = ways.find((way) => way.line === 79);
    assert.deepEqual(
      back && [back.way, back.reach, back.via, back.sources],
      ["true", "seeded", "directed", ["storage"]],
    );
    assert.ok(back?.repro.inputs.some((input) => input.kind === "storage" && input.key === "fixture.visited"));
    const seededReplay = replay(engine, plan, 1, back?.repro.inputs ?? [], back?.repro.setup);
    assert.equal(seededReplay.steps.at(-1)?.status, "halted");
    assert.ok(seededReplay.steps.some((step) => step.texts.includes("Welcome back.")));

    // Line labels: play for the answered branch, seeded for the stored one, unreachable for a constant condition.
    const file = result.coverage.files.find((entry) => entry.path === "main.tease")!;
    const labelOf = (line: number) =>
      file.unvisited.find((range) => {
        const [from = 0, to = from] = range.lines.split("-").map(Number);
        return line >= from && line <= to;
      })?.reach ?? "play";
    assert.deepEqual([labelOf(77), labelOf(80), labelOf(8), labelOf(4)], ["play", "seeded", "unreachable", "play"]);
    assert.equal(result.coverage.staticContradictions, 0);
    const never = result.coverage.unvisitedBranches.find((entry) => entry.line === 7);
    assert.deepEqual(never && [never.missed, never.reach], ["true", "unreachable"]);
    const stored = result.coverage.unvisitedBranches.find((entry) => entry.line === 79);
    assert.deepEqual(stored && [stored.reach, stored.sources], ["seeded", ["storage"]]);
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
      maxStates: 2000,
      sources: new Map(),
      diagnostics,
    });

    assert.equal(result.search.engineErrors.count, 1);
    assert.equal(result.crashes.length, 1);
    const first = result.search.engineErrors.first!;
    assert.deepEqual(first.inputs, [{ kind: "option", index: 2, label: "Stay" }]);
    assert.equal(replay(failing, plan, 1, first.inputs).error, first.message);
  },
);
