import assert from "node:assert/strict";
import test from "node:test";

import { compileProjectWithBackend } from "../../../src/compiler.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { coreOutcome } from "../../../src/type-inference/core/backend.js";
import { withTestAllowance } from "../../../src/type-inference/core/budget.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { regressionCase } from "../../helpers/regression-case.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { compiledByLine, inMode, MODES, publication } from "../../helpers/type-core-oracles.js";

/*
 * #2764: the nesting cut through the analysis. A value a growing cycle nests deeper on each turn is the cut's unknown
 * below its cut depth, answered before any demand, so the analysis settles; a level the cut does not reach keeps its
 * answer.
 */

const PART =
  "function part(value) {\n  if value is list {\n    return value\n  }\n  return [value]\n}\n";

/** The kinds of a binding at each of `paths` (dotted steps, `""` its root), through the analysis's answers. */
function kindsAt(
  source: string,
  name: string,
  paths: readonly string[],
): readonly (readonly { readonly tag: string; readonly context?: string | null }[])[] {
  const request = coreRequest([{ path: "main.tease", source }], []);
  assert.ok(request !== null, source);
  const place = new CoreProgram(request).places.find(
    (candidate) => candidate.kind.kind === "binding" && candidate.kind.name === name,
  );
  assert.ok(place !== undefined, `no binding ${name}`);
  const answers = analyseCore(request);
  return paths.map(
    (path) => answers.place(place.id, path === "" ? [] : path.split(".")).contract.kinds,
  );
}

test("a value nested below its cycle's cut depth is the cut's unknown, and known above it", () => {
  const [root, element, below] = kindsAt(
    "function wrap(x) {\n  return [x]\n}\nlet v0 = 1\nlet v1 = wrap(v0)\nlet v2 = wrap(v1)\n",
    "v2",
    ["", "element", "element.element"],
  );
  assert.deepEqual(
    root!.map((item) => item.tag),
    ["list"],
  );
  assert.ok(element!.some((item) => item.tag === "integer"));
  assert.ok(element!.some((item) => item.tag === "list"));
  // `wrap.x` is cut at 1: its element's element is known only when the script runs
  assert.deepEqual(
    below!.map((item) => [item.tag, item.context]),
    [["unknown", "unmodelled"]],
  );
});

test("a cycle's entering level counts a kind's declared elements and an upstream cut, alike in every order and sharing", () => {
  const wrap = "function wrap(x) {\n  return [x]\n}\n";
  const cases: readonly (readonly [string, string, string, string])[] = [
    // (a range copied into a list, a dict's keys: `wrap.x` is cut at 2, so `a1` is known to its second element level)
    [
      `${wrap}let a0 = (1..3).toList()\nlet a1 = wrap(a0)\nlet a2 = wrap(a1)\n`,
      "a1",
      "integer",
      "element.element",
    ],
    [
      `${wrap}let a0 = dict{}.keys\nlet a1 = wrap(a0)\nlet a2 = wrap(a1)\n`,
      "a1",
      "string",
      "element.element",
    ],
    // (`a` is cut at 1, so `b` enters at 1, is cut at 2 and known to its second element level)
    ["let a = []\na = [[a]]\nlet b = a\nb = [b]\n", "b", "list", "element.element"],
  ];
  for (const [source, name, known, at] of cases) {
    const below = `${at}.element`;
    const answered = MODES.map((mode) =>
      inMode(mode, () =>
        kindsAt(source, name, [at, below]).map((items) =>
          items.map((item) => `${item.tag}/${item.context ?? ""}`),
        ),
      ),
    );
    for (const other of answered.slice(1)) assert.deepEqual(other, answered[0], source);
    const [level, cut] = answered[0]!;
    assert.ok(level!.includes(`${known}/`), `${source}: ${level!.join(" ")}`);
    assert.deepEqual(cut, ["unknown/unmodelled"], source);
  }
});

test("a value put under one property and read from another keeps every level it is known at", () => {
  const kinds = kindsAt("let o = { a: 1, b: [] }\nlet x = o.a\nlet y = [x]\no.b = [[y]]\n", "o", [
    "b",
    "b.element",
    "b.element.element",
    "b.element.element.element",
  ]);
  assert.deepEqual(
    kinds.map((items) => items.map((item) => item.tag)),
    [["list"], ["list"], ["list"], ["integer"]],
  );
});

