/*
 * The rewind owner's adoption reads, read from its source: each read's settlement is wired through its ownership check.
 * What a settlement says is the rewind read family's (`player-session-rewind.test.ts`).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const HOST_ROOT = "player/vue/src";
/** The rewind's owner, whose adoption replaces the saved values. */
const REWIND = "session/useSessionRewind.ts";

/**
 * Each read of an adoption's saved values (`captureStorage`) in `source`, and how its settlement is wired: a `.then`
 * whose reply and rejection callbacks each call `settleAdoption` and nothing else, awaited as it is, with nothing chained
 * after it; `settleAdoption` referenced nowhere else; and `settleAdoption`'s first statement returning `false` unless
 * `ownsShown(...)` holds. What a settlement says is not seen here: that no stale failure notice shows once the page moved
 * on is the rewind read family's (`player-session-rewind.test.ts`).
 */
function adoptionSettlements(source: ts.SourceFile): { reads: number; problems: string[] } {
  const problems: string[] = [];
  let reads = 0;
  const line = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const settles = (callback: ts.Expression | undefined) =>
    callback !== undefined &&
    ts.isArrowFunction(callback) &&
    ts.isCallExpression(callback.body) &&
    ts.isIdentifier(callback.body.expression) &&
    callback.body.expression.text === "settleAdoption";
  // The `settleAdoption` references the admitted reads' callbacks make; any other is a second settlement.
  const admitted = new Set<ts.Node>();
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === "settleAdoption" &&
      !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node) &&
      !admitted.has(node)
    )
      problems.push(
        `${line(node)}: settleAdoption is reached outside the adoption read's settlement`,
      );
    if (ts.isStringLiteralLike(node) && node.text === "captureStorage") {
      const read = node.parent;
      const access = read.parent;
      const then = access?.parent;
      if (
        ts.isCallExpression(read) &&
        read.arguments[1] === node &&
        ts.isPropertyAccessExpression(read.expression) &&
        read.expression.name.text === "read" &&
        ts.isPropertyAccessExpression(access) &&
        access.name.text === "then" &&
        ts.isCallExpression(then) &&
        then.arguments.length === 2 &&
        settles(then.arguments[0]) &&
        settles(then.arguments[1]) &&
        ts.isAwaitExpression(then.parent)
      ) {
        reads += 1;
        for (const callback of then.arguments)
          if (ts.isArrowFunction(callback) && ts.isCallExpression(callback.body))
            admitted.add(callback.body.expression);
      } else
        problems.push(
          `${line(node)}: a captureStorage read that does not settle only through settleAdoption`,
        );
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === "settleAdoption") {
      const first = node.body?.statements[0];
      const guarded =
        first !== undefined &&
        ts.isIfStatement(first) &&
        ts.isPrefixUnaryExpression(first.expression) &&
        first.expression.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isCallExpression(first.expression.operand) &&
        ts.isIdentifier(first.expression.operand.expression) &&
        first.expression.operand.expression.text === "ownsShown" &&
        ts.isReturnStatement(first.thenStatement) &&
        first.thenStatement.expression?.kind === ts.SyntaxKind.FalseKeyword;
      if (!guarded)
        problems.push(`${line(node)}: settleAdoption does not begin with its ownership check`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { reads, problems };
}

test("an adoption's read reaches settleAdoption only from its two callbacks, with nothing chained after it, and settleAdoption begins with its ownership check", () => {
  const { reads, problems } = adoptionSettlements(
    ts.createSourceFile(
      REWIND,
      readFileSync(resolve(process.cwd(), HOST_ROOT, REWIND), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    ),
  );
  assert.deepEqual(problems, []);
  assert.equal(reads, 1, "the adoption's one read");
  const of = (text: string) =>
    adoptionSettlements(ts.createSourceFile("a.ts", text, ts.ScriptTarget.Latest, true)).problems;
  // A rejection that skips it, a read awaited on its own, and an unguarded settlement are each found.
  assert.deepEqual(
    of(
      'host.read(s, "captureStorage").then((c) => settleAdoption(o, s, { capture: c }), () => false);',
    ),
    [
      "1: a captureStorage read that does not settle only through settleAdoption",
      "1: settleAdoption is reached outside the adoption read's settlement",
    ],
  );
  assert.equal(of('const c = await host.read(s, "captureStorage");').length, 1);
  assert.equal(of("async function settleAdoption() { await write(); }").length, 1);
  // The ownership check is `if (!ownsShown(...)) return false;`: another prefix operator is no check.
  const guardedBy = (operator: string) =>
    of(
      `async function settleAdoption() { if (${operator}ownsShown(o, s)) return false; await write(); }`,
    );
  assert.deepEqual(guardedBy("!"), []);
  for (const operator of ["+", "-", "~"])
    assert.deepEqual(
      guardedBy(operator),
      ["1: settleAdoption does not begin with its ownership check"],
      operator,
    );
  // A second settlement chained after the read's, which calls settleAdoption again, is found.
  const read =
    'await host.read(s, "captureStorage").then((c) => settleAdoption(o, s, { capture: c }), (e) => settleAdoption(o, s, { error: e }))';
  assert.deepEqual(of(`async function f() { ${read}; }`), []);
  assert.deepEqual(
    of(
      `async function f() { ${read.replace("await ", "await (")}).then((a) => a ? settleAdoption(o, s, { capture: c }) : false); }`,
    ),
    [
      "1: a captureStorage read that does not settle only through settleAdoption",
      "1: settleAdoption is reached outside the adoption read's settlement",
      "1: settleAdoption is reached outside the adoption read's settlement",
      "1: settleAdoption is reached outside the adoption read's settlement",
    ],
  );
});
