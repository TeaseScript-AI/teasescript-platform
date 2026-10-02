import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { validateSerializableValue } from "../src/runtime/serializable-values.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { runValidSource } from "./helpers/run-valid-source.js";

function sayTexts(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return result.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

function diagnostics(source: string): string[] {
  const result = compileSource(source);
  assert.equal(result.plan, null, `${JSON.stringify(source)} must not compile`);
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function runtimeFailure(source: string): string | undefined {
  return runValidSource(source).snapshot.failure?.code;
}

test("duration literals accept short and long elapsed units and convert exactly", () => {
  assert.deepEqual(
    sayTexts(
      [
        'say "${500 ms} ${1 millisecond} ${30 s} ${1 second} ${2 seconds}"',
        'say "${10 min} ${1 minute} ${3 minutes} ${2 h} ${1 hour} ${4 hours}"',
        'say "${90 s} ${1.5 s} ${3725.25 s} ${0 ms} ${-(90 s)}"',
      ].join("\n"),
    ),
    [
      "500 ms 1 ms 30 s 1 s 2 s",
      "10 min 1 min 3 min 2 h 1 h 4 h",
      "1 min 30 s 1.5 s 1 h 2 min 5.25 s 0 s -1 min 30 s",
    ],
  );
});

test("duration arithmetic and cross-unit comparisons follow V30 section 35", () => {
  assert.deepEqual(
    sayTexts(
      [
        'say "${90 seconds > 1 minute} ${90 s == 1.5 min} ${60 min == 1 h} ${59 s >= 1 min}"',
        'say "${1 min + 30 s} ${1 min - 90 s} ${2 * 30 s} ${30 s * 3} ${1 h / 4}"',
        'say "${1 h / 30 min} ${[5 s].random} ${10 s != 10} ${10 s == 10000}"',
      ].join("\n"),
    ),
    ["true true true false", "1 min 30 s -30 s 1 min 1 min 30 s 15 min", "2 5 s true false"],
  );
});

test("mixing plain numbers with durations fails instead of guessing a unit", () => {
  for (const source of [
    'let n = 1\nsay "${1 s + n}"',
    'let n = 1\nsay "${n - 1 s}"',
    'let n = 2\nsay "${n / 1 s}"',
    'let n = 2\nsay "${1 s < n}"',
    'let d = 1 s\nsay "${d * d}"',
    'let n = 2\nsay "${1 s % n}"',
  ]) {
    assert.equal(runtimeFailure(source), "TSR009", source);
  }
  assert.equal(runtimeFailure('let n = 0\nsay "${1 s / n}"'), "TSR036");
  assert.equal(runtimeFailure('let d = 0 s\nsay "${d / d}"'), "TSR036");
  for (const source of [
    'say "${1 s + 1}"',
    "wait 1 + 2 ms",
    'say "${2 < 1 min}"',
    'say "${1 / 1 s}"',
    'say "${-1 + 1 s}"',
  ]) {
    assert.deepEqual(diagnostics(source), ["TSV035"], source);
  }
  assert.equal(runValidSource("wait (1 + 2) ms").snapshot.foregroundAction?.kind, "delay");
  assert.deepEqual(sayTexts('say "${2 * 1 s} ${1 s * 2} ${1 s / 2} ${-(1 s) * 2}"'), [
    "2 s 2 s 500 ms -2 s",
  ]);
});

test("calendar units are never misread; doubled units and overflow are rejected at compile time", () => {
  // Calendar durations are accepted direction that is not implemented yet (V30 section 35). Until it is, a calendar
  // unit must stop compilation with a structured diagnostic at the duration instead of running as another value, such
  // as `wait 3` seconds.
  for (const [source, duration] of [
    ['say "${1 day}"', "1 day"],
    ["let a = 2 weeks", "2 weeks"],
    ["let a = 1 mo", "1 mo"],
    ["wait 3 days", "3 days"],
    ["let n = 3\nwait n days", "n days"],
  ] as const) {
    const result = compileSource(source);
    assert.equal(result.plan, null, source);
    const first = result.diagnostics[0];
    assert.match(first?.code ?? "", /^TS[LPV]\d{3}$/u, source);
    const start = source.indexOf(duration);
    assert.ok(
      first!.span.start.offset >= start && first!.span.start.offset < start + duration.length,
      source,
    );
  }
  assert.deepEqual(diagnostics("wait 10 s ms"), ["TSV033"]);
  assert.deepEqual(diagnostics("let a = 1e306 h"), ["TSC001"]);
});

test("a unit only binds to a number on the same line", () => {
  const plan = compileValidPlan("let s = 1\nlet a = 2\ns = a");
  assert.equal(validateInstructionPlan(plan).valid, true);
  assert.deepEqual(sayTexts('let min = 3\nsay "${min} ${2 min}"'), ["3 2 min"]);
});

test("wait accepts duration values and keeps its trailing unit form", () => {
  for (const [source, deadline] of [
    ["wait 250 ms\nexit", 250],
    ["wait 2 min\nexit", 120_000],
    ["let d = 1.5 s\nwait d\nexit", 1_500],
    ["let n = 3\nwait n ms\nexit", 3],
    ["wait 2\nexit", 2_000],
  ] as const) {
    const result = runValidSource(source);
    assert.equal(result.snapshot.status, "waiting", source);
    assert.equal(result.snapshot.foregroundAction?.kind, "delay");
    assert.equal(
      result.snapshot.foregroundAction?.kind === "delay" &&
        result.snapshot.foregroundAction.deadlineMs,
      deadline,
      source,
    );
  }
  assert.equal(runtimeFailure("wait -(1 s)"), "TSR050");
  assert.equal(runtimeFailure("let d = 1 s\nwait d ms"), "TSR050");
});

test("duration values persist through checkpoint JSON and reject malformed data", () => {
  const plan = compileValidPlan('let d = 90 s\nwait 1\nsay "${d}"\nexit');
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, waiting.snapshot)),
  );
  assert.deepEqual(restored.snapshot.frames[0]!.bindings[0]!.value, {
    kind: "duration",
    milliseconds: 90_000,
  });
  assert.equal(
    validateSerializableValue({ kind: "duration", milliseconds: Number.NaN }) === null,
    false,
  );
  assert.equal(validateSerializableValue({ kind: "duration", milliseconds: "1" }) === null, false);
  assert.equal(
    validateSerializableValue({ kind: "duration", milliseconds: 1, unit: "s" }) === null,
    false,
  );
  assert.equal(validateSerializableValue({ kind: "duration", milliseconds: -5 }), null);
});

test("+= and -= apply to variables, properties, and indexes with one target evaluation", () => {
  assert.deepEqual(
    sayTexts(
      [
        "let x = 1",
        "x += 2",
        "x -= 0.5",
        "let o = { a: 1 }",
        "o.a += 10",
        "let l = [1, 2]",
        "let i = 0",
        "function next {",
        "  i += 1",
        "  return i",
        "}",
        "l[next()] += 5",
        "let d = 1 min",
        "d -= 15 s",
        'say "${x} ${o.a} ${l[1]} ${i} ${d}"',
      ].join("\n"),
    ),
    ["2.5 11 7 1 45 s"],
  );
});

test("compound assignment reads the target before an instruction-emitting operand runs", () => {
  assert.deepEqual(
    sayTexts(
      [
        "let x = 1",
        "function bump {",
        "  x = 100",
        "  return 1",
        "}",
        "x += bump()",
        'say "${x}"',
      ].join("\n"),
    ),
    ["2"],
  );
  assert.equal(runtimeFailure("let x = 1\nx += true"), "TSR027");
  assert.deepEqual(diagnostics("y += 1"), ["TSV003"]);
});
