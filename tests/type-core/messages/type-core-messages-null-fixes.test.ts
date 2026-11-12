// A null check's fixes (#1268): its fallback, its example in the use's place, and the check in words where no example
// may stand.

import assert from "node:assert/strict";
import test from "node:test";
import type { BinaryExpression } from "../../../src/ast.js";
import { compileProject } from "../../../src/compiler.js";
import { createFreshRuntimeSession } from "../../../src/index.js";
import { parse } from "../../../src/parser.js";
import { someNode } from "../../../src/project-globals.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { coreMessage, messageSource } from "../../../src/type-inference/core/messages.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { escaped, SAME_TYPE } from "../../helpers/type-core/type-core-message-ports.js";

/**
 * #1268: null checks' fallbacks, `⟦…⟧` around the value they stand in for, whether the fallback stands in parentheses
 * there (an operand or a receiver: TSP041 asks for them next to every operator, #1243) and what the source then says: a
 * plain value,
 * an operand of each operator class (a comparison, arithmetic, a sign, `and`, `or`, `not`; `is` takes null, so the case
 * under it is the arithmetic's operand), a condition, a count, an index, a key, an argument, text, an element of a list.
 */
const FALLBACKS: readonly (readonly [string, boolean, readonly string[]])[] = [
  ["let xs = [7, null]\nlet n: integer = ⟦xs[1]⟧\nsay n\nexit\n", false, ["0"]],
  ['let xs = [7, null]\nif ⟦xs[1]⟧ < 1 { say "low" }\nexit\n', true, ["low"]],
  ["let xs = [7, null]\nsay ⟦xs[1]⟧ + 1\nexit\n", true, ["1"]],
  ["let xs = [7, null]\nsay -⟦xs[1]⟧\nexit\n", true, ["0"]],
  ['let xs = [7, null]\nif ⟦xs[1]⟧ + 1 is integer { say "whole" }\nexit\n', true, ["whole"]],
  [
    'let bs = [true, null]\nif ⟦bs[1]⟧ and true { say "yes" } else { say "no" }\nexit\n',
    true,
    ["no"],
  ],
  [
    'let bs = [true, null]\nif false or ⟦bs[1]⟧ { say "yes" } else { say "no" }\nexit\n',
    true,
    ["no"],
  ],
  ['let bs = [true, null]\nif not ⟦bs[1]⟧ { say "yes" }\nexit\n', true, ["yes"]],
  ['let bs = [true, null]\nif ⟦bs[1]⟧ { say "yes" } else { say "no" }\nexit\n', false, ["no"]],
  ['let xs = [7, null]\nrepeat ⟦xs[1]⟧ { say "x" }\nsay "done"\nexit\n', false, ["done"]],
  ["let xs = [7, null]\nsay [5][⟦xs[1]⟧]\nexit\n", false, ["5"]],
  [
    'let ks = ["a", null]\nlet d = dict{a: 1}\nsay d.get(⟦ks[1]⟧, default: 0)\nexit\n',
    false,
    ["0"],
  ],
  [
    "function use(v: integer) {\n  say v\n}\nlet xs = [7, null]\nuse(⟦xs[1]⟧)\nexit\n",
    false,
    ["0"],
  ],
  ['let names = ["a", null]\nsay ⟦names[1]⟧.length\nexit\n', true, ["0"]],
  ['let names = ["a", null]\nsay "a" + ⟦names[1]⟧\nexit\n', true, ["a"]],
  ['let names = ["a", null]\nif ⟦names[1]⟧ < "b" { say "before" }\nexit\n', true, ["before"]],
  ['let xs = [7, null]\nsay "${⟦xs[1]⟧ + 1}"\nexit\n', true, ["1"]],
];

