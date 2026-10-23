import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, createFreshRuntimeSession } from "../src/index.js";
import type { InstructionPlan } from "../src/plan/model.js";
import type { SerializableRuntimeValue } from "../src/runtime/values/serializable-values.js";
import {
  OPERATOR_ROWS,
  operatorRow,
  type Operator,
  type OperatorRow,
} from "../src/type-inference/core/operator-table.js";
import { hasIdentity, VALUE_KIND_NAMES, valueKindOf, type ValueKind } from "../src/value-kinds.js";

// The core's operator table against the runtime, its authority (F16, C4): the runtime evaluates every operator on
// values of every pair of kinds, and a row must exist exactly where it accepts them, with the kind its result has. A
// row the runtime takes by value must be one where some values fail the runtime's check of the kinds (`TSR009`), and
// no other row's values may fail it. The operands come from host globals, which the compiler cannot see; speakers and
// handles, which only the runtime creates, come from the script through `pick`, as in `tests/value-kinds.test.ts`.

const OPERATORS: readonly Operator[] = ["+", "-", "*", "/", "%", "<", "<=", ">", ">=", "neg"];

const days = (count: number, milliseconds = 0): SerializableRuntimeValue => ({
  kind: "calendarDuration",
  months: 0,
  days: count,
  milliseconds,
});

/** Dates and times, as left and right values. */
const TEMPORAL = {
  date: [
    { kind: "date", year: 2026, month: 10, day: 4 },
    { kind: "date", year: 2026, month: 10, day: 1 },
  ],
  time: [
    { kind: "time", hour: 14, minute: 30, second: 0, millisecond: 0 },
    { kind: "time", hour: 9, minute: 15, second: 0, millisecond: 0 },
  ],
  datetime: [
    {
      kind: "datetime",
      year: 2026,
      month: 10,
      day: 4,
      hour: 14,
      minute: 30,
      second: 0,
      millisecond: 0,
    },
    {
      kind: "datetime",
      year: 2026,
      month: 10,
      day: 1,
      hour: 9,
      minute: 15,
      second: 0,
      millisecond: 0,
    },
  ],
  absoluteDateTime: [
    { kind: "absoluteDateTime", epochMilliseconds: 1_790_000_000_000 },
    { kind: "absoluteDateTime", epochMilliseconds: 1_780_000_000_000 },
  ],
} as const satisfies Readonly<
  Record<string, readonly [SerializableRuntimeValue, SerializableRuntimeValue]>
>;

/**
 * A left and a right value of each kind that a host can give, chosen so that every row's checks by value pass: whole
 * calendar parts after scaling and division, no exact offset when a date moves, one calendar family, nonzero divisors.
 */
const SAMPLES: Readonly<
  Partial<Record<ValueKind, readonly [SerializableRuntimeValue, SerializableRuntimeValue]>>
> = {
  integer: [6, 4],
  number: [2.5, 0.5],
  string: ["a", "b"],
  boolean: [true, false],
  null: [null, null],
  duration: [
    { kind: "duration", milliseconds: 2000 },
    { kind: "duration", milliseconds: 500 },
  ],
  calendarDuration: [days(12), days(2)],
  angle: [
    { kind: "angle", degrees: 90 },
    { kind: "angle", degrees: 45 },
  ],
  ...TEMPORAL,
  script: [
    { kind: "script", path: "main.tease" },
    { kind: "script", path: "main.tease" },
  ],
  regex: [
    { kind: "regex", source: "x+", flags: "i" },
    { kind: "regex", source: "y", flags: "" },
  ],
  range: [
    { kind: "range", start: 1, end: 3, inclusive: true },
    { kind: "range", start: 0, end: 2, inclusive: false },
  ],
  list: [
    { kind: "list", items: [1] },
    { kind: "list", items: [2] },
  ],
  set: [
    { kind: "set", items: [1] },
    { kind: "set", items: [2] },
  ],
  dict: [
    { kind: "dict", entries: [{ key: "a", value: 1 }] },
    { kind: "dict", entries: [{ key: "b", value: 2 }] },
  ],
  object: [
    { kind: "object", properties: [{ name: "a", value: 1 }] },
    { kind: "object", properties: [{ name: "b", value: 2 }] },
  ],
};

/** The script's speaker and handles, which a host cannot give (`hasIdentity`). */
const MADE: Readonly<Partial<Record<ValueKind, string>>> = {
  speaker: "anna",
  timer: "t",
  media: "m",
  camera: "v",
  permanentButton: "b",
  messageHandle: "g",
};

const IDENTITY_KINDS = VALUE_KIND_NAMES.filter(hasIdentity);

