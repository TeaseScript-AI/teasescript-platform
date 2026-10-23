import assert from "node:assert/strict";
import test from "node:test";

import { HANDLE_KINDS } from "../src/handle-members.js";
import { compileProject, createFreshRuntimeSession } from "../src/index.js";
import { TEASESCRIPT_PROTECTED_TYPE_NAMES } from "../src/language-facts.js";
import {
  cloneCapturedSerializableValue,
  serializableEquals,
  validateSerializableValue,
  type SerializableRuntimeValue,
} from "../src/runtime/values/serializable-values.js";
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
// These tests check what the compiler and the runtime do with a value of each kind against what V30 states, so a new
// kind needs its expectations here, its entry in `VALUE_KINDS`, and its implementation wherever an entry's fact is used.

/** What the language does with a value of a kind, as `EXPECTED` lists it. */
type Fact = "shown" | "notation" | "json" | "choice" | "ordered" | "dictKey" | "saved" | "case";

/**
 * Each kind's description, and what V30 lets a script do with a value of it: show it with `${...}` and `join()` (§8),
 * where `say` shows a script reference and a regex in their notation, write it with `toJson` (§13), give it to a button as its value (§26), order it with `<` (§5, §35), use it as a dict key
 * (§40), save it (§25), and write it as a `case` value (§32).
 */
const EXPECTED: Readonly<Record<ValueKind, readonly [description: string, ...facts: Fact[]]>> = {
  integer: ["a whole number (integer)", "shown", "json", "choice", "ordered", "saved", "case"],
  number: ["a number", "shown", "json", "choice", "ordered", "saved", "case"],
  string: ["text (string)", "shown", "json", "choice", "ordered", "dictKey", "saved", "case"],
  boolean: ["true or false (boolean)", "shown", "json", "choice", "saved", "case"],
  duration: ["a duration", "shown", "json", "choice", "ordered", "saved", "case"],
  calendarDuration: ["a calendar duration", "shown", "choice", "ordered", "saved", "case"],
  angle: ["an angle", "shown", "json", "choice", "ordered", "saved", "case"],
  date: ["a date", "shown", "json", "choice", "ordered", "saved"],
  time: ["a time", "shown", "json", "choice", "ordered", "saved"],
  datetime: ["a date and time", "shown", "json", "choice", "ordered", "saved"],
  absoluteDateTime: ["an absolute date and time", "shown", "json", "choice", "ordered", "saved"],
  script: ["a script reference", "shown", "notation", "saved"],
  regex: ["a regex", "shown", "notation", "saved"],
  range: ["a range", "saved"],
  list: ["a list", "json", "saved"],
  set: ["a set", "json", "saved"],
  dict: ["a dict", "json", "saved"],
  object: ["an object", "json", "saved"],
  speaker: ["a speaker", "json", "case"],
  timer: ["a timer handle"],
  media: ["a media handle"],
  camera: ["a camera view"],
  permanentButton: ["a permanent button"],
  messageHandle: ["a message handle"],
  null: ["null", "shown", "json", "choice", "saved", "case"],
};

function holds(kind: ValueKind, fact: Fact): boolean {
  const [, ...facts] = EXPECTED[kind];
  return facts.includes(fact);
}

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
  script: { kind: "script", path: "main.tease" },
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
  /** Whether the problems are compile errors. */
  readonly compiled: boolean;
  /** What the script said after `SETUP`. */
  readonly said: readonly string[];
  /** Whether the run stopped at an ask. */
  readonly asked: boolean;
}

/**
 * Compiles `body` after `SETUP`, as `main.tease` beside the empty `files` of a project, and, without errors, runs it; the
 * media loads, and the run stops at an ask.
 */
function outcome(body: string, files: readonly string[] = []): Outcome {
  const compiled = compileProject([
    { path: "main.tease", source: `${SETUP}\n${body}\nexit` },
    ...files.map((path) => ({ path, source: "exit" })),
  ]);
  const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (compiled.plan === null || errors.length > 0)
    return {
      problems: errors.map(({ code, message }) => [code, message]),
      compiled: true,
      said: [],
      asked: false,
    };
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
      return { problems, compiled: false, said, asked: action?.kind === "interaction" };
    session.reportMediaLoad(action.mediaId, { kind: "loaded", durationMs: 60_000 });
  }
}

