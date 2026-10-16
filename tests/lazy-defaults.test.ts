import assert from "node:assert/strict";
import test from "node:test";

import {
  compileSource,
  completeAction,
  createCheckpoint,
  deserializeCheckpoint,
  run,
  serializeCheckpoint,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/index.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

/*
 * Every `default:` runs only when it is used (owner decision, 2026-10-16): a list's or dict's `get` for a position or
 * key it does not have, a conversion for a value it cannot convert, and `toRegex`, `fromBase64`, and `fromJson` for
 * text that does not read; `fileFromBase64` is in stored-files.test.ts. The default runs after the call's own work,
 * whether it is an expression or runs instructions, such as a call, a wait, or an ask.
 */

/** A call that needs its default, and one that does not, with what each says. */
interface Construct {
  readonly name: string;
  /** The calls, with `@` for the default. */
  readonly used: string;
  readonly unused: string;
  /** What `say` shows for the call that does not need its default. */
  readonly found: string;
  /** A default of the call's type, as source and as `say` shows it. */
  readonly fallback: readonly [string, string];
}

const CONSTRUCTS: readonly Construct[] = [
  {
    name: "list get",
    used: "names.get(5, default: @)",
    unused: "names.get(0, default: @)",
    found: "a",
    fallback: ['"x"', "x"],
  },
  {
    name: "dict get",
    used: 'ages.get("kim", default: @)',
    unused: 'ages.get("sam", default: @)',
    found: "3",
    fallback: ["0", "0"],
  },
  {
    name: "toNumber",
    used: 'toNumber(same("five"), default: @)',
    unused: 'toNumber("5", default: @)',
    found: "5",
    fallback: ["0", "0"],
  },
  {
    name: "toInteger",
    used: 'toInteger(same("five"), default: @)',
    unused: 'toInteger("5.5", default: @)',
    found: "5",
    fallback: ["0", "0"],
  },
  {
    name: "toBoolean",
    used: 'toBoolean(same("yes"), default: @)',
    unused: 'toBoolean("true", default: @)',
    found: "true",
    fallback: ["false", "false"],
  },
  {
    name: "toDate",
    used: 'toDate(same("soon"), default: @)',
    unused: 'toDate("2026-10-16", default: @)',
    found: "2026-10-16",
    fallback: ['toDate("2020-01-01")', "2020-01-01"],
  },
  {
    name: "toRegex",
    used: 'toRegex(same("("), default: @)',
    unused: 'toRegex("a+", default: @)',
    found: "/a+/",
    fallback: ["/b/", "/b/"],
  },
  {
    name: "fromBase64",
    used: 'fromBase64(same("!!"), default: @)',
    unused: 'fromBase64("aGk=", default: @)',
    found: "hi",
    fallback: ['"b"', "b"],
  },
  {
    name: "fromJson without files",
    used: 'fromJson(same("{"), default: @, files: false)',
    unused: 'fromJson("1", default: @, files: false)',
    found: "1",
    fallback: ["2", "2"],
  },
  {
    name: "fromJson",
    used: 'fromJson(same("{"), default: @)',
    unused: 'fromJson("1", default: @)',
    found: "1",
    fallback: ["2", "2"],
  },
];

const SETUP = [
  "function same(value) {",
  "    return value",
  "}",
  "function note(value) {",
  '    say "default"',
  "    return value",
  "}",
  "function slow(value) {",
  "    wait 1 s",
  '    say "default"',
  "    return value",
  "}",
  'let names = ["a"]',
  "let ages = dict{ sam: 3 }",
  'let nine = load("nine", default: 9)',
];

const withDefault = (call: string, fallback: string): string => call.replace("@", fallback);

test("a default that calls a function runs only when the call needs it, after the call's own work", () => {
  for (const { name, used, unused, found, fallback } of CONSTRUCTS) {
    const call = `note(${fallback[0]})`;
    const result = runValidSource(
      [...SETUP, `say ${withDefault(unused, call)}`, `say ${withDefault(used, call)}`, "exit"].join(
        "\n",
      ),
    );
    assert.equal(result.snapshot.failure, null, name);
    assert.deepEqual(sayTexts(result), [found, "default", fallback[1]], name);
  }
});

test("a default expression runs only when the call needs it", () => {
  for (const { name, used, unused, found, fallback } of CONSTRUCTS) {
    // Reading index 9 of a list of one element fails, so the default fails where it runs.
    const failing = `[${fallback[0]}][nine]`;
    const source = [
      ...SETUP,
      `say ${withDefault(unused, failing)}`,
      `say ${withDefault(used, failing)}`,
      "exit",
    ].join("\n");
    const result = runValidSource(source);
    assert.deepEqual(sayTexts(result), [found], name);
    assert.equal(result.snapshot.failure?.code, "TSR025", name);
    const usedLine = source.split("\n").length - 2;
    assert.deepEqual(
      [result.snapshot.failure?.span.start.line, result.snapshot.failure?.span.start.column],
      [usedLine, source.split("\n")[usedLine]!.indexOf(failing) + failing.indexOf("nine")],
      name,
    );
  }
});

test("a default that waits runs only when the call needs it and resumes from every checkpoint", () => {
  for (const { name, used, unused, found, fallback } of CONSTRUCTS) {
    const call = `slow(${fallback[0]})`;
    const result = assertRuntimeResumeEquivalent(
      [...SETUP, `say ${withDefault(unused, call)}`, `say ${withDefault(used, call)}`, "exit"].join(
        "\n",
      ),
      { scenarioName: name },
    );
    assert.deepEqual(
      result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
      [found, "default", fallback[1]],
      name,
    );
  }
});

/** Runs until the script waits for an ask, through an exported and restored checkpoint. */
function restoredAtAsk(plan: InstructionPlan, snapshot: RuntimeSnapshot): RuntimeSnapshot {
  assert.deepEqual(validateRuntimeSnapshot(snapshot, plan).errors, []);
  const json = serializeCheckpoint(createCheckpoint(plan, snapshot));
  const restored = deserializeCheckpoint(json);
  assert.equal(serializeCheckpoint(restored), json);
  return restored.snapshot;
}

test("an ask in a default asks only when the call needs it, and resumes from a checkpoint while it waits", () => {
  const source = [
    'let names: string[] = load("names", default: [])',
    "let ages = dict{ sam: 3 }",
    'let name = names.get(0, default: askText "Your name?")',
    'let age = ages.get(name, default: askNumber "Your age?")',
    'say "${name} ${age}"',
    "exit",
  ].join("\n");
  const plan = compileValidPlan(source);
  // A list with an element and a dict with the key ask nothing.
  const known = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, {
      scriptStorage: [{ key: "names", value: { kind: "list", items: ["sam"] } }],
    }),
  );
  assert.equal(known.snapshot.status, "halted");
  assert.deepEqual(sayTexts(known), ["sam 3"]);

  let result = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  const answers = [
    { interactionKind: "text", payload: { kind: "submittedText", submittedText: "Ada" } },
    { interactionKind: "number", payload: { kind: "submittedText", submittedText: "41" } },
  ] as const;
  for (const answer of answers) {
    const snapshot = restoredAtAsk(plan, result.snapshot);
    const action = snapshot.foregroundAction;
    assert.ok(action?.kind === "interaction" && action.interactionKind === answer.interactionKind);
    const completed = completeAction(plan, snapshot, {
      actionId: action.actionId,
      actionKind: "interaction",
      ...answer,
    });
    assert.equal(completed.outcome.kind, "completed");
    result = run(plan, completed.snapshot);
  }
  assert.equal(result.snapshot.status, "halted");
  assert.deepEqual(sayTexts(result), ["Ada 41"]);
});

test("a default that runs only when it is used still decides the type of the result", () => {
  const prefix = 'let names = ["a"]\n';
  assert.deepEqual(
    compileSource(`${prefix}let name: string = names.get(0, default: askText "Name?")\nexit`)
      .diagnostics,
    [],
  );
  assert.deepEqual(
    compileSource(
      `${prefix}let name: string = names.get(0, default: askNumber "Age?")\nexit`,
    ).diagnostics.map((diagnostic) => diagnostic.code),
    ["TSV041"],
  );
  // A default may still decide the element type of a list that no value decided yet (V30 §16).
  assert.deepEqual(
    compileSource(
      'let scores = []\nscores.add(scores.get(0, default: askNumber "Score?") + 1)\nscores.add("x")\nexit',
    ).diagnostics.map((diagnostic) => diagnostic.code),
    ["TSV041"],
  );
});
