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
    files: ["let a = [hostValue, -1]\nlet b = [[2 s]]\n"],
    outer: "listLiteral",
    inner: "unaryExpression",
    file: 0,
    at: "-1",
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
