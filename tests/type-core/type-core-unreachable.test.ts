import assert from "node:assert/strict";
import test from "node:test";

import type { Program, Statement } from "../../src/ast.js";
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
 * The core's `unreachable` (`coreCheckResult`, #2499) against today's checker's, statement by statement and file by
 * file, for the statements the flow graph builds no node of their own for (a speaker, a function, a `global` without
 * `default:`, `while`, `switch`): every kind in every position (reached, after `exit`, after a `while true` without
 * `break`, inside `if false`, `while false` and an `else if` reached and dead, after a `return`) in every region (the
 * first file, a second file a `goto` enters, a function called from live code, never called, or called only from dead
 * code, a timer block registered in live and in dead code, and a timer block inside a function), where the language
 * lets it stand (`stands`, checked both ways). (A `global` with `default:` has a node, its assignment, and the check
 * result has no store site for a global, so it is not run.) The candidate route refuses these kinds
 * (`slice-syntax.ts`), so the core is run with that gate bypassed, as the reach measurement does: the analysis, then
 * the check result and the facts.
 * What it does not claim: that the core and today's checker decide a branch dead alike in general. The core's dead edges
 * come from literal truth and its own answers, the checker's from its narrowing; these programs decide every branch by a
 * literal, so both agree on them, and the kinds above follow the rule every statement with a node follows.
 */

const KINDS: Readonly<Record<string, string>> = {
  speaker: 'speaker vera { name: "Vera" }',
  function: 'function greet {\n  say "hi"\n}',
  global: "global level = 1",
  while: 'while hostValue == null {\n  say "w"\n}',
  switch:
    'switch hostValue {\n  case 1 {\n    say "one"\n  }\n  default {\n    say "other"\n  }\n}',
};

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

/** Each position: the statements around the kind's statement. */
const POSITIONS: Readonly<Record<string, (statement: string) => string>> = {
  reached: (s) => `${s}\nsay "end"`,
  "after exit": (s) => `say "a"\nexit\n${s}`,
  "after while true": (s) => `while true {\n  say "x"\n}\n${s}`,
  "in if false": (s) => `if false {\n${indent(s)}\n}\nsay "end"`,
  "in while false": (s) => `while false {\n${indent(s)}\n}\nsay "end"`,
  "in a reached else if": (s) =>
    `if false {\n  say "a"\n} else if true {\n${indent(s)}\n}\nsay "end"`,
  "in a dead else if": (s) => `if true {\n  say "a"\n} else if true {\n${indent(s)}\n}\nsay "end"`,
  "after return": (s) => `say "a"\nreturn\n${s}`,
};

/** Each region: the project's files, `main.tease` first, with the positioned statements in it. */
const REGIONS: Readonly<Record<string, (body: string) => Readonly<Record<string, string>>>> = {
  "the first file": (b) => ({ "main.tease": b }),
  "a second file": (b) => ({ "main.tease": 'goto "side.tease"', "side.tease": b }),
  "a function called live": (b) => ({ "main.tease": `function f {\n${indent(b)}\n}\nf()` }),
  "an uncalled function": (b) => ({ "main.tease": `function f {\n${indent(b)}\n}\nsay "end"` }),
  "a function called from dead code": (b) => ({
    "main.tease": `function f {\n${indent(b)}\n}\nexit\nf()`,
  }),
  "a live timer block": (b) => ({
    "main.tease": `timer async 30 s "T" {\n${indent(b)}\n}\nsay "end"`,
  }),
  "a dead timer block": (b) => ({ "main.tease": `exit\ntimer async 30 s "T" {\n${indent(b)}\n}` }),
  "a timer block in a function": (b) => ({
    "main.tease": `function f {\n  timer async 30 s "T" {\n${indent(indent(b))}\n  }\n}\nf()`,
  }),
};

const FILE_REGIONS = new Set(["the first file", "a second file"]);
const FUNCTION_REGIONS = new Set([
  "a function called live",
  "an uncalled function",
  "a function called from dead code",
]);

/**
 * Where the language lets a program of the family stand: a function only at a file's top level, and `return` only in a
 * function's or a block's code.
 */
