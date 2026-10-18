import assert from "node:assert/strict";
import test from "node:test";

import { HANDLE_KINDS, HANDLE_MEMBERS, type HandleKind } from "../src/handle-members.js";
import {
  DURATION_TYPE,
  INTEGER_TYPE,
  NULL_TYPE,
  optional,
  STRING_TYPE,
  union,
} from "../src/static-types.js";
import { memberOf, operationRelations } from "../src/type-inference/adapters/index.js";
import type { OperandView, OperationRelation } from "../src/type-inference/adapters/relation.js";
import { INVALID } from "../src/type-inference/adapters/views.js";
import {
  assertCase,
  BOTTOM_VIEW,
  closedView,
  dynamicView,
  inputsOf,
  legacyOperation,
  type AdapterExpectation,
  type LegacyExpectation,
} from "./helpers/adapter-parity.js";

/**
 * Parity of the members of handles with the legacy checker (work note §5.4, §6.3): every property and method of
 * `HANDLE_MEMBERS` on a receiver of each kind of handle, with and without arguments, the handles a source makes, and
 * handles among other kinds of a receiver, which `members.ts` composes.
 */
function method(name: string) {
  const relation = operationRelations().relation({ family: "method", name });
  assert.ok(relation !== undefined, `a relation for method.${name}`);
  return relation;
}

/** A property read, for parity with the legacy's fact: the member's answer; a member the kind does not have is none. */
function assertProperty(
  kind: HandleKind,
  name: string,
  receiver: OperandView,
  source: string,
  legacy: LegacyExpectation,
  adapter: AdapterExpectation,
): void {
  const answer = memberOf(kind, name, receiver);
  assert.ok(answer?.kind !== "held", "a handle's property is computed when it is read");
  if (adapter === "invalid") assert.equal(answer, undefined, `no member ${name} of ${kind}`);
  const read: OperationRelation = {
    contract: { family: "method", name },
    result: () => answer ?? INVALID,
  };
  assertCase(read, inputsOf({ receiver }), legacyOperation(source), legacy, adapter);
}

/** A handle of each kind, as `let a` declares it. */
const DECLARATIONS: Readonly<Record<HandleKind, string>> = {
  timer: "let a: timer = hostValue",
  media: "let a: media = hostValue",
  camera: "let a = showCamera",
  messageHandle: "let a: messageHandle = hostValue",
  permanentButton: 'let a = showPermanentButton "B" { }',
};

/** The code each kind reports a member it does not have with. */
const CODES: Readonly<Record<HandleKind, string>> = {
  timer: "TSV034",
  media: "TSV037",
  camera: "TSV059",
  messageHandle: "TSV043",
  permanentButton: "TSV043",
};

/** Each property's fact on the kinds that have it. */
const PROPERTIES: Readonly<Record<string, Partial<Record<HandleKind, string>>>> = {
  remaining: { timer: "duration", media: "(duration|null)" },
  elapsed: { timer: "duration", media: "duration" },
  display: { timer: "string" },
  label: { timer: "(null|string)" },
  state: { timer: "string", media: "string" },
  repeatDuration: { timer: "(duration|null)" },
  position: { media: "duration" },
  duration: { media: "(duration|null)" },
  volume: { media: "number" },
  placement: { camera: "string" },
  text: { messageHandle: "string" },
  // A property of text, and one no value has.
  length: {},
  foo: {},
};

/** The kinds that have each method, which gives null. */
const METHODS: Readonly<Record<string, readonly HandleKind[]>> = {
  pause: ["timer", "media"],
  resume: ["timer", "media"],
  stop: ["timer", "media"],
  remove: ["messageHandle", "permanentButton"],
  // A timer form's word, a method of text, and one no value has.
  cancel: [],
  trim: [],
  foo: [],
};

test("the tables cover every property and method of the contracts", () => {
  for (const kind of HANDLE_KINDS) {
    assert.deepEqual(
      Object.keys(HANDLE_MEMBERS[kind].properties).sort(),
      Object.keys(PROPERTIES)
        .filter((name) => PROPERTIES[name]![kind] !== undefined)
        .sort(),
      `the properties of ${kind}`,
    );
    assert.deepEqual(
      Object.keys(HANDLE_MEMBERS[kind].methods).sort(),
      Object.keys(METHODS)
        .filter((name) => METHODS[name]!.includes(kind))
        .sort(),
      `the methods of ${kind}`,
    );
  }
});

test("a handle's property is computed from the state it names, also null where it is nullable", () => {
  for (const [name, facts] of Object.entries(PROPERTIES))
    for (const kind of HANDLE_KINDS) {
      const fact = facts[kind];
      const source = `${DECLARATIONS[kind]}\nlet r = a.${name}\nexit`;
      if (fact !== undefined)
        assertProperty(kind, name, closedView({ kind }), source, { fact }, "fact");
      else
        assertProperty(
          kind,
          name,
          closedView({ kind }),
          source,
          { fact: "unknown", errors: [CODES[kind]] },
          "invalid",
        );
    }
  assert.deepEqual(memberOf("timer", "label", closedView({ kind: "timer" })), {
    kind: "type",
    type: optional(STRING_TYPE),
  });
});

