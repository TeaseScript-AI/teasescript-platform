import assert from "node:assert/strict";
import test from "node:test";

import {
  INTEGER_TYPE,
  optional,
  STRING_TYPE,
  union,
  withValues,
  type StaticType,
} from "../src/static-types.js";
import {
  CALENDAR_DURATION_PARTS,
  CLOCK_CONTRACTS,
  TEMPORAL_FIELDS,
  TEMPORAL_METHODS,
} from "../src/temporal-builtins.js";
import { WEEKDAY_NAMES } from "../src/temporal.js";
import { memberOf, operationRelations } from "../src/type-inference/adapters/index.js";
import type { OperandView, OperationRelation } from "../src/type-inference/adapters/relation.js";
import { INVALID } from "../src/type-inference/adapters/views.js";
import type { ValueKind } from "../src/value-kinds.js";
import {
  assertCase,
  assertEqualResult,
  BOTTOM_VIEW,
  closedView,
  dynamicView,
  inputsOf,
  legacyOperation,
  type AdapterExpectation,
  type LegacyExpectation,
} from "./helpers/adapter-parity.js";

/**
 * Parity of the clock reads and of the members of date and time values and calendar durations with the legacy
 * checker (work note §5.3, §5.4, §6.3): every clock read, every method and field of `TEMPORAL_METHODS`,
 * `TEMPORAL_FIELDS` and `CALENDAR_DURATION_PARTS` on a receiver of each date and time kind, a calendar duration and
 * an exact duration, with and without arguments, the finite values of a field, and date and time values among other
 * kinds of a receiver, which `members.ts` composes.
 */
function relation(family: "clock" | "method", name: string) {
  const found = operationRelations().relation({ family, name });
  assert.ok(found !== undefined, `a relation for ${family}.${name}`);
  return found;
}

/** A property read, for parity with the legacy's fact: the member's answer; a member the kind does not have is none. */
function assertProperty(
  kind: ValueKind,
  name: string,
  receiver: OperandView,
  source: string,
  legacy: LegacyExpectation,
  adapter: AdapterExpectation,
): void {
  const answer = memberOf(kind, name, receiver);
  assert.ok(answer?.kind !== "held", "a field is computed when it is read");
  if (adapter === "invalid") assert.equal(answer, undefined, `no member ${name} of ${kind}`);
  const read: OperationRelation = {
    contract: { family: "method", name },
    result: () => answer ?? INVALID,
  };
  assertCase(read, inputsOf({ receiver }), legacyOperation(source), legacy, adapter);
}

const scalar = (name: Extract<StaticType, { kind: "scalar" }>["name"]): StaticType => ({
  kind: "scalar",
  name,
});

/** The receivers: each date and time kind, a calendar duration, and an exact duration, which has no members. */
const RECEIVERS = [
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
  "calendarDuration",
  "duration",
] as const;
type Receiver = (typeof RECEIVERS)[number];

/** The fact of each method on the receivers that have it, and of each field and part. */
const METHOD_FACTS: Readonly<Record<string, readonly [string, readonly Receiver[]]>> = {
  toISO: ["string", ["date", "time", "datetime", "absoluteDateTime"]],
  formatDate: ["string", ["date", "datetime", "absoluteDateTime"]],
  formatTime: ["string", ["time", "datetime", "absoluteDateTime"]],
  formatDateTime: ["string", ["datetime", "absoluteDateTime"]],
  toAbsoluteDateTime: ["absoluteDateTime", ["datetime"]],
  toDateTime: ["datetime", ["absoluteDateTime"]],
  toSeconds: ["integer", ["absoluteDateTime"]],
  toMilliseconds: ["integer", ["absoluteDateTime"]],
  // A method of text is no method of a date or time value.
  trim: ["", []],
};

const WEEKDAYS = `string{${[...WEEKDAY_NAMES]
  .sort()
  .map((name) => `"${name}"`)
  .join("|")}}`;
const DATE_FIELD: readonly Receiver[] = ["date", "datetime"];
const TIME_FIELD: readonly Receiver[] = ["time", "datetime"];
const PROPERTY_FACTS: Readonly<Record<string, readonly [string, readonly Receiver[]]>> = {
  year: ["integer", DATE_FIELD],
  month: ["integer", DATE_FIELD],
  day: ["integer", DATE_FIELD],
  weekday: [WEEKDAYS, DATE_FIELD],
  weekdayNumber: ["integer{1|2|3|4|5|6|7}", DATE_FIELD],
  weekNumber: ["integer", DATE_FIELD],
  weekYear: ["integer", DATE_FIELD],
  hour: ["integer", TIME_FIELD],
  minute: ["integer", TIME_FIELD],
  second: ["integer", TIME_FIELD],
  millisecond: ["integer", TIME_FIELD],
  months: ["integer", ["calendarDuration"]],
  days: ["integer", ["calendarDuration"]],
  exactOffset: ["duration", ["calendarDuration"]],
  // A property of text, and one no value has.
  length: ["", []],
  foo: ["", []],
};

