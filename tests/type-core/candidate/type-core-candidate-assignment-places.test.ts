// The declaration of the place a compound assignment or a store into a `global` writes (#2816).

import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileProjectWithBackend } from "../../../src/compiler.js";
import { coreOutcome } from "../../../src/type-inference/core/backend.js";
import { planCheckList } from "../../helpers/plan-checks.js";
import { MODES, inMode } from "../../helpers/type-core-oracles-modes.js";

/**
 * The route past the slice's syntax and answers (`coreOutcome(request, "past")`), as the research measurements run it:
 * the real route still refuses both forms by their syntax (steps 2c and 2e). A compound assignment's place is its
 * store's (`storePlace`), and a store into a `global` resolves to the `global` statement: each source gives a plan in
 * every mode. A `global`'s check is today's plan's (`"checks"`), but for a part's label, which differs from today's for a
 * `let`'s part alike (`"types"`); what a compound assignment's check holds is step 2c's to settle (here it differs from
 * today's plan), so it is not compared (`null`).
 */
const ROWS: readonly (readonly [string, string, "checks" | "types" | null])[] = [
  ["a compound assignment", "let n = 0\nn += hostValue\nsay n\nexit\n", null],
  [
    "a compound assignment in a function",
    "function f {\n  let n = 0\n  n += hostValue\n  say n\n}\nf()\nexit\n",
    null,
  ],
  [
    "a top-level `let`'s compound assignment in a function",
    "let n = 0\nfunction f {\n  n += hostValue\n}\nf()\nsay n\nexit\n",
    null,
  ],
  ["an indexed compound assignment", "let xs = [1]\nxs[0] += hostValue\nsay xs\nexit\n", null],
  ["a store into a `global`", "global g = 0\ng = hostValue\nsay g\nexit\n", "checks"],
  [
    "a store into a `global` in a function",
    "global g = 0\nfunction f {\n  g = hostValue\n}\nf()\nsay g\nexit\n",
    "checks",
  ],
  // (a receiver in parentheses, at the root and below it)
  [
    "a store into a `global`'s property through parentheses",
    "global g = {n: 0}\n(g).n = hostValue\nsay g\nexit\n",
    "types",
  ],
  [
    "a store into a `global`'s element through parentheses below the root",
    "global g = {xs: [1]}\n(g.xs)[0] = hostValue\nsay g\nexit\n",
    "types",
  ],
  [
    "a compound assignment of a `global`'s property through parentheses",
    "global g = {n: 0}\n(g).n += hostValue\nsay g\nexit\n",
    null,
  ],
];

for (const [name, source, compared] of ROWS)
  test(`a store's declaration resolves on the research route: ${name}`, () => {
    const files = [{ path: "main.tease", source }];
    const options = { globals: ["hostValue"] };
    const today = compileProject(files, options);
    assert.ok(today.plan !== null, name);
    for (const mode of MODES) {
      const compiled = inMode(mode, () =>
        compileProjectWithBackend(files, options, {
          name: "core",
          analyze: (request) => coreOutcome(request, "past"),
        }),
      );
      const where = `${name} in ${JSON.stringify(mode)}`;
      assert.ok(compiled.plan !== null, where);
      const checks = (plan: NonNullable<typeof today.plan>) =>
        planCheckList(plan).map((check) =>
          compared === "types" ? { ...check, place: undefined } : check,
        );
      if (compared !== null) assert.deepEqual(checks(compiled.plan), checks(today.plan), where);
    }
  });
