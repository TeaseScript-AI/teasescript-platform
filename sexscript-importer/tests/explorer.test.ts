import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { explore, loadEngine, replay, type Engine } from "../src/explorer.ts";

const engineResult = await loadEngine().then(
  (engine): { engine: Engine } | { reason: string } => ({ engine }),
  (error: unknown) => ({ reason: error instanceof Error ? error.message : String(error) }),
);

test(
  "the explorer finds both ends, the crash, the inescapable loop, and the missed branch of a package",
  { skip: "reason" in engineResult ? engineResult.reason : false },
  async () => {
    const { engine } = engineResult as { engine: Engine };
    const source = await readFile(new URL("fixtures/explorer/main.tease", import.meta.url), "utf8");
    const compiled = engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
    const plan = (compiled as { plan: Readonly<Record<string, unknown>> }).plan;
    const result = explore(engine, plan, {
      seed: 1,
      budgetMs: 30_000,
      maxStates: 1000,
      sources: new Map([["main.tease", source]]),
    });

    // Every state the inputs reach is explored: "Left" exits, "Right" fails, "Stay" loops.
    assert.equal(result.search.stoppedBy, "exhausted");
    assert.ok(result.endStates.completed >= 1);
    assert.ok(result.endStates.failed >= 1);

    // One crash per code and span, with the path that reaches it; replaying the path fails the same way.
    assert.equal(result.crashes.length, 1);
    const crash = result.crashes[0]!;
    assert.deepEqual([crash.code, crash.path, crash.line], ["TSR025", "main.tease", 12]);
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
    assert.deepEqual(trap.locations, ["main.tease:16"]);
    assert.deepEqual(trap.sampleTexts, ["You are stuck."]);
    assert.deepEqual(trap.inputs, [{ kind: "option", index: 2, label: "Stay" }]);

    // Line coverage: the branch no answer takes stays unvisited, and its condition is recorded for a directed search.
    const file = result.coverage.files.find((entry) => entry.path === "main.tease")!;
    assert.ok(file.unvisited.some((range) => range.lines === "8" && range.reach === "unknown"));
    assert.ok(!file.unvisited.some((range) => /^(4|11|15)(-|$)/u.test(range.lines)));
    const branch = result.coverage.unvisitedBranches.find((entry) => entry.line === 7);
    assert.equal(branch?.missed, "true");
    assert.equal(branch?.condition?.text, 'pick == "never"');
    assert.equal(branch?.targetLine, 8);
  },
);