test("a null check's fallback compiles where it is pasted, grouped as written, and runs (#1268)", () => {
  for (const [marked, grouped, says] of FALLBACKS) {
    const source = marked.replace(/[⟦⟧]/g, "");
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const analysed = analyseCore(request).diagnostics;
    const text = messageSource([source], analysed);
    const suggested = analysed
      .map((diagnostic) => /fallback, as in '([^']*)'/.exec(coreMessage(diagnostic, text))?.[1])
      .find((found) => found !== undefined);
    assert.ok(suggested !== undefined, `a fallback: ${source}`);
    assert.equal(suggested.startsWith("("), grouped, suggested);
    const at = marked.indexOf("⟦");
    const fixed = marked.replace(/⟦[^⟧]*⟧/, suggested);
    // (its `otherwise` holds exactly the pasted code, inside the parentheses it brings: the grouping TSP041 asks for)
    const inner = suggested.startsWith("(") ? 1 : 0;
    assert.ok(
      someNode(parse(fixed).program, (node) => {
        if (node.kind !== "binaryExpression") return false;
        // EVIDENCE: invariant: a parser-owned node whose kind is `binaryExpression` is a binary expression.
        const binary = node as BinaryExpression;
        return (
          binary.operator === "otherwise" &&
          binary.span.start.offset === at + inner &&
          binary.span.end.offset === at + suggested.length - inner
        );
      }),
      fixed,
    );
    const { diagnostics, plan } = compileProject([{ path: "main.tease", source: fixed }]);
    assert.deepEqual(
      diagnostics.filter((found) => found.severity === "error").map((found) => found.message),
      [],
      fixed,
    );
    // (the fallback leaves no possible null for the new checker either)
    const repaired = coreRequest([{ path: "main.tease", source: fixed }]);
    assert.ok(repaired !== null, fixed);
    assert.deepEqual(
      analyseCore(repaired).diagnostics.filter(
        (found) =>
          found.kind !== "budget" &&
          (found.kind === "written-type" || found.kinds.includes("null")),
      ),
      [],
      fixed,
    );
    assert.ok(plan !== null, fixed);
    const events = createFreshRuntimeSession(plan, {
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    }).run().events;
    assert.deepEqual(
      events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
      says,
      fixed,
    );
  }
  // none in code where none of the value's type can be written: a list, and a union beside the type the use takes
  for (const source of [
    "let rows = [[1], null]\nsay rows[1].length\nexit\n",
    'let us: (integer | string | null)[] = [1, "a", null]\nsay us[2] + 1\nexit\n',
  ]) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const fixes = diagnostics
      .filter(
        (found) =>
          found.kind !== "written-type" && found.kind !== "budget" && found.kinds.includes("null"),
      )
      .map((found) => coreMessage(found, text));
    assert.equal(fixes.length, 1, source);
    assert.match(fixes[0]!, new RegExp(`, ${escaped(SAME_TYPE)}`), source);
    assert.doesNotMatch(fixes[0]!, / otherwise /, source);
  }
  // no join of values `join()` does not show, and no receiver form for an element `${...}` selects from a list, whose
  // text names the list (Codex r2): the steps in words
  for (const [source, words] of [
    ['say "${[set[1]]}"\nexit\n', "Show its elements with the toList and join methods instead."],
    ['say "${set[{a: 1}]}"\nexit\n', "Show its elements with the toList and join methods instead."],
    [
      'say "${dict{a: {p: 1}}}"\nexit\n',
      "Select one value with a key, or show every value with the values and join methods.",
    ],
    [
      'let d = dict{a: [1]}\nsay "${d}"\nexit\n',
      "Select one value with a key, or show every value with the values and join methods.",
    ],
    ['let xs = [{a: 1}]\nsay "${xs}"\nexit\n', "Show one of its properties instead."],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const found = diagnostics.map((diagnostic) => coreMessage(diagnostic, text));
    assert.ok(
      found.some((message) => message.endsWith(` ${words}`)),
      `${source}: ${found.join(" | ")}`,
    );
    assert.ok(
      found.every((message) => !/as in '|with '/.test(message)),
      source,
    );
  }
  // a property stored on a type without it: no read's repair, which is no place to store into (Codex r1)
  for (const source of ["let d = 2 s\nd.seconds = 3\nexit\n", "let n = 12\nn.length = 3\nexit\n"]) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const found = diagnostics.map((diagnostic) => coreMessage(diagnostic, text));
    assert.equal(found.length, 1, source);
    assert.doesNotMatch(found[0]!, /as in '|with '/, source);
  }
});

