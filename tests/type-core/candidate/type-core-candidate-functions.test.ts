// Author functions on the candidate route (#2667 step 4a-1).

import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../../../src/compiler.js";
import { MODES, inMode } from "../../helpers/type-core-oracles.js";
import { OPTIONS, candidate, sited } from "../../helpers/type-core/type-core-candidate-setup.js";

/** Whether a compile gives the unused-fallback warning (TSV062). */
const warnsUnusedFallback = (result: Parameters<typeof sited>[0]): boolean =>
  sited(result).some((entry) => entry.includes(" TSV062@"));

// V30 §18: "A value of unknown type, such as loaded data, and a value that depends on a parameter without a type get
// no warning." (#2772). Each row: the source, then whether its `otherwise` gets the warning.
const ROWS: readonly [string, string, boolean][] = [
  ["an untyped parameter", "function f(v) {\n  return v otherwise 0\n}\nsay f(1)\nexit\n", false],
  [
    "an untyped parameter through a `let`",
    "function f(v) {\n  let k = v\n  say k otherwise 0\n}\nf(1)\nexit\n",
    false,
  ],
  [
    "an untyped parameter's member",
    "function f(o) {\n  return o.n otherwise 0\n}\nsay f({n: 1})\nexit\n",
    false,
  ],
  [
    "an untyped parameter with a default (V30 §11: it has no type)",
    "function f(v = 1) {\n  return v otherwise 0\n}\nsay f()\nsay f(2)\nexit\n",
    false,
  ],
  [
    "a result that depends on an untyped parameter, at the caller",
    "function f(v) {\n  let w = v\n  return w\n}\nlet x = f(1) otherwise 0\nsay x\nexit\n",
    false,
  ],
  [
    "an element of such a result, at the caller",
    "function f(v) {\n  return [v]\n}\nlet x = f(1)[0] otherwise 0\nsay x\nexit\n",
    false,
  ],
  [
    "such a result of two calls, at the caller",
    "function f(v) {\n  let w = v\n  return w\n}\nlet x = f(1) otherwise 0\nlet y = f(2) otherwise 0\nsay x\nsay y\nexit\n",
    false,
  ],
  [
    "a typed parameter",
    "function f(v: integer) {\n  return v otherwise 0\n}\nsay f(1)\nexit\n",
    true,
  ],
  [
    "a typed parameter, shown",
    "function f(v: integer) {\n  say v otherwise 0\n}\nf(1)\nexit\n",
    true,
  ],
  [
    "a typed result, at the caller",
    "function f: integer {\n  return 1\n}\nlet x = f() otherwise 0\nsay x\nexit\n",
    true,
  ],
  [
    "an untyped result that reads no parameter, at the caller",
    "function f {\n  return 1\n}\nlet x = f() otherwise 0\nsay x\nexit\n",
    true,
  ],
  [
    "a `let` beside an untyped parameter",
    "function f(v) {\n  let k = 1\n  say k otherwise 0\n  say v\n}\nf(1)\nexit\n",
    true,
  ],
];

for (const [name, source, warns] of ROWS)
  test(`the unused-fallback warning on the candidate route: ${name}`, () => {
    for (const mode of MODES)
      assert.equal(
        warnsUnusedFallback(inMode(mode, () => candidate(source))),
        warns,
        `${name} in ${JSON.stringify(mode)}`,
      );
    // (today's checker gives the same, but for a parameter with a default, which it types by the default)
    if (!name.includes("default"))
      assert.equal(warnsUnusedFallback(compileSource(source, OPTIONS)), warns, name);
  });
