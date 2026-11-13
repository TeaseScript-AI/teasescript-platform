// The derived oracle's author functions (`derived-functions.ts`, #2667 step 4a-0): on sources whose functions store only
// into places with a written type, the oracle's checked stores and its runs are today's compiler's, which checks those
// places as V30 §10, §11 and §17 say; a check into an untyped parameter or result is underivable.

import assert from "node:assert/strict";
import test from "node:test";
import { compileProject } from "../../../src/compiler.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import {
  assignments,
  derivedStores,
  planOfFile,
  plannedStores,
  runGlobals,
} from "../../helpers/type-core-route.js";
import { evaluateProject } from "../../helpers/type-core/derived/derived-transfers.js";
import { derive } from "../../helpers/type-core/derived/type-core-derived-checks.js";
import { syntaxOf, Underivable } from "../../helpers/type-core/derived/type-core-derived.js";
import { OPTIONS } from "../../helpers/type-core/type-core-candidate-setup.js";

type Files = readonly { readonly path: string; readonly source: string }[];
const one = (source: string): Files => [{ path: "main.tease", source }];

/** Invented sources: each a function form, its places written where a value enters them. */
const CASES: readonly [string, Files][] = [
  [
    "an argument into a written parameter",
    one('function f(x: integer) {\n  say x\n}\nf(hostValue)\nsay "after"\nexit\n'),
  ],
  [
    "a named argument, inside a `let`",
    one('function f(x: integer) {\n  return "done"\n}\nlet y = f(x: hostValue)\nsay y\nexit\n'),
  ],
  [
    "a list argument into a written list",
    one("function f(xs: integer[]) {\n  for x in xs {\n    say x\n  }\n}\nf(hostValue)\nexit\n"),
  ],
  [
    "a written default, supplied and not",
    one("function f(x: integer = hostValue) {\n  say x\n}\nf(1)\nf()\nexit\n"),
  ],
  [
    "a returned value into a written result",
    one("function f: integer {\n  return hostValue\n}\nsay f()\nexit\n"),
  ],
  [
    "a bare return of an optional result",
    one(
      "function f: integer? {\n  if hostValue == null {\n    return\n  }\n  return 1\n}\nsay f()\nexit\n",
    ),
  ],
  ["a call before its function", one('say f("a")\nfunction f(v: string) {\n  return v\n}\nexit\n')],
  [
    "a parameter kept across a call of its own function",
    one(
      'function count(v: integer?) {\n  if v == null {\n    return "end"\n  }\n  say v\n  let inner = count(null)\n  say v\n  return inner\n}\nsay count(hostValue)\nexit\n',
    ),
  ],
  [
    "a store into the file's variable from a function",
    one('let top = "a"\nfunction f(v: string) {\n  top = v\n}\nf(hostValue)\nsay top\nexit\n'),
  ],
  [
    "a store into a written parameter",
    one("function f(x: integer) {\n  x = hostValue\n  say x\n}\nf(1)\nexit\n"),
  ],
  [
    "an untyped parameter that only known values fill",
    one('function shown(v) {\n  say v\n}\nshown(1)\nshown("x")\nsay hostValue != null\nexit\n'),
  ],
  [
    "a function that ends without a return",
    one("function f(x: integer) {\n  say x\n}\nlet r = f(hostValue)\nsay r == null\nexit\n"),
  ],
  [
    "a global function of another file",
    [
      { path: "main.tease", source: 'check(hostValue)\nsay "back"\nexit\n' },
      { path: "helpers.tease", source: "global function check(n: integer) {\n  say n\n}\n" },
    ],
  ],
];

for (const [name, files] of CASES)
  test(`the derived oracle's functions: ${name}, as today's compiler checks and runs it`, () => {
    const today = compileProject(files, OPTIONS);
    assert.ok(today.plan !== null, name);
    const request = coreRequest(files);
    assert.ok(request !== null, name);
    const record = compactAnalysis(request);
    const project = request.files.map((file) => syntaxOf(file.source));
    const derived = request.files.map((file, index) => {
      const own = record.checks.filter((check) => check.site.file === file.path);
      return {
        path: file.path,
        syntax: project[index]!,
        ...derive(project[index]!, { ...record, checks: own }, project),
      };
    });
    for (const file of derived)
      assert.deepEqual(
        derivedStores(file.stores),
        plannedStores(planOfFile(today.plan, file.path)),
        `${name}: the checked stores of ${file.path}`,
      );
    for (const inputs of assignments(["hostValue"]))
      assert.deepEqual(
        evaluateProject(derived, inputs).run,
        runGlobals(today.plan, inputs),
        `${name} with ${JSON.stringify(inputs)}`,
      );
  });

test("the derived oracle refuses a check into an untyped parameter or result: the route publishes none there", () => {
  for (const source of [
    "function shown(v) {\n  say v\n}\nshown(1)\nshown(hostValue)\nexit\n",
    "function pick(b) {\n  if b == null {\n    return 1\n  }\n  return b\n}\nlet n = pick(hostValue)\nsay n\nexit\n",
  ]) {
    const request = coreRequest(one(source));
    assert.ok(request !== null);
    const record = compactAnalysis(request);
    const syntax = syntaxOf(source);
    assert.throws(() => derive(syntax, record, [syntax]), Underivable, source);
  }
});
