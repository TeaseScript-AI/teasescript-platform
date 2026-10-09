import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { run, type RuntimeOperationResult } from "../src/runtime/engine.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { compileValidPlan as compile } from "./helpers/compile-valid-plan.js";
import { sayTexts } from "./helpers/runtime-events.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

test("interpolation selects one list element at every evaluation", () => {
  // `dynamic` hides the text's type, so one list may offer text and a number.
  const dynamic = "function dynamic(value) {\n  return value\n}\n";
  const template = runSource(
    `${dynamic}${[
      'let values = [dynamic("left"), 2]',
      'say "Value: ${values}"',
      'say "${values} and ${values}"',
      "exit",
    ].join("\n")}`,
    [0, 0.75, 0],
  );
  assert.equal(template.result.snapshot.failure, null);
  assert.equal(template.randomCalls, 3);
  assert.deepEqual(sayTexts(template.result), ["Value: left", "2 and left"]);

  // Any element that `${...}` shows on its own may be selected.
  const scalars = runSource(
    `${dynamic}let values = [dynamic(true), null, 90 seconds]\nsay "\${values}, \${values}, \${values}"\nexit`,
    [0, 0.5, 0.9],
  );
  assert.equal(scalars.result.snapshot.failure, null);
  assert.deepEqual(sayTexts(scalars.result), ["true, null, 1 min 30 s"]);
});

test("say shows lists, sets, and objects in code-like notation without message markup", () => {
  const cases = [
    ['say ["pet", "puppy"]\nexit', '["pet", "puppy"]'],
    ["say [2.5, 3, null]\nexit", "[2.5, 3, null]"],
    ['say [["a"], ["b"]]\nexit', '[["a"], ["b"]]'],
    ['say [{ name: "Bo", age: 3 }]\nexit', '[{ name: "Bo", age: 3 }]'],
    ['say { name: "Bo" }\nexit', '{ name: "Bo" }'],
    ['say ["He said \\"hi\\""]\nexit', '["He said \\"hi\\""]'],
    ["say []\nexit", "[]"],
    ["say {}\nexit", "{}"],
    ["say [90 seconds]\nexit", "[1 min 30 s]"],
    ["say set[2, 1, 2]\nexit", "[2, 1]"],
    ["say [2.50, -0, 1e21]\nexit", "[2.5, 0, 1e+21]"],
    [
      'say ["a\\\\b", "x\\ny\\tz\\r", "\\${name}"]\nexit',
      '["a\\\\b", "x\\ny\\tz\\r", "\\${name}"]',
    ],
    [
      'say ["**bold**", "https://example.com", "# heading", "[link](https://example.com)"]\nexit',
      '["**bold**", "https://example.com", "# heading", "[link](https://example.com)"]',
    ],
  ] as const;
  for (const [source, text] of cases) {
    const execution = runSource(source, []);
    assert.equal(execution.result.snapshot.failure, null, source);
    assert.equal(execution.randomCalls, 0, source);
    const said = execution.result.events.filter((event) => event.kind === "say");
    assert.deepEqual(
      said.map((event) => [event.text, event.content.blocks]),
      [[text, [{ kind: "paragraph", lines: [{ text, spans: [], ending: "" }] }]]],
      source,
    );
  }

  // A scalar is shown as before, and its text is still message markup.
  const scalar = runSource('say "**bold**"\nexit', []);
  assert.deepEqual(sayTexts(scalar.result), ["bold"]);
});

test("say notation survives prepared pacing and checkpoint resume", () => {
  const source = [
    "function pause {",
    "    return 0",
    "}",
    'say [{ a: "**a**", b: [1] }], pause()',
    "exit",
  ].join("\n");
  const equivalent = assertRuntimeResumeEquivalent(source);
  assert.deepEqual(
    equivalent.events.filter((event) => event.kind === "say").map((event) => event.text),
    ['[{ a: "**a**", b: [1] }]'],
  );
});

test("say shows ranges and speakers as code-like notation", () => {
  const cases = [
    ["say 1..5\nexit", "1..5"],
    ["say 1..=5\nexit", "1..=5"],
    ["say [-2..3, 0..=1]\nexit", "[-2..3, 0..=1]"],
    ["say { r: 0..=1 }\nexit", "{ r: 0..=1 }"],
    ["speaker mistress {}\nsay mistress\nexit", "<speaker mistress>"],
    [
      "speaker vera {}\nspeaker mistress {}\nsay [vera, mistress]\nexit",
      "[<speaker vera>, <speaker mistress>]",
    ],
  ] as const;
  for (const [source, text] of cases) {
    const execution = runSource(source, []);
    assert.equal(execution.result.snapshot.failure, null, source);
    assert.deepEqual(sayTexts(execution.result), [text], source);
  }
});

