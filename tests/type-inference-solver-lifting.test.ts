import assert from "node:assert/strict";
import test from "node:test";

import { operationRelations } from "../src/type-inference/adapters/index.js";
import { collectGraph } from "../src/type-inference/collector.js";
import type { Constraint, ConstraintGraph } from "../src/type-inference/graph.js";
import { Cells } from "../src/type-inference/solver/cells.js";
import { interpret } from "../src/type-inference/solver/interpret.js";
import {
  lift,
  memberRelation,
  type LiftContext,
  type Operation,
} from "../src/type-inference/solver/lifting.js";
import { solve } from "../src/type-inference/solver/solve.js";
import { TypeTable } from "../src/type-inference/solver/types.js";
import { request } from "./helpers/type-inference-graph.js";

/**
 * The lifting of a relation's answers (O4 stage 3a, work note §3.5), over the real adapters and the graph's own
 * operations: strictness, the unevaluated lazy operand, a contract's defined union, a projection through the chosen
 * alternative, and the member rules for a property read.
 */

const RELATIONS = operationRelations();

function graphOf(source: string): ConstraintGraph {
  const made = request([{ path: "main.tease", source }]);
  assert.notEqual(made, null);
  return collectGraph(made!);
}

function operationOf(graph: ConstraintGraph, name: string): Operation {
  const c = graph.constraints.find(
    (constraint): constraint is Extract<Constraint, { kind: "operation" }> =>
      constraint.kind === "operation" && constraint.contract.name === name,
  );
  assert.notEqual(c, undefined, `an operation ${name}`);
  return {
    contract: c!.contract,
    receiver: c!.receiver,
    arguments: c!.arguments,
    named: c!.named,
    result: c!.result,
    site: c!.site.start,
    evidence: c!.evidence,
  };
}

/** The registry name of an atom node, for the assertions. */
function nameOf(node: ReturnType<TypeTable["node"]>): string {
  return node.kind === "atom" || node.kind === "restricted" ? node.name : node.kind;
}

function context(cells: Cells): LiftContext {
  return { cells, nonWorking: null, asks: 0 };
}

test("a strict operand without evidence is never asked; a lazy one is always also asked unevaluated", () => {
  const graph = graphOf('let r = toRegex("a", default: 1)\nexit');
  const table = new TypeTable();
  const cells = new Cells(table, graph.places.length);
  const op = operationOf(graph, "toRegex");
  const relation = RELATIONS.relation(op.contract);
  assert.deepEqual(
    lift(context(cells), op, relation),
    { changed: false, tally: null },
    "the text argument has no evidence",
  );
  cells.add(op.arguments[0]!, {
    tag: "w",
    type: table.internTerm({ kind: "atom", name: "string" }),
    pos: [1, 1],
  });
  const union = table.internTerm({
    kind: "union",
    members: [
      { kind: "atom", name: "regex" },
      { kind: "atom", name: "integer" },
    ],
  });
  cells.add(op.named[0]!.value, { tag: "m", type: union, group: "written:p", pos: [2, 2] });
  const first = lift(context(cells), op, relation);
  assert.equal(first.changed, true);
  const tags = cells
    .items(op.result)
    .map(
      (item) =>
        `${item.tag}:${table.node(item.type!).kind === "atom" ? "atom" : table.node(item.type!).kind}`,
    );
  // the unevaluated default gives the conversion's own regex as a witness; the typed alternatives give members
  assert.ok(tags.includes("w:atom"), `a witness from the bottom ask in ${tags.join(",")}`);
  assert.ok(tags.includes("m:atom"), `members from the typed default in ${tags.join(",")}`);
  assert.equal(lift(context(cells), op, relation).changed, false, "asking again adds nothing");
});

test("a contract's alternatives answer defines a permitted union; a cascade is not counted", () => {
  const graph = graphOf('let r = fromBase64("YQ==", default: 1)\nexit');
  const table = new TypeTable();
  const cells = new Cells(table, graph.places.length);
  const op = operationOf(graph, "fromBase64");
  cells.add(op.arguments[0]!, {
    tag: "w",
    type: table.internTerm({ kind: "atom", name: "string" }),
    pos: [1, 1],
  });
  const integer = table.internTerm({ kind: "atom", name: "integer" });
  cells.add(op.named[0]!.value, { tag: "w", type: integer, pos: [2, 2] });
  lift(context(cells), op, RELATIONS.relation(op.contract));
  assert.deepEqual(
    cells
      .items(op.result)
      .map((item) => [item.tag, item.group])
      .sort(),
    [
      ["m", `op@${op.site}`],
      ["m", `op@${op.site}`],
    ],
  );
  assert.equal(interpret(cells, op.result).kind, "known");
  // a boolean default cannot be the result's copy: invalid; counted unless it is a non-working alternative of a conflict
  cells.add(op.named[0]!.value, {
    tag: "w",
    type: table.internTerm({ kind: "atom", name: "boolean" }),
    pos: [3, 3],
  });
  const counted = lift(context(cells), op, RELATIONS.relation(op.contract));
  assert.equal(counted.tally!.invalid >= 1 || counted.tally!.asked >= 2, true);
  const silenced = lift(
    {
      cells,
      nonWorking: new Set([
        `${op.named[0]!.value}:${table.internTerm({ kind: "atom", name: "boolean" })}`,
      ]),
      asks: 0,
    },
    op,
    RELATIONS.relation(op.contract),
  );
  assert.equal(
    silenced.tally!.asked,
    counted.tally!.asked - 1,
    "the cascade combination is not counted at all",
  );
});

