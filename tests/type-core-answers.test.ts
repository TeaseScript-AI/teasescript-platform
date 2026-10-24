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
  // a source a literal holds, and projections of literals and of computed values (review r2, r3)
  for (const [source, text] of [
    ["let inner = {value: 2}\nlet outer = {nested: inner}\nsay outer.nested", "outer.nested"],
    [
      "function make { return {value: 2} }\nlet outer = {nested: make()}\nsay outer.nested",
      "outer.nested",
    ],
    ["let inner = {value: 2}\nsay [inner][0]", "[inner][0]"],
    ["say [{value: 2}][0]", "[{value: 2}][0]"],
    ["say {nested: {value: 2}}.nested", "{nested: {value: 2}}.nested"],
    // a fallback's operands, an object's own `length`, a loop's element, a sum's elements (review r3)
    ["say null otherwise {value: 2}", "null otherwise {value: 2}"],
    ["say {length: {value: 2}}.length", "{length: {value: 2}}.length"],
    ["for item in [{value: 2}] { say item }", "item"],
    ["say ([{value: 2}] + [{value: 2}])[0]", "([{value: 2}] + [{value: 2}])[0]"],
    // removals' elements and a choice's option value (review r4)
    ["let xs = [{value: 2}]\nsay xs.removeFirst()", "xs.removeFirst()"],
    ["let xs = [{value: 2}]\nsay xs.removeAt(0)", "xs.removeAt(0)"],
    ['let d = dict {key: {value: 2}}\nsay d.remove("key")', 'd.remove("key")'],
    [
      'say askChoice [{text: "A", value: {value: 2}}]',
      'askChoice [{text: "A", value: {value: 2}}]',
    ],
    // a whole choice object, written and bound (review r5)
    ['say askChoice {text: "A", value: {value: 2}}', 'askChoice {text: "A", value: {value: 2}}'],
    ['let option = {text: "A", value: {value: 2}}\nsay askChoice option', "askChoice option"],
  ] as const) {
    const held = analysed(source);
    const properties = held.answers.properties(held.node(text));
    assert.deepEqual(
      [...properties].map(([name, items]) => `${name}: ${items.map((item) => item.tag).join(",")}`),
      ["value: integer"],
      text,
    );
  }
});

test("a value that holds no object has no properties, and a deep chain of operations is walked", () => {
  // a dict's keys, a list's removed value (review r4)
  for (const [source, text] of [
    ["for item in dict {key: {value: 2}} { say item }", "item"],
    ["let xs = [{value: 2}]\nlet gone = xs.remove({value: 2})\nsay gone", "gone"],
  ] as const) {
    const held = analysed(source);
    assert.deepEqual([...held.answers.properties(held.node(text)).keys()], [], text);
  }
  // 4,096 fallbacks of one record: an explicit worklist, never the native stack
  const expression = ["{value: 2}", ...Array<string>(4096).fill("null")].join(" otherwise ");
  const deep = analysed(`say ${expression}`);
  assert.deepEqual([...deep.answers.properties(deep.node(expression)).keys()], ["value"]);
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

test("a bare read names its binding's place, the one its declaration stores into (Astra B7)", () => {
  const { answers, node } = analysed("let n: integer = 1\nsay n\nexit");
  const declared = answers.at(node("let n: integer = 1", "statement"));
  const read = answers.at(node("n"));
  assert.ok(declared?.place && read?.place);
  assert.deepEqual(read.place, declared.place);
  assert.deepEqual(answers.place(read.place.id).admitted, { by: "written", kinds: ["integer"] });
});

test("a read's route is the path its answer took (Astra B5)", () => {
  const route = (source: string, text: string): string | undefined => {
    const { answers, node } = analysed(source);
    return answers.at(node(text))?.route;
  };
  // the exact path's definition answers
  assert.equal(route("let box = {left: 1}\nsay box.left\nexit", "box.left"), "exact");
  // F19a: a reference's member is opaque before the exact path
  assert.equal(
    route('speaker vera { mood: "calm" }\nlet alias = vera\nsay alias.mood\nexit', "alias.mood"),
    "contract",
  );
  // F5a: a loop add over an iterable that may hold no element takes the contract
  assert.equal(
    route(
      'let flag = askBoolean "f"\nlet items = [1]\nif flag { items.clear() }\nlet output = []\nfor n in items { output.add(n) }\nsay output.first\nexit',
      "output.first",
    ),
    "contract",
  );
  // F12: past an element step over a copy the contract answers
  assert.equal(
    route("let seed = {f: 1.5}\nlet rows = [seed]\nsay rows.first.f\nexit", "rows.first.f"),
    "contract",
  );
});

test("a place's definitions are the exact path's live list in region order (Astra B8)", () => {
  const dead = analysed("let n = 1\nif false { n = 2 }\nsay n\nexit");
  const binding = dead.answers.at(dead.node("let n = 1", "statement"))?.place;
  assert.ok(binding);
  const deadList = dead.answers.place(binding.id).definitions;
  // the dead assignment is no definition
  assert.deepEqual(
    deadList.list.map((d) => d.site.start),
    [8],
  );
  assert.equal(deadList.ownedAway, false);
  // F5a: the loop's exit add is one, after the initializer and the body's add
  const loop = analysed("let output = []\nfor n in [1] { output.add(n) }\nsay output\nexit");
  const output = loop.answers.at(loop.node("let output = []", "statement"))?.place;
  assert.ok(output);
  const list = loop.answers.place(output.id).definitions.list;
  assert.deepEqual(
    list.map((d) => `${d.kind}${d.orig === undefined ? "" : " exit"}`),
    ["whole", "add", "add exit"],
  );
});