function stands(kind: string, position: string, region: string): boolean {
  if (kind === "function" && (!FILE_REGIONS.has(region) || position.startsWith("in ")))
    return false;
  if (position === "after return" && !FUNCTION_REGIONS.has(region) && !region.includes("timer"))
    return false;
  return true;
}

/** Each statement of a program, at any depth, by identity: so a statement names its file. */
function statementsOf(program: Program): Set<Statement> {
  const found = new Set<Statement>();
  const pending: unknown[] = [program.statements];
  for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    // EVIDENCE: invariant: a parsed node with a `kind` and a `span` is a statement when it is one of a list's items.
    const node = value as { kind?: unknown; span?: unknown };
    if (typeof node.kind === "string" && node.kind !== "block" && node.span !== undefined)
      // EVIDENCE: invariant: the set is read only by the statements the checkers report, which are such nodes.
      found.add(node as Statement);
    for (const [field, child] of Object.entries(value)) if (field !== "span") pending.push(child);
  }
  return found;
}

/** Where the two checkers' unreachable statements differ for a project, by file and site, or why it was not compared. */
function difference(
  name: string,
  project: readonly { path: string; source: string }[],
): string | null {
  const request = coreRequest(project);
  if (request === null) return `${name}: refused by the name pass`;
  const owners = request.files.map((file) => statementsOf(file.program));
  const key = (found: Statement): string =>
    `${request.files[owners.findIndex((owned) => owned.has(found))]?.path}:${found.kind}@${found.span.start.offset}`;
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
    return `${name}: threw ${error instanceof Error ? error.message : String(error)}`;
  }
  return JSON.stringify(core) === JSON.stringify(checker)
    ? null
    : `${name}: core ${core.join(", ")} / checker ${checker.join(", ")}`;
}

const project = (files: Readonly<Record<string, string>>) =>
  Object.entries(files).map(([path, source]) => ({ path, source: `${source}\n` }));

test("the core's unreachable statements are today's checker's, for every kind without a flow node, position and region", () => {
  const misclassified: string[] = [];
  const differ: string[] = [];
  let standing = 0;
  for (const [kind, statement] of Object.entries(KINDS))
    for (const [position, place] of Object.entries(POSITIONS))
      for (const [region, files] of Object.entries(REGIONS)) {
        const name = `${kind} ${position} in ${region}`;
        const sources = project(files(place(statement)));
        if ((coreRequest(sources) !== null) !== stands(kind, position, region)) {
          misclassified.push(`${name}: ${stands(kind, position, region) ? "refused" : "admitted"}`);
          continue;
        }
        if (!stands(kind, position, region)) continue;
        standing += 1;
        const found = difference(name, sources);
        if (found !== null) differ.push(found);
      }
  assert.deepEqual({ misclassified, differ }, { misclassified: [], differ: [] });
  assert.ok(standing >= 4 * 5 * 8);
});

/** A function whose call never returns: its body ends the session or loops forever. */
const NEVER_RETURNS: Readonly<Record<string, string>> = {
  exit: 'function f {\n  say "bye"\n  exit\n}',
  "while true": 'function f {\n  while true {\n    say "x"\n  }\n}',
};

/**
 * Statements after a call that never returns, which counts as returning (ADR 0022 §4.3), and after a label, which a
 * `goto` can reach whatever comes before it.
 */
const STARTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  ...Object.fromEntries(
    Object.entries(NEVER_RETURNS).flatMap(([body, declaration]) =>
      Object.entries({
        "as a statement": "f()",
        "in a let": "let x = f()",
        "in a say": "say f()",
      }).map(([use, call]) => [
        `a call of a function that never returns (${body}) ${use}`,
        { "main.tease": `${declaration}\n${call}\nsay "after"` },
      ]),
    ),
  ),
  "a label after exit that a goto enters": {
    "main.tease": 'goto later\nexit\nlabel later\nsay "after"\nexit',
  },
  "a label after exit that nothing enters": {
    "main.tease": 'say "a"\nexit\nlabel later\nsay "after"\nexit',
  },
};

test("a call counts as returning and a label as reached, as today's checker has them", () => {
  const differ = Object.entries(STARTS).flatMap(([name, files]) => {
    const found = difference(name, project(files));
    return found === null ? [] : [found];
  });
  assert.deepEqual(differ, []);
});
