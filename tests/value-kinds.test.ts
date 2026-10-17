import assert from "node:assert/strict";
import test from "node:test";

import { HANDLE_KINDS } from "../src/handle-members.js";
import { compileSource, createFreshRuntimeSession } from "../src/index.js";
import { TEASESCRIPT_PROTECTED_TYPE_NAMES } from "../src/language-facts.js";
import {
  validateSerializableValue,
  type SerializableRuntimeValue,
} from "../src/runtime/serializable-values.js";
import {
  describeValue as describeType,
  UNKNOWN_TYPE,
  type StaticType,
} from "../src/static-types.js";
import {
  describeValue,
  hasIdentity,
  VALUE_KIND_NAMES,
  VALUE_KINDS,
  valueKindOf,
  type ValueKind,
} from "../src/value-kinds.js";

// Each kind of value has one entry in `VALUE_KINDS` (IMPLEMENTATION-AND-REVIEW.md, "One home for each language rule").
// These tests check that the compiler and the runtime do with a value of each kind what its entry says, so a new kind
// needs its entry here and in `VALUE_KINDS`, and its implementation wherever an entry's fact is used.

/** A value of each kind as a snapshot holds it. */
const VALUES: Readonly<Record<ValueKind, SerializableRuntimeValue>> = {
  integer: 5,
  number: 2.5,
  string: "a",
  boolean: true,
  duration: { kind: "duration", milliseconds: 2000 },
  calendarDuration: { kind: "calendarDuration", months: 0, days: 1, milliseconds: 0 },
  angle: { kind: "angle", degrees: 90 },
  date: { kind: "date", year: 2026, month: 10, day: 4 },
  time: { kind: "time", hour: 14, minute: 30, second: 0, millisecond: 0 },
  datetime: {
    kind: "datetime",
    year: 2026,
    month: 10,
    day: 4,
    hour: 14,
    minute: 30,
    second: 0,
    millisecond: 0,
  },
  absoluteDateTime: { kind: "absoluteDateTime", epochMilliseconds: 0 },
  script: { kind: "script", path: "main.tease", label: null },
  regex: { kind: "regex", source: "x+", flags: "i" },
  range: { kind: "range", start: 1, end: 3, inclusive: true },
  list: { kind: "list", items: [] },
  set: { kind: "set", items: [] },
  dict: { kind: "dict", entries: [] },
  object: { kind: "object", properties: [] },
  speaker: { kind: "speakerReference", speakerId: 0, identifier: "anna" },
  timer: { kind: "timerHandle", timerId: 1 },
  media: { kind: "mediaHandle", mediaId: 1 },
  camera: { kind: "cameraView" },
  permanentButton: { kind: "permanentButtonHandle", buttonId: 1 },
  messageHandle: { kind: "messageHandle", messageId: 1 },
  null: null,
};

/** The type the compiler gives a value of each kind. */
function typeOf(kind: ValueKind): StaticType {
  if (kind === "list" || kind === "set" || kind === "dict") return { kind, element: UNKNOWN_TYPE };
  if (kind === "object") return { kind, properties: null };
  // EVIDENCE: invariant: a kind the compiler holds as a scalar is a scalar type name, and any other is a type's kind.
  return VALUE_KINDS[kind].type === "scalar"
    ? ({ kind: "scalar", name: kind } as StaticType)
    : ({ kind } as StaticType);
}

/** Declarations that the sources of `SOURCES` read, and `pick`, which hides a value's type from the compiler. */
const SETUP = [
  "speaker anna { }",
  "function pick(value) {\n    return value\n}",
  "let t = timer async 10 s {\n    say 1\n}",
  'let m = playAudio async "a.mp3"',
  "let v = showCamera",
  'let b = showPermanentButton "Press" {\n}',
  'let g = say("hello", 0 s)',
].join("\n");