/** Statements that make the speaker and the handles, and `pick`, which hides a value's type from the compiler. */
const SETUP = [
  "speaker anna { }",
  "function pick(value) {\n    return value\n}",
  "let t = timer async 10 s {\n    say 1\n}",
  'let m = playAudio async "a.mp3"',
  "let v = showCamera",
  'let b = showPermanentButton "Press" {\n}',
  'let g = say("hello", 0 s)',
  `let handles = [${IDENTITY_KINDS.map((kind) => `pick(${MADE[kind]})`).join(", ")}]`,
].join("\n");

/**
 * The script that evaluates `OPERATORS[operator]` on `a` and `c`, then waits at an ask, where the run stops with the
 * result in its scope. `a` is the host's `left`, or the handle at `leftHandle` when that is not negative, and `c` alike.
 * The last case compares with `==`, which takes every value, so a run can show the operands' kinds.
 */
const SOURCE = [
  SETUP,
  "let a = pick(left)",
  "if leftHandle >= 0 {\n    a = pick(handles[leftHandle])\n}",
  "let c = pick(right)",
  "if rightHandle >= 0 {\n    c = pick(handles[rightHandle])\n}",
  ...[...OPERATORS, "=="].map(
    (operator, index) =>
      `${index === 0 ? "if" : "} else if"} operator == ${index} {\n    let result = ${operator === "neg" ? "-a" : `a ${operator} c`}\n    let stop = askText "end"`,
  ),
  "}",
  "exit",
].join("\n");

