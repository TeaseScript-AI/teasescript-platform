import assert from "node:assert/strict";
import test from "node:test";

import { operandsOf } from "../../../src/type-inference/core/carriers.js";
import { DefinitionIndex } from "../../../src/type-inference/core/definitions.js";
import { NestingIndex } from "../../../src/type-inference/core/indexes/nesting.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import type { PlaceId } from "../../../src/type-inference/graph.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";

/*
 * #2764: the nesting cut. A cycle of copies, arguments, results and list literals that nests a value deeper on each
 * turn is followed one level deeper than what enters it (`M + 1`); a cycle that nests nothing deeper, and a place a
 * written type decides, are never cut.
 */

const PART = `function part(value) {
  if value is list {
    return value
  }
  return [value]
}
`;

/** The nesting index of a program's source, every definition live, and its places by name. */
function indexOf(source: string): {
  readonly cut: (name: string, property?: string) => number | null;
} {
  const request = coreRequest([{ path: "main.tease", source }], []);
  assert.ok(request !== null, source);
  const program = new CoreProgram(request);
  program.index();
  const index = new NestingIndex(
    program,
    new DefinitionIndex(program),
    () => true,
    (value) => operandsOf(program, value),
  );
  const place = (name: string): PlaceId => {
    const [owner, part] = name.split(".");
    const found = program.places.find((candidate) => {
      const kind = candidate.kind;
      if (part === "result")
        return (
          kind.kind === "result" &&
          program.graph.functions.find((fn) => fn.id === kind.fn)?.name === owner
        );
      if (part !== undefined) return kind.kind === "parameter" && kind.name === part;
      return kind.kind === "binding" && kind.name === owner;
    });
    assert.ok(found !== undefined, `no place ${name}`);
    return found.id;
  };
  return { cut: (name, property = "") => index.cutDepth(place(name), property) };
}

test("a chain of calls of a helper that wraps its argument is cut one level below what enters it", () => {
  const { cut } = indexOf(`${PART}let v0 = 1\nlet v1 = part(v0)\nlet v2 = part(v1)\n`);
  // M = 0 (an integer enters), G = 1 (the literal `[value]`): known one level deep
  assert.equal(cut("part.value"), 1);
  assert.equal(cut("part.result"), 1);
  assert.equal(cut("v1"), 1);
  // what enters the cycle and what only reads it are outside it
  assert.equal(cut("v0"), null);
  assert.equal(cut("v2"), null);
});

test("a function that returns its argument in a list, called on its own result, is cut", () => {
  const { cut } = indexOf(
    "function wrap(x) {\n  return [x]\n}\nlet v0 = 1\nlet v1 = wrap(v0)\nlet v2 = wrap(v1)\n",
  );
  assert.equal(cut("wrap.x"), 1);
  assert.equal(cut("wrap.result"), 1);
});

test("a list joined with itself in a list is known one level below its literal's own levels", () => {
  // #2763's reproduction: `[[]]` enters with one element level (M = 1); its cell holds nothing, so no second
  assert.equal(indexOf("let a = [[]]\na = a + [a]\n").cut("a"), 2);
  // a deeper literal keeps its levels known: M = 3
  assert.equal(indexOf("let a = [[[1]]]\na = a + [a]\n").cut("a"), 4);
});

