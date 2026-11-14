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
import { compiledByLine, MODES } from "../../helpers/type-core-oracles.js";

/*
 * #2764 (B): the nesting cut through the analysis. A value a growing cycle nests deeper on each turn is the cut's unknown
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
  { pr: 0, atBase: /nesting cycle .*: compiles with no diagnostic/ },
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
    }
  },
);

test("a chain of a helper that wraps its argument demands no key below the cut, and a key count linear in the chain", () => {
  // the base demands its parameter's and result's keys to 101 element steps at two calls, and runs out at 300,000 units
  const solved = (k: number): readonly string[] => {
    const calls = Array.from({ length: k }, (_, i) => `let v${i + 1} = part(v${i})`).join("\n");
    const source = `${PART}let v0 = 1\n${calls}\nsay "done"\nexit\n`;
    const keys: string[] = [];
    const compiled = withSolverSeam(
      { onComponent: (members) => keys.push(...members.map((member) => member.key)) },
      () =>
        withTestAllowance(300_000, () =>
          compileProjectWithBackend(
            [{ path: "main.tease", source }],
            {},
            { name: "core", analyze: (request) => coreOutcome(request, "past") },
          ),
        ),
    );
    assert.deepEqual(compiled.diagnostics, [], `${k} calls`);
    return keys;
  };
  const [small, large] = [16, 32].map(solved);
  for (const key of [...small!, ...large!])
    // `part.value` and `part.result` are cut at 1 (M = 0, an integer enters)
    assert.ok((key.match(/element/g) ?? []).length <= 1, key);
  assert.ok(
    large!.length <= 2 * small!.length,
    `${small!.length} keys at 16 calls, ${large!.length} at 32`,
  );
});
