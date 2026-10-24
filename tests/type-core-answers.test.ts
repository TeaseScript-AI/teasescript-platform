import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import type { FlowNode } from "../src/type-inference/core/flow-graph.js";
import { coreRequest } from "./helpers/type-core-analysis.js";

/**
 * The core's published answers per occurrence, projection and property (the port plan's S3 note §1), which the kept
 * adapters will read: a statement that stores answers for its place, a read below a binding names its route and its
 * place, a projection of a value that is no place has none, and a value's properties come from every source the
 * contract and the literal index know (review r1).
 */

function analysed(source: string): {
  readonly answers: Answers;
  readonly node: (text: string, kind?: string) => FlowNode;
} {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, "the program parses and resolves");
  const answers = analyseCore(request);
  return {
    answers,
    node: (text, kind = "expression") => {
      const found = answers.graph.nodes.find(
        (candidate) =>
          candidate.kind === kind &&
          candidate.span !== null &&
          source.slice(candidate.span.start.offset, candidate.span.end.offset) === text,
      );
      assert.ok(found !== undefined, `a ${kind} node for ${text}`);
      return found;
    },
  };
}

test("a dict's entries project to its values' kinds", () => {
  const { answers, node } = analysed("let d = dict {a: 1}\nsay d");
  assert.deepEqual(
    answers.project(node("d"), "entry").map((item) => item.tag),
    ["integer"],
  );
  const record = analysed("let box = {left: 1}\nsay box");
  assert.deepEqual(
    record.answers.project(record.node("box"), { property: "left" }).map((item) => item.tag),
    ["integer"],
  );
});

test("the properties of a projected value and of a call's result are known", () => {
  const nested = analysed("let box = {nested: {value: 2}}\nsay box.nested");
  assert.deepEqual([...nested.answers.properties(nested.node("box.nested")).keys()], ["value"]);
  const made = analysed("function make { return {left: 1} }\nsay make()");
  assert.deepEqual([...made.answers.properties(made.node("make()")).keys()], ["left"]);
  const edited = analysed("let box = {left: 1}\nbox.right = 2\nlet copy = box\nsay copy");
  assert.deepEqual([...edited.answers.properties(edited.node("copy")).keys()], ["left", "right"]);
});

test("a statement that stores answers for the place it stores into", () => {
  const { answers, node } = analysed("let x: integer = hostValue\nx = hostValue");
  const answer = answers.at(node("x = hostValue", "statement"));
  assert.ok(answer !== null);
  assert.deepEqual(
    { route: answer.route, path: answer.place?.path, tags: answer.items.map((item) => item.tag) },
    { route: "value", path: [], tags: ["unknown"] },
  );
});

test("a read below a binding names its route and place; a projection of no place has none", () => {
  const read = analysed("let box = {left: 1}\nsay box.left");
  const answer = read.answers.at(read.node("box.left"));
  assert.deepEqual(
    { route: answer?.route, path: answer?.place?.path },
    { route: "exact", path: ["left"] },
  );
  const literal = analysed("say [hostValue][0]");
  assert.equal(literal.answers.at(literal.node("[hostValue][0]"))?.place, null);
});