const plan: InstructionPlan = (() => {
  const compiled = compileProject([{ path: "main.tease", source: SOURCE }], {
    globals: ["operator", "left", "right", "leftHandle", "rightHandle"],
  });
  assert.deepEqual(
    compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
  assert.notEqual(compiled.plan, null);
  return compiled.plan!;
})();

type Outcome =
  | { readonly accepted: true; readonly result: ValueKind; readonly operands: readonly ValueKind[] }
  | { readonly accepted: false; readonly code: string };

/** How the runtime evaluates `OPERATORS[operator]`, or `==` at `OPERATORS.length`, on these values or handles. */
function evaluate(
  operator: number,
  operands: readonly (SerializableRuntimeValue | { readonly handle: ValueKind })[],
): Outcome {
  const host = (index: number): [SerializableRuntimeValue, number] => {
    const operand = operands[index] ?? null;
    if (operand !== null && typeof operand === "object" && "handle" in operand)
      return [null, IDENTITY_KINDS.indexOf(operand.handle)];
    return [operand, -1];
  };
  const [left, leftHandle] = host(0);
  const [right, rightHandle] = host(1);
  const session = createFreshRuntimeSession(plan, {
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
    globals: { operator, left, right, leftHandle, rightHandle },
  });
  for (;;) {
    for (const event of session.run().events)
      if (event.kind === "runtimeFailure") return { accepted: false, code: event.code };
    const action = session.view().foregroundAction;
    if (action?.kind === "mediaPlayback") {
      session.reportMediaLoad(action.mediaId, { kind: "loaded", durationMs: 60_000 });
      continue;
    }
    assert.equal(action?.kind, "interaction");
    const bindings = new Map(
      session
        .exportSnapshot()
        .frames.flatMap((frame) => frame.bindings)
        .map((binding) => [binding.name, binding.value]),
    );
    const kindOf = (name: string): ValueKind => {
      assert.ok(bindings.has(name), name);
      return valueKindOf(bindings.get(name)!);
    };
    return { accepted: true, result: kindOf("result"), operands: [kindOf("a"), kindOf("c")] };
  }
}

/** A value of `kind` for the operand at `index`: the host's sample, or the script's handle. */
function operand(
  kind: ValueKind,
  index: 0 | 1,
): SerializableRuntimeValue | { readonly handle: ValueKind } {
  const sample = SAMPLES[kind];
  return sample === undefined ? { handle: kind } : sample[index];
}

/** Whether a result of `actual` kind is one of `row`'s: an integer is a number too, as a whole quotient is. */
function fitsResult(row: OperatorRow, actual: ValueKind): boolean {
  return actual === row.result || (row.result === "number" && actual === "integer");
}

test("every kind has a host sample or, when only the runtime creates it, a source in the script", () => {
  for (const kind of VALUE_KIND_NAMES) {
    assert.equal(SAMPLES[kind] === undefined, hasIdentity(kind), kind);
    assert.equal(MADE[kind] === undefined, !hasIdentity(kind), kind);
    for (const index of [0, 1] as const) {
      const outcome = evaluate(OPERATORS.length, [
        operand(kind, index),
        operand(kind, index === 0 ? 1 : 0),
      ]);
      assert.ok(outcome.accepted, `'==' on ${kind}`);
      assert.deepEqual(outcome.operands, [kind, kind], kind);
    }
  }
});

test("a row exists exactly where the runtime evaluates the operator, with the kind of its result", () => {
  const failures: string[] = [];
  OPERATORS.forEach((operator, index) => {
    const pairs = VALUE_KIND_NAMES.flatMap((left): ValueKind[][] =>
      operator === "neg" ? [[left]] : VALUE_KIND_NAMES.map((right) => [left, right]),
    );
    for (const kinds of pairs) {
      const row = operatorRow(operator, kinds);
      const outcome = evaluate(
        index,
        kinds.map((kind, position) => operand(kind, position === 0 ? 0 : 1)),
      );
      const what = `${operator} ${kinds.join(" ")}`;
      if (outcome.accepted && row === undefined)
        failures.push(`${what}: the runtime gives ${outcome.result}, the table has no row`);
      else if (!outcome.accepted && row !== undefined)
        failures.push(
          `${what}: the table gives ${row.result}, the runtime fails with ${outcome.code}`,
        );
      else if (outcome.accepted && row !== undefined && !fitsResult(row, outcome.result))
        failures.push(`${what}: the table gives ${row.result}, the runtime ${outcome.result}`);
    }
  });
  assert.deepEqual(failures, []);
});

test("a number result follows V30 §4: an integer when every operand is one, a number otherwise and from `/`", () => {
  // the runtime keeps no spelling, so its whole quotient cannot tell `integer` from `number` (`fitsResult`)
  const numeric = OPERATOR_ROWS.filter(
    (row) =>
      row.result !== "boolean" &&
      row.operands.every((kind) => kind === "integer" || kind === "number"),
  );
  for (const row of numeric)
    assert.equal(
      row.result,
      row.operator !== "/" && row.operands.every((kind) => kind === "integer")
        ? "integer"
        : "number",
      `${row.operator} ${row.operands.join(" ")}`,
    );
  // each of `+ - * / %` on the four pairs of number kinds, and `neg` on both
  assert.equal(numeric.length, 22);
});

/**
 * Values of each kind that a row uses, the samples among them, where checks by value can fail: zero, a negative, a
 * fraction and the largest number (a whole one, which scales a calendar duration's parts out of whole numbers);
 * calendar durations of two families, one with an exact offset, and zero; the empty text and list.
 */
const EDGES: Readonly<Partial<Record<ValueKind, readonly SerializableRuntimeValue[]>>> = {
  integer: [6, 4, 0, -3, Number.MAX_VALUE],
  number: [2.5, 0.5, 0.3, -0.25],
  string: ["a", "b", ""],
  list: [
    { kind: "list", items: [1] },
    { kind: "list", items: [] },
  ],
  duration: [
    { kind: "duration", milliseconds: 2000 },
    { kind: "duration", milliseconds: 500 },
    { kind: "duration", milliseconds: 0 },
  ],
  calendarDuration: [
    days(12),
    days(2),
    { kind: "calendarDuration", months: 1, days: 0, milliseconds: 0 },
    days(1, 1000),
    days(0),
  ],
  angle: [
    { kind: "angle", degrees: 90 },
    { kind: "angle", degrees: 45 },
    { kind: "angle", degrees: 0 },
  ],
  ...TEMPORAL,
};

test("a row the runtime takes by value has values that fail its check of the kinds, and no other row has", () => {
  const failures: string[] = [];
  for (const row of OPERATOR_ROWS) {
    const what = `${row.operator} ${row.operands.join(" ")}`;
    let combinations: SerializableRuntimeValue[][] = [[]];
    for (const kind of row.operands) {
      const edges = EDGES[kind];
      assert.ok(edges !== undefined, `edge values of ${kind}`);
      combinations = combinations.flatMap((done) => edges.map((value) => [...done, value]));
    }
    let failedByValue = false;
    for (const values of combinations) {
      const outcome = evaluate(OPERATORS.indexOf(row.operator), values);
      if (!outcome.accepted && outcome.code === "TSR009") failedByValue = true;
      if (outcome.accepted && !fitsResult(row, outcome.result))
        failures.push(`${what} on ${JSON.stringify(values)}: the runtime gives ${outcome.result}`);
    }
    if (failedByValue && !row.byValue)
      failures.push(`${what}: the runtime fails some values with TSR009, the row is not by value`);
    if (!failedByValue && row.byValue)
      failures.push(`${what}: the row is by value, no value fails it`);
  }
  assert.deepEqual(failures, []);
});
