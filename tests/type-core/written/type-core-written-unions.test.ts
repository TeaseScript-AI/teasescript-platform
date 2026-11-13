// V30 §13's union rule: its examples, and at every place and depth one compile error at the written type naming the
// union.

import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../../../src/compiler.js";
import { analyseCore, coreResult } from "../../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { type CoreAnalysisRequest } from "../../../src/type-inference/core/program.js";
import { coreRecord, type WrittenTypeError } from "../../../src/type-inference/core/result.js";
import { withoutSharing } from "../../../src/type-inference/core/sharing.js";
import { writtenTypeErrors } from "../../../src/type-inference/core/written.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { UNION_RULE_MATRIX } from "../../helpers/type-core/written/type-core-written-unions.js";
import { inBothOrders, GLOBALS } from "../../helpers/type-core/written/type-core-written-setup.js";

/** A written type's error as `written-type start:end union start:end suggests …` (`WrittenTypeError`). */
const errorText = (found: WrittenTypeError): string =>
  `written-type ${found.site.start}:${found.site.end} union ${found.union.start}:${found.union.end} ` +
  `suggests ${found.suggestion}`;

/** A request's outcome and every diagnostic, sorted, each `class kind start:end`; a written type's `errorText`. */
function writtenErrors(request: CoreAnalysisRequest) {
  const answers = analyseCore(request);
  return {
    outcome: answers.outcome,
    diagnostics: answers.diagnostics
      .map((found) =>
        found.kind === "written-type"
          ? errorText(found)
          : `${found.class} ${found.kind} ${found.site.start}:${found.site.end}`,
      )
      .sort(),
  };
}

/** A single-file request (no binding ids, unlike `prepare`). */
function requestOf(source: string): CoreAnalysisRequest {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, `${JSON.stringify(source)}: its file parses and resolves`);
  return request;
}

/** Whether the candidate route compiles a source, rather than rejecting it as outside its slice. */
function routeTakes(source: string): boolean {
  try {
    compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND);
    return true;
  } catch (error) {
    if (!(error instanceof CandidateOutsideSlice)) throw error;
    return false;
  }
}

/**
 * V30 §13's union examples (`:1406–1416`) as V30 writes them, and each union with its members in the other order:
 * `a`–`e` valid, `f`–`p` one compile error at the written type naming the union, `h`'s form (`T | U[]`, so `n`'s, `o`'s
 * and `p`'s union too) with V30's suggestion. Each line is the written type, its offending union and the suggestion.
 * `p` is written `function p: …`: V30's `function p(): …` breaks V30 §11's "Parentheses are omitted when there are no
 * parameters" (TSP026), so its type is never checked.
 */
const V30_UNION_EXAMPLES: readonly (readonly [string, string?, string?, (string | null)?])[] = [
  ['let a: (integer | string)[] = [1, "two"]'],
  ['let a: (string | integer)[] = [1, "two"]'],
  ['let b: (integer | string) set = set[1, "two"]'],
  ['let b: (string | integer) set = set[1, "two"]'],
  ["let c: (integer | string) dict = dict{}"],
  ["let c: (string | integer) dict = dict{}"],
  ["let d: integer?[] = [1, null]"],
  ["let e: integer[]? = null"],
  ["let f: integer[] | string[] = []", "integer[] | string[]", "integer[] | string[]", null],
  ["let f: string[] | integer[] = []", "string[] | integer[]", "string[] | integer[]", null],
  ['let g: string[] | string = "a"', "string[] | string", "string[] | string", null],
  ['let g: string | string[] = "a"', "string | string[]", "string | string[]", null],
  [
    "let h: integer | string[] = 1",
    "integer | string[]",
    "integer | string[]",
    "(integer | string)[]",
  ],
  [
    "let h: string[] | integer = 1",
    "string[] | integer",
    "string[] | integer",
    "(string | integer)[]",
  ],
  [
    "let i: integer set | string set = set[]",
    "integer set | string set",
    "integer set | string set",
    null,
  ],
  [
    "let i: string set | integer set = set[]",
    "string set | integer set",
    "string set | integer set",
    null,
  ],
  [
    "let j: integer dict | string dict = dict{}",
    "integer dict | string dict",
    "integer dict | string dict",
    null,
  ],
  [
    "let j: string dict | integer dict = dict{}",
    "string dict | integer dict",
    "string dict | integer dict",
    null,
  ],
  ["let k: integer[] | string set = []", "integer[] | string set", "integer[] | string set", null],
  ["let k: string set | integer[] = []", "string set | integer[]", "string set | integer[]", null],
  ["let l: list | integer = []", "list | integer", "list | integer", null],
  ["let l: integer | list = []", "integer | list", "integer | list", null],
  [
    "let m: (integer[] | string[])[] = []",
    "(integer[] | string[])[]",
    "integer[] | string[]",
    null,
  ],
  [
    "let m: (string[] | integer[])[] = []",
    "(string[] | integer[])[]",
    "string[] | integer[]",
    null,
  ],
  [
    "let n: (integer | string[]) dict = dict{}",
    "(integer | string[]) dict",
    "integer | string[]",
    "(integer | string)[]",
  ],
  [
    "let n: (string[] | integer) dict = dict{}",
    "(string[] | integer) dict",
    "string[] | integer",
    "(string | integer)[]",
  ],
  [
    "function o(x: integer | string[]) { }",
    "integer | string[]",
    "integer | string[]",
    "(integer | string)[]",
  ],
  [
    "function o(x: string[] | integer) { }",
    "string[] | integer",
    "string[] | integer",
    "(string | integer)[]",
  ],
  [
    'function p: integer[] | string { return "a" }',
    "integer[] | string",
    "integer[] | string",
    "(integer | string)[]",
  ],
  [
    'function p: string | integer[] { return "a" }',
    "string | integer[]",
    "string | integer[]",
    "(string | integer)[]",
  ],
];

