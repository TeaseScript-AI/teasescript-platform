// The stop verdict of an enclosing case: the analysis's eight orders, the allowances around each decision's work, and
// the problems a store's check or mark shows at each (`enclosingProblems`).

import { compileSourceWithBackend, type CompilationResult } from "../../../../src/compiler.js";
import type { TypeTerm } from "../../../../src/type-inference/graph.js";
import { analyseCore, type Answers } from "../../../../src/type-inference/core/answers.js";
import {
  CandidateOutsideSlice,
  CORE_BACKEND,
} from "../../../../src/type-inference/core/backend.js";
import { asked } from "../../../../src/type-inference/core/check-result/check-result.js";
import { runtimeChecks } from "../../../../src/type-inference/core/check-result/runtime-plan.js";
import { SliceIndex } from "../../../../src/type-inference/core/check-result/slice-index.js";
import { withTestDemandAllowance } from "../../../../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../../../../src/type-inference/core/consumers.js";
import { CoreProgram, propertyName } from "../../../../src/type-inference/core/program.js";
import { withoutSharing } from "../../../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../../../src/type-inference/core/solver.js";
import { coreRequest } from "../../type-core-analysis.js";
import { plannedStores, runGlobals } from "../../type-core-route.js";
import { checkedText } from "../written/type-core-written.js";
import { type EnclosingCase } from "./type-core-enclosing.js";

/** An order of the analysis: the consumers' and the solver's worklist forward or reversed, the sharing on or off. */
export interface Mode {
  readonly name: string;
  readonly run: <T>(make: () => T) => T;
}

export const MODES: readonly Mode[] = [false, true].flatMap((consumers) =>
  [false, true].flatMap((solver) =>
    [true, false].map((sharing): Mode => ({
      name:
        `${consumers ? "reversed" : "forward"} consumers, ${solver ? "reversed" : "forward"} solver` +
        (sharing ? "" : ", unshared"),
      run: <T>(make: () => T): T => {
        const ordered = consumers
          ? (): T => withConsumerOrder((items) => [...items].reverse(), make)
          : make;
        const solved = solver
          ? (): T => withSolverSeam({ reverseWorklist: true }, ordered)
          : ordered;
        return sharing ? solved() : withoutSharing(solved);
      },
    })),
  ),
);

/** How a store relates to the stopped decisions of its binding: one at or above its path, one below it only, none. */
export type Relation = "at" | "above" | "none";

/** One judged compile of a case: the stops, the store's relation and phase, and what the oracle found wrong. */
export interface EnclosingVerdict {
  readonly allowance: number | null;
  readonly stops: readonly string[];
  readonly relation: Relation;
  /** `unsettled`: a program stop before admission settled, which marks every store into an inferred place (#1252). */
  readonly phase: "settled" | "unsettled" | "unstopped";
  /**
   * What the oracle judged: the full domain, an owned mark, or at a stop at or above the store's path its mark and no
   * requirement where `certified` is `false` (#1440), nothing for a case that does not say (#1275).
   */
  readonly judged: "domain" | "mark" | "exact";
  /**
   * Whether the compile declined at a settled stop that lost a stopped mark's completion result (#2080): no plan to
   * run, nothing published to judge.
   */
  readonly declined?: true;
  readonly problems: readonly string[];
}

/**
 * The allowances around each decision's work in a case's uncapped analysis in a mode, and 1; `own`: the decisions of
 * the destination's binding alone.
 */
export function allowancesOf(c: EnclosingCase, mode: Mode, own = false): number[] {
  const request = coreRequest([{ path: "main.tease", source: c.source }])!;
  const place = own ? placeOf(request, c) : null;
  const units = new Set(
    mode
      .run(() => analyseCore(request))
      .budget.decisions.filter((d) => place === null || d.place === place)
      .map((d) => d.units),
  );
  const out = new Set<number>([1]);
  for (const unit of units) for (const at of [unit - 1, unit, unit + 1]) if (at >= 1) out.add(at);
  return [...out].sort((a, b) => a - b);
}

/** The place of a case's destination: its binding or parameter, or its function's result. */
function placeOf(request: NonNullable<ReturnType<typeof coreRequest>>, c: EnclosingCase): number {
  const program = new CoreProgram(request);
  if (c.into.result === true) program.index();
  return program.places.find(({ kind }) =>
    c.into.result === true
      ? kind.kind === "result" && program.functionOf(kind.fn).name === c.into.binding
      : (kind.kind === "binding" || kind.kind === "parameter") && kind.name === c.into.binding,
  )!.id;
}

