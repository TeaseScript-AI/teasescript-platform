import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { CLOCK_FUNCTIONS } from "../src/language-facts.js";
import { run } from "../src/runtime/engine.js";
import { RuntimeFault } from "../src/runtime/errors.js";
import type { SerializableRuntimeTemporal } from "../src/runtime/values/serializable-values.js";
import { temporalMethod, temporalNow } from "../src/runtime/values/temporal-operations.js";
import { createSourcePosition, createSourceSpan } from "../src/source.js";
import {
  CALENDAR_DURATION_PARTS,
  CLOCK_CONTRACTS,
  hasTemporalField,
  hasTemporalMethod,
  TEMPORAL_FIELDS,
  TEMPORAL_KINDS,
  TEMPORAL_METHODS,
  type TemporalKind,
} from "../src/temporal-builtins.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { AMSTERDAM, utc } from "./helpers/temporal-fixtures.js";

/*
 * The contracts of the built-ins of date and time values (V30 §35) decide what the compiler accepts and what the runtime
 * does: a built-in that a value has gives a value of the contract's type in both, and one that it does not have, or a
 * call with arguments, fails with the same text in both.
 */

/** Hides a value's type from the compiler, so that the runtime checks what is read from it. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

/** A value of each kind, which the compiler knows the type of. */
const VALUES: { readonly [Kind in TemporalKind]: string } = {
  date: 'toDate("2024-12-30")',
  time: 'toTime("14:30:15.250")',
  datetime: 'toDateTime("2026-10-25T02:30:00.001")',
  absoluteDateTime: 'toAbsoluteDateTime("2026-10-25T01:30:00Z")',
};

const CALENDAR_DURATION = "14 calendar months + 10 calendar days - 90 min";

function errors(source: string): (readonly [string, string, number])[] {
  return compileSource(source).diagnostics.flatMap((diagnostic) =>
    diagnostic.severity === "error"
      ? [[diagnostic.code, diagnostic.message, diagnostic.span.start.offset] as const]
      : [],
  );
}

/** Runs `source` with a clock at 02:30 on the night that Amsterdam leaves summer time. */
function outcome(source: string): {
  readonly says: string[];
  readonly failure: [string, string] | null;
} {
  const plan = compileValidPlan(`${source}\nexit`);
  const result = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, {
      temporalContext: AMSTERDAM,
      wallClockMs: utc("2026-10-25T00:30:00"),
    }),
  );
  const failure = result.snapshot.failure;
  return {
    says: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    failure: failure === null ? null : [failure.code, failure.message],
  };
}

test("a member of a date or time value has its contract's receivers and type when compiled and when it runs", () => {
  const members = [
    ...Object.entries(TEMPORAL_METHODS).map(([name, { result }]) => ({ name, result, call: "()" })),
    ...Object.entries(TEMPORAL_FIELDS).map(([name, { result }]) => ({ name, result, call: "" })),
  ];
  for (const kind of TEMPORAL_KINDS)
    for (const { name, result, call } of members) {
      const has = call === "()" ? hasTemporalMethod(kind, name) : hasTemporalField(kind, name);
      const known = `let v = ${VALUES[kind]}\nsay v.${name}${call}`;
      const hidden = `${DYNAMIC}let v = dynamic(${VALUES[kind]})\nsay v.${name}${call}`;
      if (has) {
        assert.deepEqual(
          errors(`let r: ${result} = ${VALUES[kind]}.${name}${call}\nexit`),
          [],
          name,
        );
        assert.deepEqual(outcome(`${hidden} is ${result}`).says, ["true"], `${kind} ${name}`);
        continue;
      }
      // The compiler reports the member where the runtime fails on it, with the runtime's text.
      const reported = errors(`${known}\nexit`);
      assert.equal(reported.length, 1, `${kind} ${name}`);
      assert.deepEqual(
        outcome(hidden).failure,
        [call === "()" ? "TSR016" : "TSR017", reported[0]![1]],
        `${kind} ${name}`,
      );
    }
  // A union of kinds that all lack the member names the first, as the runtime names that kind.
  const union = errors("function f(u: date | time) {\n    say u.trim()\n    say u.length\n}\nexit");
  assert.deepEqual(
    union.map(([, message]) => message),
    [
      outcome(`${DYNAMIC}say dynamic(${VALUES.date}).trim()`).failure![1],
      outcome(`${DYNAMIC}say dynamic(${VALUES.date}).length`).failure![1],
    ],
  );
  // A field of a local value names the conversion of an absolute date and time, as the source writes it.
  assert.deepEqual(
    errors(`let moment = ${VALUES.absoluteDateTime}\nsay moment.hour\nexit`)[0]![1],
    "An absolute date and time has no property 'hour'. Convert it first, as in 'moment.toDateTime().hour'.",
  );
  assert.deepEqual(
    outcome(`${DYNAMIC}let moment = dynamic(${VALUES.absoluteDateTime})\nsay moment.hour`).failure,
    [
      "TSR017",
      "An absolute date and time has no property 'hour'. Convert it first, as in 'moment.toDateTime().hour'.",
    ],
  );
});

