// Warnings the analysis sites at an assignment's target or at a whole compound assignment (#2807).

import assert from "node:assert/strict";
import test from "node:test";

import { compileProjectWithBackend } from "../../../src/compiler.js";
import { coreOutcome } from "../../../src/type-inference/core/backend.js";
import { planCheckList } from "../../helpers/plan-checks.js";
import { MODES, inMode } from "../../helpers/type-core-oracles-modes.js";

/**
 * The route past the slice's syntax and answers (`coreOutcome(request, "past")`), as the research measurements run it:
 * the real route still refuses these assignments by their syntax. Each row: a source whose variable holds host data of
 * unknown type, and the line of an element or key store, if any. An operator's warning on a compound assignment owes no
 * plan content, so its site is not read; a member warning at an element or key store's target names the target, and
 * the plan checks nothing there: the runtime's element store checks its receiver and its index itself, as today's plan
 * shows.
 */
const ROWS: readonly (readonly [string, string, number | null])[] = [
  ["a compound assignment", "let n = hostValue\nn += 1\nsay n\nexit\n", null],
  ["a compound subtraction", "let n = hostValue\nn -= 1\nsay n\nexit\n", null],
  [
    "a compound assignment in a block",
    "let n = hostValue\nif true {\n  n += 1\n}\nsay n\nexit\n",
    null,
  ],
  [
    "a compound assignment of two such variables",
    "let a = hostValue\nlet b = hostValue\na += b\nsay a\nexit\n",
    null,
  ],
  [
    "a compound assignment in a function",
    "function f {\n  let n = hostValue\n  n += 1\n  say n\n}\nf()\nexit\n",
    null,
  ],
  ["an element store", "let xs = hostValue\nxs[0] = 1\nsay xs\nexit\n", 2],
  ["a key store", 'let o = hostValue\no["k"] = "v"\nsay o\nexit\n', 2],
  [
    "an element store in a function",
    "function f {\n  let xs = hostValue\n  xs[0] = 1\n  say xs\n}\nf()\nexit\n",
    3,
  ],
];

for (const [name, source, store] of ROWS)
  test(`a warning at an assignment's target or at a compound assignment gives the route a result: ${name} (#2807)`, () => {
    for (const mode of MODES) {
      const compiled = inMode(mode, () =>
        compileProjectWithBackend(
          [{ path: "main.tease", source }],
          { globals: ["hostValue"] },
          { name: "core", analyze: (request) => coreOutcome(request, "past") },
        ),
      );
      const where = `${name} in ${JSON.stringify(mode)}`;
      assert.ok(compiled.plan !== null, where);
      if (store !== null)
        assert.deepEqual(
          planCheckList(compiled.plan).filter((check) => check.line === store),
          [],
          where,
        );
    }
  });
