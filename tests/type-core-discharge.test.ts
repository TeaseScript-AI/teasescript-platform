import assert from "node:assert/strict";
import test from "node:test";

import type { CallExpression, Expression } from "../src/ast.js";
import { lazyDefaultArgument } from "../src/lazy-defaults.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import type { Obligation } from "../src/type-inference/core/result.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { readFixture } from "./helpers/type-core-fixture.js";

/**
 * The discharge map of the port plan's S3 note (§4, "Completeness"): every check the core emits has a row, which names
 * the runtime check that discharges it, and that check exists today or is S7's new plan content. A check is placed in
 * its row by its kind and by where it stands in the source: a store's value, an argument or a return (C1, C7), an
 * insertion's argument, a fallback's or a default's operand (C10), a use (C2–C6, C11–C13).
 */
const ROWS = [
  ["C1, C7: a store, an argument or a return", "the destination's TypeCheckPlan"],
  ["C1: an insertion", "the call's typeCheck (add, addAll) or the assignment's (a dict entry)"],
  ["C1, C7: a possible null into a destination that holds none", "the destination's TypeCheckPlan"],
  [
    "C9: a boundary against the destination's contract",
    "the destination's TypeCheckPlan or the load's",
  ],
  ["C9: a boundary against unknown", "the runtime's validation of representable external data"],
  [
    "F18: a fromJson's expected type where it is read",
    "S7: expected on the conversion and the file store",
  ],
  ["C2, C5a: a null at a use", "the runtime's check at the use"],
  ["C5b, C5c: a member at a read or a call", "the runtime's check at the access"],
  ["C5c: a property's presence at a store", "S7: requireExisting on the store"],
  ["C2: a whole number at a use", "the runtime's check at the use"],
  ["C2: the index of a list's get", "S7: the index check on the get"],
  ["C3, C4, C11, C12, C13: an operand", "the runtime's check at the operation"],
  ["C6: an element selection", "the runtime's check at the selection"],
  ["C10: a get's, a conversion's or a load's default", "the final instruction's typeCheck"],
  ["C10: an otherwise's fallback", "S7: fallbackCheck on the final instruction"],
] as const;

type Row = (typeof ROWS)[number][0];

/** The rows whose executable check is S7's new plan content (S3 §4's "new" rows). */
const NEW: readonly Row[] = ROWS.filter(([, check]) => check.startsWith("S7:")).map(([row]) => row);

/** The expressions that contain a site, outermost first. */
function enclosing(program: unknown, start: number, end: number): Expression[] {
  const found: Expression[] = [];
  const pending: unknown[] = [program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== "object" || node === null) continue;
    if (Array.isArray(node)) {
      pending.push(...node);
      continue;
    }
    // EVIDENCE: invariant: a parsed node is a plain object, read here by key.
    const fields = node as Readonly<Record<string, unknown>>;
    // EVIDENCE: invariant: a parsed node's `span`, where it has one, is its source span.
    const span = fields["span"] as
      | { readonly start: { readonly offset: number }; readonly end: { readonly offset: number } }
      | undefined;
    if (span !== undefined && typeof fields["kind"] === "string") {
      if (span.start.offset > start || span.end.offset < end) continue;
      // EVIDENCE: invariant: a node with a kind and a span is an AST node; expressions are told by their kind below.
      found.push(node as Expression);
    }
    for (const [key, value] of Object.entries(fields)) if (key !== "span") pending.push(value);
  }
  return found.sort(
    (a, b) => a.span.start.offset - b.span.start.offset || b.span.end.offset - a.span.end.offset,
  );
}