test("say shows a timer handle with its current state, also after checkpoint resume", () => {
  const source = [
    'let beat = timer(duration: 10 s, async: true, label: "Beat")',
    "let plain = timer(duration: 10 s, async: true)",
    "wait 3 s",
    "say [beat, plain], 0",
    "beat.pause()",
    "say beat, 0",
    "plain.stop()",
    "say plain, 0",
    "beat.resume()",
    "wait 8 s",
    "say beat, 0",
    "exit",
  ].join("\n");
  const equivalent = assertRuntimeResumeEquivalent(source);
  assert.deepEqual(
    equivalent.events.filter((event) => event.kind === "say").map((event) => event.text),
    [
      '[<timer "Beat", 7 s left>, <timer, 7 s left>]',
      '<timer "Beat", paused, 7 s left>',
      "<timer, stopped>",
      '<timer "Beat", finished>',
    ],
  );
});

test("say shows a media handle with its current state, also after checkpoint resume", () => {
  const source = [
    'let music = playAudio(file: "music.mp3", async: true)',
    "wait 12 s",
    "say [music], 0",
    "music.pause()",
    "say music, 0",
    "music.stop()",
    "say music, 0",
    'let beep = playAudio(file: "beep.mp3", async: true)',
    "wait 61 s",
    "say beep, 0",
    "exit",
  ].join("\n");
  const equivalent = assertRuntimeResumeEquivalent(source, { mediaDurationMs: 60_000 });
  assert.deepEqual(
    equivalent.events.filter((event) => event.kind === "say").map((event) => event.text),
    [
      '[<media "music.mp3", playing at 12 s>]',
      '<media "music.mp3", paused at 12 s>',
      '<media "music.mp3", stopped>',
      '<media "beep.mp3", finished>',
    ],
  );
});

test("interpolation checks the whole list before selecting, so the outcome does not depend on the seed", () => {
  // `dynamic` hides the text's type, so one list may hold text and another value.
  const dynamic = "function dynamic(value) {\n  return value\n}\n";
  const cases = [
    [`${dynamic}let values = [dynamic("ok"), { value: 1 }]\nsay "\${values}"\nexit`, "TSR021"],
    [`${dynamic}let values = [dynamic("ok"), ["nested"]]\nsay "\${values}"\nexit`, "TSR021"],
    [`${dynamic}let values = [dynamic("ok"), set[1]]\nsay "\${values}"\nexit`, "TSR021"],
    [`${dynamic}let values = [dynamic("ok"), 1..2]\nsay "\${values}"\nexit`, "TSR021"],
    ['let values = []\nsay "${values}"\nexit', "TSR019"],
  ] as const;
  for (const [source, code] of cases) {
    for (const randomValue of [0, 0.75]) {
      const execution = runSource(source, [randomValue]);
      assert.equal(execution.randomCalls, 0, source);
      assert.equal(execution.result.snapshot.failure?.code, code, source);
      assert.deepEqual(sayTexts(execution.result), [], source);
    }
  }
  const empty = runSource('let values = []\nsay "${values}"\nexit', []);
  assert.equal(
    empty.result.snapshot.failure?.message,
    "'${...}' shows one random element of a list, but this list is empty. Check its length first.",
  );
});

test("interpolated values the compiler can see are checked when compiling", () => {
  const cases = [
    [
      'say "${[{}]}"\nexit',
      "{}",
      "An interpolated list may contain only text, numbers, true, false, null, durations, date and time values, and script references, because one element is shown as text.",
    ],
    [
      'let answer = askText "${[]}"\nexit',
      "[]",
      "'${...}' shows one random element of a list, but this list is empty. Check its length first.",
    ],
    [
      'speaker vera {}\nsay "${[vera]}"\nexit',
      "vera",
      "An interpolated list may contain only text, numbers, true, false, null, durations, date and time values, and script references, because one element is shown as text.",
    ],
    [
      'say "${{ name: "Bo" }}"\nexit',
      '{ name: "Bo" }',
      '"${...}" cannot show an object. It shows text, numbers, true, false, null, durations, date and time values, and script references, and selects one element of a list.',
    ],
  ] as const;
  for (const [source, at, message] of cases) {
    const result = compileSource(source);
    assert.equal(result.plan, null, source);
    const start = source.lastIndexOf(at);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.message,
        diagnostic.span.start.offset,
        diagnostic.span.end.offset,
      ]),
      [["TSV042", message, start, start + at.length]],
      source,
    );
  }
});

test("preserves direct scalar visible-text conversion", () => {
  const execution = runSource(["say true", "say null", "say 3.5", "exit"].join("\n"), []);

  assert.equal(execution.result.snapshot.failure, null);
  assert.equal(execution.randomCalls, 0);
  assert.deepEqual(sayTexts(execution.result), ["true", "null", "3.5"]);
});

function runSource(
  source: string,
  randomValues: readonly number[],
): { readonly result: RuntimeOperationResult; readonly randomCalls: number } {
  const plan = compile(source);
  let randomCalls = 0;
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan), {
    random: {
      next(): number {
        const value = randomValues[randomCalls];
        randomCalls += 1;
        if (value === undefined) throw new Error("Unexpected random draw.");
        return value;
      },
    },
  });
  return { result, randomCalls };
}
