import assert from "node:assert/strict";
import test from "node:test";

import { compileProjectWithBackend } from "../../src/compiler.js";
import { parse } from "../../src/parser.js";
import { SLICE_DEPTH } from "../../src/type-inference/core/contract-descriptors.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import {
  DISPOSITIONS,
  outsideSyntax,
  type SyntaxKind,
} from "../../src/type-inference/core/slice-syntax.js";
import { HELD_MODES } from "../helpers/type-core-held-host.js";

/*
 * The candidate route's syntax table (`DISPOSITIONS`, #2498): a construct whose row is open is still refused when a
 * construct it holds, or one after it, has a closed row; the refusal stands at the closed construct, with its row's text.
 * Each case checks its own precondition against the table, so a step that opens the inner row fails here by name.
 */

interface Composite {
  readonly name: string;
  /** The project's files; the first is `main.tease`. */
  readonly files: readonly string[];
  /** The open construct's kind and the closed one's. */
  readonly outer: SyntaxKind;
  readonly inner: SyntaxKind;
  /** The file of the closed construct, and its text, which starts where it stands. */
  readonly file: number;
  readonly at: string;
}

const CASES: readonly Composite[] = [
  {
    name: "a closed statement in an open statement's block",
    files: ["if hostValue == null {\n  while true {\n    exit\n  }\n}\n"],
    outer: "ifStatement",
    inner: "whileStatement",
    file: 0,
    at: "while true",
  },
  {
    name: "a closed expression as an open list's element",
    files: ["let xs = [1, -hostValue]\n"],
    outer: "listLiteral",
    inner: "unaryExpression",
    file: 0,
    at: "-hostValue",
  },
  {
    name: "a closed expression as an open call's argument",
    files: ["let text = toJson(-1)\n"],
    outer: "callExpression",
    inner: "unaryExpression",
    file: 0,
    at: "-1",
  },
  {
    name: "a closed expression two open constructs deep",
    files: ['let o = {k: [hostValue, {m: "a" otherwise -2}]}\n'],
    outer: "objectLiteral",
    inner: "unaryExpression",
    file: 0,
    at: "-2",
  },
  {
    name: "a closed statement after an open one in the same list",
    files: ['let a = hostValue\nsave a as "k"\n'],
    outer: "letStatement",
    inner: "saveStatement",
    file: 0,
    at: 'save a as "k"',
  },
  {
    name: "a closed expression as a command's operand",
    files: ['showButton "Go", timeout: -2 s\n'],
    outer: "showButtonStatement",
    inner: "unaryExpression",
    file: 0,
    at: "-2 s",
  },
  {
    name: "a closed expression as a command's only operand",
    files: ["showImage -hostValue\n"],
    outer: "showImageStatement",
    inner: "unaryExpression",
    file: 0,
    at: "-hostValue",
  },
  {
    name: "a closed expression as a say's pacing",
    files: ['say "a", -hostValue\n'],
    outer: "sayStatement",
    inner: "unaryExpression",
    file: 0,
    at: "-hostValue",
  },
  {
    name: "the first of two closed constructs in source order, the later one deeper",
    files: ["let a = [-1, [-2 s]]\n"],
    outer: "listLiteral",
    inner: "unaryExpression",
    file: 0,
    at: "-1",
  },
  {
    // (wider than the engine's argument count: a list of children is never spread into arguments)
    name: "a closed element after 150,000 open ones",
    files: [`let xs = [${"0, ".repeat(150_000)}-hostValue]\n`],
    outer: "listLiteral",
    inner: "unaryExpression",
    file: 0,
    at: "-hostValue",
  },
  {
    name: "a closed statement in a later file after an open file",
    files: ["let a = hostValue\n", "let b = 1\nlet c = -b\n"],
    outer: "letStatement",
    inner: "unaryExpression",
    file: 1,
    at: "-b",
  },
];

/** A refused row's text: the kind in words, as the walk makes it (`ifStatement` is "this if statement"). */
const refusedText = (kind: SyntaxKind): string =>
  `this ${kind.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}`;