test("#2763's variants are cut one level below what enters them", () => {
  const cases: readonly (readonly [string, string, number | null])[] = [
    ["let a = []\nrepeat 3 {\n  a = a + [a]\n}\n", "a", 1],
    ["let a = [[]]\na += [a]\n", "a", 2],
    ["let a = [[]]\na = [a] + a\n", "a", 2],
    ["let a = []\nrepeat 3 {\n  a = [a]\n}\nlet b = a + a\n", "a", 1],
    // (only reads the cycle)
    ["let a = []\nrepeat 3 {\n  a = [a]\n}\nlet b = a + a\n", "b", null],
    // (an identity function's call is its argument, #2493)
    ["function f(d) {\n  return d\n}\nlet a = [f([])]\na = a + [f(a)]\n", "a", 2],
    // (a function that calls itself before every return never returns: its return still counts, as the contract counts
    // code that never runs, and the analysis knows no value there for the cut to hide)
    ["function g(x) {\n  return x + [g(x)]\n}\nlet a = g([[]])\n", "g.result", 1],
    [
      "function g(x, n) {\n  if n == 0 {\n    return x\n  }\n  return x + [g(x, n - 1)]\n}\nlet a = g([[]], 2)\n",
      "g.result",
      2,
    ],
    ['let a = [[1]]\na = a + [a]\na = a + [["x"]]\n', "a", 3],
    ['let u: list[][][] = []\nlet r = u + [[[[1]]], [[["x"]]]]\n', "u", null],
  ];
  for (const [source, name, cut] of cases) assert.equal(indexOf(source).cut(name), cut, source);
});

test("a cycle that gains two levels a turn turns unknown within its first turn", () => {
  // M = 1: known to level 2, where one turn would reach level 3
  assert.equal(indexOf("let a = [1]\na = [[a]]\n").cut("a"), 2);
});

test("`otherwise` passes a value on at its own level, from both sides", () => {
  assert.equal(indexOf("let a = [1]\na = [a otherwise 1]\n").cut("a"), 2);
  assert.equal(indexOf("let a = [1]\na = [null otherwise a]\n").cut("a"), 2);
});

test("a `get` with a default takes its receiver's element and its default at its own level", () => {
  // the element taken out of the list it was wrapped in: +1 and -1
  assert.equal(
    indexOf("let xs = [[1]]\nlet p = xs.get(0, default: [])\nxs = [p]\n").cut("xs"),
    null,
  );
  // the default wrapped again: +1
  assert.equal(indexOf("let a = [1]\nlet b = [[2]]\na = [b.get(0, default: a)]\n").cut("a"), 2);
});

test("a copying method passes its receiver on at its own level", () => {
  assert.equal(indexOf("let a = [1]\na = [a.toList()]\n").cut("a"), 2);
  assert.equal(indexOf("let a = [1]\na = [a.take(1)]\n").cut("a"), 2);
});

test("a removing method gives its receiver's element", () => {
  // the element taken out of the list it was wrapped in: +1 and -1
  assert.equal(indexOf("let xs = [[1]]\nlet p = xs.removeAt(0)\nxs = [p]\n").cut("xs"), null);
  // wrapped twice: +2 and -1
  assert.equal(indexOf("let xs = [[1]]\nxs = [[xs.removeFirst()]]\n").cut("xs"), 3);
});

test("a dict's `values` passes its values on at their own level", () => {
  // the carrier table reads `d.values` as the dict's values (0) and as an object's property `values`: that
  // property's own cycle is cut first, at 3, and enters the dict's as an upstream component, so the dict is cut at 4
  assert.equal(indexOf('let d = dict{}\nd["k"] = [1]\nd["k"] = d.values\n').cut("d"), 4);
  assert.equal(indexOf('let d = dict{}\nd["k"] = [1]\nd["k"] = d.values\n').cut("d", "values"), 3);
});

test("a choice's answer passes no level on: its options never close a cycle", () => {
  assert.equal(
    indexOf('let opts = ["a"]\nlet c = askChoice opts\nopts = [[c]]\n').cut("opts"),
    null,
  );
});

/** A function whose result holds its argument's loop values, each wrapped once. */
const FILL =
  "function fill(d) {\n  let out = []\n  for value in d {\n    out = [value]\n  }\n  return out\n}\n";

