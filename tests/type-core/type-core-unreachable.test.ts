import assert from "node:assert/strict";
import test from "node:test";

import type { Statement } from "../../src/ast.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import {
  asked,
  coreCheckResult,
  coreFacts,
} from "../../src/type-inference/core/check-result/check-result.js";
import { SliceIndex } from "../../src/type-inference/core/check-result/slice-index.js";
import { analyzeTypes } from "../../src/type-inference/index.js";
import { coreRequest } from "../helpers/type-core-analysis.js";

/*
 * The core's `unreachable` (`coreCheckResult`, #2499) against today's checker's, statement by statement, for the
 * statements the flow graph builds no node of their own for (a speaker, a function, a `global` without `default:`,
 * `while`, `switch`) in every position that decides reachability: reached, after `exit`, after a `while true` without
 * `break`, inside `if false` and `while false`, after a `return`, in a function no live code calls, and in a timer block
 * registered in live and in dead code; a function only at a file's top level, the one place it may stand. (A `global`
 * with `default:` has a node, its assignment, and the check result has no store site for a global, so it is not run.)
 * The candidate route refuses these kinds (`slice-syntax.ts`), so the core is run with that gate bypassed, as the reach
 * measurement does: the analysis, then the check result and the facts.
 * What it does not claim: that the core and today's checker decide a branch dead alike in general. The core's dead edges
 * come from literal truth and its own answers, the checker's from its narrowing; these programs decide every branch by a
 * literal, so both agree on them, and the kinds above follow the rule every statement with a node follows.
 */

/** A kind's statement, and whether it may stand inside a block or a function. */
const KINDS: Readonly<Record<string, { readonly statement: string; readonly nested: boolean }>> = {
  speaker: { statement: 'speaker vera { name: "Vera" }', nested: true },
  function: { statement: 'function greet {\n  say "hi"\n}', nested: false },
  global: { statement: "global level = 1", nested: true },
  while: { statement: 'while hostValue == null {\n  say "w"\n}', nested: true },
  switch: {
    statement:
      'switch hostValue {\n  case 1 {\n    say "one"\n  }\n  default {\n    say "other"\n  }\n}',
    nested: true,
  },
};

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

/** The positions at a file's top level: the program with the statement there. */
const TOP_LEVEL: Readonly<Record<string, (statement: string) => string>> = {
  reached: (s) => `${s}\nsay "end"`,
  "after exit": (s) => `say "a"\nexit\n${s}`,
  "after while true": (s) => `while true {\n  say "x"\n}\n${s}`,
};

/** The positions inside a block or a function. */
const NESTED: Readonly<Record<string, (statement: string) => string>> = {
  "in if false": (s) => `if false {\n${indent(s)}\n}\nsay "end"`,
  "in while false": (s) => `while false {\n${indent(s)}\n}\nsay "end"`,
  "after return": (s) => `function f {\n  return\n${indent(s)}\n}\nf()`,
  "in an uncalled function": (s) => `function f {\n${indent(s)}\n}\nsay "end"`,
  "in a function called from dead code": (s) => `function f {\n${indent(s)}\n}\nexit\nf()`,
  "in a live timer block": (s) => `timer async 30 s "T" {\n${indent(s)}\n}\nsay "end"`,
  "in a dead timer block": (s) => `exit\ntimer async 30 s "T" {\n${indent(s)}\n}`,
};

const key = (statement: Statement): string => `${statement.kind}@${statement.span.start.offset}`;

test("the core's unreachable statements are today's checker's, for every kind without a flow node in every position", () => {
  const invalid: string[] = [];
  const differ: string[] = [];
  let programs = 0;
  let compared = 0;
  for (const [kind, { statement, nested }] of Object.entries(KINDS))
    for (const [position, place] of Object.entries({ ...TOP_LEVEL, ...(nested ? NESTED : {}) })) {
      programs += 1;
      const name = `${kind} ${position}`;
      const request = coreRequest([{ path: "main.tease", source: `${place(statement)}\n` }]);
      if (request === null) {
        invalid.push(name);
        continue;
      }
      const checker = [...analyzeTypes(request).checked.unreachable].map(key).sort();
      let core: string[];
      try {
        core = asked(analyseCore(request), (answers) => {
          const index = new SliceIndex(request.files.map((file) => file.program));
          const result = coreCheckResult(answers, index, request);
          coreFacts(answers, index, request);
          return [...result.unreachable].map(key).sort();
        });
      } catch (error) {
        differ.push(`${name}: threw ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      compared += 1;
      if (JSON.stringify(core) !== JSON.stringify(checker))
        differ.push(`${name}: core ${core.join(", ")} / checker ${checker.join(", ")}`);
    }
  assert.deepEqual({ invalid, differ }, { invalid: [], differ: [] });
  // every kind in every position it may stand in
  assert.equal(programs, 4 * (3 + 7) + 3);
  assert.equal(compared, programs);
});