test("a clock read and a part of a calendar duration have their contract's type when compiled and when it runs", () => {
  for (const [name, { result }] of Object.entries(CLOCK_CONTRACTS)) {
    assert.deepEqual(errors(`let r: ${result} = ${name}()\nexit`), [], name);
    assert.deepEqual(outcome(`${DYNAMIC}say dynamic(${name}()) is ${result}`).says, ["true"], name);
  }
  for (const [name, { result }] of Object.entries(CALENDAR_DURATION_PARTS)) {
    assert.deepEqual(errors(`let r: ${result} = (${CALENDAR_DURATION}).${name}\nexit`), [], name);
    assert.deepEqual(
      outcome(`${DYNAMIC}say dynamic(${CALENDAR_DURATION}).${name} is ${result}`).says,
      ["true"],
      name,
    );
  }
  const reported = errors(`let c = ${CALENDAR_DURATION}\nsay c.weeks\nexit`);
  assert.equal(reported.length, 1);
  assert.deepEqual(
    outcome(`${DYNAMIC}let c = dynamic(${CALENDAR_DURATION})\nsay c.weeks`).failure,
    ["TSR017", reported[0]![1]],
  );
});

test("a clock read or a method of a date or time value with arguments fails alike, also on a value of unknown type", () => {
  const span = createSourceSpan(createSourcePosition(0, 0, 0), createSourcePosition(1, 0, 1));
  const fault = (call: () => void): readonly [string, string] => {
    try {
      call();
    } catch (error) {
      if (error instanceof RuntimeFault) return [error.code, error.message];
      throw error;
    }
    assert.fail("The call did not fail.");
  };
  const capture = { boundaryMs: 0, sinceEventSequence: 0, epochMs: 0, context: AMSTERDAM };
  for (const name of CLOCK_FUNCTIONS)
    for (const [written, positional, named] of [
      ["1", [1], {}],
      ["x: 1", [], { x: 1 }],
    ] as const) {
      const reported = errors(`say ${name}(${written})\nexit`);
      assert.deepEqual(
        reported.map(([code]) => code),
        ["TSV020"],
        name,
      );
      assert.deepEqual(
        fault(() => temporalNow(name, positional, named, capture, 0, span)),
        ["TSR028", reported[0]![1]],
        name,
      );
    }
  const values: { readonly [Kind in TemporalKind]: SerializableRuntimeTemporal } = {
    date: { kind: "date", year: 2024, month: 12, day: 30 },
    time: { kind: "time", hour: 14, minute: 30, second: 15, millisecond: 250 },
    datetime: {
      kind: "datetime",
      year: 2026,
      month: 10,
      day: 25,
      hour: 2,
      minute: 30,
      second: 0,
      millisecond: 1,
    },
    absoluteDateTime: { kind: "absoluteDateTime", epochMilliseconds: utc("2026-10-25T01:30:00") },
  };
  for (const [name, method] of Object.entries(TEMPORAL_METHODS))
    for (const kind of method.receivers)
      for (const [written, positional, named] of [
        ["1", [1], {}],
        ["1, 2", [1, 2], {}],
        ["x: 1", [], { x: 1 }],
      ] as const) {
        // The same text at the method's name, whether the compiler knows the value or not.
        const call = `say v.${name}(${written})\nexit`;
        const at = (source: string) =>
          errors(source).map(([code, message, offset]) => [
            code,
            message,
            offset - source.indexOf(call),
          ]);
        const known = at(`let v = ${VALUES[kind]}\n${call}`);
        assert.deepEqual(known, [["TSV020", known[0]![1], "say v.".length]], `${kind} ${name}`);
        assert.deepEqual(
          at(`${DYNAMIC}let v = dynamic(${VALUES[kind]})\n${call}`),
          known,
          `${kind} ${name}(${written})`,
        );
        assert.deepEqual(
          fault(() => temporalMethod(values[kind], name, positional, named, AMSTERDAM, span)),
          ["TSR015", known[0]![1]],
          `${kind} ${name}(${written})`,
        );
      }
});

test("no other value has a method of a date or time value, so a call of one only reads", () => {
  const others = [
    '"abc"',
    "[1]",
    "set[1]",
    'dict{ "a": 1 }',
    "(1..=2)",
    "5",
    "true",
    "1 s",
    "1 calendar day",
    "1 deg",
    "/x/",
  ];
  for (const name of Object.keys(TEMPORAL_METHODS))
    for (const other of others)
      assert.equal(
        errors(`let v = ${other}\nsay v.${name}()\nexit`).length,
        1,
        `${other}.${name}()`,
      );
});
