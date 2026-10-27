import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { compileSourceWithBackend } from "../src/compiler.js";
import type { InstructionPlan, TypePlan } from "../src/plan/model.js";
import { analyseCore, coreResult, type Answers } from "../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { type CoreAnalysisRequest, CoreProgram } from "../src/type-inference/core/program.js";
import { coreRecord, type WrittenTypeError } from "../src/type-inference/core/result.js";
import type { PlaceId } from "../src/type-inference/graph.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { writtenTypeErrors } from "../src/type-inference/core/written.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { runGlobals } from "./helpers/type-core-route.js";
import {
  DEFAULT_CHAIN_MATRIX,
  INFERRED_COPY_MATRIX,
  OBJECT_PROPERTY_MATRIX,
  UNRESTRICTED_COLLECTION_MATRIX,
  UNION_RULE_MATRIX,
  type UnrestrictedCase,
  V30_TYPE_MATRIX,
  WRITTEN_DOMAIN_MATRIX,
  type WrittenCase,
} from "./helpers/type-core-written.js";

/*
 * The written-domain matrices (`type-core-written.ts`; the lead's rulings on the merged S6's B1 and B2: A4, F17b,
 * §4's fit rule, ADR 0021 1.3, V30 §13), each source in both orders and with the sharing on and off, in three layers:
 * the decision (the place's admitted kinds at each level, and the program's C9 boundaries, each at its host read with its
 * target's level and `against`, none at a level that admits every kind), the plan (each store that brings a host value
 * checked against the whole written type) and
 * the runs (each host value that fits says DONE, each other one stops at TSR058 at the first checked store's value,
 * nothing said). The decision layer also holds the outcome and every diagnostic: a runtime-check warning at each store
 * that brings a host value to a decided level, nothing else. Whether the candidate route takes a source is each row's
 * own axis (`executable`): a row it takes must plan and run, a row it does not is checked in the decision layer alone.
 * Each exact source is analysed and planned once per mode, the two orders' plans compared whole, and each distinct plan
 * runs its host values once; every row that holds the source is compared with that.
 * V30 §13's union rule is a compile error with no plan: its examples in the decision layer and the candidate route's
 * rejection; `UNION_RULE_MATRIX` at the check of written types the analysis reports (`writtenTypeErrors`, which reads
 * the declarations alone), each placement's first error and valid control in the decision layer too.
 */

function inBothOrders<T>(run: () => T): T {
  const forward = run();
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder((list) => [...list].reverse(), run),
  );
  assert.deepEqual(reversed, forward);
  return forward;
}

const sorted = (kinds: readonly string[]): string[] => [...kinds].sort();

function typeText(type: TypePlan | null): string {
  if (type === null) return "any";
  if (type.kind === "union") return type.members.map(typeText).join("|");
  if (type.kind === "list" || type.kind === "set" || type.kind === "dict")
    return `${type.kind}<${typeText(type.element)}>`;
  return type.kind;
}

/** A plan's checked stores, each as `start:end type`. */
function checksOf(plan: InstructionPlan): string[] {
  return plan.instructions.flatMap((instruction) =>
    (instruction.kind === "declareBinding" || instruction.kind === "assign") &&
    instruction.typeCheck !== undefined
      ? [`${instruction.span.so}:${instruction.span.eo} ${typeText(instruction.typeCheck.type)}`]
      : [],
  );
}

/** The host globals a source may read: the host value, and a host-started binding's own (`WrittenCase.globals`). */
const GLOBALS = ["hostValue", "hostInit"];

/** A source's request and its bindings' ids, once per exact source (a `CoreProgram` builds its graph and dominators). */
const prepared = new Map<
  string,
  { readonly request: CoreAnalysisRequest; readonly ids: Map<string, PlaceId> }
>();

function prepare(source: string) {
  let known = prepared.get(source);
  if (known === undefined) {
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
    assert.ok(request !== null, `${JSON.stringify(source)}: its file parses and resolves`);
    const ids = new Map<string, PlaceId>();
    for (const { id, kind } of new CoreProgram(request).places)
      if (kind.kind === "binding" && !ids.has(kind.name)) ids.set(kind.name, id);
    prepared.set(source, (known = { request, ids }));
  }
  return known;
}

