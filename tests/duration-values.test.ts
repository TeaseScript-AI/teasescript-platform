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
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { validateSerializableValue } from "../src/runtime/serializable-values.js";
import type { SourceSpan } from "../src/source.js";
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

/** Hides a value's type from the compiler, so a contradiction reaches the runtime check. */
const DYNAMIC = "function dynamic(value) {\n  return value\n}\n";

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
  for (const [declaration, expression] of [
    ["let n = 1", "1 s + n"],
    ["let n = 1", "n - 1 s"],
    ["let n = 2", "n / 1 s"],
    ["let n = 2", "1 s < n"],
    ["let d = 1 s", "d * d"],
    ["let n = 2", "1 s % n"],
  ] as const) {
    const source = `${declaration}\nsay "\${${expression}}"`;
    assert.deepEqual(diagnostics(source), ["TSV043"], source);
    const dynamic = `${DYNAMIC}${declaration.replace(/= (.*)$/, "= dynamic($1)")}\nsay "\${${expression}}"`;
    assert.equal(runtimeFailure(dynamic), "TSR009", dynamic);
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
  // Calendar durations (V30 section 35) are accepted direction without an implementation yet. A calendar unit may be
  // rejected with a compile or runtime error located in the duration, but a started wait must have the calendar
  // meaning, never for example `wait 3` seconds or `1 min`. A calendar day spans 23 to 25 elapsed hours, a week 7 days
  // and a month 28 to 31 days. Interpolated durations use the same expression parser as these `let` initializers.
  const days = (fewest: number, most: number) => (deadlineMs: number) =>
    deadlineMs >= fewest * 23 * 3_600_000 && deadlineMs <= most * 25 * 3_600_000;
  const cases: ReadonlyArray<
    readonly [source: string, duration: string, accepted: (deadlineMs: number) => boolean]
  > = [
    ["wait 3 days", "3 days", days(3, 3)],
    ["let n = 3\nwait n days", "n days", days(3, 3)],
    ["let a = 2 weeks\nwait a", "2 weeks", days(14, 14)],
    ["let a = 1 mo\nwait a", "1 mo", days(28, 31)],
  ];
  for (const [source, duration, accepted] of cases) {
    const start = source.indexOf(duration);
    const inDuration = (span: SourceSpan): boolean =>
      span.start.offset >= start && span.end.offset <= start + duration.length;
    const message = `${JSON.stringify(source)}: an error must be located in ${JSON.stringify(duration)}`;
    const compiled = compileSource(source);
    if (compiled.plan === null) {
      assert.ok(
        compiled.diagnostics.some(({ severity, span }) => severity === "error" && inDuration(span)),
        message,
      );
      continue;
    }
    const { snapshot, events } = run(
      compiled.plan,
      createImmediatePacingRuntimeSnapshot(compiled.plan),
    );
    const failure = events.at(-1);
    if (failure?.kind === "runtimeFailure") {
      assert.ok(inDuration(failure.span), message);
      continue;
    }
    const action = snapshot.foregroundAction;
    assert.ok(action?.kind === "delay", `${JSON.stringify(source)} must wait`);
    assert.ok(
      accepted(action.deadlineMs),
      `${JSON.stringify(source)} must not mean ${action.deadlineMs} ms`,
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
  assert.deepEqual(diagnostics("let d = 1 s\nwait d ms"), ["TSV043"]);
  assert.equal(runtimeFailure(`${DYNAMIC}let d = dynamic(1 s)\nwait d ms`), "TSR050");
});

test("duration values persist through checkpoint JSON and reject malformed data", () => {
  const plan = compileValidPlan('let d = 90 s\nwait 1\nsay "${d}"\nexit');
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, waiting.snapshot)),
  );
  const resumed = run(restored.plan, observeTime(restored.plan, restored.snapshot, 1_000).snapshot);
  assert.equal(resumed.snapshot.status, "halted");
  assert.deepEqual(
    resumed.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["1 min 30 s"],
  );
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
        "let x: number = 1",
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
  assert.deepEqual(diagnostics("let x = 1\nx += true"), ["TSV041"]);
  assert.equal(
    runtimeFailure('let flag = load "flag" default true\nlet x = 1\nx += flag'),
    "TSR027",
  );
  assert.deepEqual(diagnostics("y += 1"), ["TSV003"]);
});
