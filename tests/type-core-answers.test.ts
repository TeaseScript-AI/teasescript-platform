import assert from "node:assert/strict";
import test from "node:test";

import { compileProjectWithBackend } from "../src/compiler.js";
import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import type { FlowNode } from "../src/type-inference/core/flow-graph.js";
import { ingressLeaves, REASON, type ItemTag } from "../src/type-inference/core/items.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { everyAnswer } from "./helpers/type-core-oracles.js";

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
    // removals' elements (review r4)
    ["let xs = [{value: 2}]\nsay xs.removeFirst()", "xs.removeFirst()"],
    ["let xs = [{value: 2}]\nsay xs.removeAt(0)", "xs.removeAt(0)"],
    ['let d = dict {key: {value: 2}}\nsay d.remove("key")', 'd.remove("key")'],
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
  // a choice's answer, which no button gives as an object (TSV029, TABLE r4.93): of an option's value, a whole choice
  // object, written and bound (reviews r4, r5); no value is composed at a property its object's names give (the names
  // are the carriers' walk, `carriers.ts`)
  for (const [source, text] of [
    [
      'say askChoice [{text: "A", value: {value: 2}}]',
      'askChoice [{text: "A", value: {value: 2}}]',
    ],
    ['say askChoice {text: "A", value: {value: 2}}', 'askChoice {text: "A", value: {value: 2}}'],
    ['let option = {text: "A", value: {value: 2}}\nsay askChoice option', "askChoice option"],
  ] as const) {
    const held = analysed(source);
    const properties = held.answers.properties(held.node(text));
    assert.deepEqual(
      [...properties].flatMap(([, items]) => items),
      [],
      text,
    );
  }
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
    ["check that box is an object with a store of .element before the store"],
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
  // a list or the speaker: a value of an unrestricted dict (a written union of a list and the speaker is V30 §13's
  // error, and two returns of different kinds admission's, ADR 0021 1.5)
  const pool = "let pool: dict = dict{a: [1], b: vera}\n";
  const maybeVera = `${pool}function h {\n  return pool.get("a", default: vera)\n}\n`;
  assert.deepEqual(
    [
      // a written union of text and the speaker, a list or the speaker, and a late store of the speaker
      read(
        `${vera}let alias: string|speaker = "abc"\nrepeat alias.length {}\nexit`,
        "alias.length",
      ),
      read(
        `${vera}${pool}let alias = pool.get("a", default: vera)\nrepeat alias.length {}\nexit`,
        "alias.length",
      ),
      // (a late store that may be the speaker: a definite one would be admission's error and be ignored, A6)
      read(
        `${vera}${maybeVera}let alias = [1]\nrepeat alias.length {}\nalias = h()\nexit`,
        "alias.length",
      ),
      // a function's result that may be the speaker or a list: no integer beside the member
      read(`${vera}${maybeVera}repeat h().length {}\nexit`, "h().length"),
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
  // (a list or the speaker: a value of an unrestricted dict, as in the test before)
  const pool = "let pool: dict = dict{a: [1], b: vera}\n";
  for (const [setup, after, expected] of [
    [`${pool}let alias = pool.get("a", default: vera)`, "", opaque],
    [
      `${pool}function h {\n  return pool.get("a", default: vera)\n}\nlet alias = [1]`,
      "alias = h()\n",
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
 * S3 §1 (review: Astra's D2, round 2's D1): a decided place's admitted answer names the site of the contribution that
 * decided it (A2's earliest definite one, a literal's earliest element, A4's copy), also where A3 settled the path
 * without a scan, for the deciding line S8's sentences name; a written place has none. Both orders.
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
    // (paths A3 settles without a scan: a plain scalar root, a settled family below a literal; Astra r2 D1)
    ["let n = 6\nexit", "let n = 6", [], "6"],
    ["let n = 6\nn = 7.5\nexit", "let n = 6", [], "6"],
    ["let xs = [6]\nexit", "let xs = [6]", ["element"], "6"],
    ["let r = {nested: {n: 6}}\nexit", "let r = {nested: {n: 6}}", ["nested", "n"], "6"],
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

/**
 * #1203: below their root computed-key loads hold host data at every path (F19; never a kind from their default, ADR
 * 0021 §6.2), each naming its own ingress (C9), and the value side answers a literal's class of them once for every
 * path. A field read answers one unknown that holds the leaf of each load its list holds, whatever the key's form or the
 * default, and the root keeps a `null` default's `null`. With the sharing off (`withoutSharing`) each load is read at
 * each path by itself: every read's answer, its items whole with their leaves, and the program's diagnostics and checks
 * are the same either way, in both orders, for the controls too. These sources lie outside the candidate's slice: they
 * are analysed, never run.
 */
test("a field read of computed-key loads holds every load's leaf, as each load read by itself (#1203)", () => {
  const loads = (n: number, fallback = "0"): string =>
    Array.from({ length: n }, () => `load(hostValue, default: ${fallback})`).join(", ");
  const keyed = (fallback: string): string =>
    'let key = "k"\nlet names = {key: "k"}\nlet keys = ["k"]\nlet box = [' +
    ["hostValue", "key", "names.key", "keys[0]", 'key + "1"']
      .map((key) => `load(${key}, default: ${fallback})`)
      .join(", ") +
    "]\nrepeat box[0].f0 {}\nrepeat box[1].f1 {}\nlet whole = box[2]\nexit\n";
  // per program its reads, each with the binding whose line holds the loads it holds and the kinds it answers, and
  // the defaults whose compile errors stand each at its own
  const programs: readonly (readonly [
    source: string,
    reads: readonly (readonly [string, string, string])[],
    errors?: readonly string[],
  ])[] = [
    [
      keyed("0"),
      [
        ["box[0].f0", "box", "unknown"],
        ["box[1].f1", "box", "unknown"],
        ["box[2]", "box", "unknown"],
      ],
    ],
    [
      keyed("null"),
      [
        ["box[0].f0", "box", "unknown"],
        ["box[2]", "box", "unknown,null"],
      ],
    ],
    [
      keyed("{f0: 1, f1: 2}"),
      [
        ["box[0].f0", "box", "unknown"],
        ["box[2]", "box", "unknown"],
      ],
    ],
    // loads of a default with no class (a choice of a list's buttons) answer alike below their root (#1208 review r3)
    [
      `let key = "k"\nlet box = [load(hostValue, default: (askChoice [1, 2])), load(key, default: (askChoice [1, 2])), load(hostValue, default: {a2: 1})]\nrepeat box[0].field0 {}\nrepeat box[2].field1 {}\nlet whole = box[1]\nexit\n`,
      [
        ["box[0].field0", "box", "unknown"],
        ["box[2].field1", "box", "unknown"],
        ["box[1]", "box", "unknown"],
      ],
    ],
    // loads landing in a written type: one with fields (`object`), a dict's values, a scalar one, and defaults that do
    // not fit it, each keeping its own error (the lead's ruling on #1208)
    [
      'let key = "k"\nlet box: object[] = [load(hostValue, default: {f0: 1}), load(key, default: {a1: 1}), load(hostValue, default: {f0: {g: 1}})]\nrepeat box[0].f0 {}\nrepeat box[1].f1 {}\nlet whole = box[2]\nexit\n',
      [
        ["box[0].f0", "box", "unknown"],
        ["box[1].f1", "box", "unknown"],
        ["box[2]", "box", "unknown"],
      ],
    ],
    [
      'let d: object dict = dict{a: load(hostValue, default: {f0: 1}), b: load(hostValue, default: {f1: 2})}\nrepeat d["a"].f0 {}\nrepeat d["b"].f1 {}\nexit\n',
      [
        ['d["a"].f0', "d", "unknown"],
        ['d["b"].f1', "d", "unknown"],
      ],
    ],
    [
      'let key = "k"\nlet box: integer[] = [load(hostValue, default: "zero"), load(hostValue, default: 0), load(key, default: "one")]\nrepeat box[0] {}\nrepeat box[1].f0 {}\nexit\n',
      [
        ["box[0]", "box", "unknown"],
        ["box[1].f0", "box", "unknown"],
      ],
      ['"zero"', '"one"'],
    ],
    // loads of different defaults, each its own class, answer alike below their root (#1208 review r1 B1)
    [
      `let key = "k"\nlet named = {a3: 1}\nlet box = [load(hostValue, default: {a0: 1}), load(key, default: null), load(hostValue, default: {f0: {a2: 1}}), load(hostValue, default: named), ${loads(1)}]\nrepeat box[0].field0 {}\nrepeat box[3].field1 {}\nlet whole = box[1]\nexit\n`,
      [
        ["box[0].field0", "box", "unknown"],
        ["box[3].field1", "box", "unknown"],
        ["box[1]", "box", "unknown,null"],
      ],
    ],
    // the linear control: one load copied, its one leaf
    [
      "let one = load(hostValue, default: 0)\nlet box = [one, one, one]\nrepeat box[0].f0 {}\nrepeat box[1].f1 {}\nexit\n",
      [
        ["box[0].f0", "one", "unknown"],
        ["box[1].f1", "one", "unknown"],
      ],
    ],
    // disjoint lists: each its own loads
    [
      `let a = [${loads(2)}]\nlet b = [${loads(3, "null")}]\nrepeat a[0].f0 {}\nrepeat b[1].f0 {}\nexit\n`,
      [
        ["a[0].f0", "a", "unknown"],
        ["b[1].f0", "b", "unknown"],
      ],
    ],
    // changed receivers, guarded reads, a written destination, mixed literals, nested paths, member steps, a choice and
    // a loop that adds to the list
    [
      `let box = [${loads(3)}]\nbox[0] = {f0: 1}\nrepeat box[0].f0 {}\nrepeat box[1].f1 {}\nexit\n`,
      [],
    ],
    [
      `let box = [${loads(3)}]\nif hostValue == 1 {\n  box = [{f0: 1}]\n}\nrepeat box[0].f0 {}\nexit\n`,
      [],
    ],
    [
      `let box = [${loads(3)}]\nbox.add(load(hostValue, default: null))\nrepeat box[0].f0 {}\nexit\n`,
      [],
    ],
    [
      `let box = [${loads(3)}]\nif box[0].f0 is integer {\n  repeat box[0].f0 {}\n}\nif box[1].f1 != null {\n  repeat box[1].f1 {}\n}\nexit\n`,
      [],
    ],
    [
      `let typed: integer[] = [${loads(3)}]\nlet box = [${loads(3)}]\nrepeat typed[0] {}\nrepeat box[0].f0 {}\nexit\n`,
      [],
    ],
    [
      `let h = hostValue\nlet box = [h, ${loads(3)}, {f0: 1}, 5]\nrepeat box[0].f0 {}\nrepeat box[1].f1 {}\nexit\n`,
      [],
    ],
    [
      `let box = [${loads(3, "{f0: {g: 1}}")}]\nrepeat box[0].f0.g {}\nrepeat box[1][0].f0 {}\nlet nested = [[${loads(2)}], [${loads(1)}]]\nrepeat nested[0][1].f0 {}\nrepeat nested[1][0].f1 {}\nexit\n`,
      [],
    ],
    [
      `let box = [${loads(3, '{text: "a", value: {f0: 1}}')}]\nrepeat box[0].year {}\nlet names = box[0].keys\nlet picked = askChoice box\nrepeat picked.f0 {}\nexit\n`,
      [],
    ],
    [
      `let box = [${loads(3)}]\nrepeat 2 {\n  repeat box[0].f0 {}\n  box.add(load(hostValue, default: null))\n}\nexit\n`,
      [],
    ],
  ];
  for (const [source, reads, errors] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const published = (sharing: boolean, reversed: boolean): string => {
      const run = (): Answers =>
        sharing ? analyseCore(request) : withoutSharing(() => analyseCore(request));
      const answers = reversed
        ? withSolverSeam({ reverseWorklist: true }, () =>
            withConsumerOrder((list) => [...list].reverse(), run),
          )
        : run();
      for (const [text, list, kinds] of reads) {
        const start = source.indexOf(text);
        const read = answers.graph.expressionAt({ file: 0, start, end: start + text.length });
        assert.ok(read !== undefined, text);
        // the sites of the loads on the binding's own line, from the source
        const line = source.search(new RegExp(`let ${list}[ :]`));
        const own = [...source.slice(line, source.indexOf("\n", line)).matchAll(/load\(/g)].map(
          (match) => line + match.index,
        );
        assert.deepEqual(
          answers
            .at(read)!
            .items.map((item) => [
              item.tag,
              item.reasons,
              item.ingress === undefined
                ? []
                : ingressLeaves(item.ingress).map(({ start }) => start),
            ]),
          kinds
            .split(",")
            .map((tag) => (tag === "unknown" ? [tag, REASON.external, own] : [tag, 0, []])),
          `${text} in ${source}`,
        );
      }
      // every read's answer, its items whole with their ingress stores by their leaves
      // each default that does not fit the written type keeps its own compile error, at that default
      if (errors !== undefined)
        assert.deepEqual(
          answers.diagnostics
            .filter((diagnostic) => diagnostic.class === "compile-error")
            .map((diagnostic) => diagnostic.site.start),
          errors.map((text) => source.indexOf(text)),
          source,
        );
      return everyAnswer(answers);
    };
    for (const reversed of [false, true])
      assert.equal(
        published(true, reversed),
        published(false, reversed),
        `${source}, reversed: ${reversed}`,
      );
  }
  assert.throws(
    () =>
      compileProjectWithBackend(
        [{ path: "main.tease", source: keyed("0") }],
        { globals: ["hostValue"] },
        CORE_BACKEND,
      ),
    (error) => error instanceof CandidateOutsideSlice && error.what === "this load expression",
  );
});

/**
 * Each program analysed with the sharing on answers as with it off (`withoutSharing`), where each member of a class is
 * read by itself: every occurrence's answer, its items whole with their leaves, and the program's diagnostics and checks,
 * in both orders. Where `named` is given, the read's items are `kinds` in order, its unknown naming the sites of the
 * texts `named` matches and every other item none.
 */
function assertSharedAsUnshared(
  programs: readonly (readonly [
    source: string,
    read: string,
    named: RegExp | null,
    kinds?: readonly ItemTag[],
  ])[],
): void {
  for (const [source, text, named, kinds = ["unknown"]] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const published = (sharing: boolean, reversed: boolean): string => {
      const run = (): Answers =>
        sharing ? analyseCore(request) : withoutSharing(() => analyseCore(request));
      const answers = reversed
        ? withSolverSeam({ reverseWorklist: true }, () =>
            withConsumerOrder((list) => [...list].reverse(), run),
          )
        : run();
      if (named !== null) {
        const start = source.indexOf(text);
        const read = answers.graph.expressionAt({ file: 0, start, end: start + text.length });
        assert.ok(read !== undefined, text);
        const sites = [...source.matchAll(named)].map((match) => match.index);
        assert.deepEqual(
          answers
            .at(read)!
            .items.map((item) => [
              item.tag,
              item.ingress === undefined
                ? []
                : ingressLeaves(item.ingress).map(({ start }) => start),
            ]),
          kinds.map((tag) => [tag, tag === "unknown" ? sites : []]),
          source,
        );
      }
      return everyAnswer(answers);
    };
    for (const reversed of [false, true])
      assert.equal(
        published(true, reversed),
        published(false, reversed),
        `${source}, reversed: ${reversed}`,
      );
  }
}

/**
 * #1207: k loads whose default reads host data, directly or through one named copy, are one class, mixed by the leaves
 * they name (each load's, and a direct default's, C9). A property read below their list reads one of them and names
 * every other's leaves beside its own: each load's and each default's, as with the sharing off, where each load is
 * read by itself; for a guarded list and two classes in one list too.
 */
test("a property read of loads defaulting to host data names every load's and default's leaf (#1207)", () => {
  const loads = (n: number, fallback: string): string =>
    Array.from({ length: n }, () => `load("k", default: ${fallback})`).join(", ");
  // per program a read with the texts whose sites its unknown names, `null` where only the sharing is compared
  assertSharedAsUnshared([
    [
      `let wide = [${loads(3, "hostValue")}]\nlet first = wide[0]\nlet a: integer = first.f0\nsay wide[1].f1\nexit\n`,
      "first.f0",
      /load|hostValue/g,
    ],
    [
      `let raw = hostValue\nlet wide = [${loads(3, "raw")}]\nsay wide[0].f0\nexit\n`,
      "wide[0].f0",
      /load|hostValue/g,
    ],
    [
      `if hostValue.f0 is integer {\n  let wide = [${loads(2, "hostValue")}]\n  say wide[0].f0\n}\nexit\n`,
      "wide[0].f0",
      null,
    ],
    [
      `let raw = hostValue\nlet wide = [${loads(2, "hostValue")}, ${loads(2, "raw")}]\nsay wide[0].f1\nexit\n`,
      "wide[0].f1",
      null,
    ],
  ]);
});

/**
 * #1304: k `load(…, default: hostValue) otherwise {p0: 1}` are one class mixed by their leaves alone, at any depth of
 * their parts: a property read below their list beside an object of k properties reads one of them and names every
 * load's and every default's leaf, as with the sharing off; for `fromJson`, a composite two deep and one inside an
 * object too.
 */
test("a property read of composite fallbacks names every load's and default's leaf (#1304)", () => {
  const list = (element: string, wide = "{p0: 1, p1: 1, p2: 1}"): string =>
    `let xs = [${element}, ${wide}, ${element}, ${element}]`;
  const composite = '(load("k", default: hostValue) otherwise {p0: 1})';
  assertSharedAsUnshared([
    [
      `${list(composite)}\nlet n1: integer = xs[0].p1\nexit\n`,
      "xs[0].p1",
      /load|hostValue/g,
      ["integer", "unknown"],
    ],
    [
      `${list('(fromJson("{}", default: hostValue) otherwise {p0: 1})')}\nlet n0: integer = xs[0].p0\nexit\n`,
      "xs[0].p0",
      /fromJson|hostValue/g,
      ["integer", "unknown"],
    ],
    [
      `${list('(load("k", default: hostValue) otherwise (load("j", default: hostValue) otherwise {p0: 1}))')}\nlet n2: integer = xs[0].p2\nexit\n`,
      "xs[0].p2",
      /load|hostValue/g,
      ["integer", "unknown"],
    ],
    [
      `${list(`{box: ${composite}}`, "{box: {p0: 1, p1: 1, p2: 1}}")}\nlet n1: integer = xs[0].box.p1\nexit\n`,
      "xs[0].box.p1",
      /load|hostValue/g,
      ["integer", "unknown"],
    ],
  ]);
});

/**
 * #1313: a read of a binding of one stable definition answers as its value at every path, so k bindings of loads of
 * one default, or of alike objects, are one class: a property read below their list beside an object reads one binding
 * and names every load's and default's leaf, as with the sharing off; with no object beside them, where one binding is
 * tested, and where one is written again and stands apart, too.
 */
test("a property read of named bindings in a list names every binding's leaves (#1313)", () => {
  const bindings = (n: number, value: string): string =>
    Array.from({ length: n }, (_, i) => `let l${i} = ${value}`).join("\n");
  assertSharedAsUnshared([
    [
      'let l0 = load("a", default: hostValue)\nlet l1 = load("b", default: hostValue)\nlet xs = [l0, {f0: 1, f1: 1}, l1]\nlet a0: integer = xs[0].f0\nlet a1: integer = xs[0].f1\nexit\n',
      "xs[0].f1",
      /load|hostValue/g,
      ["integer", "unknown"],
    ],
    [
      `${bindings(3, 'load("k", default: hostValue)')}\nif l1.f1 is integer {\n  let xs = [l0, l1, {f0: 1, f1: 1}, l2]\n  say xs[0].f1\n}\nexit\n`,
      "xs[0].f1",
      null,
    ],
    [
      `${bindings(3, "{f0: 1}")}\nlet xs = [l0, {f0: 1, f1: 1}, l1, l2]\nsay xs[0].f1\nexit\n`,
      "xs[0].f1",
      null,
    ],
    [
      `${bindings(3, 'fromJson("{}", default: hostValue)')}\nlet xs = [l0, l1, l2]\nlet a1: integer = xs[0].f1\nexit\n`,
      "xs[0].f1",
      /fromJson|hostValue/g,
    ],
    [
      `${bindings(3, 'load("k", default: hostValue)')}\nlet xs = [l0, l1, {f0: 1}, l2]\nlet a0: integer = xs[0].f0\nl1 = hostValue\nexit\n`,
      "xs[0].f0",
      null,
    ],
  ]);
});

test("a written union of one type repeated answers as that type does (V30 §13, #1256)", () => {
  // (a union is the alternatives it holds: a result written `object | object` is an object, so adding a number to it is
  // the error it is for `object`, never a warning that the result might be of another type)
  const shape = (source: string): string => {
    const { answers } = analysed(source);
    return JSON.stringify([answers.outcome, answers.diagnostics.map((d) => [d.class, d.code])]);
  };
  for (const [type, source] of [
    ["object", "function make: TYPE { return {p: 1} }\nlet a = make()\nsay a + 1\nexit"],
    ["integer", "function make: TYPE { return 1 }\nlet a = make()\nsay a.length\nexit"],
  ] as const)
    assert.equal(
      shape(source.replace("TYPE", `${type} | ${type}`)),
      shape(source.replace("TYPE", type)),
      `${type} | ${type}`,
    );
});

test("each option's nested choice selects what its own objects hold (#1233, review r4)", () => {
  // (the two options' nested lists hold the same kinds at each property, but the second's selected `text` may be a
  // text: the store into `n` would warn of it with its check, never counted with the first option as one; an object as
  // the outer choice's button value is TSV029's error since S9b, so the answer holds no list to choose from, TABLE r4.93)
  const { answers } = analysed(
    [
      'let options = [{text: "a", value: {choices: [{value: 1, text: "x"}, {text: null}]}}, {text: "b", value: {choices: [{value: 1, text: null}, {text: "x"}]}}]',
      "let outer = askChoice options",
      "let picked = askChoice outer.choices",
      "let n: integer? = picked",
      "say n",
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(
    [
      answers.outcome,
      answers.diagnostics.map((d) => [d.class, d.code]),
      answers.checks.map((c) => c.kind),
    ],
    ["compile-error", [["compile-error", "TSV029"]], []],
  );
});