/**
 * One type written twice is one type, not another type beside it (ADR 0021 3.2, `T?` is `T | null`), also when
 * spelled two ways; two list types are two types (Sol's r1 B1).
 */
const SAME_TYPE_UNIONS: readonly (readonly [string, string?, string?, (string | null)?])[] = [
  ["let a: integer[] | integer[] = []"],
  ["let b: list | list = []"],
  ["let c: integer[]? | integer[] = []"],
  ["let d: integer[] | (integer[] | null) = []"],
  ["let e: integer?[] | (integer | null)[] = []"],
  ["let f: integer?[] | integer[] = []", "integer?[] | integer[]", "integer?[] | integer[]", null],
];

test("V30 §13's union examples: f–p one compile error at the written type naming the union, h's form with its suggestion, a–e and a type written twice valid", () => {
  const wrong: string[] = [];
  for (const [line, type, unionText, suggestion] of [...V30_UNION_EXAMPLES, ...SAME_TYPE_UNIONS])
    // (also in code that never runs: the rule reads the written type alone)
    for (const source of [`${line}\nexit\n`, `exit\n${line}\n`]) {
      const request = requestOf(source);
      const run = () => writtenErrors(request);
      const seen = inBothOrders(run);
      assert.deepEqual(
        inBothOrders(() => withoutSharing(run)),
        seen,
      );
      let expected: ReturnType<typeof writtenErrors> = { outcome: "valid", diagnostics: [] };
      if (type !== undefined && unionText !== undefined) {
        const start = source.indexOf(type);
        const at = start + type.indexOf(unionText);
        expected = {
          outcome: "compile-error",
          diagnostics: [
            `written-type ${start}:${start + type.length} union ${at}:${at + unionText.length} suggests ${suggestion}`,
          ],
        };
        if (routeTakes(source))
          wrong.push(`${JSON.stringify(source)}: the candidate route takes it`);
      }
      if (JSON.stringify(seen) !== JSON.stringify(expected))
        wrong.push(`${JSON.stringify(source)}: ${JSON.stringify(seen)}`);
    }
  assert.deepEqual(wrong, []);
  // the record carries the union and the suggestion as data beside the written type's site
  const h = "let h: integer | string[] = 1\nexit\n";
  assert.deepEqual(coreRecord(coreResult(analyseCore(requestOf(h))), ["main.tease"]).diagnostics, [
    {
      class: "compile-error",
      kind: "written-type",
      site: { file: "main.tease", offset: 7, end: 25 },
      union: { file: "main.tease", offset: 7, end: 25 },
      suggestion: "(integer | string)[]",
    },
  ]);
  // a written type of another file errs in that file
  const project = coreRequest(
    [
      { path: "main.tease", source: "exit\n" },
      { path: "other.tease", source: "function use(x: list | integer) {\n}\n" },
    ],
    GLOBALS,
  );
  assert.ok(project !== null);
  assert.deepEqual(
    analyseCore(project).diagnostics.map((found) => [found.kind, found.site]),
    [["written-type", { file: 1, start: 16, end: 30 }]],
  );
  // the place keeps its written type (A4): stores and copies that fit it add nothing to the one error
  const kept = writtenErrors(
    requestOf('let h: integer | string[] = 1\nh = ["a"]\nlet copy = h\ncopy = 2\nh = copy\nexit\n'),
  );
  assert.deepEqual(kept, {
    outcome: "compile-error",
    diagnostics: ["written-type 7:25 union 7:25 suggests (integer | string)[]"],
  });
});

/**
 * The rule reads the written types alone: no solver order or sharing reaches it, and the analysis reports its errors as
 * they are (`analyseCore`), which each placement's first error and first valid control show in both orders.
 */
test("V30 §13's union rule at every place and depth: one compile error at the written type naming the union", (t) => {
  const wrong: string[] = [];
  let errors = 0;
  const analysed = new Set<string>();
  for (const c of UNION_RULE_MATRIX) {
    const request = requestOf(c.source);
    const expected =
      c.error === null
        ? []
        : [`written-type ${c.error.site} union ${c.error.union} suggests ${c.error.suggestion}`];
    if (c.error !== null) errors += 1;
    const found = writtenTypeErrors(request.files.map((file) => file.program)).map(errorText);
    if (JSON.stringify(found) !== JSON.stringify(expected))
      wrong.push(`${c.name}: ${JSON.stringify(found)}`);
    const sample = `${c.placement}, ${c.error === null ? "valid" : "error"}`;
    if (analysed.has(sample)) continue;
    analysed.add(sample);
    const seen = inBothOrders(() => writtenErrors(request));
    const outcome = c.error === null ? "valid" : "compile-error";
    if (JSON.stringify(seen) !== JSON.stringify({ outcome, diagnostics: expected }))
      wrong.push(`${c.name} (analysed): ${JSON.stringify(seen)}`);
  }
  t.diagnostic(
    `${UNION_RULE_MATRIX.length} sources (${errors} errors, ${UNION_RULE_MATRIX.length - errors} valid controls) ` +
      `at the check, ${analysed.size} of them (a first error and valid control per placement) analysed in both orders`,
  );
  assert.deepEqual(wrong, []);
  assert.equal(analysed.size, 2 * new Set(UNION_RULE_MATRIX.map((c) => c.placement)).size);
});