/** The outcome of `body` with a value of `kind` for `X`: written as itself, and through `pick`. */
function outcomes(kind: ValueKind, body: string): readonly [Outcome, Outcome] {
  const value = SOURCES[kind];
  return [outcome(body.replaceAll("X", value)), outcome(body.replaceAll("X", `pick(${value})`))];
}

test("a value of each kind is of its kind, is stored as its entry says, and has one description", () => {
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
    assert.equal(describeValue(value), EXPECTED[kind][0], kind);
    assert.equal(describeType(typeOf(kind)), EXPECTED[kind][0], kind);
  }
});

/** The stored kinds whose values hold other values, which a copy must not share. */
const CONTAINERS: ReadonlySet<unknown> = new Set(["list", "set", "object", "dict"]);

/**
 * Checks without recursion that `copy` has the shape and scalars of `source`, and that none of its arrays, containers,
 * dict entries, or object properties is one of `source`'s, so changing either cannot change the other.
 */
function assertDetachedCopy(
  source: SerializableRuntimeValue,
  copy: SerializableRuntimeValue,
  where: string,
): void {
  const mutable = new Set<object>();
  const pending: unknown[] = [source];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null) continue;
    // A dict entry and an object property have no kind.
    if (Array.isArray(current) || !("kind" in current) || CONTAINERS.has(current.kind))
      mutable.add(current);
    for (const part of Object.values(current)) pending.push(part);
  }
  const pairs: (readonly [unknown, unknown])[] = [[source, copy]];
  while (pairs.length > 0) {
    const [original, copied] = pairs.pop()!;
    if (typeof original !== "object" || original === null) {
      assert.ok(Object.is(copied, original), where);
      continue;
    }
    assert.ok(typeof copied === "object" && copied !== null && !mutable.has(copied), where);
    assert.equal(Array.isArray(copied), Array.isArray(original), where);
    assert.deepEqual(Object.keys(copied), Object.keys(original), where);
    // The keys are the same and in the same order, so the parts pair up by position.
    const copiedParts = Object.values(copied);
    for (const [index, part] of Object.values(original).entries())
      pairs.push([part, copiedParts[index]]);
  }
}

test("a copy of a value of each kind, alone, in each container, and deep inside containers, equals it and shares no container", () => {
  const values = VALUE_KIND_NAMES.map((kind) => VALUES[kind]);
  const containers: SerializableRuntimeValue[] = [
    { kind: "list", items: values },
    { kind: "set", items: values },
    { kind: "object", properties: VALUE_KIND_NAMES.map((name) => ({ name, value: VALUES[name] })) },
    { kind: "dict", entries: VALUE_KIND_NAMES.map((key) => ({ key, value: VALUES[key] })) },
  ];
  // 20,000 levels, which the copy reaches without recursion: each kind of container in turn, beside a scalar and a handle.
  let deep: SerializableRuntimeValue = { kind: "list", items: values };
  for (let depth = 0; depth < 20_000; depth += 1) {
    const parts: SerializableRuntimeValue[] = [depth, VALUES.timer, deep];
    if (depth % 4 === 0) deep = { kind: "list", items: parts };
    else if (depth % 4 === 1) deep = { kind: "set", items: parts };
    else if (depth % 4 === 2)
      deep = {
        kind: "object",
        properties: parts.map((value, index) => ({ name: `p${index}`, value })),
      };
    else
      deep = { kind: "dict", entries: parts.map((value, index) => ({ key: `k${index}`, value })) };
  }
  const cases: (readonly [string, SerializableRuntimeValue])[] = [
    ...VALUE_KIND_NAMES.map((kind) => [kind, VALUES[kind]] as const),
    ...containers.map((value, index) => [`container ${index}`, value] as const),
    ["containers in a list", { kind: "list", items: containers }],
  ];
  for (const [where, value] of cases) {
    const copy = cloneCapturedSerializableValue(value);
    // A copied speaker or handle names the same speaker or record, so it is `==` to the original.
    assert.ok(serializableEquals(copy, value), where);
    assertDetachedCopy(value, copy, where);
  }
  assertDetachedCopy(deep, cloneCapturedSerializableValue(deep), "deep");
});