/** Source that gives a value of each kind, after `SETUP`. */
const SOURCES: Readonly<Record<ValueKind, string>> = {
  integer: "5",
  number: "2.5",
  string: '"a"',
  boolean: "true",
  duration: "2 s",
  calendarDuration: "1 calendar day",
  angle: "90 deg",
  date: 'toDate("2026-10-04")',
  time: 'toTime("14:30")',
  datetime: 'toDateTime("2026-10-04T14:30")',
  absoluteDateTime: 'toAbsoluteDateTime("2026-10-04T12:30:00Z")',
  script: 'script("main.tease")',
  regex: "/x+/i",
  range: "1..3",
  list: "[1]",
  set: "set[]",
  dict: "dict{}",
  object: "{ a: 1 }",
  speaker: "anna",
  timer: "t",
  media: "m",
  camera: "v",
  permanentButton: "b",
  messageHandle: "g",
  null: "null",
};

interface Outcome {
  /** The compile errors, or else the runtime failures, as code and text. */
  readonly problems: readonly (readonly [string, string])[];
  /** What the script said after `SETUP`. */
  readonly said: readonly string[];
  /** Whether the run stopped at an ask. */
  readonly asked: boolean;
}

/** Compiles `body` after `SETUP` and, without errors, runs it; the media loads, and the run stops at an ask. */
function outcome(body: string): Outcome {
  const compiled = compileSource(`${SETUP}\n${body}\nexit`);
  const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (compiled.plan === null || errors.length > 0)
    return { problems: errors.map(({ code, message }) => [code, message]), said: [], asked: false };
  const session = createFreshRuntimeSession(compiled.plan, {
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
  });
  const problems: (readonly [string, string])[] = [];
  const said: string[] = [];
  for (;;) {
    for (const event of session.run().events) {
      if (event.kind === "runtimeFailure") problems.push([event.code, event.message]);
      if (event.kind === "say" && event.text !== "hello") said.push(event.text);
    }
    const action = session.view().foregroundAction;
    if (action?.kind !== "mediaPlayback")
      return { problems, said, asked: action?.kind === "interaction" };
    session.reportMediaLoad(action.mediaId, { kind: "loaded", durationMs: 60_000 });
  }
}

/** The outcome of `body` with a value of `kind` for `X`: written as itself, and through `pick`. */
function outcomes(kind: ValueKind, body: string): readonly [Outcome, Outcome] {
  const value = SOURCES[kind];
  return [outcome(body.replaceAll("X", value)), outcome(body.replaceAll("X", `pick(${value})`))];
}

test("a value of each kind is of its kind, is stored as its entry says, and has its description", () => {
  for (const kind of VALUE_KIND_NAMES) {
    const value = VALUES[kind];
    assert.equal(valueKindOf(value), kind);
    assert.equal(validateSerializableValue(value), null, kind);
    const stored = typeof value === "object" && value !== null ? value.kind : typeof value;
    assert.equal(value === null ? "null" : stored, VALUE_KINDS[kind].stored, kind);
    // Only a type of its kind holds it, and the type `number` holds integers too.
    for (const other of VALUE_KIND_NAMES)
      assert.equal(
        VALUE_KINDS[other].is(value),
        other === kind || (other === "number" && kind === "integer"),
        `${kind} as ${other}`,
      );
    // The compiler describes the type as the runtime describes the value.
    assert.equal(describeValue(value), VALUE_KINDS[kind].description, kind);
    assert.equal(describeType(typeOf(kind)), VALUE_KINDS[kind].description, kind);
  }
});

test("the compiler and the runtime name a value of each kind with one text", () => {
  for (const kind of VALUE_KIND_NAMES) {
    // `sum` takes a list, and names any other value.
    if (kind === "list") continue;
    const [known, unknown] = outcomes(kind, "say sum(X)");
    const message = `sum(...) needs a list, not ${VALUE_KINDS[kind].description}.`;
    assert.equal(known.problems[0]?.[0], "TSV043", kind);
    assert.ok(known.problems[0]![1].startsWith(message), `${kind}: ${known.problems[0]![1]}`);
    assert.deepEqual(unknown.problems, [["TSR059", known.problems[0]![1]]], kind);
  }
});