/** A complete type as `checkedText` prints a form. */
function termText(term: TypeTerm): string {
  switch (term.kind) {
    case "atom":
      return term.name;
    case "list":
    case "set":
    case "dict":
      return `${term.kind}<${termText(term.element)}>`;
    case "union":
      return term.members.map(termText).join("|");
    case "dynamic":
      return "any";
    default:
      return term.kind;
  }
}

/**
 * A type's text as `checkedText` and `termText` print it, compared as a type: each union's members in one order, and a
 * written `object` as the plan prints it (`{}`) named `object`.
 */
function typeText(text: string): string {
  const members: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at <= text.length; at += 1) {
    const char = text[at];
    if (char === "<") depth += 1;
    else if (char === ">") depth -= 1;
    else if ((char === "|" && depth === 0) || at === text.length) {
      const member = text.slice(start, at);
      const open = member.indexOf("<");
      members.push(
        open < 0
          ? member === "{}"
            ? "object"
            : member
          : `${member.slice(0, open)}<${typeText(member.slice(open + 1, -1))}>`,
      );
      start = at + 1;
    }
  }
  return members.sort().join("|");
}

/**
 * The budget-context records at a site, shown or deferred, whose obligation is the destination's (`target`): the stop's
 * owned marks of the store there, not a decision's own warning at another level of its value.
 */
function marksAt(answers: Answers, site: EnclosingCase["site"], target: string): number {
  return [...answers.diagnostics, ...answers.budget.deferred].filter(
    (d) =>
      d.class === "warning-runtime-check" &&
      "provenance" in d &&
      d.provenance.context === "budget" &&
      d.obligation.target === target &&
      d.site.start === site.start &&
      d.site.end === site.end,
  ).length;
}

/**
 * #2080 part 2: a decline before admission settled stands only at the site of an owed obligation against `unknown`, read
 * where the gate reads: the analysis inside `asked`.
 */
function undecidedProblems(
  request: NonNullable<ReturnType<typeof coreRequest>>,
  capped: <T>(make: () => T) => T,
  site: { readonly file: number; readonly start: number; readonly end: number },
): string[] {
  const undecided = capped(() =>
    asked(analyseCore(request), (answers) => {
      const index = new SliceIndex(request.files.map((file) => file.program));
      return [...answers.diagnostics, ...answers.budget.deferred].some((d) => {
        if (d.class !== "warning-runtime-check" || d.kind === "budget") return false;
        const { obligation } = d;
        if (obligation.against.join("|") !== "unknown" || obligation.site.file !== site.file)
          return false;
        const expression = index.expressionAt(obligation.site);
        const store = index.storeOf(expression);
        const value =
          store === undefined
            ? expression
            : store.kind === "letStatement"
              ? store.initializer
              : store.kind === "assignmentStatement"
                ? store.value
                : expression;
        return value.span.start.offset === site.start && value.span.end.offset === site.end;
      });
    }),
  );
  return undecided ? [] : [`declined at ${site.start}:${site.end} with no undecided mark there`];
}

/**
 * #1440: a store at or below a stop the source leaves unproved (`EnclosingCase.certified`) keeps its mark, its type
 * undecided, beside no requirement; so does every store into an inferred place before admission settled (#1252,
 * docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-135: the fresh pass decides no inferred
 * place). Nothing such a store owes is invented.
 */
function unprovedProblems(
  answers: Answers,
  c: EnclosingCase,
  relation: Relation,
  unproved: boolean,
  unsettledInferred: boolean,
  rejects: boolean,
  target: string,
  place: number,
): string[] {
  const problems: string[] = [];
  if (relation === "at" && unproved && marksAt(answers, c.site, target) < 1 && !rejects)
    problems.push("no mark at an unproved store at the stop");
  if ((relation === "at" && unproved) || unsettledInferred) {
    const required = answers.requirement(place, c.into.path);
    if (required !== null) problems.push(`unproved requirement ${termText(required)}`);
  }
  return problems;
}

/**
 * The oracle at one allowance (`null`: uncapped) in one mode. Every fitting value reaches `AFTER`. Where the
 * destination's complete type is the source's (`form`) and the store is neither an exact target of a stop the source
 * does not prove it apart from (`certified`, #1440; #1275) nor into an inferred place before admission settled (#1252,
 * whose mark stands for its value), every forbidden value is rejected before `AFTER`, by the compile or at its store,
 * the plan checks the store against the whole form, and a store at or above a stop has exactly one owned mark at its
 * own site and the form as its requirement; where an object literal decides the destination, or the source leaves it
 * unproved, a store above a stop has that mark, and one at the stop the mark beside no requirement.
 */