test("a value whose kind declares its elements enters a cycle with that level", () => {
  const wrap = "function wrap(x) {\n  return [x]\n}\n";
  // a range's whole numbers, copied into a list, written or not, and a dict's keys, its text: M = 1
  const seeds = [
    "let a0 = (1..3).toList()",
    "let a0 = dict{}.keys",
    "let r: range = 1..3\nlet a0 = r.toList()",
    "function numbers(r: range) {\n  return r.toList()\n}\nlet a0 = numbers(1..3)",
    "function span(n): range {\n  return 1..n\n}\nlet a0 = span(3).toList()",
    "let rs: range[] = [1..3]\nlet a0 = rs[0].toList()",
    // a loop's value, wrapped once: a range's number, a dict's key (a loop over an empty literal never runs)
    "let r: range = 1..3\nlet a0 = []\nfor value in r {\n  a0 = [value]\n}",
    FILL + "let a0 = fill(dict{})",
  ];
  for (const seed of seeds)
    assert.equal(
      indexOf(`${wrap}${seed}\nlet a1 = wrap(a0)\nlet a2 = wrap(a1)\n`).cut("wrap.x"),
      2,
      seed,
    );
});

test("a growing component that reads another enters at the other's cut", () => {
  // `a` is cut at 1 (M = 0), so `b` enters at 1 and is cut at 2, `c` at 3, whatever `a` gains a turn
  for (const nest of ["[[a]]", "[[[a]]]"]) {
    const index = indexOf(`let a = []\na = ${nest}\nlet b = a\nb = [b]\nlet c = b\nc = [c]\n`);
    assert.deepEqual(
      ["a", "b", "c"].map((name) => index.cut(name)),
      [1, 2, 3],
      nest,
    );
  }
});

test("a cycle that nests nothing deeper is never cut", () => {
  // whole copies around a ring: weight 0
  const ring = indexOf("let a = [1]\nlet b = a\na = b\n");
  assert.equal(ring.cut("a"), null);
  assert.equal(ring.cut("b"), null);
  // an element taken out and put back in a list: +1 and -1
  assert.equal(indexOf("let xs = [[1]]\nlet p = xs[0]\nxs = [p]\n").cut("xs"), null);
  // an element taken out of a list it was wrapped in, only: -1
  assert.equal(indexOf("let xs = [[1]]\nlet p = xs[0]\nxs = p\n").cut("xs"), null);
});

test("a place a written type decides takes no route into it, so its cycle is not cut", () => {
  assert.equal(indexOf("let a: list[][] = [[]]\na = a + [a]\n").cut("a"), null);
});

test("a cycle through a property is cut at that property", () => {
  // ToyExpanded's shape: a function that wraps its argument's property in a list, under the same property
  const wrap = indexOf(
    "function wrap(o) {\n  return { arg: [o.arg] }\n}\nlet b0 = { arg: 1 }\nlet b1 = wrap(b0)\nlet b2 = wrap(b1)\n",
  );
  assert.equal(wrap.cut("wrap.o", "arg"), 1);
  assert.equal(wrap.cut("wrap.result", "arg"), 1);
  // (the object itself does not nest: its root is not cut)
  assert.equal(wrap.cut("wrap.o"), null);
  // an event's argument stored under a property of a dict's value and read back into a list
  const events = indexOf(
    "let events = dict{}\nfunction setEvent(name, arg) {\n  events[name] = { arg: arg }\n}\n" +
      'function fire(args) {\n  setEvent("again", args)\n}\nsetEvent("start", 1)\n' +
      "for name in events.keys {\n  let e = events[name]\n  fire([e.arg])\n}\n",
  );
  assert.equal(events.cut("setEvent.arg"), 1);
});

test("a value put under one property and read from another closes no cycle", () => {
  // with property names ignored, `o.a` -> `x` -> `[x]` -> `[[y]]` -> `o.b` would be a cycle gaining three levels
  const index = indexOf("let o = { a: 1, b: [] }\nlet x = o.a\nlet y = [x]\no.b = [[y]]\n");
  for (const property of ["", "a", "b"]) assert.equal(index.cut("o", property), null, property);
  assert.equal(index.cut("x"), null);
});