/**
 * The place's admitted kinds at each prefix of `path`, and the program's C9 boundaries, sorted, each as `root level
 * [against] start:end` (`WrittenCase.boundaries`).
 */
function decision(answers: Answers, id: PlaceId, path: readonly string[]) {
  return {
    levels: Array.from({ length: path.length + 1 }, (_, length) => {
      const admitted = answers.place(id, path.slice(0, length)).admitted;
      return admitted.by === "undecided" ? ["undecided"] : sorted(admitted.kinds);
    }),
    boundaries: answers.checks
      .filter((check) => check.boundary)
      .map((check) => {
        const steps = check.target.split(".");
        const level = steps.filter((step) => step === "element" || step === "entry").length;
        return `${steps[0]} ${level} [${sorted(check.against).join(",")}] ${check.site.start}:${check.site.end}`;
      })
      .sort(),
  };
}

/** The line of `source` an offset is on. */
function lineAt(source: string, offset: number): string {
  const end = source.indexOf("\n", offset);
  return source.slice(source.lastIndexOf("\n", offset - 1) + 1, end < 0 ? undefined : end);
}

/** A written case's element path down its levels. */
const elementsOf = (c: WrittenCase): string[] => Array<string>(c.levels.length - 1).fill("element");

/**
 * The decision of one source in one order (its analysis released before the route compiles), and its whole plan where
 * the route takes it.
 */
function observe(c: WrittenCase) {
  const { request, ids } = prepare(c.source);
  const decided = (() => {
    const answers = analyseCore(request);
    return {
      ...decision(answers, ids.get(c.place)!, elementsOf(c)),
      outcome: answers.outcome,
      diagnostics: [
        ...new Set(
          answers.diagnostics.map(
            (found) => `${found.class} ${found.kind} ${lineAt(c.source, found.site.start)}`,
          ),
        ),
      ].sort(),
    };
  })();
  let plan: InstructionPlan | null | "outside";
  try {
    plan = compileSourceWithBackend(c.source, { globals: GLOBALS }, CORE_BACKEND).plan;
  } catch (error) {
    if (!(error instanceof CandidateOutsideSlice)) throw error;
    plan = "outside";
  }
  return { ...decided, plan };
}

/** A plan's run of each host value of `c`, where the route takes the source. */
function runsOf(c: WrittenCase, plan: InstructionPlan | null | "outside") {
  return plan === "outside" || plan === null
    ? []
    : c.runs.map(([value]) => {
        const ran = runGlobals(plan, { ...c.globals, hostValue: value });
        return { status: ran.status, failure: ran.failure, says: ran.said.map(({ text }) => text) };
      });
}

/**
 * Every layer of one exact input with the sharing on and off: each mode's decision and checked stores, analysed and
 * compiled in both orders (`inBothOrders` compares the whole plans), and the runs of each distinct plan, a plan equal
 * to the sharing's own running nothing again.
 */
function observeModes(c: WrittenCase) {
  const modes = [
    inBothOrders(() => observe(c)),
    inBothOrders(() => withoutSharing(() => observe(c))),
  ];
  const shared = runsOf(c, modes[0]!.plan);
  return modes.map(({ plan, ...decided }, index) => ({
    ...decided,
    checks: plan === "outside" ? "outside" : plan === null ? "no plan" : checksOf(plan),
    runs: index === 0 || isDeepStrictEqual(plan, modes[0]!.plan) ? shared : runsOf(c, plan),
  }));
}

/** Each exact input's observations, the sharing on and off, shared by every row that holds it (Astra's D3). */
const observations = new Map<string, ReturnType<typeof observeModes>>();

function observed(c: WrittenCase, shared: boolean): ReturnType<typeof observeModes>[number] {
  const key = JSON.stringify([
    c.source,
    c.place,
    c.levels.length,
    c.runs.map(([value]) => value),
    c.globals,
  ]);
  let found = observations.get(key);
  if (found === undefined) observations.set(key, (found = observeModes(c)));
  return found[shared ? 0 : 1]!;
}

