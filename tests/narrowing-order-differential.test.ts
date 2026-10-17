import assert from "node:assert/strict";
import test from "node:test";

import { compileAndRunVariants, type FlowRun } from "./helpers/flow-differential.js";

/*
 * Narrowing against the runtime's evaluation order (V30 §13, §14, and docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md,
 * "One home for each language rule"): for every construct whose parts can be written in more than one order, one part
 * calls a function that clears the narrowed variable `x` and another reads `x` in a way that fails on null. Each
 * construct is written in both orders, or in its one order with the call and the read swapped between its parts. The
 * check must report the read exactly when the run fails there, which is when the call is written first.
 *
 * A reported script does not run, so each variant is also run with `x` read and cleared through a property of an
 * `object`, which the check does not follow (only plain variables narrow, V30 §13). That twin evaluates the same parts
 * in the same order and fails where the reported read would.
 */

/** A part of a construct: with the call that clears `x`, or with the read of `x`; `null` where the part cannot hold it. */
interface Part {
  readonly clear: string | null;
  readonly read: string | null;
}

interface Construct {
  readonly name: string;
  readonly parts: readonly [Part, Part];
  /** The construct's line, with its parts in written order. */
  readonly line: (parts: readonly [string, string]) => string;
  /** The parts are always written in the order given. */
  readonly fixed?: boolean;
  /** The run answers a number ask with 1, so the assignment around the ask completes. */
  readonly answers?: boolean;
  /**
   * The command forgets what is known about `x` before its parts run, since it first waits for the previous message's
   * pacing, where a block may run (V30 §13). A read written first is reported too, so only a failing run is checked.
   */
  readonly forgetsFirst?: boolean;
}

const named = (name: string, part: Part): Part => ({
  clear: part.clear === null ? null : `${name}: ${part.clear}`,
  read: part.read === null ? null : `${name}: ${part.read}`,
});

const TEXT: Part = { clear: '"${clearText()}"', read: '"${x + 1}"' };
const SECONDS: Part = { clear: "clearInteger() s", read: "x s" };
const INTEGER: Part = { clear: "clearInteger()", read: "x + 1" };
const DISPLAY: Part = { clear: "clearDisplay()", read: '["visible"][x - 5]' };