/**
 * #1268: checks, `⟦…⟧` around the use's statement, which the check's example holds as the source writes
 * it (a kept value's read as `value`, its `let` on a line before), and what the source then says: a null check of a
 * variable and of a kept value, on a line of its own and in a block (Astra on #1273); around a condition, a count, an
 * iterable, a store, an interpolation, a receiver; a type test, a length check, a timer's block.
 */
const CHECKS: readonly (readonly [string, readonly string[]])[] = [
  ["let ns = [1, null]\nlet n = ns[1]\n⟦say n + 1⟧\nexit\n", []],
  ["let ns = [1, null]\nlet n = ns[0]\nif true {\n  ⟦say n + 1⟧\n}\nexit\n", ["2"]],
  ["let ns = [1, null]\nlet n = ns[0]\nif true { ⟦say n + 1⟧ }\nexit\n", ["2"]],
  ["let ns = [1, null]\n⟦say ns[0] + 1⟧\nexit\n", ["2"]],
  ["let ns = [1, null]\nif true { ⟦say ns[0] + 1⟧ }\nexit\n", ["2"]],
  [
    'let ns = [1, null]\nlet n = ns[0]\n⟦if n < 1 { say "low" } else { say "high" }⟧\nexit\n',
    ["high"],
  ],
  ['let ns = [1, null]\nlet n = ns[0]\n⟦repeat n { say "x" }⟧\nexit\n', ["x"]],
  ["let lists = [[4], null]\nlet xs = lists[0]\n⟦for x in xs { say x }⟧\nexit\n", ["4"]],
  ["let ns = [1, null]\nlet n = ns[0]\nlet m = 0\n⟦m = n + 1⟧\nsay m\nexit\n", ["2"]],
  ['let ns = [1, null]\nlet n = ns[0]\n⟦say "${n + 1}"⟧\nexit\n', ["2"]],
  ['let names = ["ab", null]\n⟦say names[0].length⟧\nexit\n', ["2"]],
  ['let us: (integer | string)[] = [1, "a"]\nlet u = us[0]\n⟦say u + 1⟧\nexit\n', ["2"]],
  ['let us: (integer | string)[] = [1, "a"]\n⟦say us[0] + 1⟧\nexit\n', ["2"]],
  ["let groups: integer[][] = [[], [21]]\n⟦say groups[1].last⟧\nexit\n", ["21"]],
  ["let ns = [1, null]\nlet n = ns[0]\nlet t = timer async 1 s { ⟦say n + 1⟧ }\nexit\n", []],
  // (beside text, the null check's alternative is the type test too, Codex r4)
  [
    'let us: (integer | string | null)[] = [1, "a", null]\nlet u = us[0]\n⟦say u + 1⟧\nexit\n',
    ["2"],
  ],
  ['let us: (integer | string | null)[] = [1, "a", null]\n⟦say us[0] + 1⟧\nexit\n', ["2"]],
  // (a call after the read, a method of the value itself, a kept call read first: nothing changes before the use)
  ["let ns = [1, null]\nfunction f { return 2 }\n⟦say ns[0] + f()⟧\nexit\n", ["3"]],
  ["let lists = [[1], null]\nlet xs = lists[0]\n⟦xs.add(2)⟧\nsay xs\nexit\n", ["[1, 2]"]],
  ["let ns = [1, null]\nfunction f { return ns[0] }\n⟦say f() + 1⟧\nexit\n", ["2"]],
];