/**
 * The sources of `cases` that fail a layer, how many the route took in every layer, the forms and the decisions it took
 * in none of their sources, and the rows it took whose kinds no host value has (each runs forbidden values only).
 */
function failing(cases: readonly WrittenCase[]): {
  wrong: string[];
  full: number;
  decisionOnly: string;
  forbiddenOnly: string;
} {
  const wrong: string[] = [];
  const taken = { forms: new Map<string, boolean>(), decisions: new Map<string, boolean>() };
  const forbiddenOnly = new Set<string>();
  let full = 0;
  for (const c of cases) {
    for (const shared of [true, false]) {
      const seen = observed(c, shared);
      const name = `${c.name}${shared ? "" : " (no sharing)"}`;
      if (JSON.stringify(seen.levels) !== JSON.stringify(c.levels.map(sorted)))
        wrong.push(`${name}: admits ${JSON.stringify(seen.levels)}`);
      if (JSON.stringify(seen.boundaries) !== JSON.stringify(c.boundaries))
        wrong.push(`${name}: C9 boundaries ${JSON.stringify(seen.boundaries)}`);
      const diagnostics = [
        ...new Set(c.warned.map((line) => `warning-runtime-check written-target ${line}`)),
      ].sort();
      const outcome = diagnostics.length > 0 ? "warning-runtime-check" : "valid";
      if (
        seen.outcome !== outcome ||
        JSON.stringify(seen.diagnostics) !== JSON.stringify(diagnostics)
      )
        wrong.push(`${name}: ${seen.outcome}, diagnostics ${JSON.stringify(seen.diagnostics)}`);
      const inside = seen.checks !== "outside";
      if (inside !== c.executable)
        wrong.push(`${name}: the route ${inside ? "takes" : "does not take"} it`);
      if (shared) {
        taken.forms.set(c.form, (taken.forms.get(c.form) ?? false) || inside);
        taken.decisions.set(c.decision, (taken.decisions.get(c.decision) ?? false) || inside);
      }
      if (!inside) continue;
      if (shared) full += 1;
      const checks = seen.checks;
      if (checks === "no plan" || JSON.stringify(checks) !== JSON.stringify(c.checks))
        wrong.push(`${name}: checks ${JSON.stringify(checks)}`);
      const runs = c.runs.map(([, stop]) =>
        stop === null
          ? { status: "halted", failure: null, says: ["DONE"] }
          : { status: "failed", failure: stop, says: [] },
      );
      if (JSON.stringify(seen.runs) !== JSON.stringify(runs))
        wrong.push(`${name}: runs ${JSON.stringify(seen.runs)}`);
      // (every row the route takes runs a forbidden value, and a conforming one where its kinds are a host value's)
      if (!c.runs.some(([, stop]) => stop !== null)) wrong.push(`${name}: no forbidden run`);
      if (!c.runs.some(([, stop]) => stop === null)) {
        if (!/timer|media|messageHandle|speaker/.test(c.form))
          wrong.push(`${name}: no conforming run`);
        else if (shared) forbiddenOnly.add(c.form);
      }
    }
  }
  const none = (map: Map<string, boolean>): string =>
    [...map].flatMap(([name, inside]) => (inside ? [] : [name])).join(", ") || "none";
  return {
    wrong,
    full,
    decisionOnly: `forms ${none(taken.forms)}; decisions ${none(taken.decisions)}`,
    forbiddenOnly: [...forbiddenOnly].join(", ") || "none",
  };
}

test("a written type or a copy of it admits its written domain at every level, null alone included (merged S6 B1)", (t) => {
  const { wrong, full } = failing(WRITTEN_DOMAIN_MATRIX);
  t.diagnostic(
    `${WRITTEN_DOMAIN_MATRIX.length} sources (${full} in all three layers), both orders, sharing on and off`,
  );
  assert.deepEqual(wrong, []);
});

