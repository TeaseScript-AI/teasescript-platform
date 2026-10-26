import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../src/compiler.js";
import type { InstructionPlan, TypePlan } from "../src/plan/model.js";
import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { type CoreAnalysisRequest, CoreProgram } from "../src/type-inference/core/program.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { runGlobals } from "./helpers/type-core-route.js";
import {
  INFERRED_COPY_MATRIX,
  UNRESTRICTED_COLLECTION_MATRIX,
  V30_TYPE_MATRIX,
  WRITTEN_DOMAIN_MATRIX,
  type WrittenCase,
} from "./helpers/type-core-written.js";

/*
 * The written-domain matrices (`type-core-written.ts`; the lead's rulings on the merged S6's B1 and B2: A4, F17b,
 * §4's fit rule, ADR 0021 1.3, V30 §13), each source in both orders and with the sharing on and off, in three layers:
 * the decision (the place's admitted kinds at each level and C9's `against` at each of its targets, none at a level
 * that admits every kind), the plan (each store that brings a host value checked against the whole written type) and
 * the runs (each host value that fits says DONE, each other one stops at TSR058 at the first checked store's value,
 * nothing said). A source the candidate route does not take is checked in the decision layer alone.
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

/** The place's admitted kinds at each of its first `count` levels and C9's `against` at each of its targets. */
function decision(answers: Answers, request: CoreAnalysisRequest, place: string, count: number) {
  const id = new CoreProgram(request).places.find(
    ({ kind }) => kind.kind === "binding" && kind.name === place,
  )!.id;
  return {
    levels: Array.from({ length: count }, (_, level) => {
      const admitted = answers.place(id, Array<string>(level).fill("element")).admitted;
      return admitted.by === "undecided" ? ["undecided"] : sorted(admitted.kinds);
    }),
    against: answers.checks
      .filter((check) => check.boundary && check.target.split(".")[0] === place)
      .map((check) => ({
        level: check.target.split(".").filter((step) => step === "element" || step === "entry")
          .length,
        kinds: sorted(check.against),
      })),
  };
}

/** Every layer of one source in one order: the decision, and the plan and its runs where the route takes it. */
function observe(c: WrittenCase, request: CoreAnalysisRequest) {
  const answers = analyseCore(request);
  let plan: InstructionPlan | null | "outside";
  try {
    plan = compileSourceWithBackend(c.source, { globals: ["hostValue"] }, CORE_BACKEND).plan;
  } catch (error) {
    if (!(error instanceof CandidateOutsideSlice)) throw error;
    plan = "outside";
  }
  return {
    ...decision(answers, request, c.place, c.levels.length),
    checks: plan === "outside" ? "outside" : plan === null ? "no plan" : checksOf(plan),
    runs:
      plan === "outside" || plan === null
        ? []
        : c.runs.map(([value]) => {
            const ran = runGlobals(plan, { hostValue: value });
            return {
              status: ran.status,
              failure: ran.failure,
              says: ran.said.map(({ text }) => text),
            };
          }),
  };
}