test("a check's example holds the use's statement, compiles in its place, and runs (#1268)", () => {
  for (const [marked, says] of CHECKS) {
    const source = marked.replace(/[⟦⟧]/g, "");
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    // (every check its messages offer: a type test beside a null check's, Codex r4)
    const offers = new Set(
      diagnostics.flatMap((diagnostic) => {
        const message = coreMessage(diagnostic, text);
        const check = / as in '(if [^']*)'/.exec(message)?.[1];
        const kept = /as in '(let value = [^']*)', and check/.exec(message)?.[1];
        return check === undefined ? [] : [kept === undefined ? check : `${kept}\n${check}`];
      }),
    );
    assert.ok(offers.size > 0, `a check: ${source}`);
    const statement = /⟦([^⟧]*)⟧/.exec(marked)![1]!;
    for (const offer of offers) {
      const [check, kept] = offer.includes("\n") ? offer.split("\n").reverse() : [offer];
      // (it holds the statement it replaces: as written, a kept value's read as `value`)
      const held = /^if .+? \{ (.*) \}$/.exec(check!)?.[1];
      assert.equal(
        kept === undefined ? held : held?.replace("value", kept.slice("let value = ".length)),
        statement,
        offer,
      );
      const fixed = marked.replace(/⟦[^⟧]*⟧/, offer);
      const { diagnostics, plan } = compileProject([{ path: "main.tease", source: fixed }]);
      assert.deepEqual(
        diagnostics.filter((found) => found.severity === "error").map((found) => found.message),
        [],
        fixed,
      );
      assert.ok(plan !== null, fixed);
      const events = createFreshRuntimeSession(plan, {
        baseDelayMs: 0,
        delayPerWordMs: 0,
        delayPerCharacterMs: 0,
      }).run().events;
      assert.deepEqual(
        events.filter((event) => event.kind === "runtimeFailure"),
        [],
        fixed,
      );
      assert.deepEqual(
        events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
        says,
        fixed,
      );
    }
  }
});

/**
 * #1268: uses whose statement no check may hold as written, and declarations not on one line:
 * the step in words, with no block and no placeholder; where the words still offer code, a fallback or a type, `⟦…⟧`
 * marks where it goes.
 */
