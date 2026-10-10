import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

// TSV061 (V30 §27): a `wait` or timer whose length is written in days or weeks counts scene time, which stops while the
// Player is closed, while such a length almost always means real time. The compiler warns on the length and the script
// still runs.

function said(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

test("a wait or timer written in days or weeks gets TSV061 on its length, which it quotes", () => {
  for (const [source, length, quoted] of [
    ["wait 2 days", "2 days", "wait 2 days"],
    ["wait 2 d", "2 d", "wait 2 d"],
    ["timer 3 weeks", "3 weeks", "timer 3 weeks"],
    ['timer async hidden 1 w "Lock" {\n    say "Open"\n}', "1 w", "timer 1 w"],
    ["wait (1..3) days", "(1..3) days", "wait (1..3) days"],
    ["let r = 1..=3\ntimer r weeks", "r weeks", "timer r weeks"],
    ["let t = timer(duration: (1..=2) days, async: true)", "(1..=2) days", "timer (1..=2) days"],
    ["wait 1 day + 2 h", "1 day + 2 h", "wait 1 day + 2 h"],
    ["wait 2 * 1 week", "2 * 1 week", "wait 2 * 1 week"],
    // A length over several lines is quoted on one.
    ["wait (1 +\n    2) days", "(1 +\n    2) days", "wait (1 + 2) days"],
  ] as const) {
    const result = compileSource(`${source}\nexit`);
    assert.notEqual(result.plan, null, source);
    const [warning, ...rest] = result.diagnostics;
    assert.ok(warning, source);
    assert.deepEqual(rest, [], source);
    assert.deepEqual(
      [warning.severity, warning.code, warning.message],
      [
        "warning",
        "TSV061",
        `'${quoted}' counts only time while the Player is open, so closing the Player pauses it.`,
      ],
      source,
    );
    const start = source.lastIndexOf(length);
    assert.deepEqual(
      [warning.span.start.offset, warning.span.end.offset],
      [start, start + length.length],
      source,
    );
  }
});

test("hours, minutes, a length in a variable, and a day within a count before another unit stay silent", () => {
  for (const source of [
    "wait 2 h",
    "wait 48 h",
    "wait 30 min",
    "timer (1..3) h",
    "let t = timer(duration: 90 min, async: true)",
    "let x = 2 days\nwait x",
    "let elapsed = 3 days\nwait (elapsed / 1 day) s",
    "let elapsed = 3 days\nwait 1 h + (elapsed / 1 day) s",
  ]) {
    const result = compileSource(`${source}\nexit`);
    assert.deepEqual(result.diagnostics, [], source);
  }
});

test("a wait in days still runs, for exactly that much scene time", () => {
  const plan = compileValidPlan('wait 2 days\nsay "Later"\nexit', {}, ["TSV061"]);
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.equal(waiting.status, "waiting");
  const twoDays = 2 * 24 * 3_600_000;
  const before = run(plan, observeTime(plan, waiting, twoDays - 1).snapshot);
  assert.equal(before.snapshot.status, "waiting");
  assert.deepEqual(said(before.events), []);
  const after = run(plan, observeTime(plan, before.snapshot, twoDays).snapshot);
  assert.equal(after.snapshot.status, "halted");
  assert.deepEqual(said(after.events), ["Later"]);
});