test("the tables cover every method, field and part of the contracts", () => {
  assert.deepEqual(
    Object.keys(METHOD_FACTS).filter((name) => name !== "trim"),
    Object.keys(TEMPORAL_METHODS),
  );
  assert.deepEqual(
    Object.keys(PROPERTY_FACTS).filter((name) => name !== "length" && name !== "foo"),
    [...Object.keys(TEMPORAL_FIELDS), ...Object.keys(CALENDAR_DURATION_PARTS)],
  );
});

test("a clock read gives a value of its kind, with or without the arguments it does not take", () => {
  for (const name of Object.keys(CLOCK_CONTRACTS)) {
    assertEqualResult(
      relation("clock", name),
      inputsOf({}),
      legacyOperation(`let r = ${name}()\nexit`),
      "type",
    );
    const fact = legacyOperation(`let r = ${name}()\nexit`).type!;
    assertCase(
      relation("clock", name),
      inputsOf({ arguments: [closedView(INTEGER_TYPE)] }),
      legacyOperation(`let r = ${name}(1)\nexit`),
      { fact, errors: ["TSV020"] },
      "fact",
    );
    assertCase(
      relation("clock", name),
      inputsOf({ named: { x: closedView(INTEGER_TYPE) } }),
      legacyOperation(`let r = ${name}(x: 1)\nexit`),
      { fact, errors: ["TSV020"] },
      "fact",
    );
  }
});

test("a method of a date or time value gives a new value of its result, on the receivers that have it", () => {
  for (const [name, [fact, receivers]] of Object.entries(METHOD_FACTS))
    for (const kind of RECEIVERS) {
      const source = `let a: ${kind} = hostValue\nlet r = a.${name}()\nexit`;
      const inputs = inputsOf({ receiver: closedView(scalar(kind)) });
      if (receivers.includes(kind))
        assertCase(
          relation("method", name),
          inputs,
          legacyOperation(source),
          { fact },
          "fact",
          "type",
        );
      else
        assertCase(
          relation("method", name),
          inputs,
          legacyOperation(source),
          { fact: "unknown", errors: ["TSV043"] },
          "invalid",
        );
    }
});

test("a method called with arguments is reported and still gives its result", () => {
  for (const [name, [fact, receivers]] of Object.entries(METHOD_FACTS)) {
    const kind = receivers.includes("datetime") ? "datetime" : receivers[0];
    if (kind === undefined) continue;
    assertCase(
      relation("method", name),
      inputsOf({ receiver: closedView(scalar(kind)), arguments: [closedView(INTEGER_TYPE)] }),
      legacyOperation(`let a: ${kind} = hostValue\nlet r = a.${name}(1)\nexit`),
      { fact, errors: ["TSV020"] },
      "fact",
    );
  }
});

test("a field or part is computed on the receivers that have it, with a field's few values kept", () => {
  for (const [name, [fact, receivers]] of Object.entries(PROPERTY_FACTS))
    for (const kind of RECEIVERS) {
      const source = `let a: ${kind} = hostValue\nlet r = a.${name}\nexit`;
      if (receivers.includes(kind))
        assertProperty(kind, name, closedView(scalar(kind)), source, { fact }, "fact");
      else
        assertProperty(
          kind,
          name,
          closedView(scalar(kind)),
          source,
          { fact: "unknown", errors: ["TSV043"] },
          "invalid",
        );
    }
  assert.deepEqual(memberOf("date", "weekday", closedView(scalar("date"))), {
    kind: "type",
    type: withValues(STRING_TYPE, WEEKDAY_NAMES),
  });
});

test("the members of a value the compiler knows are those of its kind", () => {
  assertProperty(
    "date",
    "year",
    closedView(scalar("date")),
    "let r = getDate().year\nexit",
    { fact: "integer" },
    "fact",
  );
  assertProperty(
    "datetime",
    "weekday",
    closedView(scalar("datetime")),
    "let r = getDateTime().weekday\nexit",
    { fact: WEEKDAYS },
    "fact",
  );
  assertProperty(
    "calendarDuration",
    "months",
    closedView(scalar("calendarDuration")),
    "let r = (1 calendar months).months\nexit",
    { fact: "integer" },
    "fact",
  );
  assertProperty(
    "calendarDuration",
    "exactOffset",
    closedView(scalar("calendarDuration")),
    "let r = (1 calendar days).exactOffset\nexit",
    { fact: "duration" },
    "fact",
  );
  assertEqualResult(
    relation("method", "toISO"),
    inputsOf({ receiver: closedView(scalar("date")) }),
    legacyOperation("let r = getDate().toISO()\nexit"),
  );
});