const CONSTRUCTS: readonly Construct[] = [
  {
    name: "a named timer's label and duration",
    parts: [named("label", TEXT), named("duration", SECONDS)],
    line: ([a, b]) => `timer(${a}, ${b})`,
  },
  {
    name: "a named async timer's display and duration",
    parts: [named("display", DISPLAY), named("duration", SECONDS)],
    line: ([a, b]) => `let t = timer(${a}, ${b}, async: true) { say "t" }`,
  },
  {
    name: "a named timer's display and label",
    parts: [named("display", DISPLAY), named("label", TEXT)],
    line: ([a, b]) => `timer(${a}, ${b}, duration: 1 s)`,
  },
  {
    name: "a short timer's duration and label",
    parts: [SECONDS, TEXT],
    line: ([a, b]) => `timer async ${a} ${b}`,
    fixed: true,
  },
  {
    name: "a play command's options",
    parts: [named("startAt", SECONDS), named("volume", { clear: "clearVolume()", read: "x / 10" })],
    line: ([a, b]) => `playAudio(file: "a.mp3", ${a}, ${b})`,
    forgetsFirst: true,
  },
  {
    name: "an ask's question and hint",
    parts: [TEXT, named("hint", TEXT)],
    line: ([a, b]) => `let a = askText ${a}, ${b}`,
    fixed: true,
  },
  {
    name: "askPassword's question and hint",
    parts: [TEXT, named("hint", TEXT)],
    line: ([a, b]) => `let a = askPassword ${a}, ${b}`,
    fixed: true,
  },
  {
    name: "an ask's hint and prefill",
    parts: [named("hint", TEXT), named("prefill", TEXT)],
    line: ([a, b]) => `let a = askText "Q", ${a}, ${b}`,
  },
  {
    name: "askBoolean's named arguments",
    parts: [named("yesText", TEXT), named("noText", TEXT)],
    line: ([a, b]) => `let a = askBoolean "Q", ${a}, ${b}`,
  },
  {
    name: "askBooleans' named arguments",
    parts: [
      named("texts", { clear: '[clearText(), "B"]', read: '["${x + 1}", "B"]' }),
      named("prefill", { clear: "[clearInteger() > 0, true]", read: "[x > 0, true]" }),
    ],
    line: ([a, b]) => `let a = askBooleans "Q", ${a}, ${b}`,
  },
  {
    name: "askChoice's options",
    parts: [TEXT, TEXT],
    line: ([a, b]) => `let a = askChoice ${a}, ${b}`,
  },
  {
    name: "askChoice's options and prefill",
    parts: [TEXT, named("prefill", TEXT)],
    line: ([a, b]) => `let a = askChoice "a", ${a}, ${b}`,
    fixed: true,
  },
  {
    name: "showButton's label and options",
    parts: [TEXT, named("timeout", SECONDS)],
    line: ([a, b]) => `showButton ${a}, ${b}`,
    fixed: true,
  },
  {
    name: "showButton's options",
    parts: [
      named("background", { clear: "clearColour()", read: '["#336699"][x - 5]' }),
      named("timeout", SECONDS),
    ],
    line: ([a, b]) => `showButton "Go", ${a}, ${b}`,
  },
  {
    // The list has no position 1 or 6, so the default runs, after the index.
    name: "a get's index and default",
    parts: [INTEGER, TEXT],
    line: ([a, b]) => `let r = ["a"].get(${a}, default: ${b})`,
    fixed: true,
  },
  {
    // The text is no JSON, so the default runs, after `files:`, which is written after it.
    name: "fromJson's files and default",
    parts: [{ clear: "clearInteger() > 0", read: "x + 1 > 0" }, TEXT],
    line: ([a, b]) => `let r = fromJson("{", default: ${b}, files: ${a})`,
    fixed: true,
  },
  {
    // No time lock, so the run stops where the Player locks.
    name: "encryptText's password and timeLock",
    parts: [
      named("password", TEXT),
      named("timeLock", { clear: "clearInteger() > 5", read: "x > 9" }),
    ],
    line: ([a, b]) => `let r = encryptText("t", ${a}, ${b})`,
  },
  {
    // The question of a password field is said where `password:` stands; the field then waits for the player.
    name: "a lock call's password field and timeLock",
    parts: [
      named("password", {
        clear: 'askPassword("${clearText()}")',
        read: 'askPassword("${x + 1}")',
      }),
      named("timeLock", { clear: "clearInteger() > 5", read: "x > 9" }),
    ],
    line: ([a, b]) => `let r = encryptText("t", ${a}, ${b})`,
  },
  {
    // The text is no lock, so the default runs, after `password:`, which is written after it.
    name: "decryptText's password and default",
    parts: [TEXT, TEXT],
    line: ([a, b]) => `let r = decryptText("x", default: ${b}, password: ${a})`,
    fixed: true,
  },
  {
    name: "named call arguments",
    parts: [named("a", INTEGER), named("b", INTEGER)],
    line: ([a, b]) => `let r = add(${a}, ${b})`,
  },
  ...(["+=", "-="] as const).map((operator): Construct => ({
    name: `'${operator}' with a call`,
    parts: [
      { clear: null, read: "x" },
      { clear: "clearInteger()", read: null },
    ],
    line: ([a, b]) => `${a} ${operator} ${b}`,
    fixed: true,
  })),
  {
    name: "'+=' with an ask",
    parts: [
      { clear: null, read: "x" },
      { clear: "askInteger clearText()", read: null },
    ],
    line: ([a, b]) => `${a} += ${b}`,
    fixed: true,
    answers: true,
  },
  {
    name: "the operands of '+=' with a call",
    parts: [
      { clear: "clearInteger()", read: "x" },
      { clear: "clearInteger()", read: "x" },
    ],
    line: ([a, b]) => `x += ${a} + ${b}`,
  },
  {
    name: "the operands of '+=' with an ask",
    parts: [
      { clear: "(askInteger clearText())", read: "x" },
      { clear: "(askInteger clearText())", read: "x" },
    ],
    line: ([a, b]) => `x += ${a} + ${b}`,
    answers: true,
  },
];

