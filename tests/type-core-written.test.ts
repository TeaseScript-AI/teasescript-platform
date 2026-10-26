import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../src/compiler.js";
import type { InstructionPlan, TypePlan } from "../src/plan/model.js";
import { analyseCore, coreResult, type Answers } from "../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { type CoreAnalysisRequest, CoreProgram } from "../src/type-inference/core/program.js";
import { coreRecord } from "../src/type-inference/core/result.js";
import type { PlaceId } from "../src/type-inference/graph.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
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
 * Each exact source is analysed, planned and run once per mode, and every row that holds it is compared with that.
 * V30 §13's union rule (`UNION_RULE_MATRIX`, its examples) is a compile error with no plan: the decision layer and the
 * candidate route's rejection.
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
 * Every layer of one source in one order: the decision (its analysis released before the route compiles), and the plan
 * and its runs where the route takes it.
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
  return {
    ...decided,
    checks: plan === "outside" ? "outside" : plan === null ? "no plan" : checksOf(plan),
    runs:
      plan === "outside" || plan === null
        ? []
        : c.runs.map(([value]) => {
            const ran = runGlobals(plan, { ...c.globals, hostValue: value });
            return {
              status: ran.status,
              failure: ran.failure,
              says: ran.said.map(({ text }) => text),
            };
          }),
  };
}

/** Each exact input's observation per mode, shared by every row that holds it (Astra's D3). */
const observations = new Map<string, ReturnType<typeof observe>>();

function observed(c: WrittenCase, shared: boolean): ReturnType<typeof observe> {
  const key = JSON.stringify([
    shared,
    c.source,
    c.place,
    c.levels.length,
    c.runs.map(([value]) => value),
    c.globals,
  ]);
  let found = observations.get(key);
  if (found === undefined) {
    found = inBothOrders(() => (shared ? observe(c) : withoutSharing(() => observe(c))));
    observations.set(key, found);
  }
  return found;
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
 * place's levels differ, and how many the route planned and ran (each saying DONE, nothing checked).
 */
function owing(cases: readonly UnrestrictedCase[]): { wrong: string[]; full: number } {
  const wrong: string[] = [];
  let full = 0;
  for (const c of cases) {
    const { request, ids } = prepare(c.source);
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
        return {
          levels,
          ...result,
          plan:
            plan === "outside"
              ? "outside"
              : plan === null
                ? "no plan"
                : {
                    checks: checksOf(plan),
                    says: runGlobals(plan, { hostValue: 1 }).said.map(({ text }) => text),
                  },
        };
      };
      const observed = inBothOrders(() => (shared ? run() : withoutSharing(run)));
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
    `${OBJECT_PROPERTY_MATRIX.length} sources (${full} planned and run; object literals are outside the candidate slice), both orders, sharing on and off`,
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

/**
 * A request's outcome and every diagnostic, sorted, each `class kind start:end`; a written type's error as
 * `written-type start:end union start:end suggests …` (`WrittenTypeError`).
 */
function writtenErrors(request: CoreAnalysisRequest) {
  const answers = analyseCore(request);
  return {
    outcome: answers.outcome,
    diagnostics: answers.diagnostics
      .map((found) =>
        found.kind === "written-type"
          ? `written-type ${found.site.start}:${found.site.end} union ${found.union.start}:${found.union.end} ` +
            `suggests ${found.suggestion}`
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

test("V30 §13's union examples: f–p one compile error at the written type naming the union, h's form with its suggestion, a–e valid (r4.75 (3))", () => {
  const wrong: string[] = [];
  for (const [line, type, unionText, suggestion] of V30_UNION_EXAMPLES)
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

test("V30 §13's union rule at every place and depth: one compile error at the written type naming the union (r4.75 (3))", (t) => {
  const wrong: string[] = [];
  let errors = 0;
  for (const c of UNION_RULE_MATRIX) {
    const request = requestOf(c.source);
    const seen = inBothOrders(() => writtenErrors(request));
    const expected =
      c.error === null
        ? { outcome: "valid", diagnostics: [] }
        : {
            outcome: "compile-error",
            diagnostics: [
              `written-type ${c.error.site} union ${c.error.union} suggests ${c.error.suggestion}`,
            ],
          };
    if (c.error !== null) errors += 1;
    if (JSON.stringify(seen) !== JSON.stringify(expected))
      wrong.push(`${c.name}: ${JSON.stringify(seen)}`);
    if (routeTakes(c.source)) wrong.push(`${c.name}: the candidate route takes it`);
  }
  t.diagnostic(
    `${UNION_RULE_MATRIX.length} sources (${errors} errors, ${UNION_RULE_MATRIX.length - errors} valid controls), ` +
      "both orders; the candidate route takes none (a written union is outside its slice until S10)",
  );
  assert.deepEqual(wrong, []);
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