test("a date or time value among the kinds of a receiver: every kind must have the method", () => {
  const either = (...kinds: readonly ("date" | "time" | "datetime" | "absoluteDateTime")[]) =>
    closedView(union(kinds.map(scalar)));
  assertCase(
    relation("method", "toISO"),
    inputsOf({ receiver: either("date", "datetime") }),
    legacyOperation("let a: date | datetime = hostValue\nlet r = a.toISO()\nexit"),
    { fact: "string" },
    "fact",
    "byReceiver",
  );
  assertCase(
    relation("method", "formatDate"),
    inputsOf({ receiver: either("date", "absoluteDateTime") }),
    legacyOperation("let a: date | absoluteDateTime = hostValue\nlet r = a.formatDate()\nexit"),
    { fact: "string" },
    "fact",
    "byReceiver",
  );
  for (const [annotation, name, view] of [
    ["date | time", "formatDate", either("date", "time")],
    ["datetime | absoluteDateTime", "toDateTime", either("datetime", "absoluteDateTime")],
    ["date?", "toISO", closedView(optional(scalar("date")))],
    ["date | string", "toISO", closedView(union([scalar("date"), STRING_TYPE]))],
    ["date | string", "trim", closedView(union([scalar("date"), STRING_TYPE]))],
    ["date | timer", "cancel", closedView(union([scalar("date"), { kind: "timer" }]))],
  ] as const)
    assertCase(
      relation("method", name),
      inputsOf({ receiver: view }),
      legacyOperation(`let a: ${annotation} = hostValue\nlet r = a.${name}()\nexit`),
      { fact: "unknown", errors: ["TSV043"] },
      "invalid",
    );
  // A speaker beside a date: the runtime checks the speaker; the legacy's unknown without an error.
  assertCase(
    relation("method", "toISO"),
    inputsOf({ receiver: closedView(union([{ kind: "speaker" }, scalar("date")])) }),
    legacyOperation(
      'speaker guide {\n displayName: "G"\n}\nlet a: speaker | date = hostValue\nlet r = a.toISO()\nexit',
    ),
    { fact: "unknown" },
    { realized: "unknown" },
    "byReceiver",
  );
  assertCase(
    relation("method", "toISO"),
    inputsOf({ receiver: dynamicView("host") }),
    legacyOperation("let r = hostValue.toISO()\nexit"),
    { fact: "unknown" },
    { dynamic: "host" },
  );
  // A field of a receiver of several kinds is composed by stage 3's resolver: each kind answers alone.
  assertProperty(
    "date",
    "year",
    either("date", "datetime"),
    "let a: date | datetime = hostValue\nlet r = a.year\nexit",
    { fact: "integer" },
    "fact",
  );
  assert.deepEqual(memberOf("datetime", "year", either("date", "datetime")), {
    kind: "type",
    type: INTEGER_TYPE,
  });
});

test("a relation answers from its inputs alone: bottom waits, a dynamic remainder is kept", () => {
  const toIso = relation("method", "toISO");
  assert.equal(toIso.result(inputsOf({ receiver: BOTTOM_VIEW })).kind, "unconstrained");
  assert.deepEqual(toIso.result(inputsOf({ receiver: closedView(scalar("time")) })), {
    kind: "type",
    type: STRING_TYPE,
  });
  assert.equal(toIso.result(inputsOf({ receiver: BOTTOM_VIEW })).kind, "unconstrained");
  assert.deepEqual(toIso.result(inputsOf({ receiver: dynamicView("host", [scalar("time")]) })), {
    kind: "alternatives",
    results: [
      // beside data the compiler cannot know the case stays a `byReceiver`, read as conditional on the kind
      {
        kind: "byReceiver",
        cases: [{ receiver: "time", result: { kind: "type", type: STRING_TYPE } }],
      },
      { kind: "dynamic", why: "host" },
    ],
  });
  assert.deepEqual(relation("clock", "getDate").result(inputsOf({ arguments: [BOTTOM_VIEW] })), {
    kind: "type",
    type: scalar("date"),
  });
});
