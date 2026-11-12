import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckpointError,
  RuntimeDataError,
  createRuntimeSession,
  createTaggedRuntimeSession,
  deserializeCheckpoint,
  deserializeRuntimeSession,
  interpreterEventProblem,
  runtimeTimedWork,
  serializeCheckpoint,
  validateRuntimeSnapshot,
  type InstructionPlan,
  type RuntimeSession,
} from "../../../src/index.js";
import { compileValidPlan } from "../../helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "../../helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "../../helpers/runtime-equivalence.js";

// Every record of a runtime snapshot has exactly the fields its revision defines (#1779). An own `__proto__` key is the
// case that matters most: validation used to accept it in some records, and the trusted copy, which assigns each key
// on an ordinary object, then dropped it, so the checked and trusted exports of one state differed.

const UNKNOWN_KEYS = ["__proto__", "unknownField"] as const;
const PROTOTYPE_NAMES = new Set(["__proto__", "constructor", "hasOwnProperty"]);

/** Hides a value from the compiler, so a check reaches the runtime. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}";

interface Scenario {
  readonly source: string;
  readonly ending?: "halted" | "failed";
}

// Small scripts whose instruction boundaries reach every record the snapshot types define outside actions and values:
// globals, speakers and their properties, bindings live and retained, the failure and its span, each loop kind, the
// temporaries of a call and its caller, and a function call frame in each prologue phase with each argument state.
const SCENARIOS: readonly Scenario[] = [
  {
    source: [
      "speaker vera {",
      '    title: "Mistress"',
      "}",
      "global score = 7",
      "function slow(n) {",
      "    wait 1 s",
      "    return n",
      "}",
      "function prologue(first, second = slow(2)) {",
      "    wait 1 s",
      "    return first + second",
      "}",
      'say "${prologue(1)}"',
      'say "${slow(1)} and ${slow(2)}"',
      "for item in [1, 2] {",
      "    wait 1 s",
      "}",
      "for key, value in dict{ a: 1 } {",
      "    wait 1 s",
      "}",
      "repeat 2 {",
      "    wait 1 s",
      "}",
      "let going = true",
      "while going {",
      "    wait 1 s",
      "    going = false",
      "}",
      "if going == false {",
      "    let kept = score",
      '    let t = timer(duration: 1 s, async: true, display: "hidden") { say "${kept}" }',
      "}",
      "wait 2 s",
      "exit",
    ].join("\n"),
  },
  {
    source: [DYNAMIC, "let d = dict{ a: 1 }", "wait 1 s", 'say "${d[dynamic("b")]}"', "exit"].join(
      "\n",
    ),
    ending: "failed",
  },
];

/** The records that accepted unknown keys before #1779, by path and variant, which the scenarios must keep reaching. */
const REQUIRED_RECORDS = [
  "$.rng",
  "$.globals[]",
  "$.frames[].bindings[]",
  "$.retainedScopes[].bindings[]",
  "$.speakers[]",
  "$.speakers[].properties[]",
  "$.failure",
  "$.failure.span",
  "$.failure.span.start",
  "$.failure.span.end",
  "$.loopFrames[] for",
  "$.loopFrames[] for valueVariable",
  "$.loopFrames[] repeat",
  "$.loopFrames[] while",
  "$.temporaries[]",
  "$.callFrames[] function",
  "$.callFrames[].callerTemporaries[]",
  "$.callFrames[].callSiteSpan",
  "$.callFrames[].callSiteSpan.start",
  "$.callFrames[].arguments[] unsupplied",
  "$.callFrames[].arguments[] supplied with value",
  "$.callFrames[].arguments[] supplied and bound",
  "$.callFrames[].parameterState supplied",
  "$.callFrames[].parameterState defaults",
  "$.callFrames[].parameterState body",
];

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every record of a JSON state with its path, array positions written `[]`, visited without recursion. */
function records(root: unknown): Array<{ readonly path: string; readonly value: JsonRecord }> {
  const found: Array<{ readonly path: string; readonly value: JsonRecord }> = [];
  const pending: Array<{ readonly path: string; readonly value: unknown }> = [
    { path: "$", value: root },
  ];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const { path, value } = item;
    if (Array.isArray(value)) {
      for (const nested of value) pending.push({ path: `${path}[]`, value: nested });
    } else if (isRecord(value)) {
      found.push({ path, value });
      for (const [key, nested] of Object.entries(value)) {
        pending.push({ path: `${path}.${key}`, value: nested });
      }
    }
  }
  return found;
}