/**
 * The sources of `cases` where an unrestricted part's contents owe anything (a diagnostic, a check, a boundary) or the
 * place's levels differ, and how many the route planned and ran (each saying DONE, nothing checked). Each mode compiles
 * in both orders, its whole plans compared; a plan equal to the sharing's own runs nothing again.
 */
function owing(cases: readonly UnrestrictedCase[]): { wrong: string[]; full: number } {
  const wrong: string[] = [];
  let full = 0;
  for (const c of cases) {
    const { request, ids } = prepare(c.source);
    let ran: { readonly plan: InstructionPlan; readonly says: string[] } | undefined;
    for (const shared of [true, false]) {
      const run = () => {
        const answers = analyseCore(request);
        const levels = decision(answers, ids.get(c.place)!, c.path).levels;
        const result = {
          outcome: answers.outcome,
          diagnostics: answers.diagnostics.length,
          checks: answers.checks.length,
        };
        let plan: InstructionPlan | null | "outside";
        try {
          plan = compileSourceWithBackend(c.source, { globals: GLOBALS }, CORE_BACKEND).plan;
        } catch (error) {
          if (!(error instanceof CandidateOutsideSlice)) throw error;
          plan = "outside";
        }
        return { levels, ...result, plan };
      };
      const { plan, ...result } = inBothOrders(() => (shared ? run() : withoutSharing(run)));
      if (plan !== "outside" && plan !== null && !isDeepStrictEqual(plan, ran?.plan))
        ran = { plan, says: runGlobals(plan, { hostValue: 1 }).said.map(({ text }) => text) };
      const observed = {
        ...result,
        plan:
          plan === "outside"
            ? "outside"
            : plan === null
              ? "no plan"
              : { checks: checksOf(plan), says: ran!.says },
      };
      if (shared && observed.plan !== "outside") full += 1;
      const expected = {
        levels: c.levels.map(sorted),
        outcome: "valid",
        diagnostics: 0,
        checks: 0,
        plan: c.executable ? { checks: [], says: ["DONE"] } : "outside",
      };
      if (JSON.stringify(observed) !== JSON.stringify(expected))
        wrong.push(`${c.name}${shared ? "" : " (no sharing)"}: ${JSON.stringify(observed)}`);
    }
  }
  return { wrong, full };
}

test("an unrestricted written collection takes any known contents, owing nothing for its elements (merged S6 B2)", (t) => {
  const { wrong, full } = owing(UNRESTRICTED_COLLECTION_MATRIX);
  t.diagnostic(
    `${UNRESTRICTED_COLLECTION_MATRIX.length} sources (${full} planned and run), both orders, sharing on and off`,
  );
  assert.deepEqual(wrong, []);
});

test("an object's properties take any contents in every form, copy and projection, owing nothing (merged S6 B2, Sol r1)", (t) => {
  const { wrong, full } = owing(OBJECT_PROPERTY_MATRIX);
  t.diagnostic(
    `${OBJECT_PROPERTY_MATRIX.length} sources (${full} planned and run), both orders, sharing on and off`,
  );
  assert.deepEqual(wrong, []);
});

test("V30 §13's written types, each form and copy, admit what they permit in every layer (merged S6 B1, B2)", (t) => {
  const { wrong, full, decisionOnly, forbiddenOnly } = failing(V30_TYPE_MATRIX);
  t.diagnostic(
    `${V30_TYPE_MATRIX.length} sources (${full} in all three layers), both orders, sharing on and off; ` +
      `decision layer only (outside the candidate slice): ${decisionOnly}; forbidden values only (no host value is ` +
      `a timer, media or message handle or a speaker): ${forbiddenOnly}`,
  );
  assert.deepEqual(wrong, []);
});

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
 * `p` is written `function p: …`: V30's `function p(): …` breaks §11's "Parentheses are omitted when there are no
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
 * One type written twice is one type, not another type beside it (§13; ADR 0021 3.2, `T?` is `T | null`), also when
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