/** The row of a check, by its kind and where it stands; `null` where none fits. */
function rowOf(check: Obligation, program: unknown): Row | null {
  const unknown = check.against.length === 1 && check.against[0] === "unknown";
  if (check.boundary) {
    if (unknown) return "C9: a boundary against unknown";
    return check.target === "fromJson.result"
      ? "F18: a fromJson's expected type where it is read"
      : "C9: a boundary against the destination's contract";
  }
  const chain = enclosing(program, check.site.start, check.site.end);
  const site = chain.findLast(
    (node) =>
      node.span.start.offset === check.site.start && node.span.end.offset === check.site.end,
  );
  const parentOf = (node: Expression): Expression | undefined => chain[chain.indexOf(node) - 1];
  switch (check.kind) {
    case "copy-type": {
      if (site === undefined) return null;
      const parent = parentOf(site);
      // a fallback's or a default's own operand
      for (const call of chain.filter(
        (node): node is CallExpression => node.kind === "callExpression",
      )) {
        const lazy = lazyDefaultArgument(call);
        const own = call.arguments.find(
          (argument) => argument.kind === "namedArgument" && argument.name.name === "default",
        );
        if (own?.value === site)
          return lazy?.operation === "fileFromBase64" ||
            lazy?.operation === "decryptText" ||
            lazy?.operation === "decryptFile"
            ? null
            : "C10: a get's, a conversion's or a load's default";
      }
      if (
        parent?.kind === "binaryExpression" &&
        parent.operator === "otherwise" &&
        parent.right === site
      )
        return "C10: an otherwise's fallback";
      // an insertion's argument
      if (
        chain.some(
          (node) =>
            node.kind === "callExpression" &&
            node.callee.kind === "propertyAccessExpression" &&
            (node.callee.property.name === "add" || node.callee.property.name === "addAll") &&
            node.arguments.some(
              (argument) =>
                argument.value.span.start.offset <= check.site.start &&
                check.site.end <= argument.value.span.end.offset,
            ),
        )
      )
        return "C1: an insertion";
      return "C1, C7: a store, an argument or a return";
    }
    case "null-check":
      if (!(check.against.length === 1 && check.against[0] === "non-null"))
        return "C1, C7: a possible null into a destination that holds none";
      if (
        check.on.endsWith("before the store") &&
        !check.on.endsWith("is not null before the store")
      )
        return "C5c: a property's presence at a store";
      return check.on.includes(" has ") || check.on.includes(" with .")
        ? "C5b, C5c: a member at a read or a call"
        : "C2, C5a: a null at a use";
    case "integer-check":
      return chain.some(
        (node) =>
          node.kind === "callExpression" &&
          node.callee.kind === "propertyAccessExpression" &&
          node.callee.property.name === "get" &&
          node.arguments[0]?.kind === "positionalArgument" &&
          node.arguments[0].value === site,
      )
        ? "C2: the index of a list's get"
        : "C2: a whole number at a use";
    case "operand":
      return "C3, C4, C11, C12, C13: an operand";
    case "empty-check":
      return "C6: an element selection";
  }
}

test("every check the core emits has a row of the discharge map, its runtime check existing or S7's (S3 §4)", () => {
  const witnessed = new Map<Row, number>();
  const unplaced: string[] = [];
  for (const record of readFixture()) {
    const request = coreRequest(record.files);
    assert.ok(request !== null, record.name);
    const answers = analyseCore(request);
    for (const check of answers.checks) {
      const row = rowOf(check, request.files[check.site.file]!.program);
      if (row === null)
        unplaced.push(`${record.name}: ${check.kind} ${check.target} @${check.site.start}`);
      else witnessed.set(row, (witnessed.get(row) ?? 0) + 1);
    }
  }
  assert.deepEqual(unplaced, []);
  // every row has a record of the set that emits its check
  assert.deepEqual(
    ROWS.map(([row]) => row).filter((row) => !witnessed.has(row)),
    [],
  );
  assert.deepEqual(NEW, [
    "F18: a fromJson's expected type where it is read",
    "C5c: a property's presence at a store",
    "C2: the index of a list's get",
    "C10: an otherwise's fallback",
  ]);
});