test("an open construct holding or followed by a closed one is refused at the closed one, with its row's text", () => {
  for (const composite of CASES) {
    assert.notEqual(
      DISPOSITIONS[composite.outer].row,
      "refused",
      `${composite.name}: outer row open`,
    );
    assert.equal(
      DISPOSITIONS[composite.inner].row,
      "refused",
      `${composite.name}: inner row closed`,
    );
    const files = composite.files.map((source, index) => ({
      path: index === 0 ? "main.tease" : `part${index}.tease`,
      source,
    }));
    const source = composite.files[composite.file]!;
    assert.equal(source.indexOf(composite.at), source.lastIndexOf(composite.at), composite.name);
    let refused: unknown = null;
    try {
      compileProjectWithBackend(files, { globals: ["hostValue"] }, CORE_BACKEND);
    } catch (error) {
      refused = error;
    }
    assert.ok(refused instanceof CandidateOutsideSlice, `${composite.name}: refused`);
    assert.deepEqual(
      { path: refused.path, start: refused.site.start, what: refused.what },
      {
        path: files[composite.file]!.path,
        start: source.indexOf(composite.at),
        what: refusedText(composite.inner),
      },
      composite.name,
    );
  }
});

/**
 * An open row's own condition, on its refusing side: the source, the refused construct's whole text (its offsets),
 * and the row's words.
 */
interface Condition {
  readonly row: SyntaxKind;
  /** What the row checks, in words. */
  readonly condition: string;
  readonly source: string;
  readonly at: string;
  readonly what: string;
}

/**
 * The inventory of the open rows' own conditions, with those of the predicates they call (`annotationOutside`,
 * `nullTest`, `sliceCall`, `sliceMethod`): a source for each operand, comparison and unwrapping that, weakened, would
 * admit a refused source (`tools/slice-conditions.json` lists them with their mutants). Every other open row has none
 * (`UNCONDITIONAL`); the inventory test below keeps the two lists equal to the table's open rows.
 */