test("V30 §13's union examples: f–p one compile error at the written type naming the union, h's form with its suggestion, a–e and a type written twice valid (r4.75 (3))", () => {
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
  // the place keeps its written type (TABLE A1, A4): stores and copies that fit it add nothing to the one error
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
test("V30 §13's union rule at every place and depth: one compile error at the written type naming the union (r4.75 (3))", (t) => {
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

test("a copy of an unannotated source has its whole-source type, a later fraction or null included (Q1, ADR 0021 1.1, 1.2, r4.28)", (t) => {
  const { wrong, full } = failing(INFERRED_COPY_MATRIX);
  t.diagnostic(
    `${INFERRED_COPY_MATRIX.length} sources (${full} in all three layers), both orders, sharing on and off`,
  );
  assert.deepEqual(wrong, []);
});

test("a copy of an unannotated parameter whose default copies a written binding has the written type (F21, r4.75 (1))", (t) => {
  const { wrong, full } = failing(DEFAULT_CHAIN_MATRIX);
  t.diagnostic(
    `${DEFAULT_CHAIN_MATRIX.length} sources (${full} in all three layers; a function is outside the candidate slice), both orders, sharing on and off`,
  );
  assert.deepEqual(wrong, []);
});

test("a copy keeps its source's written type past a later copy back, and agrees with its source on a cycle of copies (Sol r2)", () => {
  const levelsOf = (source: string, places: readonly string[], path = ["element"]) => {
    const { request, ids } = prepare(source);
    const run = () => {
      const answers = analyseCore(request);
      return {
        outcome: answers.outcome,
        levels: places.map((place) => decision(answers, ids.get(place)!, path).levels),
      };
    };
    const shared = inBothOrders(run);
    assert.deepEqual(
      inBothOrders(() => withoutSharing(run)),
      shared,
    );
    return shared;
  };
  // a copy back into the source after its own written copy closes no cycle its decision waits on
  const back = levelsOf(
    "let typed: null[] = [null]\nlet a = null\nlet b = a\na = typed\na = b\nlet out = b\nout = [hostValue]\nexit\n",
    ["b", "out"],
  );
  // (`a`'s own `null` start before its written copy makes it optional, and its copies with it: Astra's F2)
  assert.deepEqual(back.levels, [
    [["list", "null"], ["null"]],
    [["list", "null"], ["null"]],
  ]);
  const swap = levelsOf(
    "let typed: integer?[] = [1]\nlet a = typed\nlet b = [2]\nlet tmp = a\na = b\nb = tmp\ntmp = [null]\nexit\n",
    ["tmp"],
  );
  assert.deepEqual(swap, { outcome: "valid", levels: [[["list"], ["integer", "null"]]] });
  // a cycle of copies before the source's written copy: the copy admits what its source does
  const cycle = levelsOf(
    "let typed: null[] = [null]\nlet a = null\nlet b = a\na = b\na = typed\nlet out = b\nout = [hostValue]\nexit\n",
    ["b", "out"],
  );
  assert.deepEqual(cycle.levels[1]![1], cycle.levels[0]![1]);
  // a place copied into itself at another path is no cycle: `a.q.p` copies `a.p` (Sol's round 3 B2), in either order
  const inside = levelsOf(
    "let typed: null = null\nlet a = {p: typed, q: null}\na.q = a\nlet out = a.q.p\nout = hostValue\nexit\n",
    ["out"],
    [],
  );
  assert.deepEqual(inside, { outcome: "warning-runtime-check", levels: [[["null"]]] });
  // a cycle of whole copies brings every member the written type's paths (Sol's round 4 B1)
  const round = levelsOf(
    "let typed: null[] = [null]\nlet a0 = typed\nlet a1 = a0\nlet a2 = a1\na0 = a2\nlet out = a2\nout = hostValue\nexit\n",
    ["a1", "a2", "out"],
  );
  assert.deepEqual(round.levels, [
    [["list"], ["null"]],
    [["list"], ["null"]],
    [["list"], ["null"]],
  ]);
  // a place nesting itself without end stops at the deepest path a written type reaches, within the allowance
  const nesting = levelsOf(
    "let typed: integer[] = [1]\nlet a = null\na = a[0]\na = [[typed]]\nlet out = a\nexit\n",
    ["out"],
    [],
  );
  assert.notEqual(nesting.outcome, "budget-error");
});

/**
 * TABLE r4.80 (the owner's reviewer's F1 on #1049): a field a copy inherits a written type at is decided where the copy's
 * own store reaches it, whatever no read asks, in every layer: a misfitting value stored into it is an error at that
 * value; host data stored into it owes its check there, against the inherited type, which the candidate plan holds at
 * the store and which stops a forbidden value before anything is said. For a copy, a copy of a copy and a second copy
 * of the root, in both orders, with the sharing on and off. A `fromJson` call is outside the candidate route: its
 * decision is the host value's.
 */
test("a copy's inherited written field is decided at the copy's own store in every layer (TABLE r4.80)", () => {
  const span = (source: string, text: string, from = 0): string => {
    const start = source.indexOf(text, from);
    assert.ok(start >= 0, `${JSON.stringify(text)} in ${JSON.stringify(source)}`);
    return `${start}:${start + text.length}`;
  };
  for (const copies of [
    "let a = root",
    "let first = root\nlet a = first",
    "let other = root\nlet a = root",
  ]) {
    const prefix = `let typed: integer = 1\nlet root = {f: typed, g: typed}\n${copies}\n`;
    const wrong = `${prefix}a.f = "x"\nexit\n`;
    const host = `${prefix}a.f = hostValue\nsay "stored"\nexit\n`;
    const parsed = `${prefix}a.f = fromJson(hostValue)\nexit\n`;
    const store = prefix.length;
    for (const shared of [true, false]) {
      const decided = (source: string) =>
        inBothOrders(() => {
          const run = (): Answers =>
            analyseCore(coreRequest([{ path: "main.tease", source }], GLOBALS)!);
          const answers = shared ? run() : withoutSharing(run);
          return {
            outcome: answers.outcome,
            diagnostics: answers.diagnostics.map(
              (found) => `${found.class} ${found.kind} ${found.site.start}:${found.site.end}`,
            ),
            boundaries: answers.checks
              .filter((check) => check.boundary)
              .map(
                (check) =>
                  `${check.target} [${sorted(check.against).join(",")}] ${check.site.start}:${check.site.end}`,
              ),
          };
        });
      const mode = `${JSON.stringify(copies)}${shared ? "" : " (no sharing)"}`;
      assert.deepEqual(
        decided(wrong),
        {
          outcome: "compile-error",
          diagnostics: [`compile-error written-target ${span(wrong, '"x"', store)}`],
          boundaries: [],
        },
        mode,
      );
      const at = span(host, "hostValue", store);
      assert.deepEqual(
        decided(host),
        {
          outcome: "warning-runtime-check",
          diagnostics: [`warning-runtime-check written-target ${at}`],
          boundaries: [`a.f [integer] ${at}`],
        },
        mode,
      );
      const call = span(parsed, "fromJson(hostValue)", store);
      assert.deepEqual(
        decided(parsed),
        {
          outcome: "warning-runtime-check",
          diagnostics: [`warning-runtime-check written-target ${call}`],
          boundaries: [`a.f [integer] ${call}`],
        },
        mode,
      );
      const compile = (): InstructionPlan | null =>
        compileSourceWithBackend(host, { globals: GLOBALS }, CORE_BACKEND).plan;
      const plan = shared ? compile() : withoutSharing(compile);
      assert.ok(plan !== null, mode);
      assert.deepEqual(checksOf(plan), [`${span(host, "a.f = hostValue", store)} integer`], mode);
      const fits = runGlobals(plan, { hostValue: 5 });
      assert.deepEqual(
        [fits.status, fits.failure, fits.said.map(({ text }) => text)],
        ["halted", null, ["stored"]],
        mode,
      );
      const misfits = runGlobals(plan, { hostValue: "x" });
      assert.deepEqual(
        [misfits.status, misfits.failure, misfits.said],
        ["failed", `TSR058@${at}`, []],
        mode,
      );
    }
  }
});

/**
 * Sol's review r1 on #1059 (TABLE r4.80's repair): a place copying itself whole twice decides as before, with the sharing
 * on and off; a record whose host or misfitting field another copy's written type lands in the copy owes its check or
 * its error at the copy's store, the check in the plan stopping a forbidden value (all three layers); and a store
 * rejected at a field stays rejected through a cycle of copies that adds a step. Both orders, the sharing on and off.
 */
test("copies of different sources, repeated self copies and a rejection through a path cycle keep their answers", () => {
  const at = (source: string, text: string): string => {
    const start = source.lastIndexOf(text);
    return `${start}:${start + text.length}`;
  };
  const decided = (source: string, shared: boolean) =>
    inBothOrders(() => {
      const run = (): Answers =>
        analyseCore(coreRequest([{ path: "main.tease", source }], GLOBALS)!);
      const answers = shared ? run() : withoutSharing(run);
      return {
        outcome: answers.outcome,
        diagnostics: answers.diagnostics.map(
          (found) => `${found.class} ${found.kind} ${found.site.start}:${found.site.end}`,
        ),
        checks: answers.checks
          .map(
            (check) =>
              `${check.target} [${sorted(check.against).join(",")}] ${check.site.start}:${check.site.end}${check.boundary ? " boundary" : ""}`,
          )
          .sort(),
      };
    });
  const typed = "let typed:integer=1\n";
  const self = `${typed}let a={f:typed}\na=a\na=a\nexit\n`;
  const host = `${typed}let root={f:typed}\nlet other={f:hostValue,g:typed}\nlet a=root\na=other\nsay "stored"\nexit\n`;
  const text = `${typed}let root={f:typed}\nlet other={f:"s",g:typed}\nlet a=root\na=other\nexit\n`;
  const cycle = `${typed}let root={f:typed}\nlet bad={f:"s"}\nlet a=root\nlet b={p:a}\na=b.p\na=bad\nexit\n`;
  for (const shared of [true, false]) {
    const mode = shared ? "" : " (no sharing)";
    assert.deepEqual(
      decided(self, shared),
      { outcome: "valid", diagnostics: [], checks: [] },
      `self${mode}`,
    );
    const copy = at(host, "other");
    assert.deepEqual(
      decided(host, shared),
      {
        outcome: "warning-runtime-check",
        diagnostics: [`warning-runtime-check written-target ${copy}`],
        checks: [`a.f [integer] ${copy}`, `other [object] ${at(host, "hostValue")} boundary`],
      },
      `host${mode}`,
    );
    assert.deepEqual(
      decided(text, shared),
      {
        outcome: "compile-error",
        diagnostics: [`compile-error written-target ${at(text, "other")}`],
        checks: [],
      },
      `text${mode}`,
    );
    assert.deepEqual(
      decided(cycle, shared),
      {
        outcome: "compile-error",
        diagnostics: [`compile-error written-target ${at(cycle, "bad")}`],
        checks: [],
      },
      `cycle${mode}`,
    );
    const compile = (): InstructionPlan | null =>
      compileSourceWithBackend(host, { globals: GLOBALS }, CORE_BACKEND).plan;
    const plan = shared ? compile() : withoutSharing(compile);
    assert.ok(plan !== null, `host plan${mode}`);
    // (the record's own host data checked where it is declared, its copy's field where it lands)
    assert.deepEqual(
      checksOf(plan),
      [`${at(host, "let other={f:hostValue,g:typed}")} object`, `${at(host, "a=other")} object`],
      `host plan${mode}`,
    );
    const fits = runGlobals(plan, { hostValue: 5 });
    assert.deepEqual(
      [fits.status, fits.failure, fits.said.map(({ text: said }) => said)],
      ["halted", null, ["stored"]],
    );
    const misfits = runGlobals(plan, { hostValue: "bad" });
    assert.deepEqual(
      [misfits.status, misfits.failure, misfits.said],
      ["failed", `TSR058@${copy}`, []],
    );
  }
});