const WORDED: readonly (readonly [string, string])[] = [
  // a declaration, whose name would end with the check's block; a statement over two lines; an `else if`'s condition;
  // a `while`'s, tested again after each pass; a return; a comment
  [
    "let ns = [1, null]\nlet n = ns[0]\nlet m = ⟦n⟧ + 1\nsay m\nexit\n",
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  [
    "let ns = [1, null]\nlet n = ns[0]\nsay ⟦n⟧ +\n  1\nexit\n",
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  [
    "let ns = [1, null]\nlet n = ns[0]\nif false { say 0 } else if ⟦n⟧ < 1 { say 1 }\nexit\n",
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  [
    "let ns = [1, null]\nlet n = ns[0]\nwhile ⟦n⟧ < 3 { n = 3 }\nexit\n",
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  [
    "let ns = [1, null]\nfunction f(k) {\n  let n = ns[k]\n  return ⟦n⟧ + 1\n}\nsay f(0)\nexit\n",
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  [
    "let ns = [1, null]\nlet n = ns[0]\nsay ⟦n⟧ /* one */ + 1\nexit\n",
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  // something evaluated before the use that may change or draw, the kept read's own effect, or a use a run may skip
  // (Codex r4, r5): a check before the statement would not hold there, and a kept value would be read too early
  [
    "let ns = [1, null]\nfunction change {\n  ns[0] = 9\n  return 1\n}\nsay change() + ⟦ns[0]⟧\nexit\n",
    "Keep 'ns[0]' in a new variable and check that it is not null first, or give a fallback, as in " +
      "'(ns[0] otherwise 0)'.",
  ],
  [
    "let ns = [1, null]\nlet n = ns[0]\nfunction change {\n  n = 9\n  return 1\n}\nsay change() + ⟦n⟧\nexit\n",
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  [
    "let xs = [7]\nfunction change {\n  xs.clear()\n  return 1\n}\nsay change() + xs.last\nexit\n",
    "Check the length of 'xs' first.",
  ],
  [
    'let ns = [1, null]\nlet n = ns[0]\nif askBoolean "go" or ⟦n⟧ > 0 { say 1 }\nexit\n',
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  [
    "let n = 1\nlet ns = [1, null]\nfunction read {\n  n = 9\n  return ns[0]\n}\nsay n + ⟦read()⟧\nexit\n",
    "Keep 'read()' in a new variable and check that it is not null first, or give a fallback, as in " +
      "'(read() otherwise 0)'.",
  ],
  [
    'let ns = [1, 2, null, 3]\nsay "${[10, 20]} ${⟦ns.random⟧ + 1}"\nexit\n',
    "Keep 'ns.random' in a new variable and check that it is not null first, or give a fallback, as in " +
      "'(ns.random otherwise 0)'.",
  ],
  // a kept value the statement reads twice: a check of one read leaves the other
  [
    "let ns = [1, null]\nsay ⟦ns[0]⟧ + ns[0]\nexit\n",
    "Keep 'ns[0]' in a new variable and check that it is not null first, or give a fallback, as in " +
      "'(ns[0] otherwise 0)'.",
  ],
  // another problem where the code would stand (Codex r5): a whole number joined with text, a duration or
  // a number that may also be null, a mixed key or condition
  [
    'let ns = [1, null]\nlet n = ns[0]\nsay "x" + n\nexit\n',
    "Check that 'n' is not null first, or give a fallback of the same type with 'otherwise'.",
  ],
  [
    "let vs: duration?[] = [1 s, null]\nlet v = vs[0]\nsay v.seconds\nexit\n",
    "Divide the duration by a unit of time instead.",
  ],
  ["let vs: integer?[] = [1, null]\nlet v = vs[0]\nif v { say 1 }\nexit\n", "Compare it instead."],
  // a type test and a length check in a declaration
  [
    'let us: (integer | string)[] = [1, "a"]\nlet m = us[0] + 1\nexit\n',
    "Keep 'us[0]' in a new variable and check that it is a whole number (integer) first.",
  ],
  [
    "let groups: integer[][] = [[], [21]]\nlet x = groups[1].last\nexit\n",
    "Check the length of 'groups[1]' first.",
  ],
  [
    "let groups: integer[][] = [[], [21]]\nlet x = groups.random.last\nexit\n",
    "Keep 'groups.random' in a new variable and check its length first.",
  ],
  // after an error, a form that reads a call's or an index read's result into another operation: a
  // shown object's property, a date and time conversion
  [
    'function make { return {a: 1, b: 2} }\nsay "${make()}"\nexit\n',
    "Show one of its properties instead.",
  ],
  [
    'let ts = [toAbsoluteDateTime("2026-01-01T00:00:00Z")]\nlet i = 0\nsay ts[i].year\nexit\n',
    "Convert 'ts[i]' with the toDateTime method first.",
  ],
  // a start value over lines (Astra on #1273's sibling)
  [
    'let mood⟦⟧ = [\n  1\n][0]\nmood = "happy"\nexit\n',
    "To allow both, declare it with the type 'integer | string'.",
  ],
  [
    'function use(n⟦: integer⟧ = [\n  1\n][0]) { say n }\nuse("x")\nexit\n',
    "To allow both, declare the parameter 'n' with the type 'integer | string'.",
  ],
];

test("a use no check may hold as written gets the check in words, with no block or placeholder (#1268)", () => {
  for (const [marked, words] of WORDED) {
    const source = marked.replace(/[⟦⟧]/g, "");
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const found = diagnostics.map((diagnostic) => coreMessage(diagnostic, text));
    assert.ok(
      found.some((message) => message.includes(words)),
      `${source}: ${found.join(" | ")}`,
    );
    assert.ok(
      found.every((message) => !/'if [^']*\{|\{ \.\.\. \}| = \.\.\.'|'let value = /.test(message)),
      source,
    );
    // (the code the words still offer, in its place, adds no error: a use it does not mend keeps its own)
    const fallback = /fallback, as in '([^']*)'/.exec(words)?.[1];
    const type = /with the type '([^']*)'/.exec(words)?.[1];
    const offered = fallback ?? (type === undefined ? undefined : `: ${type}`);
    assert.equal(marked.includes("⟦"), offered !== undefined, marked);
    if (offered === undefined) continue;
    const fixed = marked.replace(/⟦[^⟧]*⟧/, offered);
    const errors = (code: string): string[] =>
      compileProject([{ path: "main.tease", source: code }])
        .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`);
    const before = errors(source);
    assert.deepEqual(
      errors(fixed).filter((error) => !before.includes(error)),
      [],
      fixed,
    );
  }
});