const CONDITIONS: readonly Condition[] = [
  {
    row: "durationLiteral",
    condition: "a literal the plan stores (`storedLiteral`)",
    source: "let c = 1.5 calendar months",
    at: "1.5 calendar months",
    what: "this duration literal",
  },
  {
    row: "letStatement",
    condition: "a written type of the slice",
    source: "let x: integer | string = 1",
    at: "integer | string",
    what: "this written type",
  },
  {
    row: "letStatement",
    condition: "a written list type above the facts' deepest depth (`SLICE_DEPTH`)",
    source: `let x: integer${"[]".repeat(SLICE_DEPTH)} = []`,
    at: "integer[]",
    what: "this written type",
  },
  {
    row: "assignmentStatement",
    condition: "the operator is `=`",
    source: "let n = 1\nn += 1",
    at: "n += 1",
    what: "this assignment",
  },
  {
    row: "assignmentStatement",
    condition: "a variable or property target",
    source: "let xs = [1]\nxs[0] = 2",
    at: "xs[0] = 2",
    what: "this assignment",
  },
  {
    row: "sayStatement",
    condition: "shown text without interpolation",
    source: 'say "Hi ${hostValue}"',
    at: 'say "Hi ${hostValue}"',
    what: "this say",
  },
  {
    row: "sayStatement",
    condition: "a shown value other than a text literal is walked",
    source: "say toInteger(hostValue)",
    at: "toInteger(hostValue)",
    what: "this call expression",
  },
  {
    row: "expressionStatement",
    condition: "a call",
    source: 'askBooleans("Q?", texts: ["A"], prefill: [false], cancel: "Back")',
    at: 'askBooleans("Q?", texts: ["A"], prefill: [false], cancel: "Back")',
    what: "this expression statement",
  },
  {
    row: "identifier",
    condition: "one of its file's variables or a host value",
    source: "let x = player\nexit",
    at: "player",
    what: "the name 'player'",
  },
  {
    row: "stringLiteral",
    condition: "no interpolation",
    source: 'let t = "a ${hostValue}"',
    at: '"a ${hostValue}"',
    what: "text with interpolation",
  },
  {
    row: "propertyAccessExpression",
    condition: "a receiver that is no literal of another kind than object",
    source: 'let n = "abc".size',
    at: '"abc".size',
    what: "this member or element read",
  },
  {
    row: "propertyAccessExpression",
    condition: "a receiver that is no literal of another kind than object, in parentheses",
    source: 'let n = ("abc").size',
    at: '("abc").size',
    what: "this member or element read",
  },
  {
    row: "binaryExpression",
    condition: "`otherwise` or a null test",
    source: "let n = hostValue + 1",
    at: "hostValue + 1",
    what: "this binary expression",
  },
  {
    row: "binaryExpression",
    condition: "a comparison is a null test only with a `null` side",
    source: "let b = hostValue == 1",
    at: "hostValue == 1",
    what: "this binary expression",
  },
  {
    row: "binaryExpression",
    condition: "a null test is `==` or `!=`",
    source: "let b = hostValue < null",
    at: "hostValue < null",
    what: "this binary expression",
  },
  {
    row: "typeTestExpression",
    condition: "a written type of the slice",
    source: "let b = hostValue is integer | string",
    at: "integer | string",
    what: "this written type",
  },
  {
    row: "callExpression",
    condition: "one of `sliceCall`'s shapes",
    source: "let n = toInteger(hostValue)",
    at: "toInteger(hostValue)",
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "a method of `sliceMethod`'s shapes",
    source: "let xs = [1]\nxs.add(2)",
    at: "xs.add(2)",
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "a method's receiver is walked",
    source: "let n = [hostValue + 1].get(0, default: 1)",
    at: "hostValue + 1",
    what: "this binary expression",
  },
  {
    row: "callExpression",
    condition: "a method other than `get` takes no named argument",
    source: "let xs = [1]\nlet b = xs.contains(1, default: false)",
    at: "xs.contains(1, default: false)",
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "a method other than `get` takes no named argument, also in its contract's count",
    source: "let xs = [1]\nlet b = xs.contains(other: 1)",
    at: "xs.contains(other: 1)",
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "a method takes no more arguments than its contract",
    source: "let xs = [1]\nlet b = xs.contains(1, 2)",
    at: "xs.contains(1, 2)",
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "a method takes its contract's required arguments",
    source: "let xs = [1]\nlet b = xs.contains()",
    at: "xs.contains()",
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "a method that copies its receiver's elements",
    source: "let xs = [1]\nlet ys = xs.take(1)",
    at: "xs.take(1)",
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "`get` with `default:` alone",
    source: "let xs = [1]\nlet n = xs.get(0, default: 1, other: 2)",
    at: "xs.get(0, default: 1, other: 2)",
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "`toJson` of one value",
    source: "let t = toJson(hostValue, hostValue)",
    at: "toJson(hostValue, hostValue)",
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "`toJson` with no named argument",
    source: 'let t = toJson(hostValue, default: "")',
    at: 'toJson(hostValue, default: "")',
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "one positional argument beside `default:`",
    source: "let n = toInteger(hostValue, hostValue, default: 0)",
    at: "toInteger(hostValue, hostValue, default: 0)",
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "a conversion with `default:` alone",
    source: "let n = toInteger(hostValue, default: 0, other: 1)",
    at: "toInteger(hostValue, default: 0, other: 1)",
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "a conversion of a value of named kinds (not `toString`)",
    source: 'let t = toString(hostValue, default: "")',
    at: 'toString(hostValue, default: "")',
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "`fromJson` with `files:` alone beside `default:`",
    source: 'let v = fromJson("1", default: 0, other: 1)',
    at: 'fromJson("1", default: 0, other: 1)',
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "`fromJson` with `files: false` only",
    source: 'let v = fromJson("1", default: 0, files: true)',
    at: 'fromJson("1", default: 0, files: true)',
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "`fileFromBase64` with `default:` alone",
    source: 'let f = fileFromBase64("YQ==", default: hostValue, other: 1)',
    at: 'fileFromBase64("YQ==", default: hostValue, other: 1)',
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "a decryption with one of `password:` and `key:`",
    source: 'let t = decryptText("x", default: "", password: "p", key: "k")',
    at: 'decryptText("x", default: "", password: "p", key: "k")',
    what: "this call expression",
  },
  {
    row: "callExpression",
    condition: "a decryption with `password:` or `key:`",
    source: 'let t = decryptText("x", default: "", other: "p")',
    at: 'decryptText("x", default: "", other: "p")',
    what: "this call expression",
  },
  {
    row: "loadExpression",
    condition: "a `default:`",
    source: 'let v = load "k"',
    at: 'load "k"',
    what: "this load expression",
  },
  {
    row: "loadExpression",
    condition: "a default that is no `null`",
    source: 'let v = load "k", default: null',
    at: 'load "k", default: null',
    what: "this load expression",
  },
  {
    row: "loadExpression",
    condition: "a default that is no `null`, in parentheses",
    source: 'let v = load "k", default: (null)',
    at: 'load "k", default: (null)',
    what: "this load expression",
  },
  {
    row: "loadExpression",
    condition: "a key no earlier load of the project wrote",
    source: 'let a = load "k", default: 1\nlet b = load "k", default: 2',
    at: 'load "k", default: 2',
    what: "this load expression",
  },
  {
    row: "loadExpression",
    condition: "a key no earlier load of the project wrote, the empty key",
    source: 'let a = load "", default: 1\nlet b = load "", default: 2',
    at: 'load "", default: 2',
    what: "this load expression",
  },
  {
    row: "loadExpression",
    condition: "a key no earlier load of the project wrote, written in parentheses",
    source: 'let a = load(("key"), default: 1)\nlet b = load(("key"), default: 2)',
    at: 'load(("key"), default: 2)',
    what: "this load expression",
  },
  {
    row: "loadExpression",
    condition:
      "a key no earlier load of the project wrote, written in parentheses within parentheses",
    source: 'let a = load((("key")), default: 1)\nlet b = load((("key")), default: 2)',
    at: 'load((("key")), default: 2)',
    what: "this load expression",
  },
  {
    row: "gotoStatement",
    condition: "a file or `script(…)` target, not a label",
    source: "goto top\nlabel top",
    at: "goto top",
    what: "this goto statement",
  },
  {
    row: "gotoStatement",
    condition: "a `script(…)` call, not a grouped target",
    source: "goto (hostValue)",
    at: "goto (hostValue)",
    what: "this goto statement",
  },
  {
    row: "gotoStatement",
    condition: "`script(…)` with an argument",
    source: "goto script()",
    at: "goto script()",
    what: "this goto statement",
  },
  {
    row: "gotoStatement",
    condition: "`script(…)` with one argument",
    source: 'goto script("main.tease", "b")',
    at: 'goto script("main.tease", "b")',
    what: "this goto statement",
  },
  {
    row: "gotoStatement",
    condition: "`script(…)` with a positional argument",
    source: 'goto script(path: "main.tease")',
    at: 'goto script(path: "main.tease")',
    what: "this goto statement",
  },
  {
    row: "gotoStatement",
    condition: "the path is walked",
    source: "goto script(-hostValue)",
    at: "-hostValue",
    what: "this unary expression",
  },
  {
    row: "interactionExpression",
    condition: "an ask whose answer the core gives a kind: not `askBooleans`",
    source: 'let r = askBooleans "q", texts: ["a"], prefill: [true]',
    at: 'askBooleans "q", texts: ["a"], prefill: [true]',
    what: "this ask",
  },
  {
    row: "interactionExpression",
    condition: "an ask whose answer the core gives a kind: not `askForm`",
    source: 'let r = askForm "q", fields: {name: "text"}',
    at: 'askForm "q", fields: {name: "text"}',
    what: "this ask",
  },
  {
    row: "interactionExpression",
    condition: "no `prefill:` on `askPassword`",
    source: 'let r = askPassword("q", prefill: hostValue)',
    at: 'askPassword("q", prefill: hostValue)',
    what: "this ask",
  },
  {
    row: "interactionExpression",
    condition: "a prefill written as a literal: a computed one is outside",
    source: 'let r = askText("q", prefill: hostValue)',
    at: 'askText("q", prefill: hostValue)',
    what: "this ask",
  },
  {
    row: "interactionExpression",
    condition: "a prefill written as a literal: a negative number is an operator, not one",
    source: 'let r = askNumber("q", prefill: -2)',
    at: 'askNumber("q", prefill: -2)',
    what: "this ask",
  },
  {
    row: "interactionExpression",
    condition: "a prefill written as a literal, in the compact form too",
    source: 'let r = askBoolean "q", prefill: hostValue',
    at: 'askBoolean "q", prefill: hostValue',
    what: "this ask",
  },
  {
    row: "interactionExpression",
    condition: "a literal prefill in parentheses is read as the literal",
    source: 'let r = askText("q", prefill: (null))',
    at: 'askText("q", prefill: (null))',
    what: "this ask",
  },
  {
    row: "interactionExpression",
    condition: "a text literal prefill only on `askText` or `askChoice`",
    source: 'let r = askNumber("q", prefill: "2")',
    at: 'askNumber("q", prefill: "2")',
    what: "this ask",
  },
  {
    row: "interactionExpression",
    condition: "a text literal prefill that is not blank",
    source: 'let r = askText("q", prefill: "  ")',
    at: 'askText("q", prefill: "  ")',
    what: "this ask",
  },
  {
    row: "interactionExpression",
    condition: "a number literal prefill only on `askNumber`, `askInteger` or `askChoice`",
    source: 'let r = askText("q", prefill: 2)',
    at: 'askText("q", prefill: 2)',
    what: "this ask",
  },

  {
    row: "interactionExpression",
    condition: "a number literal prefill of `askInteger` written as a whole number",
    source: 'let r = askInteger("q", prefill: 2.0)',
    at: 'askInteger("q", prefill: 2.0)',
    what: "this ask",
  },
  {
    row: "interactionExpression",
    condition: "a number literal prefill of `askInteger` in the safe range",
    source: 'let r = askInteger("q", prefill: 9007199254740993)',
    at: 'askInteger("q", prefill: 9007199254740993)',
    what: "this ask",
  },
  {
    row: "interactionExpression",
    condition: "a truth value literal prefill only on `askBoolean` or `askChoice`",
    source: 'let r = askText("q", prefill: true)',
    at: 'askText("q", prefill: true)',
    what: "this ask",
  },
  {
    row: "interactionExpression",
    condition: "a `null` literal prefill only on `askChoice`",
    source: 'let r = askBoolean("q", prefill: null)',
    at: 'askBoolean("q", prefill: null)',
    what: "this ask",
  },
  {
    row: "interactionExpression",
    condition: "its parts are walked",
    source: "let r = askText(-hostValue)",
    at: "-hostValue",
    what: "this unary expression",
  },
];

