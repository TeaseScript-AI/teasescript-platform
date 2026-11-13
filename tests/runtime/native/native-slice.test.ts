import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { compileSource } from "../../../src/compiler.js";
import { createFreshRuntimeSession } from "../../../src/index.js";
import { createFreshNativeSession } from "../../../src/runtime/native/session.js";

// The native engine gives the product today's engine gives for the plans it runs: the same events in the same drives,
// where it waits, and the same generator, status and failure, under the same seed and clock.

const FRESH = { seed: 20260713, wallClockMs: Date.UTC(2026, 6, 13, 9, 0, 0) };

interface Drive {
  readonly kind: "step" | "run" | "observe";
  readonly budget?: number;
  readonly nowMs?: number;
}

/** A drive's run options: its budget, or the engines' default. */
function options(drive: Drive): { readonly instructionBudget?: number } {
  return drive.budget === undefined ? {} : { instructionBudget: drive.budget };
}

/** What both engines show of each drive and of the state after it. */
function product(source: string, drives: readonly Drive[], engine: "today" | "native"): unknown[] {
  const compiled = compileSource(source);
  assert.ok(compiled.plan, JSON.stringify(compiled.diagnostics.slice(0, 2)));
  const shown: unknown[] = [];
  if (engine === "today") {
    const session = createFreshRuntimeSession(compiled.plan, FRESH);
    for (const drive of drives) {
      const result =
        drive.kind === "observe"
          ? session.observeTime(drive.nowMs)
          : drive.kind === "run"
            ? session.run(options(drive))
            : session.stepToEvent(options(drive));
      const state = session.exportSnapshot();
      shown.push({
        events: result.events,
        instructions: result.instructionsExecuted,
        status: state.status,
        failure: state.failure,
        rng: state.rng,
        next: state.nextInstruction,
        foreground: state.foregroundAction,
      });
    }
    return JSON.parse(JSON.stringify(shown)) as unknown[];
  }
  const session = createFreshNativeSession(compiled.plan, FRESH);
  for (const drive of drives) {
    const result =
      drive.kind === "observe"
        ? session.observeTime(drive.nowMs!)
        : drive.kind === "run"
          ? session.run(options(drive))
          : session.stepToEvent(options(drive));
    const state = session.state;
    shown.push({
      events: result.events,
      instructions: result.instructionsExecuted,
      status: state.status,
      failure: state.failure,
      rng: state.rng,
      next: state.nextInstruction,
      foreground: state.foregroundAction,
    });
  }
  return JSON.parse(JSON.stringify(shown)) as unknown[];
}

function assertSameProduct(source: string, drives: readonly Drive[]): void {
  assert.deepEqual(product(source, drives, "native"), product(source, drives, "today"));
}

const STEPS: readonly Drive[] = Array.from({ length: 8 }, () => ({ kind: "step" }));

test("a loop of draws and a paced say: the same result, reading time and settlement", () => {
  assertSameProduct(
    `let grid = []
for i in 0..100 { grid.add(0) }
let hits = 0
let n = 0
while n < 2000 {
  let x = randomInteger(0..9)
  let y = randomInteger(0..9)
  if grid[x * 10 + y] == 0 { hits += 1 }
  n += 1
}
say "\${hits}"
exit`,
    [{ kind: "step" }, { kind: "observe", nowMs: 100 }, { kind: "observe", nowMs: 60_000 }, { kind: "step" }],
  );
});

test("the Battleship shot: functions, prepared references, a speaker's says and clock reads", () => {
  const source = readFileSync(
    new URL("../../../../benchmarks/runtime/workloads/battleship-three-hits-500.tease", import.meta.url),
    "utf8",
  );
  assertSameProduct(source, STEPS);
});

test("faults fail the session at their instruction with today's messages", () => {
  // A store through a prepared reference names no place, as its path holds an index.
  assertSameProduct(
    `let grid = [[0, 0], [0, 0]]
let k = 1
grid[k][2] = 1`,
    STEPS,
  );
  assertSameProduct(`let n = 3\nwhile n { n -= 1 }`, STEPS);
  assertSameProduct(`function down(n) { return down(n + 1) }\nlet x = down(0)`, STEPS);
  assertSameProduct(`let items = [1, 2]\nlet x = items[5]`, STEPS);
});

test("the step budget fails at the loop that used it", () => {
  assertSameProduct(`let n = 0\nwhile true { n += 1 }`, [{ kind: "run", budget: 5000 }]);
});
