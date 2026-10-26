import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import type { FlowNode } from "../src/type-inference/core/flow-graph.js";
import { propertyStep } from "../src/type-inference/core/program.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest } from "./helpers/type-core-analysis.js";

/** The analysis of `source` in the core's order and with its consumers' and solver's orders reversed. */
function bothOrders(source: string): readonly Answers[] {
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
  assert.ok(request !== null, source);
  return [
    analyseCore(request),
    withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => analyseCore(request),
      ),
    ),
  ];
}

/** The flow node of the expression at `start` in `source`, `length` long. */
function nodeAt(answers: Answers, start: number, length: number): FlowNode {
  const node = answers.graph.expressionAt({ file: 0, start, end: start + length });
  assert.ok(node !== undefined);
  return node;
}

test("a value's answer at a path below it gives its kinds there and the properties it is known to have (S3 §1, S7)", () => {
  const call = 'fromJson(hostValue, default: {stats: {n: 0, m: 1.5}, tag: "a"}, files: false)';
  const source = `let p = ${call}\nsay p.tag\nexit\n`;
  for (const answers of bothOrders(source)) {
    const node = nodeAt(answers, source.indexOf(call), call.length);
    const at = (path: readonly string[]): string => {
      const answer = answers.valueAt(node, path);
      return `${[...new Set(answer.items.map((item) => item.tag))].sort().join("|")} [${[...answer.properties].sort().join(", ")}]`;
    };
    assert.equal(at([]), "object [stats, tag]");
    assert.equal(at([propertyStep("stats")]), "object [m, n]");
    // a level that holds no object has no properties to find
    assert.equal(at([propertyStep("stats"), propertyStep("m")]), "number []");
    assert.equal(at([propertyStep("tag")]), "string []");
  }
});

test("a place's known properties at a path are those its literals and its property stores give it (S3 §1, S7)", () => {
  const source = "let d = {s: {x: 1}}\nd.t = 2\nd.s.y = 3\nsay d.t\nexit\n";
  for (const answers of bothOrders(source)) {
    // the read of `d` that `say` shows a property of
    const read = source.indexOf("say d.t") + "say ".length;
    const place = answers.at(nodeAt(answers, read, 1))?.place;
    assert.ok(place !== null && place !== undefined);
    assert.deepEqual([...answers.placeProperties(place.id)].sort(), ["s", "t"]);
    assert.deepEqual([...answers.placeProperties(place.id, [propertyStep("s")])].sort(), [
      "x",
      "y",
    ]);
  }
});

test("a place's admitted domain says whether a copy of a written type decides it (A4 through copies, r4.75 (1); S7)", () => {
  const source =
    "let a: number = 0\nlet b = a\nlet out = [a]\nlet own = 1.5\nlet copy = own\nsay b\nexit\n";
  for (const answers of bothOrders(source)) {
    const inherited = (name: string, path: readonly string[] = []): string => {
      // the place the `let` of `name` stores into
      const start = source.indexOf(`let ${name} = `);
      const statement = answers.graph.statementAt({
        file: 0,
        start,
        end: source.indexOf("\n", start),
      });
      assert.ok(statement !== undefined, name);
      const place = answers.at(statement)?.place;
      assert.ok(place !== null && place !== undefined, name);
      const admitted = answers.place(place.id, path).admitted;
      return `${admitted.by}${admitted.by === "decided" ? ` ${admitted.inherited}` : ""}`;
    };
    assert.equal(inherited("b"), "decided true");
    assert.equal(inherited("out", ["element"]), "decided true");
    assert.equal(inherited("copy"), "decided false");
    assert.equal(inherited("own"), "decided false");
  }
});