/** A record's path and the variant that its fields alone do not show. */
function variant(path: string, value: JsonRecord): string {
  if (path === "$.loopFrames[]")
    return `${path} ${String(value.kind)}${"valueVariable" in value ? " valueVariable" : ""}`;
  if (path === "$.callFrames[]")
    return `${path} ${String(value.kind)}${isRecord(value.timerInterruption) ? " block" : ""}`;
  if (path === "$.callFrames[].parameterState") return `${path} ${String(value.phase)}`;
  if (path === "$.callFrames[].arguments[]")
    return `${path} ${value.supplied === false ? "unsupplied" : "value" in value ? "supplied with value" : "supplied and bound"}`;
  return path;
}

/** One mutation target per variant and structural shape: its kind and fields. */
function shapeOf(path: string, value: JsonRecord): string {
  return `${variant(path, value)}|${String(value.kind)}|${Object.keys(value).sort().join(",")}`;
}

function prototypeNamedKeys(snapshot: unknown): string[] {
  return records(snapshot).flatMap(({ value }) =>
    Object.keys(value).filter((key) => PROTOTYPE_NAMES.has(key)),
  );
}

test("validation rejects an own __proto__ or other unknown key on each record of the snapshot", () => {
  const reached = new Set<string>();
  const shapes = new Map<string, { plan: InstructionPlan; json: string; path: string }>();
  for (const scenario of SCENARIOS) {
    const plan = compileValidPlan(scenario.source);
    const { boundaries } = assertRuntimeResumeEquivalent(scenario.source, {
      ...(scenario.ending === undefined ? {} : { ending: scenario.ending }),
      seed: 5,
    });
    for (const boundary of boundaries) {
      const json = JSON.stringify(boundary);
      for (const { path, value } of records(JSON.parse(json))) {
        reached.add(variant(path, value));
        const shape = shapeOf(path, value);
        if (!shapes.has(shape)) shapes.set(shape, { plan, json, path });
      }
    }
  }
  for (const record of REQUIRED_RECORDS) assert.ok(reached.has(record), `not reached: ${record}`);

  for (const [shape, { plan, json, path }] of shapes) {
    for (const key of UNKNOWN_KEYS) {
      const state: unknown = JSON.parse(json);
      const target = records(state).find(
        (record) => record.path === path && shapeOf(path, record.value) === shape,
      )!;
      // As `JSON.parse` makes it from text: an own property, not the prototype.
      Object.defineProperty(target.value, key, {
        value: { probe: 1 },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      // The helper validated this boundary as it is, so the added key is what fails it.
      assert.equal(validateRuntimeSnapshot(state, plan).valid, false, `${key} in ${shape}`);
    }
  }
});

test("a restored snapshot with an own __proto__ in its RNG state fails at every restore", () => {
  const plan = compileValidPlan("wait 1 s\nexit");
  const session = createRuntimeSession(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { seed: 5 }),
  );
  session.run();
  const tagged = session.exportTaggedSnapshot();
  const checkpoint = serializeCheckpoint(session.exportCheckpoint());
  const rng = '"rng":{"algorithm":"xorshift32-v1","state":5}';
  assert.ok(tagged.json.includes(rng) && checkpoint.includes(rng));
  const message = "Runtime RNG state is malformed or unsupported.";

  // The unedited texts restore with one JSON for every export.
  for (const restored of [
    createRuntimeSession(plan, JSON.parse(tagged.json)),
    deserializeRuntimeSession(checkpoint),
    createTaggedRuntimeSession(plan, tagged),
  ]) {
    const checked = JSON.stringify(restored.exportSnapshot());
    assert.equal(checked, tagged.json);
    assert.equal(JSON.stringify(restored.exportTrustedSnapshot()), checked);
    assert.equal(restored.exportTaggedSnapshot().json, checked);
  }

  for (const field of ['"__proto__":{"probe":1}', '"unknownField":1']) {
    const edited = (text: string) =>
      text.replace(rng, `"rng":{"algorithm":"xorshift32-v1","state":5,${field}}`);
    const isRuntimeDataError = (error: unknown) => {
      assert.ok(error instanceof RuntimeDataError, field);
      assert.equal(error.code, "TSR101", field);
      assert.match(error.message, new RegExp(message.replace(/\./gu, "\\.")), field);
      return true;
    };
    assert.throws(
      () => createRuntimeSession(plan, JSON.parse(edited(tagged.json))),
      isRuntimeDataError,
    );
    // A tag that does not match its JSON sends the JSON through validation.
    assert.throws(
      () => createTaggedRuntimeSession(plan, { json: edited(tagged.json), tag: tagged.tag }),
      isRuntimeDataError,
    );
    const isCheckpointError = (error: unknown) => {
      assert.ok(error instanceof CheckpointError, field);
      assert.equal(error.info.code, "TSK002", field);
      assert.match(error.info.message, new RegExp(message.replace(/\./gu, "\\.")), field);
      return true;
    };
    assert.throws(() => deserializeRuntimeSession(edited(checkpoint)), isCheckpointError);
    assert.throws(() => deserializeCheckpoint(edited(checkpoint)), isCheckpointError);
  }

  // Persisted interpreter events check their spans with the same rule.
  const events = [
    ...session.observeTime(runtimeTimedWork(session.view())[0]!.deadlineMs).events,
    ...session.run().events,
  ];
  const exit = events.find((event) => event.kind === "exit");
  assert.ok(exit !== undefined);
  assert.equal(interpreterEventProblem(JSON.parse(JSON.stringify(exit))), null);
  const edited: unknown = JSON.parse(
    JSON.stringify(exit).replace('"span":{', '"span":{"__proto__":{"probe":1},'),
  );
  assert.notEqual(interpreterEventProblem(edited), null);
});

test("script data named like JavaScript object members stays values through save and restore", () => {
  // Speaker and record properties, dict keys written and computed from stored text, a parameter, a variable, a
  // function and storage keys: each name is a string in the state, never a JavaScript object key.
  const source = [
    "speaker vera {",
    '    __proto__: "speaker proto"',
    '    constructor: "speaker maker"',
    "}",
    "global prototype = 1",
    "let constructor = 2",
    "function hasOwnProperty(__proto__) {",
    "    return __proto__ + 1",
    "}",
    'let record = { __proto__: "record proto", constructor: "record maker" }',
    'let table = dict{ __proto__: "dict proto", ["constructor"]: "dict maker" }',
    'let stored = load "__proto__", default: "none"',
    "table[stored] = stored",
    'save table as "constructor"',
    "wait 1 s",
    'say "${record.__proto__} ${table[stored]} ${hasOwnProperty(constructor)} ${vera.__proto__}"',
    "exit",
  ].join("\n");
  // The helper restores every instruction boundary and requires equal checked, trusted and tagged JSON, equal
  // checkpoint round trips, and the uninterrupted run's events and final state from each.
  const { boundaries, events } = assertRuntimeResumeEquivalent(source, {
    scriptStorage: [{ key: "__proto__", value: "constructor" }],
  });
  assert.deepEqual(
    events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["record proto constructor 3 speaker proto"],
  );
  for (const boundary of boundaries) assert.deepEqual(prototypeNamedKeys(boundary), []);

  // The player's answer as a dict key and a property value.
  const plan = compileValidPlan(
    [
      'let answer = askText "Name?"',
      "let table = dict{ seen: answer }",
      "table[answer] = answer",
      "let record = { name: answer }",
      "wait 1 s",
      'say "${table[answer]} ${record.name}"',
      "say table.keys",
      "exit",
    ].join("\n"),
  );
  const session = createRuntimeSession(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { seed: 5 }),
  );
  session.run();
  const action = session.view().foregroundAction;
  assert.ok(action?.kind === "interaction");
  session.completeAction({
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: action.interactionKind,
    payload: { kind: "submittedText", submittedText: "__proto__" },
  });
  session.run();
  const checked = JSON.stringify(session.exportSnapshot());
  assert.equal(JSON.stringify(session.exportTrustedSnapshot()), checked);
  assert.equal(session.exportTaggedSnapshot().json, checked);
  assert.deepEqual(prototypeNamedKeys(JSON.parse(checked)), []);
  const restored = deserializeRuntimeSession(serializeCheckpoint(session.exportCheckpoint()));
  const finish = (played: RuntimeSession) => {
    const observed = played.observeTime(runtimeTimedWork(played.view())[0]!.deadlineMs);
    return {
      events: [...observed.events, ...played.run().events],
      json: JSON.stringify(played.exportSnapshot()),
    };
  };
  const continued = finish(session);
  assert.deepEqual(finish(restored), continued);
  assert.deepEqual(
    continued.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["__proto__ __proto__", '["seen", "__proto__"]'],
  );
  assert.equal(session.view().status, "halted");
  assert.equal(restored.view().status, "halted");
});
