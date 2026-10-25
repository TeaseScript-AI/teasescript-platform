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
    // a dict's values (TABLE r4.46 (2))
    ["let d = dict {k: {value: 2}}\nsay d.values.first", "d.values.first"],
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
    // a receiver that may be a reference has the runtime's members (F19a; #1027 review r4); a written union keeps the
    // reference, where a store of one into the dict's place would be admission's error and be ignored (A6)
    ["let d: object dict | speaker = dict {k: {value: 2}}\nsay d.values.first", "d.values.first"],
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
  // a store's member checks name the property as written (the receiver's boundary check beside them is C9's)
  const stored = analysed("let box = hostValue\nbox.element = 1\nexit").answers;
  assert.deepEqual(
    stored.checks.filter((check) => !check.boundary).map((check) => check.on),
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
  const maybeVera =
    "function h(flag: boolean): integer[]|speaker {\n  if flag { return vera }\n  return [1]\n}\n";
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
      // (a late store that may be the speaker: a definite one would be admission's error and be ignored, A6)
      read(
        `${vera}${maybeVera}let alias = [1]\nrepeat alias.length {}\nalias = h(true)\nexit`,
        "alias.length",
      ),
      // a function's result that may be the speaker or a list: no integer beside the member (a written result: two
      // returns of different kinds would be admission's error, ADR 0021 1.5)
      read(`${vera}${maybeVera}repeat h(true).length {}\nexit`, "h(true).length"),
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
      // the late store's own check against the list the place is decided by (C1)
      "contract: unknown; integer-use warning-runtime-check, member-read warning-runtime-check, written-target warning-runtime-check; copy-type, integer-check, null-check",
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
  // a late store that may be the speaker owes its own check against the list the place is decided by (C1); a definite
  // speaker there would be admission's error and be ignored (A6)
  const late =
    "value: unknown; integer-use warning-runtime-check, member-read warning-runtime-check, written-target warning-runtime-check; copy-type, integer-check, null-check";
  const got: string[] = [];
  const want: string[] = [];
  for (const [setup, after, expected] of [
    ["let alias: integer[]|speaker = [1]", "", opaque],
    [
      "function h(flag: boolean): integer[]|speaker {\n  if flag { return vera }\n  return [1]\n}\nlet alias = [1]",
      "alias = h(true)\n",
      late,
    ],
    ["let alias = vera", "", opaque],
  ] as const)
    for (const call of ['alias.get(0, default: "bad")', "alias.get(0)"]) {
      got.push(...read(setup, call, after));
      want.push(expected, expected);
    }
  // three receivers, with and without a default, in both orders
  assert.deepEqual(got, want);
});

/**
 * S3 §1 (review: Astra's D2): a decided place's admitted answer names the site of the contribution that decided it
 * (A2's earliest definite one, a literal's earliest element, A4's copy), for the deciding line S8's sentences name; a
 * written place has none. Both orders.
 */
test("a decided place publishes the site of the contribution that decided it", () => {
  for (const [source, statement, path, decider] of [
    ["let n = 3\nn = hostValue\nexit", "let n = 3", [], "3"],
    [
      "let whole: integer = 1\nlet xs = [2.5, whole]\nxs = [3.5]\nexit",
      "let xs = [2.5, whole]",
      ["element"],
      "2.5",
    ],
    ["let typed: integer = 1\nlet copy = typed\ncopy = 2\nexit", "let copy = typed", [], "typed"],
  ] as const)
    for (const reversed of [false, true]) {
      const run = (): ReturnType<typeof analysed> =>
        withSolverSeam({ reverseWorklist: reversed }, () => analysed(source));
      const { answers, node } = reversed
        ? withConsumerOrder((list) => [...list].reverse(), run)
        : run();
      const place = answers.at(node(statement, "statement"))?.place;
      assert.ok(place, `${source}: its place`);
      const admitted = answers.place(place.id, path).admitted;
      assert.ok(admitted.by === "decided", `${source}: decided`);
      const at = source.indexOf(decider, source.indexOf(statement));
      assert.deepEqual(
        admitted.decider === null
          ? null
          : { start: admitted.decider.start, end: admitted.decider.end },
        { start: at, end: at + decider.length },
        `${source}${reversed ? " reversed" : ""}`,
      );
    }
  const { answers, node } = analysed("let w: integer = 1\nexit");
  const place = answers.at(node("let w: integer = 1", "statement"))?.place;
  assert.ok(place);
  assert.deepEqual(answers.place(place.id).admitted, { by: "written", kinds: ["integer"] });
});