/** The functions that clear `x` and give a value of each kind the parts need. */
const CLEARS: Readonly<Record<string, string>> = {
  clearText: '"b"',
  clearInteger: "1",
  clearDisplay: '"visible"',
  clearColour: '"#336699"',
  clearVolume: "0.5",
};

/**
 * `main.tease` with the construct's line where `x` is narrowed, or, for the twin, with `x` held in a property of an
 * `object`; and the 1-based line of the construct.
 */
function program(line: string, twin: boolean): { readonly source: string; readonly at: number } {
  const place = twin ? "o.n" : "x";
  const lines = [
    twin ? "global o: object = { n: 5 }" : 'global x: integer? = load("x", default: 5)',
    ...Object.entries(CLEARS).flatMap(([name, value]) => [
      `function ${name} {`,
      `    ${place} = null`,
      `    return ${value}`,
      "}",
    ]),
    "function add(a: integer, b: integer) {",
    "    return a + b",
    "}",
    `if ${place} != null {`,
    `    ${twin ? line.replaceAll(/\bx\b/g, place) : line}`,
    "}",
    'say "after"',
    "exit",
  ];
  return { source: lines.join("\n"), at: lines.length - 3 };
}

/** Each variant of a construct: its line, and whether the call is written before the read. */
function variants(construct: Construct): { readonly line: string; readonly clearFirst: boolean }[] {
  const found = new Map<string, boolean>();
  for (const clearAt of [0, 1] as const) {
    const clear = construct.parts[clearAt].clear;
    const read = construct.parts[1 - clearAt]!.read;
    if (clear === null || read === null) continue;
    const parts: [string, string] = clearAt === 0 ? [clear, read] : [read, clear];
    found.set(construct.line(parts), clearAt === 0);
    if (construct.fixed !== true) found.set(construct.line([parts[1], parts[0]]), clearAt === 1);
  }
  return [...found].map(([line, clearFirst]) => ({ line, clearFirst }));
}

test("narrowing agrees with the runtime on the order of each construct's parts", () => {
  for (const construct of CONSTRUCTS)
    for (const { line, clearFirst } of variants(construct)) {
      const label = `${construct.name}: ${line}`;
      const failedAt =
        (at: number) =>
        (run: FlowRun): boolean =>
          run.failure !== null && run.failure.path === "main.tease" && run.failure.line === at;
      const outcome = (twin: boolean) => {
        const { source, at } = program(line, twin);
        const compiled = compileAndRunVariants(
          [{ path: "main.tease", source }],
          [],
          {},
          construct.answers === true ? "1" : null,
        );
        for (const run of compiled.runs)
          if (run.failure !== null && !failedAt(at)(run))
            assert.fail(`${label}: failed with ${run.failure.code} at line ${run.failure.line}`);
        return {
          at,
          errors: compiled.diagnostics
            .filter((diagnostic) => diagnostic.severity === "error")
            .map((diagnostic) => [diagnostic.code, diagnostic.span.start.line + 1]),
          runs: compiled.runs,
          fails: compiled.runs.some(failedAt(at)),
        };
      };
      const checked = outcome(false);
      const twin = outcome(true);
      assert.deepEqual(twin.errors, [], `${label}: the twin compiles`);
      assert.equal(twin.runs.length, 1, label);
      // The parts run in source order: the read fails exactly when the call that clears `x` comes first.
      assert.equal(twin.fails, clearFirst, `${label}: the twin's run`);
      const reported = checked.errors.length > 0;
      assert.deepEqual(
        checked.errors,
        reported ? [["TSV043", checked.at]] : [],
        `${label}: only the read is reported`,
      );
      if (construct.forgetsFirst === true) assert.ok(reported || !twin.fails, label);
      else assert.equal(reported, twin.fails, `${label}: reported exactly when the run fails`);
      if (!reported) assert.equal(checked.fails, false, `${label}: accepted, but the run fails`);
    }
});
