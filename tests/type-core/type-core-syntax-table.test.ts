import assert from "node:assert/strict";
import test from "node:test";

import { compileProjectWithBackend } from "../../src/compiler.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { DISPOSITIONS, type SyntaxKind } from "../../src/type-inference/core/slice-syntax.js";

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
    files: ['let o = {k: [hostValue, {m: "a" otherwise 2 s}]}\n'],
    outer: "objectLiteral",
    inner: "durationLiteral",
    file: 0,
    at: "2 s",
  },
  {
    name: "a closed statement after an open one in the same list",
    files: ["let a = hostValue\nwait 1 s\n"],
    outer: "letStatement",
    inner: "waitStatement",
    file: 0,
    at: "wait 1 s",
  },
  {
    name: "the first of two closed constructs in source order, the later one deeper",
    files: ["let a = [-1, [2 s]]\n"],
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
    assert.equal(
      DISPOSITIONS[composite.outer].row,
      "modelled",
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

/** A modelled row's own condition, on its refusing side: the source, the construct's text, and the row's words. */
interface Condition {
  readonly row: SyntaxKind;
  /** What the row checks, in words. */
  readonly condition: string;
  readonly source: string;
  readonly at: string;
  readonly what: string;
}

/**
 * The inventory of the modelled rows' own conditions, one source each: the conditions of main's `outsideSyntax` cases
 * (a85dc7d8f929ea7cd74f133834b3ce4c9ff487a3) that became the rows. Every other modelled row has none
 * (`UNCONDITIONAL`); the inventory test below keeps the two lists equal to the table's modelled rows.
 */
const CONDITIONS: readonly Condition[] = [
  {
    row: "letStatement",
    condition: "a written type of the slice",
    source: "let x: integer | string = 1",
    at: "integer | string",
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
    condition: "no presentation",
    source: 'say prose(color: "red") "A letter."',
    at: "say prose",
    what: "this say",
  },
  {
    row: "sayStatement",
    condition: "no speaker",
    source: 'say as player "Hold."',
    at: "say as",
    what: "this say",
  },
  {
    row: "sayStatement",
    condition: "no skip policy",
    source: 'say skippable "Hold."',
    at: "say skippable",
    what: "this say",
  },
  {
    row: "sayStatement",
    condition: "no pacing",
    source: 'say "Hold.", instant',
    at: "say",
    what: "this say",
  },
  {
    row: "sayStatement",
    condition: "shown text without interpolation",
    source: 'say "Hi ${hostValue}"',
    at: "say",
    what: "this say",
  },
  {
    row: "expressionStatement",
    condition: "a call",
    source: 'askBooleans("Q?", texts: ["A"], prefill: [false], cancel: "Back")',
    at: "askBooleans",
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
    at: '"a',
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
    row: "binaryExpression",
    condition: "`otherwise` or a null test",
    source: "let n = hostValue + 1",
    at: "hostValue + 1",
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
    at: "toInteger",
    what: "this call expression",
  },
  {
    row: "loadExpression",
    condition: "a `default:`",
    source: 'let v = load "k"',
    at: "load",
    what: "this load expression",
  },
  {
    row: "loadExpression",
    condition: "a default that is no `null`",
    source: 'let v = load "k", default: null',
    at: "load",
    what: "this load expression",
  },
  {
    row: "loadExpression",
    condition: "a key no earlier load of the project wrote",
    source: 'let a = load "k", default: 1\nlet b = load "k", default: 2',
    at: 'load "k", default: 2',
    what: "this load expression",
  },
];

/** The modelled rows that check nothing of their own: each walks its children. */
const UNCONDITIONAL: readonly SyntaxKind[] = [
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
];

test("every modelled row is in the condition inventory or has no condition of its own", () => {
  // EVIDENCE: invariant: the table's keys are exactly the AST kinds (its mapped type).
  const modelled = (Object.keys(DISPOSITIONS) as SyntaxKind[])
    .filter((kind) => DISPOSITIONS[kind].row === "modelled")
    .sort();
  const conditional = [...new Set(CONDITIONS.map((condition) => condition.row))];
  assert.deepEqual(
    conditional.filter((kind) => UNCONDITIONAL.includes(kind)),
    [],
  );
  assert.deepEqual([...conditional, ...UNCONDITIONAL].sort(), modelled);
});

test("each modelled row refuses where its own condition fails, at its construct, with its text", () => {
  for (const condition of CONDITIONS) {
    const name = `${condition.row}, ${condition.condition}: ${condition.source}`;
    assert.equal(DISPOSITIONS[condition.row].row, "modelled", name);
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
    assert.deepEqual(
      { start: refused.site.start, what: refused.what },
      { start: source.indexOf(condition.at), what: condition.what },
      name,
    );
  }
});