/**
 * A cut level meeting a decided level in a join (#1272): `v`, a growing component's result, is cut below its first
 * element level; the literal decides the levels below. An operand a written type leaves open there (`list[]`, V30 §13)
 * leaves the join open: it holds the literal's kinds and an unknown at each level, with no diagnostic and no check in
 * the plan. The cut operand gets the same, whether the literal disagrees with what `v` holds when the script runs or
 * agrees; only its unknown's context differs (the cut's `unmodelled`), which no diagnostic shows here.
 */
test("a join of a cut operand with a deeper literal answers as one with an open operand", () => {
  const levels = ["element.element", "element.element.element", "element.element.element.element"];
  const tags = (items: readonly { readonly tag: string }[]): string =>
    items.map((item) => item.tag).join("|");
  for (const literal of ['[[[["x"]]]]', "[[1]]"]) {
    const forms = {
      cut: `function wrap(x) {\n  return [x]\n}\nlet v = wrap(wrap(1))\nlet b = v + ${literal}\nsay "done"\nexit\n`,
      open: `let v: list[] = [[1]]\nlet b = v + ${literal}\nsay "done"\nexit\n`,
    };
    const [cut, open] = Object.values(forms).map((source) => {
      const compiled = withTestAllowance(300_000, () =>
        compiledByLine([{ path: "main.tease", source }], MODES[0]!, [], "past"),
      );
      return { compiled, kinds: kindsAt(source, "b", levels).map(tags) };
    });
    assert.deepEqual(open!.compiled.diagnostics, [], literal);
    assert.deepEqual(open!.compiled.checks, [], literal);
    assert.ok(open!.compiled.run !== null, literal);
    assert.deepEqual(cut!.compiled.diagnostics, open!.compiled.diagnostics, literal);
    assert.deepEqual(cut!.compiled.checks, open!.compiled.checks, literal);
    assert.ok(cut!.compiled.run !== null, literal);
    assert.deepEqual(cut!.kinds, open!.kinds, literal);
  }
});

/**
 * Each shape is a cycle that nests a value a level deeper on each turn: under F20 and F21 its types have no end, and the
 * base's solver restarts its component at every deeper key until the allowance runs out, so the script compiles with
 * TSV076 "too large to check completely". Under the cut each compiles to a plan with no diagnostic, alike in every order
 * and sharing: the cut depends on the graph alone, never on the order anything is asked in (r4-44).
 */
regressionCase(
  "a cycle that nests a value deeper on each turn compiles with no stop, alike in every order and sharing (#2764)",
  { pr: 2794, atBase: /nesting cycle .*: compiles with no diagnostic/ },
  () => {
    const part = PART;
    const shapes: Record<string, string> = {
      "a chain of a helper that wraps a non-list": `${part}let v0 = 1\nlet v1 = part(v0)\nlet v2 = part(v1)\nsay "done"\nexit\n`,
      "a helper that wraps its argument, called on its result":
        'function wrap(x) {\n  return [x]\n}\nlet v0 = 1\nlet v1 = wrap(v0)\nlet v2 = wrap(v1)\nsay "done"\nexit\n',
      "a ring of functions": `${part}let g0 = []\nlet g1 = []\nfunction f0 {\n  g0 = g0 + part(g1)\n}\nfunction f1 {\n  g1 = g1 + part(g0)\n}\nrepeat 2 {\n  f0()\n  f1()\n}\nsay "done"\nexit\n`,
      "through a property":
        'function wrap(o) {\n  return { arg: [o.arg] }\n}\nlet b0 = { arg: 1 }\nlet b1 = wrap(b0)\nlet b2 = wrap(b1)\nsay "done"\nexit\n',
    };
    for (const [shape, source] of Object.entries(shapes)) {
      const files = [{ path: "main.tease", source }];
      const compiled = MODES.map((mode) =>
        withTestAllowance(300_000, () => compiledByLine(files, mode, [], "past")),
      );
      assert.deepEqual(
        compiled[0]!.diagnostics,
        [],
        `nesting cycle ${shape}: compiles with no diagnostic`,
      );
      assert.ok(compiled[0]!.run !== null, `${shape}: a plan`);
      for (const other of compiled.slice(1)) assert.deepEqual(other, compiled[0], shape);
      // (and the answers at every occurrence with them)
      const published = MODES.map((mode) =>
        withTestAllowance(300_000, () => publication(files, mode, [])),
      );
      for (const other of published.slice(1)) assert.equal(other, published[0], shape);
      // (and every binding's kinds at the levels around the cut, which no occurrence's answer reaches here)
      const request = coreRequest(files);
      assert.ok(request !== null);
      const bindings = new CoreProgram(request).places.filter(
        (place) => place.kind.kind === "binding",
      );
      const levels = ["", "element", "element.element", "element.element.element"];
      const deep = MODES.map((mode) =>
        inMode(mode, () => {
          const answers = withTestAllowance(300_000, () => analyseCore(request));
          return bindings.map((place) =>
            levels.map((path) =>
              answers
                .place(place.id, path === "" ? [] : path.split("."))
                .contract.kinds.map((item) => item.tag)
                .join("|"),
            ),
          );
        }),
      );
      for (const other of deep.slice(1)) assert.deepEqual(other, deep[0], shape);
    }
  },
);