test("every method of a handle gives null, also when the visitor reports its arguments", () => {
  for (const [name, kinds] of Object.entries(METHODS))
    for (const kind of HANDLE_KINDS) {
      const inputs = inputsOf({ receiver: closedView({ kind }) });
      const source = `${DECLARATIONS[kind]}\nlet r = a.${name}()\nexit`;
      if (kinds.includes(kind))
        assertCase(method(name), inputs, legacyOperation(source), { fact: "null" }, "fact", "type");
      else
        assertCase(
          method(name),
          inputs,
          legacyOperation(source),
          { fact: "unknown", errors: [CODES[kind]] },
          "invalid",
        );
    }
  for (const name of ["pause", "stop", "remove"])
    for (const kind of HANDLE_KINDS) {
      const inputs = inputsOf({
        receiver: closedView({ kind }),
        arguments: [closedView(INTEGER_TYPE)],
      });
      const source = `${DECLARATIONS[kind]}\nlet r = a.${name}(1)\nexit`;
      assertCase(
        method(name),
        inputs,
        legacyOperation(source),
        METHODS[name]!.includes(kind)
          ? { fact: "null", errors: [CODES[kind]] }
          : { fact: "unknown", errors: [CODES[kind]] },
        METHODS[name]!.includes(kind) ? "fact" : "invalid",
      );
    }
});

test("the handles a source makes have the members of their kind", () => {
  assertProperty(
    "timer",
    "label",
    closedView({ kind: "timer" }),
    'let t = timer async 10 s "Clock"\nlet r = t.label\nexit',
    { fact: "(null|string)" },
    "fact",
  );
  assertProperty(
    "media",
    "state",
    closedView({ kind: "media" }),
    'let t = playAudio async "a.mp3"\nlet r = t.state\nexit',
    { fact: "string" },
    "fact",
  );
  assertProperty(
    "messageHandle",
    "text",
    closedView({ kind: "messageHandle" }),
    'let t = say("Hi", instant)\nlet r = t.text\nexit',
    { fact: "string" },
    "fact",
  );
  assertCase(
    method("remove"),
    inputsOf({ receiver: closedView({ kind: "messageHandle" }) }),
    legacyOperation('let t = say("Hi", instant)\nlet r = t.remove()\nexit'),
    { fact: "null" },
    "fact",
  );
});

test("a handle among the kinds of a receiver: every kind must have the method", () => {
  assertCase(
    method("pause"),
    inputsOf({ receiver: closedView(union([{ kind: "timer" }, { kind: "media" }])) }),
    legacyOperation("let a: timer | media = hostValue\nlet r = a.pause()\nexit"),
    { fact: "null" },
    "fact",
    "byReceiver",
  );
  assertCase(
    method("remove"),
    inputsOf({
      receiver: closedView(
        union([{ kind: "messageHandle" }, { kind: "list", element: INTEGER_TYPE }]),
      ),
    }),
    legacyOperation("let a: messageHandle | integer[] = hostValue\nlet r = a.remove()\nexit"),
    { fact: "null" },
    "fact",
    "byReceiver",
  );
  for (const [annotation, name, view] of [
    [
      "timer | messageHandle",
      "stop",
      closedView(union([{ kind: "timer" }, { kind: "messageHandle" }])),
    ],
    ["timer?", "pause", closedView(optional({ kind: "timer" }))],
  ] as const)
    assertCase(
      method(name),
      inputsOf({ receiver: view }),
      legacyOperation(`let a: ${annotation} = hostValue\nlet r = a.${name}()\nexit`),
      { fact: "unknown", errors: ["TSV043"] },
      "invalid",
    );
  // A speaker beside a timer: the runtime checks the speaker; the legacy's unknown without an error.
  assertCase(
    method("stop"),
    inputsOf({ receiver: closedView(union([{ kind: "speaker" }, { kind: "timer" }])) }),
    legacyOperation(
      'speaker guide {\n displayName: "G"\n}\nlet a: speaker | timer = hostValue\nlet r = a.stop()\nexit',
    ),
    { fact: "unknown" },
    { realized: "unknown" },
    "byReceiver",
  );
  assertCase(
    method("pause"),
    inputsOf({ receiver: dynamicView("host") }),
    legacyOperation("let r = hostValue.pause()\nexit"),
    { fact: "unknown" },
    { dynamic: "host" },
  );
  // A property of a receiver of several kinds is composed by stage 3's resolver: each kind answers alone.
  const either = closedView(union([{ kind: "timer" }, { kind: "media" }]));
  assertProperty(
    "media",
    "remaining",
    either,
    "let a: timer | media = hostValue\nlet r = a.remaining\nexit",
    { fact: "(duration|null)" },
    "fact",
  );
  assert.deepEqual(memberOf("timer", "remaining", either), { kind: "type", type: DURATION_TYPE });
});

test("a relation answers from its inputs alone: bottom waits, a dynamic remainder is kept", () => {
  const pause = method("pause");
  assert.equal(pause.result(inputsOf({ receiver: BOTTOM_VIEW })).kind, "unconstrained");
  assert.deepEqual(pause.result(inputsOf({ receiver: closedView({ kind: "timer" }) })), {
    kind: "type",
    type: NULL_TYPE,
  });
  assert.equal(pause.result(inputsOf({ receiver: BOTTOM_VIEW })).kind, "unconstrained");
  assert.deepEqual(pause.result(inputsOf({ receiver: dynamicView("host", [{ kind: "media" }]) })), {
    kind: "alternatives",
    results: [
      { kind: "type", type: NULL_TYPE },
      { kind: "dynamic", why: "host" },
    ],
  });
});