export function enclosingProblems(
  c: EnclosingCase,
  allowance: number | null,
  mode: Mode,
): EnclosingVerdict {
  const request = coreRequest([{ path: "main.tease", source: c.source }]);
  if (request === null) throw new Error(`The case does not resolve: ${c.name}`);
  const place = placeOf(request, c);
  // (the destination's obligation target, as a store's mark names it: its place's label and steps)
  const target = [
    new CoreProgram(request).place(place).label,
    ...c.into.path.map(propertyName),
  ].join(".");
  const capped = <T>(make: () => T): T =>
    mode.run(() => (allowance === null ? make() : withTestDemandAllowance(allowance, make)));
  const answers = capped(() => analyseCore(request));
  const stopped = answers.budget.decisions
    .filter((d) => d.stopped && d.place === place)
    .map((d) => d.path);
  const prefix = (of: readonly string[], path: readonly string[]): boolean =>
    of.length <= path.length && of.every((step, index) => path[index] === step);
  const relation: Relation = stopped.some((path) => prefix(path, c.into.path))
    ? "at"
    : stopped.some((path) => prefix(c.into.path, path))
      ? "above"
      : "none";
  const phase =
    answers.budget.exhausted === null
      ? stopped.length > 0
        ? "settled"
        : "unstopped"
      : answers.budget.settled
        ? "settled"
        : "unsettled";
  const unsettledInferred = phase === "unsettled" && !c.written;
  // (#1440: a store at or below a stop is judged on its whole domain where the source proves it apart from the stop
  // and the pass's results stand; one the source leaves unproved keeps its mark, its type undecided, above a stop too)
  const unproved = c.certified === false || (c.certified === true && unsettledInferred);
  const judged =
    relation === "at"
      ? c.certified === true && !unsettledInferred && c.form !== null
        ? "domain"
        : "exact"
      : c.form === null || unsettledInferred || (relation === "above" && unproved)
        ? "mark"
        : "domain";
  const problems: string[] = [];
  const inside = (d: { readonly site: EnclosingCase["site"] }): boolean =>
    d.site.start >= c.site.start && d.site.end <= c.site.end;
  const errors = answers.diagnostics.filter((d) => d.class === "compile-error" && inside(d)).length;
  // (C1's error at the store's value rejects it and stands for its mark, A6; another rule's error, as a literal's mixed
  // elements', leaves the mark)
  const rejects = answers.diagnostics.some(
    (d) => d.class === "compile-error" && "rule" in d && d.rule.rule === "store" && inside(d),
  );
  // (one owned mark at a store above a stop, none beside its rejection)
  const owned = (marks: number): boolean => marks === (rejects ? 0 : 1);
  // (the analysis's own verdict at a compiled store, with a plan or declined: its marks, requirement and proofs)
  const analysisProblems = (): string[] => {
    const found: string[] = [];
    if (relation === "above" || (relation === "at" && judged === "domain")) {
      const marks = marksAt(answers, c.site, target);
      if (judged === "domain" ? !owned(marks) : marks < 1 && !rejects)
        found.push(`${marks} owned marks at the store ${relation} the stop`);
    }
    if (relation === "at" && judged === "domain") {
      const required = answers.requirement(place, c.into.path);
      if (required === null || typeText(termText(required)) !== typeText(checkedText(c.form!)))
        found.push(`requirement ${required === null ? "none" : termText(required)}`);
    }
    if (unsettledInferred && relation !== "at" && marksAt(answers, c.site, target) < 1)
      found.push("no mark at a store into an inferred place before admission settled");
    found.push(
      ...unprovedProblems(
        answers,
        c,
        relation,
        unproved,
        unsettledInferred,
        rejects,
        target,
        place,
      ),
    );
    return found;
  };
  if (!c.slice) {
    // (at the analysis: a literal's error uncapped, and above a stop the mark and the complete type its check carries)
    if (phase === "unstopped" && !c.host && errors > 0 !== !c.values[0]!.fits)
      problems.push(`${errors} errors at the store of ${JSON.stringify(c.values[0]!.value)}`);
    if (relation !== "none" && judged === "domain") {
      const marks = marksAt(answers, c.site, target);
      if (!owned(marks)) problems.push(`${marks} owned marks at the store ${relation} the stop`);
      const required = answers.requirement(place, c.into.path);
      if (required === null || typeText(termText(required)) !== typeText(checkedText(c.form!)))
        problems.push(`requirement ${required === null ? "none" : termText(required)}`);
    }
    problems.push(
      ...unprovedProblems(
        answers,
        c,
        relation,
        unproved,
        unsettledInferred,
        rejects,
        target,
        place,
      ),
    );
    return {
      allowance,
      stops: stopped.map((path) => path.join(".")),
      relation,
      phase,
      judged,
      problems,
    };
  }
  let compiled: CompilationResult;
  try {
    compiled = capped(() =>
      compileSourceWithBackend(c.source, { globals: ["hostValue"] }, CORE_BACKEND),
    );
  } catch (error) {
    // (#2080 part 2: before admission settled, a stop's own mark against `unknown` that no complete store check carries
    // declines at its store, publishing nothing; the analysis is judged as with a plan)
    if (
      error instanceof CandidateOutsideSlice &&
      error.what === "a store whose check was left undecided at the budget" &&
      phase === "unsettled"
    ) {
      problems.push(...undecidedProblems(request, capped, error.site), ...analysisProblems());
      return {
        allowance,
        stops: stopped.map((path) => path.join(".")),
        relation,
        phase,
        judged,
        problems,
        declined: true,
      };
    }
    // (#2080 part 1: a settled stop whose stopped mark's completion result was lost or is absent declines at that mark
    // where no complete store check carries it, publishing nothing; any other decline is a problem. Read where the gate
    // reads: the registry inside `asked`, and the published contract and store check `runtimeChecks` gives the gate)
    if (
      !(error instanceof CandidateOutsideSlice) ||
      error.what !== "a store whose check was lost at the budget" ||
      phase !== "settled"
    )
      throw error;
    const site = error.site;
    const read = capped(() =>
      asked(analyseCore(request), (answers) => {
        const index = new SliceIndex(request.files.map((file) => file.program));
        const { checks, contracts } = runtimeChecks(answers, index, request);
        const at = (answers.gated() ?? []).filter(
          ({ obligation, result }) =>
            obligation.epoch === answers.epoch &&
            obligation.slot.role === "stopped" &&
            obligation.slot.site.file === site.file &&
            obligation.slot.site.start === site.start &&
            obligation.slot.site.end === site.end &&
            (result === null || result.state === "lost"),
        );
        const carried = at.some(({ obligation }) => {
          const store = index.storeAt(obligation.slot.site);
          return (
            store !== undefined && contracts.get(store)?.state === "complete" && checks.has(store)
          );
        });
        return { unresolved: at.length > 0, carried };
      }),
    );
    if (!read.unresolved)
      problems.push(`declined at ${site.start}:${site.end} with no lost or absent result there`);
    else if (read.carried)
      problems.push(
        `declined at ${site.start}:${site.end} where a complete store check carries it`,
      );
    return {
      allowance,
      stops: stopped.map((path) => path.join(".")),
      relation,
      phase,
      judged,
      problems,
      declined: true,
    };
  }
  const plan = compiled.plan;
  const within = (d: CompilationResult["diagnostics"][number]): boolean =>
    d.span.start.offset >= c.site.start && d.span.end.offset <= c.site.end;
  const rejected =
    plan === null && compiled.diagnostics.some((d) => d.severity === "error" && within(d));
  if (plan === null && !rejected)
    problems.push(
      `no plan, no error at the store: ${compiled.diagnostics.map((d) => `${d.code}@${d.span.start.offset}`).join(",")}`,
    );
  for (const { value, fits: fitting } of c.values) {
    const what = JSON.stringify(value);
    // (a fitting value plays whatever is judged: a mark with its type undecided rejects none, #1440's family)
    const judgesFitting = judged !== "exact" || c.certified !== undefined;
    if (plan === null) {
      if (fitting && judgesFitting) problems.push(`fitting ${what} rejected by the compile`);
      continue;
    }
    const ran = runGlobals(plan, { hostValue: c.host ? value : null });
    const after = ran.said.some((said) => said.text === "AFTER");
    if (fitting && !after && judgesFitting)
      problems.push(`fitting ${what} stopped: ${ran.failure ?? ran.status}`);
    if (!fitting && after && judged === "domain") problems.push(`forbidden ${what} reached AFTER`);
  }
  if (plan !== null && judged === "domain" && c.form !== null) {
    const site = `${c.site.start}:${c.site.end}`;
    const planned = plannedStores(plan).find((store) => store.includes(` ${site} `));
    const type = planned?.slice(planned.lastIndexOf(" ") + 1);
    if (type !== undefined && typeText(type) !== typeText(checkedText(c.form)))
      problems.push(`planned ${planned}, not ${checkedText(c.form)}`);
    if (planned === undefined && c.values.some((each) => !each.fits))
      problems.push(`no planned check at ${site}`);
  }
  problems.push(...analysisProblems());
  return {
    allowance,
    stops: stopped.map((path) => path.join(".")),
    relation,
    phase,
    judged,
    problems,
  };
}