test("a value an add or an addAll inserts has its properties, never the collection itself (N1)", () => {
  // per program the read and its property names, each answered as its projection, in both orders
  const added = "let xs = []\nxs.add({value: 2})\n";
  const programs: readonly (readonly [string, string, string, readonly string[]])[] = [
    ["a list's add", `${added}say xs.first`, "xs.first", ["value"]],
    [
      "a set's add",
      "let xs = set[]\nxs.add({value: 2})\nfor entry in xs {\n  say entry.value\n}",
      "entry",
      ["value"],
    ],
    [
      "a named record added",
      "let r = {value: 2}\nlet xs = []\nxs.add(r)\nsay xs.first",
      "xs.first",
      ["value"],
    ],
    [
      "a literal's addAll",
      "let xs = []\nxs.addAll([{value: 2}])\nsay xs.first",
      "xs.first",
      ["value"],
    ],
    [
      "a named list's addAll",
      "let ys = [{value: 2}]\nlet xs = []\nxs.addAll(ys)\nsay xs.first",
      "xs.first",
      ["value"],
    ],
    [
      "an add in a loop",
      "let xs = []\nfor i in [1, 2] {\n  xs.add({value: i})\n}\nsay xs.first",
      "xs.first",
      ["value"],
    ],
    ["a copied collection", `${added}let ys = xs\nsay ys.first`, "ys.first", ["value"]],
    [
      "a returned collection",
      "function make {\n  let xs = []\n  xs.add({value: 2})\n  return xs\n}\nlet ys = make()\nsay ys.first",
      "ys.first",
      ["value"],
    ],
    [
      "a handler's add",
      "let xs = []\ntimer async hidden 1 s { xs.add({value: 2}) }\nsay xs.first",
      "xs.first",
      ["value"],
    ],
    [
      "a nested collection",
      "let xss = []\nxss.add([{value: 2}])\nsay xss.first.first",
      "xss.first.first",
      ["value"],
    ],
    [
      "a nested record",
      "let xs = []\nxs.add({inner: {value: 2}})\nsay xs.first.inner",
      "xs.first.inner",
      ["value"],
    ],
    ["a removed record", `${added}let r = xs.removeFirst()\nsay r`, "r", ["value"]],
    // the controls: a literal's element; the collections themselves and scalar elements have none
    ["a literal's element", "let xs = [{value: 2}]\nsay xs.first", "xs.first", ["value"]],
    ["the collection", `${added}say xs`, "xs", []],
    ["a scalar added", "let xs = []\nxs.add(2)\nsay xs.first", "xs.first", []],
    ["the inner collection", "let xss = []\nxss.add([{value: 2}])\nsay xss.first", "xss.first", []],
    ["the collection of an addAll", "let xs = []\nxs.addAll([{value: 2}])\nsay xs", "xs", []],
    [
      "a record holding a collection added to",
      "let box = {list: []}\nbox.list.add({value: 2})\nsay box",
      "box",
      ["list"],
    ],
  ];
  for (const [name, body, text, names] of programs) {
    const answered = (): string => {
      const { answers, node } = analysed(`${body}\nexit`);
      const properties = answers.properties(node(text));
      assert.deepEqual([...properties.keys()], names, name);
      for (const [property, items] of properties)
        assert.deepEqual(items, answers.project(node(text), { property }), `${name}: ${property}`);
      return JSON.stringify(
        [...properties].map(([property, items]) => [property, items.map((item) => item.tag)]),
      );
    };
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder((list) => [...list].reverse(), answered),
    );
    assert.equal(reversed, answered(), name);
  }
});
