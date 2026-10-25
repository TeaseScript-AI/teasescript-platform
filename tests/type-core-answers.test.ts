import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import type { FlowNode } from "../src/type-inference/core/flow-graph.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
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
    // a dict's values, read and copied (TABLE r4.46 (2); #1027 review r3)
    ["let d = dict {k: {value: 2}}\nsay d.values.first", "d.values.first"],
    ["let d = dict {k: {value: 2}}\nlet p = d.values\nsay p.first", "p.first"],
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
  // F14: an object's own `length` takes its field's route; a collection's is computed
  assert.equal(
    route(
      "let seed = {length: 1.5}\nlet rows = [seed]\nsay rows.first.length\nexit",
      "rows.first.length",
    ),
    "contract",
  );
  assert.equal(
    route(
      'let flag = askBoolean "f"\nlet box = {length: 1}\nif flag { box.length = 1.5 }\nsay box.length\nexit',
      "box.length",
    ),
    "contract",
  );
  assert.equal(route("let box = {length: 1}\nsay box.length\nexit", "box.length"), "exact");
  assert.equal(route("let items = [1, 2]\nsay items.length\nexit", "items.length"), "exact");
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

test("a property named as an internal step keeps its name in the answers (Astra B1)", () => {
  const { answers, node } = analysed('let box = {element: 1, iteration: "a"}\nsay box\nexit');
  const box = node("box");
  assert.deepEqual(
    [...answers.properties(box)].map(
      ([name, items]) => `${name}: ${items.map((item) => item.tag).join(",")}`,
    ),
    ["element: integer", "iteration: string"],
  );
  assert.deepEqual(
    answers.project(box, { property: "iteration" }).map((item) => item.tag),
    ["string"],
  );
  // a store's member checks name the property as written
  const stored = analysed("let box = hostValue\nbox.element = 1\nexit").answers;
  assert.deepEqual(
    stored.checks.map((check) => check.on),
    ["check that box is a object with a store of .element before the store"],
  );
});

test("a handle's own length is the runtime's member, its consumer's check kept (F14, F19a)", () => {
  const read = (setup: string, text: string): string => {
    const { answers, node } = analysed(`${setup}\nrepeat ${text} {}\nexit`);
    const at = answers.at(node(text));
    const diagnostics = answers.diagnostics.map((d) => `${d.kind} ${d.class}`).sort();
    const checks = answers.checks.map((check) => check.kind).sort();
    return `${at?.route}: ${at?.items.map((item) => item.tag).join(",")}; ${diagnostics.join(", ")}; ${checks.join(", ")}`;
  };
  const opaque =
    "contract: unknown; integer-use warning-runtime-check, member-read warning-runtime-check; integer-check, null-check";
  assert.deepEqual(
    [
      read("speaker vera { length: 2 }\nlet alias = vera", "alias.length"),
      read("let alias = timer async hidden 1 s {}", "alias.length"),
      read('let alias = say "hi"', "alias.length"),
      // the ordinary member: the same
      read("speaker vera { custom: 2 }\nlet alias = vera", "alias.custom"),
    ],
    [opaque, opaque, opaque, opaque],
  );
});

test("a receiver that may be a reference answers by F19a before its exact value (Astra Q4-r2)", () => {
  const read = (source: string, text: string): string => {
    const { answers, node } = analysed(source);
    const at = answers.at(node(text));
    const diagnostics = answers.diagnostics.map((d) => `${d.kind} ${d.class}`).sort();
    const checks = answers.checks.map((check) => check.kind).sort();
    return `${at?.route}: ${at?.items.map((item) => item.tag).join(",")}; ${diagnostics.join(", ")}; ${checks.join(", ")}`;
  };
  const vera = "speaker vera { length: 2 }\n";
  const opaque =
    "unknown; integer-use warning-runtime-check, member-read warning-runtime-check; integer-check, null-check";
  assert.deepEqual(
    [
      // a written union with text or a list, and a late store of the speaker
      read(
        `${vera}let alias: string|speaker = "abc"\nrepeat alias.length {}\nexit`,
        "alias.length",
      ),
      read(
        `${vera}let alias: integer[]|speaker = [1]\nrepeat alias.length {}\nexit`,
        "alias.length",
      ),
      read(`${vera}let alias = [1]\nrepeat alias.length {}\nalias = vera\nexit`, "alias.length"),
      // a function's result that may be the speaker or a list: no integer beside the member
      read(
        `${vera}function h(flag: boolean) {\n  if flag { return vera }\n  return [1]\n}\nrepeat h(true).length {}\nexit`,
        "h(true).length",
      ),
      // the pure reference, and a method of a written union
      read(`${vera}let alias = vera\nrepeat alias.length {}\nexit`, "alias.length"),
      read(
        `${vera}let alias: string|speaker = "abc"\nsay alias.uppercase()\nexit`,
        "alias.uppercase()",
      ),
    ],
    [
      `contract: ${opaque}`,
      `contract: ${opaque}`,
      `contract: ${opaque}`,
      `value: ${opaque}`,
      `contract: ${opaque}`,
      "value: unknown; member-read warning-runtime-check; null-check",
    ],
  );
});

test("a `get` on a receiver that may be a reference is the runtime's, no default beside it (F19a before F17b)", () => {
  const vera = "speaker vera { length: 2 }\n";
  const read = (setup: string, call: string, after: string): string[] =>
    [false, true].map((reversed) => {
      const source = `${vera}${setup}\nrepeat ${call} {}\n${after}exit`;
      const request = coreRequest([{ path: "main.tease", source }]);
      assert.ok(request !== null, source);
      const run = (): Answers =>
        withSolverSeam({ reverseWorklist: reversed }, () => analyseCore(request));
      const answers = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const node = answers.graph.nodes.find(
        (candidate) =>
          candidate.kind === "expression" &&
          candidate.span !== null &&
          source.slice(candidate.span.start.offset, candidate.span.end.offset) === call,
      );
      assert.ok(node !== undefined, call);
      const at = answers.at(node);
      const diagnostics = answers.diagnostics.map((d) => `${d.kind} ${d.class}`).sort();
      const checks = answers.checks.map((check) => check.kind).sort();
      return `${at?.route}: ${at?.items.map((item) => item.tag).join(",")}; ${diagnostics.join(", ")}; ${checks.join(", ")}`;
    });
  const opaque =
    "value: unknown; integer-use warning-runtime-check, member-read warning-runtime-check; integer-check, null-check";
  const got: string[] = [];
  for (const [setup, after] of [
    ["let alias: integer[]|speaker = [1]", ""],
    ["let alias = [1]", "alias = vera\n"],
    ["let alias = vera", ""],
  ] as const)
    for (const call of ['alias.get(0, default: "bad")', "alias.get(0)"])
      got.push(...read(setup, call, after));
  // three receivers, with and without a default, in both orders
  assert.deepEqual(
    got,
    Array.from({ length: 12 }, () => opaque),
  );
});