/** The open rows that check nothing of their own: each walks its children. */
const UNCONDITIONAL: readonly SyntaxKind[] = [
  "speakerDeclaration",
  "speakerSetterStatement",
  "showButtonStatement",
  "waitStatement",
  "showImageStatement",
  "hideImageStatement",
  "showPopupStatement",
  "openUrlStatement",
  "exportTextStatement",
  "stopAudioStatement",
  "deleteStatement",
  "exitStatement",
  "ifStatement",
  "repeatStatement",
  "forStatement",
  "booleanLiteral",
  "nullLiteral",
  "numberLiteral",
  "regexLiteral",
  "listLiteral",
  "objectLiteral",
  "parenthesizedExpression",
  "indexExpression",
  "rangeExpression",
  // (a unit's or an angle's amount is judged after the analysis)
  "unitExpression",
  "angleExpression",
];

test("every open row is in the condition inventory or has no condition of its own", () => {
  // EVIDENCE: invariant: the table's keys are exactly the AST kinds (its mapped type).
  const modelled = (Object.keys(DISPOSITIONS) as SyntaxKind[])
    .filter((kind) => DISPOSITIONS[kind].row !== "refused")
    .sort();
  const conditional = [...new Set(CONDITIONS.map((condition) => condition.row))];
  assert.deepEqual(
    conditional.filter((kind) => UNCONDITIONAL.includes(kind)),
    [],
  );
  assert.deepEqual([...conditional, ...UNCONDITIONAL].sort(), modelled);
});