test("a property read goes through the member rules: a held part's items name their part, a missing member is invalid", () => {
  const graph = graphOf("let xs = [1]\nlet n = xs.length\nlet a = xs.first\nexit");
  const table = new TypeTable();
  const cells = new Cells(table, graph.places.length);
  const reads = graph.constraints.filter(
    (c): c is Extract<Constraint, { kind: "project" }> =>
      c.kind === "project" && typeof c.step === "object",
  );
  const owner = reads[0]!.owner;
  const part = cells.derived(owner, "element");
  cells.add(part, {
    tag: "w",
    type: table.internTerm({ kind: "atom", name: "integer" }),
    pos: [6, 6],
    decl: true,
  });
  cells.add(part, {
    tag: "w",
    type: table.internTerm({ kind: "atom", name: "string" }),
    pos: [9, 9],
  });
  cells.add(owner, { tag: "w", ctor: "list", parts: { element: part }, pos: [1, 1] });
  for (const read of reads)
    cells.add(read.owner, { tag: "w", ctor: "list", parts: { element: part }, pos: [1, 1] });
  const length = reads.find((c) => typeof c.step === "object" && c.step.property === "length")!;
  const first = reads.find((c) => typeof c.step === "object" && c.step.property === "first")!;
  const propertyOf = (c: typeof length): string =>
    typeof c.step === "object" ? c.step.property : "";
  const read = (c: typeof length): Operation => ({
    contract: { family: "member", name: propertyOf(c) },
    receiver: c.owner,
    arguments: [],
    named: [],
    result: c.into,
    site: c.site.start,
    evidence: undefined,
  });
  // EVIDENCE: the reads were filtered to property steps above.
  lift(context(cells), read(length), memberRelation("length"));
  assert.deepEqual(
    cells.items(length.into).map((item) => `${item.tag}:${nameOf(table.node(item.type!))}`),
    ["w:integer"],
  );
  lift(context(cells), read(first), memberRelation("first"));
  assert.deepEqual(
    cells.items(first.into).map((item) => [item.tag, [...item.from], item.decl]),
    [
      ["w", [part], false],
      ["w", [part], false],
    ],
    "the element's items, each naming the part it came from; the read's own position and no mark",
  );
  const scalar = cells.derived(0, "scalar");
  cells.add(scalar, {
    tag: "w",
    type: table.internTerm({ kind: "atom", name: "integer" }),
    pos: [1, 1],
  });
  const missing = lift(
    context(cells),
    {
      contract: { family: "member", name: "length" },
      receiver: scalar,
      arguments: [],
      named: [],
      result: cells.derived(0, "out"),
      site: 0,
      evidence: undefined,
    },
    memberRelation("length"),
  );
  assert.deepEqual(missing.tally, { asked: 1, invalid: 1 });
});

test("a symmetric relation is asked once per multiset of its arguments' alternatives", () => {
  const callOf = (count: number, declared: string, fn: string) => {
    const args = Array.from({ length: count }, () => "a").join(", ");
    const solution = solve(graphOf(`let a: ${declared} = 1\nlet b = ${fn}(${args})\nexit`), {
      relations: RELATIONS,
      verify: true,
    });
    return { asks: solution.asks, statuses: solution.statuses };
  };
  // k arguments over two alternatives are k + 1 multisets, not 2^k sequences: six arguments more cost the same asks
  // at every size (Dropje97's W2-B2 measured 786,432 asks for eighteen arguments before the rule)
  const six = callOf(6, "integer | number", "min");
  const twelve = callOf(12, "integer | number", "min");
  const eighteen = callOf(18, "integer | number", "min");
  assert.equal(eighteen.asks - twelve.asks, twelve.asks - six.asks);
  assert.ok(eighteen.asks < 100, `${eighteen.asks} asks for eighteen arguments`);
  // the status counts multisets: `max` over `integer | string` is valid for the all-integer multiset alone
  assert.deepEqual(callOf(6, "integer | string", "max").statuses, [
    "listFunction.max@36:partial(6/7)",
  ]);
  assert.deepEqual(callOf(12, "integer | string", "max").statuses, [
    "listFunction.max@36:partial(12/13)",
  ]);
  // arguments with different alternatives are their own groups: the multisets of each, combined
  const mixed = solve(
    graphOf(
      "let a: integer | number = 1\nlet c: integer | string = 2\nlet b = min(a, c, a, c, a, c)\nexit",
    ),
    { relations: RELATIONS, verify: true },
  );
  assert.deepEqual(mixed.statuses, ["listFunction.min@64:partial(12/16)"]);
});