/** The sources of `cases` that fail a layer, and how many the route took in every layer. */
function failing(cases: readonly WrittenCase[]): {
  wrong: string[];
  full: number;
  decisionOnly: Set<string>;
} {
  const wrong: string[] = [];
  const decisionOnly = new Set<string>();
  let full = 0;
  for (const c of cases) {
    const request = coreRequest([{ path: "main.tease", source: c.source }]);
    assert.ok(request !== null, `${c.name}: its file parses and resolves`);
    for (const shared of [true, false]) {
      const observed = inBothOrders(() =>
        shared ? observe(c, request) : withoutSharing(() => observe(c, request)),
      );
      const name = `${c.name}${shared ? "" : " (no sharing)"}`;
      if (JSON.stringify(observed.levels) !== JSON.stringify(c.levels.map(sorted)))
        wrong.push(`${name}: admits ${JSON.stringify(observed.levels)}`);
      for (const { level, kinds } of observed.against)
        if (
          JSON.stringify(kinds) !== JSON.stringify(sorted(c.levels[level] ?? ["unowed"])) ||
          kinds.includes("unknown")
        )
          wrong.push(`${name}: C9 at level ${level} against ${JSON.stringify(kinds)}`);
      if (observed.checks === "outside") {
        if (shared) decisionOnly.add(c.form);
        continue;
      }
      if (shared) full += 1;
      const checks = observed.checks;
      if (
        checks === "no plan" ||
        (c.exact
          ? JSON.stringify(checks) !== JSON.stringify(c.checks)
          : !c.checks.every((check) => checks.includes(check)))
      )
        wrong.push(`${name}: checks ${JSON.stringify(checks)}`);
      const runs = c.runs.map(([, stop]) =>
        stop === null
          ? { status: "halted", failure: null, says: ["DONE"] }
          : { status: "failed", failure: stop, says: [] },
      );
      if (observed.runs.length > 0 && JSON.stringify(observed.runs) !== JSON.stringify(runs))
        wrong.push(`${name}: runs ${JSON.stringify(observed.runs)}`);
    }
  }
  return { wrong, full, decisionOnly };
}

test("a written type or a copy of it admits its written domain at every level, null alone included (merged S6 B1)", (t) => {
  const { wrong, full } = failing(WRITTEN_DOMAIN_MATRIX);
  t.diagnostic(
    `${WRITTEN_DOMAIN_MATRIX.length} sources (${full} in all three layers), both orders, sharing on and off`,
  );
  assert.deepEqual(wrong, []);
});

test("an unrestricted written collection takes any known contents, owing nothing for its elements (merged S6 B2)", (t) => {
  const wrong: string[] = [];
  let full = 0;
  for (const c of UNRESTRICTED_COLLECTION_MATRIX) {
    const request = coreRequest([{ path: "main.tease", source: c.source }]);
    assert.ok(request !== null, `${c.name}: its file parses and resolves`);
    for (const shared of [true, false]) {
      const run = () => {
        const answers = analyseCore(request);
        let plan: InstructionPlan | null | "outside";
        try {
          plan = compileSourceWithBackend(c.source, { globals: ["hostValue"] }, CORE_BACKEND).plan;
        } catch (error) {
          if (!(error instanceof CandidateOutsideSlice)) throw error;
          plan = "outside";
        }
        return {
          ...decision(answers, request, c.place, c.levels.length),
          outcome: answers.outcome,
          diagnostics: answers.diagnostics.length,
          checks: answers.checks.length,
          plan:
            plan === "outside"
              ? "outside"
              : plan === null
                ? "no plan"
                : {
                    checks: checksOf(plan),
                    says: runGlobals(plan, {}).said.map(({ text }) => text),
                  },
        };
      };
      const observed = inBothOrders(() => (shared ? run() : withoutSharing(run)));
      if (shared && observed.plan !== "outside") full += 1;
      const expected = {
        levels: c.levels.map(sorted),
        against: [],
        outcome: "valid",
        diagnostics: 0,
        checks: 0,
        plan: observed.plan === "outside" ? "outside" : { checks: [], says: ["DONE"] },
      };
      if (JSON.stringify(observed) !== JSON.stringify(expected))
        wrong.push(`${c.name}${shared ? "" : " (no sharing)"}: ${JSON.stringify(observed)}`);
    }
  }
  t.diagnostic(
    `${UNRESTRICTED_COLLECTION_MATRIX.length} sources (${full} planned and run), both orders, sharing on and off`,
  );
  assert.deepEqual(wrong, []);
});

test("V30 §13's written types, each form and copy, admit what they permit in every layer (merged S6 B1, B2)", (t) => {
  const { wrong, full, decisionOnly } = failing(V30_TYPE_MATRIX);
  t.diagnostic(
    `${V30_TYPE_MATRIX.length} sources (${full} in all three layers), both orders, sharing on and off; ` +
      `decision layer only (outside the candidate slice): ${[...decisionOnly].join(", ")}`,
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