test("each kind is shown, written as JSON, returned by a button, ordered, a dict key, and saved as its entry says", () => {
  const facts: readonly (readonly [
    fact: string,
    body: string,
    holds: (kind: ValueKind) => boolean,
    shows: "said" | "asked",
  ])[] = [
    ["shown", "say [X].join()", (kind) => VALUE_KINDS[kind].shown !== null, "said"],
    ["JSON", "say toJson(X)", (kind) => VALUE_KINDS[kind].json !== null, "said"],
    [
      "choice",
      'let c = askChoice [{ value: X, text: "pick" }]',
      (kind) => VALUE_KINDS[kind].choice,
      "asked",
    ],
    ["ordered", "say X < X", (kind) => VALUE_KINDS[kind].ordered, "said"],
    ["equal", "say X == X", () => true, "said"],
    [
      "dict key",
      "let d = dict{}\nd[X] = 1\nsay d.length",
      (kind) => VALUE_KINDS[kind].dictKey,
      "said",
    ],
    ["saved", 'save X as "k"\nsay "saved"', (kind) => !hasIdentity(kind), "said"],
  ];
  for (const [fact, body, holds, shows] of facts)
    for (const kind of VALUE_KIND_NAMES)
      for (const [form, result] of outcomes(kind, body).entries()) {
        const where = `${fact} of ${kind}${form === 0 ? "" : " through pick"}`;
        const expected = holds(kind);
        assert.equal(
          result.problems.length === 0,
          expected,
          `${where}: ${JSON.stringify(result.problems)}`,
        );
        if (!expected) continue;
        if (shows === "asked") assert.ok(result.asked, where);
        else assert.equal(result.said.length, 1, where);
        if (fact === "equal") assert.deepEqual(result.said, ["true"], where);
      }
});

test("a case value is a literal of a kind whose entry says it may be one", () => {
  // Each kind that a literal writes; after 'case', an object literal would be the block.
  const literals: readonly (readonly [ValueKind, string])[] = [
    ["integer", "5"],
    ["number", "2.5"],
    ["string", '"a"'],
    ["boolean", "true"],
    ["duration", "2 s"],
    ["calendarDuration", "1 calendar day"],
    ["angle", "90 deg"],
    ["regex", "/x+/i"],
    ["list", "[1]"],
    ["set", "set[1]"],
    ["dict", 'dict{ "a": 1 }'],
    ["speaker", "anna"],
    ["null", "null"],
  ];
  for (const [kind, literal] of literals) {
    const { problems } = outcome(
      `switch pick(1) {\n    case ${literal} {\n        say 1\n    }\n}`,
    );
    assert.equal(
      problems.some(([code]) => code === "TSV047"),
      !VALUE_KINDS[kind].case,
      `${kind}: ${JSON.stringify(problems)}`,
    );
  }
});

test("the protected type names are those of V30 §38", () => {
  assert.deepEqual(
    new Set(TEASESCRIPT_PROTECTED_TYPE_NAMES),
    new Set([
      ...["string", "boolean", "integer", "number", "date", "time", "datetime", "absoluteDateTime"],
      ...["duration", "calendarDuration", "angle", "list", "dict", "object", "range", "media"],
      ...["messageHandle", "script", "regex"],
      // The earlier name stays reserved (ADR 0026).
      "timestamp",
    ]),
  );
});

test("the handles are the kinds with an identity but speakers", () => {
  assert.deepEqual(
    new Set(HANDLE_KINDS),
    new Set(VALUE_KIND_NAMES.filter((kind) => hasIdentity(kind) && kind !== "speaker")),
  );
});