test("a chain of a helper that wraps its argument demands no key below the cut, and a key count linear in the chain", () => {
  // the base demands its parameter's and result's keys to 101 element steps at two calls, and runs out at 300,000 units
  const source = (k: number): string => {
    const calls = Array.from({ length: k }, (_, i) => `let v${i + 1} = part(v${i})`).join("\n");
    return `${PART}let v0 = 1\n${calls}\nsay "done"\nexit\n`;
  };
  // `part.value` and `part.result` are cut at 1 (M = 0, an integer enters)
  const steps = (key: string): number => (key.match(/element/g) ?? []).length;
  // the analysis's contract demands: a key below the cut is answered before it is one
  const request = coreRequest([{ path: "main.tease", source: source(4) }]);
  assert.ok(request !== null);
  for (const { key } of analyseCore(request).budget.finished)
    if (key.startsWith("c|")) assert.ok(steps(key) <= 1, key);
  // the candidate route's cycles, at two sizes
  const solved = (k: number): readonly string[] => {
    const keys: string[] = [];
    const compiled = withSolverSeam(
      { onComponent: (members) => keys.push(...members.map((member) => member.key)) },
      () =>
        withTestAllowance(300_000, () =>
          compileProjectWithBackend(
            [{ path: "main.tease", source: source(k) }],
            {},
            { name: "core", analyze: (request) => coreOutcome(request, "past") },
          ),
        ),
    );
    assert.deepEqual(compiled.diagnostics, [], `${k} calls`);
    return keys;
  };
  const [small, large] = [16, 32].map(solved);
  for (const key of [...small!, ...large!]) assert.ok(steps(key) <= 1, key);
  assert.ok(
    large!.length <= 2 * small!.length,
    `${small!.length} keys at 16 calls, ${large!.length} at 32`,
  );
});

/**
 * #2771: a recursive function that fills a written `dict` with its own result nests it without end below the `dict`'s
 * open element, where the contract reads the stores; `asList`, called on the elements of its own result, reads one level
 * deeper on each turn. Before the written place took its routes, each level was a new key and the analysis ran to the
 * allowance; now `value` is cut at depth 2, one level below `entries`' written `dict` (M = 1), and the analysis settles in
 * every mode.
 */
regressionCase(
  "a recursive function filling a written dict with its own result, read a level deeper on each turn, settles (#2771)",
  { pr: 2809, atBase: /a recursive loader into a written dict: the analysis settles in .+/ },
  () => {
    const source =
      "function loadValue(key) {\n  let value = load key, default: null\n  if value == null {\n" +
      "    let names: string[] = []\n    if names.length > 0 {\n      let entries: dict = dict{}\n" +
      '      for name in names {\n        entries[name] = loadValue("${key}.${name}")\n      }\n' +
      "      value = entries\n    }\n  }\n  return value\n}\n" +
      "function asList(value) {\n  return value otherwise []\n}\n" +
      "function pick(spec) {\n  for part in asList(spec) {\n  }\n}\n" +
      "function walk(specs) {\n  for spec in asList(specs) {\n    pick(spec)\n  }\n}\n" +
      'walk(loadValue("x"))\nexit\n';
    const request = coreRequest([{ path: "main.tease", source }], []);
    assert.ok(request !== null);
    for (const mode of MODES)
      inMode(mode, () => {
        const answers = withTestAllowance(300_000, () => analyseCore(request));
        assert.equal(
          answers.budget.exhausted,
          null,
          `a recursive loader into a written dict: the analysis settles in ${JSON.stringify(mode)}`,
        );
      });
    const [root, below] = kindsAt(source, "value", ["", "element.element.element"]);
    assert.ok(root!.some((item) => item.tag === "dict"));
    assert.deepEqual(
      below!.map((item) => [item.tag, item.context]),
      [["unknown", "unmodelled"]],
    );
  },
);