test("the compiler and the runtime name a value of each kind with one text", () => {
  for (const kind of VALUE_KIND_NAMES) {
    // `sum` takes a list, and names any other value.
    if (kind === "list") continue;
    const [known, unknown] = outcomes(kind, "say sum(X)");
    const message = `sum(...) needs a list, not ${EXPECTED[kind][0]}.`;
    assert.equal(known.problems[0]?.[0], "TSV043", kind);
    assert.ok(known.problems[0]![1].startsWith(message), `${kind}: ${known.problems[0]![1]}`);
    assert.deepEqual(unknown.problems, [["TSR059", known.problems[0]![1]]], kind);
  }
});

test("a value of each kind is shown, written as JSON, returned by a button, ordered, a dict key, and saved as V30 says", () => {
  // Every value equals itself, also as a set's member, which is unique by `==`.
  const checks: readonly (readonly [
    fact: Fact | "equal" | "member",
    body: string,
    shows: "said" | "asked",
  ])[] = [
    ["shown", "say [X].join()", "said"],
    ["json", "say toJson(X)", "said"],
    ["choice", 'let c = askChoice [{ value: X, text: "pick" }]', "asked"],
    ["ordered", "say X < X", "said"],
    ["equal", "say X == X", "said"],
    ["member", "say set[X, X].length", "said"],
    ["dictKey", "let d = dict{}\nd[X] = 1\nsay d.length", "said"],
    ["saved", 'save X as "k"\nsay "saved"', "said"],
  ];
  for (const [fact, body, shows] of checks)
    for (const kind of VALUE_KIND_NAMES)
      for (const [form, result] of outcomes(kind, body).entries()) {
        const where = `${fact} of ${kind}${form === 0 ? "" : " through pick"}`;
        const expected = fact === "equal" || fact === "member" || holds(kind, fact);
        assert.equal(
          result.problems.length === 0,
          expected,
          `${where}: ${JSON.stringify(result.problems)}`,
        );
        // The compiler rejects a value it knows, and the runtime one it does not know.
        if (!expected) {
          assert.equal(result.compiled, form === 0, where);
          continue;
        }
        if (shows === "asked") assert.ok(result.asked, where);
        else assert.equal(result.said.length, 1, where);
        if (fact === "equal") assert.deepEqual(result.said, ["true"], where);
        if (fact === "member") assert.deepEqual(result.said, ["1"], where);
      }
});

test("values of one family order, and values of two do not", () => {
  const ordered = VALUE_KIND_NAMES.filter((kind) => holds(kind, "ordered"));
  const numbers: readonly ValueKind[] = ["integer", "number"];
  for (const left of ordered)
    for (const right of ordered) {
      const body = `say pick(${SOURCES[left]}) < pick(${SOURCES[right]})`;
      const expected = left === right || (numbers.includes(left) && numbers.includes(right));
      assert.equal(outcome(body).problems.length === 0, expected, body);
    }
});

test("say shows a script reference and a regex as their notation, and any other shown value as its text", () => {
  // Each holds a markup character, which `${...}` reads as markup, while `say` shows a notation as it is.
  const cases: readonly (readonly [kind: ValueKind, source: string, files: readonly string[]])[] = [
    ["script", 'script("a`b`.tease")', ["a`b`.tease"]],
    ["regex", "/a\\*/", []],
    ["string", '"a`b`"', []],
  ];
  for (const [kind, source, files] of cases) {
    const { problems, said } = outcome(`say pick(${source})\nsay "\${pick(${source})}"`, files);
    assert.deepEqual(problems, [], kind);
    assert.equal(said.length, 2, kind);
    if (holds(kind, "notation")) {
      assert.equal(said[0], source, kind);
      assert.notEqual(said[1], source, kind);
    } else assert.equal(said[0], said[1], kind);
  }
});

test("a case value is a literal of a kind that V30 lets a case be", () => {
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
      !holds(kind, "case"),
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