test("a written union nested deeper than the analysis walks is refused as a written type in every mode, never thrown", () => {
  // (the direct analysis of such a type throws `RangeError`; the slice takes no union, so the route never reaches it)
  for (const depth of [2_000, 10_000]) {
    let type = "integer";
    for (let level = 0; level < depth; level += 1) type = `(integer | ${type})`;
    const source = `let x: ${type} = hostValue\nexit\n`;
    for (const mode of HELD_MODES)
      assert.throws(
        () =>
          mode.run(() =>
            compileProjectWithBackend(
              [{ path: "main.tease", source }],
              { globals: ["hostValue"] },
              CORE_BACKEND,
            ),
          ),
        (error) => error instanceof CandidateOutsideSlice && error.what === "this written type",
        `${depth} levels [${mode.name}]`,
      );
  }
});

test("each open row refuses where its own condition fails, at its construct, with its text", () => {
  for (const condition of CONDITIONS) {
    const name = `${condition.row}, ${condition.condition}: ${condition.source}`;
    assert.notEqual(DISPOSITIONS[condition.row].row, "refused", name);
    const source = `${condition.source}\n`;
    assert.equal(source.indexOf(condition.at), source.lastIndexOf(condition.at), name);
    let refused: unknown = null;
    try {
      compileProjectWithBackend(
        [{ path: "main.tease", source }],
        { globals: ["hostValue"] },
        CORE_BACKEND,
      );
    } catch (error) {
      refused = error;
    }
    assert.ok(refused instanceof CandidateOutsideSlice, `${name}: refused`);
    const start = source.indexOf(condition.at);
    const expected = { start, end: start + condition.at.length, what: condition.what };
    assert.deepEqual(
      { start: refused.site.start, end: refused.site.end, what: refused.what },
      expected,
      name,
    );
    // the syntax rule alone, as the contract capture reads it (`consumers.ts`): a refusal the route makes after the
    // analysis (`outsideAnswers`) at the same construct cannot stand in for the row's own
    const file = { path: "main.tease", program: parse(source).program, source, picks: new Map() };
    const own = outsideSyntax([file], new Set(["hostValue"]));
    assert.deepEqual(
      { start: own?.span.start.offset, end: own?.span.end.offset, what: own?.what },
      expected,
      `${name}: the syntax rule`,
    );
  }
});
