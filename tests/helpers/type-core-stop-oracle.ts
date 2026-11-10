import type { Expression } from "../../src/ast.js";
import { compileProjectWithBackend, type CompilationResult } from "../../src/compiler.js";
import type { InstructionPlan, TypePlan } from "../../src/plan/model.js";
import { executeInstruction, run } from "../../src/runtime/engine.js";
import { assertValueType } from "../../src/runtime/values/value-types.js";
import { valueKindOf } from "../../src/value-kinds.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import { CORE_BACKEND, CandidateOutsideSlice } from "../../src/type-inference/core/backend.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../src/type-inference/core/budget.js";
import { withMessagesInWords } from "../../src/type-inference/core/check-result/check-result.js";
import {
  LIMIT_REASONS,
  OPEN_BY_STOP,
  SliceIndex,
  UNDECIDED_AT_BUDGET,
} from "../../src/type-inference/core/check-result/slice-index.js";
import type { Omission } from "../../src/type-inference/core/consumers.js";
import { withoutRecords } from "../../src/type-inference/core/consumers/left-out.js";
import type { ItemTag } from "../../src/type-inference/core/items.js";
import type { CoreDiagnostic, Obligation } from "../../src/type-inference/core/result.js";
import type { SourceSite } from "../../src/type-inference/graph.js";
import { createImmediatePacingRuntimeSnapshot } from "./immediate-pacing-runtime.js";
import { coreRequest, type SourceFile } from "./type-core-analysis.js";
import { decisionsByKey } from "./type-core-oracles.js";
import { siteKey } from "./site-keys.js";

/*
 * The stop oracle (D4 a′): a compile stopped at some unit against the unstopped compile,
 * whole. One function for `tests/type-core/type-core-stop.test.ts` and the every-unit sweep kept outside CI.
 */

/** A plan's globals for one run. */
export type Globals = Readonly<Record<string, SerializableRuntimeValue>>;

/** A compile's diagnostics and plan. */
type Compiled = Pick<CompilationResult, "diagnostics" | "plan">;

/** A compile of one source and its analysis at the same allowance, in the same mode. */
export interface StopRun {
  readonly result: Compiled;
  readonly answers: Answers;
  /**
   * The compile and its analysis again under `withoutRecords(omit)`, at the run's own allowance, under its demand
   * allowance and in its mode (a rerun stopped elsewhere, or under another allowance where its analysis shows it, is
   * refused: `otherScope`, #1594, #1631; its mode is not checked); `key` names the omission (for a cache).
   */
  readonly without: (
    omit: Omission,
    key: string,
  ) => { readonly result: Compiled; readonly answers: Answers };
}

export interface StopCase {
  readonly unstopped: StopRun;
  readonly stopped: StopRun;
  readonly fitting: readonly Globals[];
  readonly violating: readonly Globals[];
  /**
   * What a combined stop's rule accepts of its demand-only reference (`combinedStop`): records, each
   * by its code at its whole site (`code file:start:end`), excused as a mark's are, and checks (as `JSON.stringify` gives
   * them, their sites whole) owed on neither side.
   */
  readonly excused?: {
    readonly records: ReadonlySet<string>;
    readonly checks: ReadonlySet<string>;
  };
}

/** A site's offsets. */
interface Span {
  readonly start: number;
  readonly end: number;
}

/** Where two plans differ: the path of the differing value, and the innermost plan node with a span holding it. */
interface PlanDifference {
  readonly path: string;
  readonly node: Span | null;
}

/** The parts of a plain value: an array's items, an object's fields; none for anything else. */
function partsOf(value: unknown): Map<string, unknown> | null {
  if (Array.isArray(value)) return new Map(value.map((item, index) => [String(index), item]));
  return value !== null && typeof value === "object" ? new Map(Object.entries(value)) : null;
}

/** A plan node's span as the plan serializes it (an instruction's compact `so`/`eo`, else its offsets), or `null`. */
function spanOf(value: unknown): Span | null {
  const parts = partsOf(partsOf(value)?.get("span"));
  if (parts === null) return null;
  if (parts.has("so")) return { start: Number(parts.get("so")), end: Number(parts.get("eo")) };
  const offset = (end: string): number => Number(partsOf(parts.get(end))?.get("offset"));
  return { start: offset("start"), end: offset("end") };
}

/** The decline of a compile that would lose a check its store owes (#1526 decision 2, condition 1). */
const LOST_CHECK = "a store whose check was lost at the budget";

/** Whether an analysis stopped before admission settled, where the plain gate reads (#2080 part 2). */
export const unsettledStop = (budget: Answers["budget"]): boolean =>
  budget.exhausted !== null && !budget.settled;

/**
 * Why a compile's decline at a stop does not stand, or `null` where it does (#2080 part 2, Codex r1–r3): a decline a
 * limit causes, at the phase it belongs to ("a store whose check was left undecided at the budget" before admission
 * settled; the lost and unestablished checks and a lost default, #2183, only after it; an open typed default at any stop);
 * or a construct outside
 * the slice, with the reason the unstopped compile gives too (`natural`) or one the caller names as expected at its
 * stops (`expected`, none unless named). Any other decline would hide a wrong reason as no plan.
 */
export function stopDeclineProblem(
  what: string,
  unsettled: boolean,
  natural: string | null,
  expected: readonly string[],
): string | null {
  if (!LIMIT_REASONS.includes(what))
    return what === natural || expected.includes(what)
      ? null
      : `declined at a stop with "${what}", unstopped ${natural ?? "compiled"}`;
  if (what === UNDECIDED_AT_BUDGET ? unsettled : what === OPEN_BY_STOP || !unsettled) return null;
  return `declined with "${what}" ${unsettled ? "before" : "after"} admission settled`;
}

/**
 * What a record stands for in a plan, between the compile with it and the one without it (`rerun`): where they differ;
 * where one of them has no plan, the candidate declining it (`LOST_CHECK`), the whole plan.
 */
function contentOf(one: Compiled["plan"], other: Compiled["plan"]): PlanDifference[] {
  return (one === null) !== (other === null)
    ? [{ path: "", node: null }]
    : planDifferences(one, other);
}

/** Every place two plans differ: each value's path where one has what the other lacks or another value. */
function planDifferences(
  want: unknown,
  got: unknown,
  node: Span | null = null,
  path = "",
  out: PlanDifference[] = [],
): PlanDifference[] {
  if (JSON.stringify(want) === JSON.stringify(got)) return out;
  const here = spanOf(want) ?? spanOf(got) ?? node;
  const [w, g] = [partsOf(want), partsOf(got)];
  if (
    w !== null &&
    g !== null &&
    Array.isArray(want) === Array.isArray(got) &&
    (!Array.isArray(want) || w.size === g.size)
  ) {
    for (const key of new Set([...w.keys(), ...g.keys()]))
      planDifferences(w.get(key), g.get(key), here, `${path}/${key}`, out);
    return out;
  }
  out.push({ path: path || "/", node: here });
  return out;
}

/** A run of a plan to its end with `globals`: what it said and where it failed. */
function ranWith(
  plan: InstructionPlan,
  globals: Globals,
): { readonly said: readonly string[]; readonly failure: (Span & { code: string }) | null } {
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals }));
  const failure = result.events.find((event) => event.kind === "runtimeFailure");
  return {
    said: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    failure:
      failure?.kind === "runtimeFailure"
        ? { code: failure.code, start: failure.span.start.offset, end: failure.span.end.offset }
        : null,
  };
}

/** A run of a plan as `ranWith` gives it, with the plan indices of the instructions it executed (`instructionTrace`). */
function tracedRun(
  plan: InstructionPlan,
  globals: Globals,
): ReturnType<typeof ranWith> & {
  readonly executed: ReadonlySet<number>;
  /** How many loops took a round (a `loopStart` continuing into its body), each loop once. */
  readonly rounds: number;
} {
  const result = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { globals }),
    {},
    { instructionTrace: true },
  );
  const failure = result.events.find((event) => event.kind === "runtimeFailure");
  return {
    said: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    failure:
      failure?.kind === "runtimeFailure"
        ? { code: failure.code, start: failure.span.start.offset, end: failure.span.end.offset }
        : null,
    executed: new Set(result.instructionTrace?.instructions ?? []),
    rounds: (result.instructionTrace?.branches ?? []).filter(
      ([at, next]) => plan.instructions[at]?.kind === "loopStart" && next === at + 1,
    ).length,
  };
}

/**
 * A natural compile error's requirement and its site's value path, where both resolve (#2183): the error's
 * rule names the kinds the consumer takes (`count`: an integer, `integerOnly`; `argument`: its `domain`; `iterable`: a
 * list, set, dict or range, a dict for entries), and its site is a binding read or a chain of property reads and literal
 * integer indexes off one. Else `null`, and the error reads as before: any run that passes its instruction is `open`.
 */
function resolvedError(
  answers: Answers,
  request: NonNullable<ReturnType<typeof coreRequest>>,
  code: string,
  site: SourceSite,
): { readonly requires: readonly ItemTag[]; readonly path: ValuePath } | null {
  const error = answers.diagnostics.find(
    (d) => d.class === "compile-error" && d.code === code && siteKey(d.site) === siteKey(site),
  );
  if (error === undefined || error.class !== "compile-error" || !("rule" in error)) return null;
  const { rule } = error;
  const requires: readonly ItemTag[] | null =
    rule.rule === "count"
      ? ["integer"]
      : rule.rule === "argument"
        ? rule.domain
        : rule.rule === "iterable"
          ? rule.entries
            ? ["dict"]
            : ["list", "set", "dict", "range"]
          : null;
  if (requires === null) return null;
  const expression = new SliceIndex(request.files.map((file) => file.program)).findExpressionAt(
    site,
  );
  const path = expression === undefined ? null : valuePath(expression);
  return path === null ? null : { requires, path };
}

/** A binding and the property names and element positions read below it. */
interface ValuePath {
  readonly name: string;
  readonly steps: readonly (string | number)[];
}

/** `expression` as a binding read below which only property reads and literal integer indexes follow, or `null`. */
function valuePath(expression: Expression): ValuePath | null {
  if (expression.kind === "identifier") return { name: expression.name, steps: [] };
  if (expression.kind === "parenthesizedExpression") return valuePath(expression.expression);
  if (expression.kind === "propertyAccessExpression") {
    const below = valuePath(expression.object);
    return below === null ? null : { ...below, steps: [...below.steps, expression.property.name] };
  }
  if (
    expression.kind === "indexExpression" &&
    expression.index.kind === "numberLiteral" &&
    expression.index.numericType === "integer"
  ) {
    const below = valuePath(expression.object);
    return below === null ? null : { ...below, steps: [...below.steps, expression.index.value] };
  }
  return null;
}

/**
 * The value at `path` just before a run of `plan` with `globals` first reaches the instruction whose span is `own`,
 * stepping with the public `executeInstruction` (#2183: not the engine-owned observer entry); `undefined` where
 * the run fails or ends first, a step bound passes, or the path does not resolve in its frames and globals.
 */
function valueBefore(
  plan: InstructionPlan,
  globals: Globals,
  own: Span,
  path: ValuePath,
): SerializableRuntimeValue | undefined {
  const target = plan.instructions.findIndex((instruction) => {
    const span = spanOf(instruction);
    return span !== null && span.start === own.start && span.end === own.end;
  });
  if (target < 0) return undefined;
  let snapshot = createImmediatePacingRuntimeSnapshot(plan, { globals });
  for (let steps = 0; snapshot.nextInstruction !== target; steps += 1) {
    if (steps >= VALUE_STEPS) return undefined;
    const result = executeInstruction(plan, snapshot);
    if (result.events.some((event) => event.kind === "runtimeFailure" || event.kind === "exit"))
      return undefined;
    snapshot = result.snapshot;
  }
  const bindings = [...snapshot.frames].reverse().flatMap((frame) => frame.bindings);
  let value: SerializableRuntimeValue | undefined = [...bindings, ...snapshot.globals].find(
    (binding) => binding.name === path.name,
  )?.value;
  for (const step of path.steps) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    value =
      typeof step === "number"
        ? value.kind === "list"
          ? value.items[step]
          : undefined
        : value.kind === "object"
          ? value.properties.find((property) => property.name === step)?.value
          : undefined;
  }
  return value;
}

/** The instructions `valueBefore` steps at most before it reads nothing (a run that loops past them). */
const VALUE_STEPS = 10_000;

/** A runtime value's kind as the core names it. */
const kindOf = (value: SerializableRuntimeValue): ItemTag => valueKindOf(value);

/** The span of the innermost instruction of `plan` whose span holds `site`, or `null`. */
function instructionHolding(plan: InstructionPlan, site: Span): Span | null {
  let best: Span | null = null;
  for (const instruction of plan.instructions) {
    const span = spanOf(instruction);
    if (span !== null && within(site, span) && (best === null || within(span, best))) best = span;
  }
  return best;
}

/** Whether a run executed an instruction of `plan` whose span is `span`, and did not fail inside it. */
function passed(plan: InstructionPlan, ran: ReturnType<typeof tracedRun>, span: Span): boolean {
  if (ran.failure !== null && within(ran.failure, span)) return false;
  return plan.instructions.some((instruction, index) => {
    const at = spanOf(instruction);
    return at !== null && at.start === span.start && at.end === span.end && ran.executed.has(index);
  });
}

/** A record's code and site, `code file:start:end` (`siteKey`: a site's offsets are its file's, #1700). */
function recordOf(code: string, site: SourceSite): string {
  return `${code} ${siteKey(site)}`;
}

/** Whether `inner` lies within `outer` in the same file. */
function inSite(inner: SourceSite, outer: SourceSite): boolean {
  return inner.file === outer.file && within(inner, outer);
}

/**
 * What to leave out of a compile (`StopRun.without`): the warnings and marks with the records `records` names (each
 * `code file:start:end`), and the boundary checks within `spans`, with its key.
 */
function omission(
  records: ReadonlySet<string>,
  spans: readonly SourceSite[] = [],
): readonly [Omission, string] {
  return [
    {
      diagnostic: (d: CoreDiagnostic) => records.has(recordOf(d.code, d.site)),
      check: (check: Obligation) =>
        check.boundary && spans.some((span) => inSite(check.site, span)),
    },
    `${[...records].sort().join("|")}#${spans.map(siteKey).join("|")}`,
  ];
}

/**
 * How a rerun's analysis differs from the run's in what bounds it, or `null`: the stop's phase, whether it settled, the
 * program allowance, or the demand allowance of a decision or a bounded read both analyses made (#1594; #1631: a rerun
 * without the run's demand allowance stops in the same phase at the same program allowance, but none of its decisions).
 */
function otherScope(own: Answers["budget"], other: Answers["budget"]): string | null {
  if (own.settled !== other.settled || own.stoppedIn !== other.stoppedIn)
    return `another stop (${other.stoppedIn ?? "none"}, settled ${other.settled}) than the run's (${own.stoppedIn ?? "none"}, settled ${own.settled})`;
  if (own.allowance !== other.allowance)
    return `the program allowance ${other.allowance}, not the run's ${own.allowance}`;
  // (each decision by its key, place and exact path, and its occurrence there: a run can decide one place's path more
  // than once in a pass, #1757, and the runs compare such records in order, never overwritten; a key the two runs
  // decide a different number of times refuses the comparison)
  const mine = decisionsByKey(own.decisions);
  for (const [key, theirs] of decisionsByKey(other.decisions)) {
    const ours = mine.get(key);
    if (ours === undefined) continue;
    if (ours.length !== theirs.length)
      return `the decision at ${key} ${theirs.length} times, not the run's ${ours.length}`;
    for (const [at, d] of theirs.entries())
      if (d.allowance !== ours[at]!.allowance)
        return `the demand allowance ${d.allowance} at its decision ${key}${ours.length > 1 ? ` (its record ${at + 1})` : ""}, not the run's ${ours[at]!.allowance}`;
  }
  const reads = (budget: Answers["budget"]): Map<string, number> =>
    new Map(
      budget.demands.flatMap((d) => (d.bounded ? [[`read ${d.node}`, d.allowance] as const] : [])),
    );
  const myReads = reads(own);
  for (const [demand, allowance] of reads(other))
    if (myReads.has(demand) && myReads.get(demand) !== allowance)
      return `the demand allowance ${allowance} at its ${demand}, not the run's ${myReads.get(demand)}`;
  return null;
}

/**
 * `each.without(omit, key)`, refused where it ran another analysis than the run's own (`otherScope`; #1594: a driver's
 * `without` made outside the run's allowance measured the unstopped compile's content, so every plan change of the
 * stop's marks read as unowned, and excused every extra check as one that forms only with the marks).
 */
function rerun(
  each: StopRun,
  omit: Omission,
  key: string,
): { readonly result: Compiled; readonly answers: Answers } {
  let again: { readonly result: Compiled; readonly answers: Answers };
  try {
    again = each.without(omit, key);
  } catch (error) {
    // (#1526 decision 2, condition 1: the compile with these records left out loses a check its store owes, and the
    // candidate declines it; no plan, so what the records stand for is the whole plan, `contentOf`)
    if (!(error instanceof CandidateOutsideSlice) || error.what !== LOST_CHECK) throw error;
    return { result: { diagnostics: [], plan: null }, answers: each.answers };
  }
  const other = otherScope(each.answers.budget, again.answers.budget);
  if (other !== null)
    throw new Error(
      `A stop run's 'without' analysed ${other}: rerun it at the run's allowance, under its demand allowance and in its mode.`,
    );
  return again;
}

/**
 * A compiled diagnostic's site: its file by the path a project's compile gives it, as the run's analysis counts its files
 * (a source's compile names none: its one file, 0; a path the analysis has no file of, -1, which no record excuses).
 */
function compiledSite(d: Compiled["diagnostics"][number], answers: Answers): SourceSite {
  const path = "path" in d && typeof d.path === "string" ? d.path : null;
  const file = path === null ? 0 : answers.graph.files.findIndex((each) => each.path === path);
  return { file, start: d.span.start.offset, end: d.span.end.offset };
}

/** A diagnostic's message with every fix in words, which a compile under `withMessagesInWords` gives it, or none. */
function inWords(d: Compiled["diagnostics"][number]): string | undefined {
  return "words" in d && typeof d.words === "string" ? d.words : undefined;
}

/**
 * Whether a stopped diagnostic is the unstopped one as a stop keeps it: every field the same, and its message the
 * unstopped one's or that one with every fix in words (`words`), as a stop's unchecked region gives a fix.
 */
function keeps(
  want: Compiled["diagnostics"][number],
  got: Compiled["diagnostics"][number],
  words: () => string | undefined,
): boolean {
  const fields = (d: Compiled["diagnostics"][number]) =>
    JSON.stringify({ ...d, message: undefined, words: undefined });
  return fields(want) === fields(got) && (got.message === want.message || got.message === words());
}

/** The operator consumer's own words for an operand's operand check (`consumers/operations.ts`), naming its operator. */
const OPERATOR_OPERAND_CHECK = /^check the operand of (.+) when it runs$/;

/**
 * Whether the stopped run's `check` stands for the unstopped run's lost `null-check`: the same check in other words,
 * where a stopped decision leaves a value's kinds unknown and its consumer owes, for the null the natural analysis
 * proved, the check of the kinds its use needs. It stands only for one of three consumers' pairs, each named by both
 * checks' own words (a check that merely shares a span stands for nothing):
 * 1. the operator's operand (#1688, the lead's ruling (A)): "check that X is not null before /" and "check the operand
 *    of / when it runs", each at that operand's own span (`operandSite`), never a receiver's check at the same span nor
 *    the whole operation's operand check; their targets are spelled apart, so the target is not compared;
 * 2. a for loop's iterable (#1741): "check that X is not null at the iterable of for" and "check the operand X at the
 *    iterable of for when it runs", on the same target X;
 * 3. a repeat count (#1741): "check that the repeat count is not null when it runs" and its `integer-check`, "check that
 *    the repeat count is a whole number when it runs", on the same target.
 * Every pair also needs the null check's whole site (file and offsets) and boundary, and a domain that excludes `null`
 * (it holds neither `null` nor `unknown`, which admits it) and lies within the null check's `against`, each kind among
 * them by name: a wider domain is a weaker check, never one in other words (option (A′), refused), and a domain this
 * cannot compare by name (a null check's `unknown` or `non-null` beside a value kind) stands for nothing. Nothing else
 * stands for anything; the pair is reported apart (`standing check`), never as lost nor as equal, and the replacing
 * check is still counted as its own content.
 */
export function standsForNullCheck(check: Obligation, nullCheck: Obligation): boolean {
  if (
    nullCheck.kind !== "null-check" ||
    check.boundary !== nullCheck.boundary ||
    siteKey(check.site) !== siteKey(nullCheck.site) ||
    check.against.includes("null") ||
    check.against.includes("unknown") ||
    !check.against.every((kind) => nullCheck.against.includes(kind))
  )
    return false;
  // (the null check's words, its own target whole, a source's line breaks in it as well: Codex r2 on #1725)
  const operator = OPERATOR_OPERAND_CHECK.exec(check.on)?.[1];
  const same = check.target === nullCheck.target;
  return (
    (check.kind === "operand" &&
      operator !== undefined &&
      nullCheck.on === `check that ${nullCheck.target} is not null before ${operator}`) ||
    (check.kind === "operand" &&
      same &&
      check.on === `check the operand ${check.target} at the iterable of for when it runs` &&
      nullCheck.on === `check that ${nullCheck.target} is not null at the iterable of for`) ||
    (check.kind === "integer-check" &&
      same &&
      check.on === "check that the repeat count is a whole number when it runs" &&
      nullCheck.on === "check that the repeat count is not null when it runs")
  );
}

/** Whether `inner` lies within `outer`. */
function within(inner: Span, outer: Span): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * Where either run of `c` decides one place's path more than once in a pass (#1757), one line each, `repeated decision
 * at [place, path]: units a, b`, the same line once: what a sweep or replay records beside `stopProblems`, never part of
 * its verdict (the lead's ruling on #1741's sweep).
 */
export function repeatedDecisions(c: Pick<StopCase, "unstopped" | "stopped">): string[] {
  const lines: string[] = [];
  for (const run of [c.unstopped, c.stopped])
    for (const [key, records] of decisionsByKey(run.answers.budget.decisions)) {
      const line = `repeated decision at ${key}: units ${records.map((d) => d.units).join(", ")}`;
      if (records.length > 1 && !lines.includes(line)) lines.push(line);
    }
  return lines;
}

/**
 * What a stop changed of the unstopped compile that no deferred mark excuses, none at a
 * sound stop, settled or not. A mark excuses the record with its code at its site and nothing else; before admission
 * settled, a store marked with its type undecided also stands for its records within its value and for the errors it
 * brought, a written store's mark for its records within its value, and C5's error at a literal for
 * the mark of the store that owes it. The diagnostics, each whole but for a fix the stop gives in words, and the
 * checks are compared in their published order besides those records, what forms only with the marks, and the
 * stop's own warning. The plans are compared whole; a difference stands only inside the plan content of a mark whose
 * obligation is not the unstopped one at its code and site (one that is owes the same check), or of a marked store's
 * records: the content that leaving them out of each compile's analysis and discharge removes. The fitting runs are
 * unchanged; a violating run differs only where the run that stops first fails in a node holding such content.
 */
export function stopProblems(c: StopCase): string[] {
  const { unstopped, stopped } = c;
  const problems: string[] = [];
  const marks = stopped.answers.budget.deferred;
  const [want, got] = [unstopped.result.plan, stopped.result.plan];
  const fitting = (): void =>
    c.fitting.forEach((globals) => {
      const [a, b] = [
        JSON.stringify(ranWith(want!, globals)),
        JSON.stringify(ranWith(got!, globals)),
      ];
      if (a !== b) problems.push(`fitting ${b} against ${a}`);
    });
  // (a record the rule accepts excuses the entry file's diagnostics alone, its own whole site kept apart, so a record of
  // another file at the same offsets excuses nothing)
  const excused = new Set([
    ...marks.map((mark) => recordOf(mark.code, mark.site)),
    ...[...(c.excused?.records ?? [])].filter((record) => /^\S+ 0:\d+:\d+$/.test(record)),
  ]);
  const accepted = c.excused?.checks ?? new Set<string>();
  // before admission settled no decision is read: each store marked with its type undecided stands for its
  // records within its value and for the errors it brought, and C5's error at a literal may stand as the mark
  // of the store that owes it, its receiver's shape undecided; a written store's mark stands for its
  // records within its value too (an element its literal holds that admission left undecided), never for one outside
  // it
  const storeMarks = stopped.answers.budget.settled
    ? []
    : marks.filter((mark) => mark.rule.rule === "store");
  const undecided = (mark: (typeof marks)[number]): boolean =>
    mark.obligation.against.length === 1 && mark.obligation.against[0] === "unknown";
  const stores = storeMarks.filter(undecided).map((mark) => mark.site);
  const values = storeMarks
    .filter((mark) => undecided(mark) || (mark.rule.rule === "store" && mark.rule.written))
    .map((mark) => mark.site);
  const ofStore = (site: SourceSite): boolean => values.some((span) => inSite(site, span));
  const storeRecords = new Set<string>();
  if (!stopped.answers.budget.settled)
    for (const d of unstopped.answers.diagnostics) {
      if (!("rule" in d)) continue;
      const { rule } = d;
      if (
        ofStore(d.site) ||
        (rule.rule === "store" &&
          rule.brought !== null &&
          stores.some((span) => siteKey(span) === siteKey(rule.brought!))) ||
        (d.class === "compile-error" &&
          rule.rule === "absent" &&
          rule.store !== null &&
          excused.has(recordOf(d.code, rule.store)))
      )
        storeRecords.add(recordOf(d.code, d.site));
    }
  for (const record of storeRecords) excused.add(record);
  // the diagnostics, in their published order, each whole but for its fix in words: the unstopped ones in words
  // compiled once, where a message alone differs
  const shown = (each: Pick<StopRun, "result" | "answers">) =>
    each.result.diagnostics.filter(
      (d) => d.code !== "TSV076" && !excused.has(recordOf(d.code, compiledSite(d, each.answers))),
    );
  const [before, after] = [shown(unstopped), shown(stopped)];
  let words: readonly (string | undefined)[] | undefined;
  const wordsAt = (index: number): string | undefined => {
    words ??= shown(
      withMessagesInWords(() => rerun(unstopped, omission(new Set())[0], "#words")),
    ).map(inWords);
    return words[index];
  };
  const text = (list: typeof before): string => list.map((d) => JSON.stringify(d)).join(" | ");
  if (
    before.length !== after.length ||
    before.some((d, index) => !keeps(d, after[index]!, () => wordsAt(index)))
  )
    problems.push(`diagnostics ${text(after)} against ${text(before)}`);
  // the checks, by one ledger of each check's content (#1642, the lead's ruling on #1663): every check a record owns uses
  // one count of its content and every other check is compared, so a further copy is an extra check and a missing one a
  // lost check, on either side. A content's count on a side is its published copies less what stands for some of them:
  // its owning records there (that side's warnings and marks the stop excuses; a record whose check its side does not
  // publish is a lost check), else one the combined stop's rule accepts; on the unstopped side every copy of a marked
  // store's record, on the stopped side as many of those as the unstopped side has; and on the stopped
  // side one copy of a content no record, rule or unstopped copy stands for that forms only with the marks, their
  // content (the stopped analysis without them has fewer). The two counts of each content must be equal, and
  // the checks left compared stand in the same published order.
  const counted = (texts: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
    return counts;
  };
  const owners = (list: readonly CoreDiagnostic[]): Map<string, number> => {
    const objects = new Set<Obligation>();
    for (const d of list)
      if ("obligation" in d && excused.has(recordOf(d.code, d.site))) objects.add(d.obligation);
    return counted([...objects].map((each) => JSON.stringify(each)));
  };
  const textsOf = (checks: readonly Obligation[]): string[] =>
    checks.map((check) => JSON.stringify(check));
  const [checksBefore, checksAfter] = [
    textsOf(unstopped.answers.checks),
    textsOf(stopped.answers.checks),
  ];
  const [publishedBefore, publishedAfter] = [counted(checksBefore), counted(checksAfter)];
  const [ownedBefore, ownedAfter] = [
    owners([...unstopped.answers.diagnostics, ...unstopped.answers.budget.deferred]),
    owners([...stopped.answers.diagnostics, ...marks]),
  ];
  for (const [owned, published] of [
    [ownedBefore, publishedBefore],
    [ownedAfter, publishedAfter],
  ] as const)
    for (const [text, count] of owned)
      for (let missing = count - (published.get(text) ?? 0); missing > 0; missing -= 1)
        problems.push(`lost check ${text}`);
  const standing = (owned: ReadonlyMap<string, number>, text: string): number =>
    owned.get(text) ?? (accepted.has(text) ? 1 : 0);
  const marked = new Set(
    unstopped.answers.checks
      .filter((check) => ofStore(check.site))
      .map((check) => JSON.stringify(check)),
  );
  // (each content's count on each side, before formation)
  const contents = new Set([...checksBefore, ...checksAfter]);
  const left = new Map<string, readonly [number, number]>();
  for (const text of contents) {
    const unstoppedCount = Math.max(
      0,
      (publishedBefore.get(text) ?? 0) - standing(ownedBefore, text),
    );
    const stoppedCount = Math.max(0, (publishedAfter.get(text) ?? 0) - standing(ownedAfter, text));
    left.set(
      text,
      marked.has(text)
        ? [0, Math.max(0, stoppedCount - unstoppedCount)]
        : [unstoppedCount, stoppedCount],
    );
  }
  let formed: string[] = [];
  const surplus = [...left].filter(([, [mine, theirs]]) => theirs > mine);
  if (surplus.length > 0 && marks.length > 0) {
    const without = counted(textsOf(rerun(stopped, ...omission(excused)).answers.checks));
    formed = surplus
      .filter(
        ([text, [mine, theirs]]) =>
          mine === 0 &&
          standing(ownedBefore, text) === 0 &&
          standing(ownedAfter, text) === 0 &&
          !marked.has(text) &&
          theirs > (without.get(text) ?? 0),
      )
      .map(([text]) => text);
    for (const text of formed) {
      const [mine, theirs] = left.get(text)!;
      left.set(text, [mine, theirs - 1]);
    }
  }
  // (a lost null check the stopped run owes as another check in other words, each standing for one: reported apart,
  // the replacing check still counted as its own content, #1688, #1741)
  const standingFor = new Set<number>();
  const standingCopies = new Map<string, number>();
  const standsFor = (text: string): Obligation | undefined => {
    const lost: Obligation = JSON.parse(text);
    const index = stopped.answers.checks.findIndex(
      (check, at) => !standingFor.has(at) && standsForNullCheck(check, lost),
    );
    if (index < 0) return undefined;
    standingFor.add(index);
    standingCopies.set(text, (standingCopies.get(text) ?? 0) + 1);
    return stopped.answers.checks[index];
  };
  for (const [text, [mine, theirs]] of left) {
    for (let count = mine - theirs; count > 0; count -= 1) {
      const operand = standsFor(text);
      problems.push(
        operand === undefined
          ? `lost check ${text}`
          : `standing check ${text} by ${JSON.stringify(operand)}`,
      );
    }
    for (let count = theirs - mine; count > 0; count -= 1) problems.push(`extra check ${text}`);
  }
  // (the checks left compared, in their published order: each side less, from its first copies, what stands for some)
  const compared = (texts: readonly string[], counts: (text: string) => number): string[] => {
    const skip = new Map<string, number>();
    return texts.filter((text) => {
      const done = skip.get(text) ?? 0;
      skip.set(text, done + 1);
      return done >= counts(text);
    });
  };
  // (a standing null check is accounted for as its pair, so its copy is not compared: the rest still is, #1688)
  const owed = compared(checksBefore, (text) =>
    marked.has(text)
      ? Infinity
      : (publishedBefore.get(text) ?? 0) - left.get(text)![0] + (standingCopies.get(text) ?? 0),
  );
  const kept = compared(
    checksAfter,
    (text) => (publishedAfter.get(text) ?? 0) - left.get(text)![1],
  );
  if (
    problems.every((problem) => !/^(lost|extra) check /.test(problem)) &&
    JSON.stringify(owed) !== JSON.stringify(kept)
  )
    problems.push(`checks order ${kept.join(" | ")}`);
  if (want !== null && got === null) problems.push("no plan");
  if (want === null || got === null) return problems;
  // the plans, whole: each difference inside a changing mark's content
  const differences = planDifferences(want, got);
  const obligations = new Map(
    [...unstopped.answers.diagnostics, ...unstopped.answers.budget.deferred].flatMap((d) =>
      "obligation" in d ? [[recordOf(d.code, d.site), JSON.stringify(d.obligation)] as const] : [],
    ),
  );
  const changing = new Set(
    marks
      .filter(
        (mark) =>
          obligations.get(recordOf(mark.code, mark.site)) !== JSON.stringify(mark.obligation),
      )
      .map((mark) => recordOf(mark.code, mark.site)),
  );
  const content: PlanDifference[] = [];
  // (a check the receiving completion gave a store whose decision stopped, #1526 phase C step 5, is that store's mark's
  // content: a stop always comes before the completion, which runs after everything that can stop, so it leaves the
  // mark as the settled pass made it; only an analysis with a decision stopped completes)
  if (differences.length > 0 && unstopped.answers.budget.decisions.some((d) => d.stopped))
    content.push(
      ...contentOf(
        rerun(
          unstopped,
          { diagnostic: () => false, check: () => false, completion: true },
          "#completion",
        ).result.plan,
        unstopped.result.plan,
      ),
    );
  if (differences.length > 0 && changing.size > 0) {
    const own = (each: StopRun): PlanDifference[] =>
      contentOf(
        rerun(each, ...omission(new Set())).result.plan,
        rerun(each, ...omission(new Set([...changing, ...storeRecords]), stores)).result.plan,
      );
    content.push(...own(unstopped), ...own(stopped));
  }
  // (a boundary check that forms only with the marks, whose own obligations are unchanged, #1448: its own plan content,
  // what leaving that exact check out of the stopped compile's discharge removes, every warning and other check kept)
  const boundaries = new Set(
    stopped.answers.checks
      .filter((check) => check.boundary)
      .map((check) => JSON.stringify(check))
      .filter((text) => formed.includes(text)),
  );
  if (differences.length > 0 && boundaries.size > 0)
    content.push(
      ...contentOf(
        rerun(stopped, ...omission(new Set())).result.plan,
        rerun(
          stopped,
          {
            diagnostic: () => false,
            check: (check: Obligation) => boundaries.has(JSON.stringify(check)),
          },
          `checks#${[...boundaries].sort().join("|")}`,
        ).result.plan,
      ),
    );
  const inContent = (path: string): boolean =>
    content.some((part) => path === part.path || path.startsWith(`${part.path}/`));
  const excusedNodes: Span[] = [];
  for (const difference of differences)
    if (difference.node !== null && inContent(difference.path)) excusedNodes.push(difference.node);
    else problems.push(`plan ${difference.path}`);
  // the runs
  fitting();
  const first = (one: ReturnType<typeof ranWith>, other: ReturnType<typeof ranWith>): boolean =>
    one.failure !== null &&
    excusedNodes.some((node) => within(one.failure!, node)) &&
    one.said.every((text, index) => other.said[index] === text);
  c.violating.forEach((globals) => {
    const [a, b] = [ranWith(want, globals), ranWith(got, globals)];
    if (JSON.stringify(a) !== JSON.stringify(b) && !first(a, b) && !first(b, a))
      problems.push(`violating ${JSON.stringify(b)} against ${JSON.stringify(a)}`);
  });
  return problems;
}

/*
 * A stop's runs against its unstopped compile's (#2080): the stopped plan must stop wherever the natural plan stops with a
 * runtime failure, for any host data. `hostValues` gives each global the source names the values of a pool made from the
 * source's own names and paths and from the types the plans check; `stopRuns` compiles a unit unstopped and at a demand
 * allowance in a mode, feeds the pool to `stopProblems` as its violating runs, and compares each run directly with the
 * engine's instruction trace. It claims only what it demonstrates (#2142, under
 * docs/DEVELOPMENT-WORKFLOW.md#review-convergence; #2080's design round: positive escapes are the blockers, an unwitnessed
 * cell is unresolved evidence): see `StopRunKind`. `tests/families/stop-runs.mjs` runs it over a set's items.
 */

/** Words a source's property names are never taken from. */
const NOT_NAMES = new Set([
  "let",
  "integer",
  "number",
  "string",
  "text",
  "list",
  "null",
  "bool",
  "boolean",
  "default",
]);

/** The names a source's property reads and writes and object keys use, at most `limit`, in source order. */
function propertyNames(files: readonly SourceFile[], limit: number): string[] {
  const found: string[] = [];
  for (const { source } of files)
    for (const match of source.matchAll(/\.([A-Za-z_]\w*)|([A-Za-z_]\w*)\s*:/g)) {
      const name = match[1] ?? match[2]!;
      if (!NOT_NAMES.has(name) && !found.includes(name)) found.push(name);
    }
  return found.slice(0, limit);
}

/** The property paths a source reads below a value (`x.a.b.c` gives `a`, `b`, `c`), at most `limit`, in source order. */
function propertyChains(files: readonly SourceFile[], limit: number): string[][] {
  const found = new Map<string, string[]>();
  for (const { source } of files)
    for (const match of source.matchAll(/[A-Za-z_]\w*((?:\.[A-Za-z_]\w*)+)/g)) {
      const chain = match[1]!.slice(1).split(".");
      if (chain.length > 0 && !found.has(chain.join("."))) found.set(chain.join("."), chain);
    }
  return [...found.values()].slice(0, limit);
}

/** Whether `value` fits `type`, by the runtime's own check (`assertValueType`) at a plan's location `at`. */
function fits(value: SerializableRuntimeValue, type: TypePlan, at: PlanLocation): boolean {
  try {
    assertValueType(value, { type, place: "a value" }, at);
    return true;
  } catch {
    return false;
  }
}

/** A plan's own source location, as an instruction carries it. */
type PlanLocation = Parameters<typeof assertValueType>[2];

/**
 * Values made from a checked type (#2080, the design round on #2142): one that fits it, and for each part of it (the
 * root, a collection's element, an object's property) the same value with that part replaced by a value of another kind,
 * kept where the whole then fails the type. So a pool exercises each path of a changed check, a nested element included.
 */
function typeValues(type: TypePlan, at: PlanLocation, depth = 0): SerializableRuntimeValue[] {
  const others: SerializableRuntimeValue[] = [
    1,
    2.5,
    "s",
    false,
    null,
    { kind: "list", items: [] },
  ];
  const fitting = (t: TypePlan): SerializableRuntimeValue => {
    if (t.kind === "union") return fitting(t.members[0] ?? { kind: "null" });
    if (t.kind === "list" || t.kind === "set")
      return { kind: t.kind, items: t.element === null ? [] : [fitting(t.element)] };
    if (t.kind === "dict")
      return {
        kind: "dict",
        entries: t.element === null ? [] : [{ key: "k", value: fitting(t.element) }],
      };
    if (t.kind === "object")
      return {
        kind: "object",
        properties: t.properties.map((p) => ({ name: p.name, value: fitting(p.type) })),
      };
    return others.find((value) => fits(value, t, at)) ?? null;
  };
  const whole = fitting(type);
  const out: SerializableRuntimeValue[] = [
    whole,
    ...others.filter((value) => !fits(value, type, at)),
  ];
  if (depth < 4) {
    const inner = (
      t: TypePlan,
      wrap: (part: SerializableRuntimeValue) => SerializableRuntimeValue,
    ): void => {
      for (const part of typeValues(t, at, depth + 1)) {
        const value = wrap(part);
        if (!fits(value, type, at)) out.push(value);
      }
    };
    if (type.kind === "list" && type.element !== null)
      inner(type.element, (part) => ({ kind: "list", items: [part] }));
    if (type.kind === "set" && type.element !== null)
      inner(type.element, (part) => ({ kind: "set", items: [part] }));
    if (type.kind === "dict" && type.element !== null)
      inner(type.element, (part) => ({ kind: "dict", entries: [{ key: "k", value: part }] }));
    if (type.kind === "object")
      for (const property of type.properties)
        inner(property.type, (part) => ({
          kind: "object",
          properties: type.properties.map((p) => ({
            name: p.name,
            value: p.name === property.name ? part : fitting(p.type),
          })),
        }));
  }
  const seen = new Set<string>();
  return out
    .filter((value) => {
      const text = JSON.stringify(value);
      return !seen.has(text) && seen.add(text) !== undefined;
    })
    .slice(0, 24);
}

/** Each type a plan checks a store or a part against, with an instruction's location for the runtime's check. */
function checkedTypes(plan: InstructionPlan): {
  readonly types: TypePlan[];
  readonly at: PlanLocation | null;
} {
  const types: TypePlan[] = [];
  JSON.stringify(plan, (key, value: unknown) => {
    if (
      (key === "typeCheck" || key === "partChecks") &&
      value !== null &&
      typeof value === "object"
    ) {
      // EVIDENCE: invariant: a plan's `typeCheck` and each of its `partChecks` hold the checked type as `type`.
      const checks = (Array.isArray(value) ? value : [value]) as readonly {
        readonly type?: TypePlan;
      }[];
      for (const each of checks) if (each.type !== undefined) types.push(each.type);
    }
    return value;
  });
  // EVIDENCE: invariant: every planned instruction carries its source location as `span`.
  const at = (plan.instructions[0] as { readonly span?: PlanLocation } | undefined)?.span ?? null;
  return { types, at };
}

/**
 * Host data for a stop's runs (#2080): each global the files name takes in turn every value of a pool, every other global
 * 1. The pool:
 * - scalars, among them 0, -1, a number with a fraction, the empty text and both booleans;
 * - `typed`: values made from the types the plans check (`typeValues`), fitting and failing at each part;
 * - a list of each scalar kind and an empty list, a set, a dict and a range;
 * - objects one and two properties deep by the files' own property names, and a list of an object;
 * - an object along each property path the files read below a value (`x.a.b.c`), with a scalar or a list at its end.
 * Past one named global, the scalars and collections stay whole and the objects are thinned to every `step`th, and the
 * product is capped at `cap` runs. The same list for the same files. A pool cannot reach every path a program takes:
 * `stopRuns` reports a difference no value exercised as `unwitnessed`, never `closed`.
 */
export function hostValues(
  files: readonly SourceFile[],
  globals: readonly string[],
  cap = 4000,
  typed: readonly SerializableRuntimeValue[] = [],
): Globals[] {
  const text = files.map((file) => file.source).join("\n");
  const used = globals.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
  const names = propertyNames(files, 6);
  const object = (
    entries: readonly (readonly [string, SerializableRuntimeValue])[],
  ): SerializableRuntimeValue => ({
    kind: "object",
    properties: entries.map(([name, value]) => ({ name, value })),
  });
  const list = (items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
    kind: "list",
    items,
  });
  const leaves: SerializableRuntimeValue[] = [0, 1, -1, 2.5, "s", "", true, false, null, ...typed];
  const collections: SerializableRuntimeValue[] = [
    list([1]),
    list([2.5]),
    list(["s"]),
    list([null]),
    list([]),
    { kind: "set", items: [1] },
    { kind: "dict", entries: [{ key: "k", value: 1 }] },
    { kind: "dict", entries: [] },
    { kind: "range", start: 0, end: 2, inclusive: false },
  ];
  const objects: SerializableRuntimeValue[] = [];
  for (const name of names)
    for (const value of [1, "s", null, list(["s"])]) objects.push(object([[name, value]]));
  for (const outer of names)
    for (const inner of names)
      if (outer !== inner) objects.push(object([[outer, object([[inner, "s"]])]]));
  for (const outer of names)
    for (const inner of names)
      objects.push(
        object([
          [outer, object([[inner, 1]])],
          ...names.filter((other) => other !== outer).map((other) => [other, null] as const),
        ]),
      );
  objects.push(list([object(names.map((name) => [name, "s"]))]));
  for (const chain of propertyChains(files, 8))
    for (const end of [1, "s", null, list(["s"])])
      objects.push(
        chain.reduceRight<SerializableRuntimeValue>((inner, name) => object([[name, inner]]), end),
      );
  const step = Math.ceil(objects.length / 8);
  const each = [
    ...leaves,
    ...collections,
    ...(used.length <= 1 ? objects : objects.filter((_, at) => at % step === 0)),
  ];
  let runs: Record<string, SerializableRuntimeValue>[] = [{}];
  for (const name of used)
    runs = runs.flatMap((run) => each.map((value) => ({ ...run, [name]: value })));
  if (runs.length > cap) runs = runs.filter((_, at) => at % Math.ceil(runs.length / cap) === 0);
  const rest = Object.fromEntries(globals.map((name) => [name, 1]));
  return runs.map((run) => ({ ...rest, ...run }));
}

/** One side of a stop's runs: its compile's plan and check count, or the candidate route's reason for declining it. */
export interface StopRunSide {
  readonly plan: boolean;
  readonly checks: number;
  readonly declined: string | null;
}

/**
 * What a stop's runs found (`stopRuns`). The oracle claims only what it demonstrates (#2142, the lead's ruling under
 * docs/DEVELOPMENT-WORKFLOW.md#review-convergence; #2080's design round: positive escapes are the blockers, an
 * unwitnessed cell is unresolved evidence):
 * - `open`: a run where the natural plan fails at runtime and the stopped plan runs to its end; with no natural plan (a
 *   compile error the stop turned into runtime checks), a run in a single-file unit that executes the error's own store
 *   instruction (the innermost holding the error's site; a store's absent property, C5c, at the store, not the object the
 *   diagnostic names) and passes it: it ends, or it fails elsewhere with no loop round in its trace. Where the error's
 *   requirement and its site's value resolve (`resolvedError`), only a run whose value there violates the requirement
 *   (#2183); a run whose value fits is no escape;
 * - `later`: a run where both fail at different sites and the stopped run executed the natural failure's exact
 *   instruction and passed it, in a single-file unit with no loop round in its trace (the instruction trace,
 *   `docs/RUNTIME.md#instruction-trace`);
 * - `closed`: the two plans are equal. Nothing else is `closed`, and nothing without a natural plan ever is;
 * - `unwitnessed`: plans that differ with no `open` or `later` run: multi-file units, loops, an earlier or stricter
 *   failure, a failure of a sibling or of another check, a no-plan error not shown passed or passed only by values that
 *   fit its requirement (`resolved`). Unresolved evidence, never
 *   proof that no check is owed; `untested` (below) and the type-derived values serve to find escapes, never to decide
 *   `closed`;
 * - `declined`: the stop's compile declined (a refusal, never a missing check);
 * - `natural declined`, `no plan`: nothing to run.
 */
export type StopRunKind =
  "open" | "later" | "unwitnessed" | "closed" | "declined" | "natural declined" | "no plan";

export interface StopRuns {
  readonly kind: StopRunKind;
  readonly natural: StopRunSide;
  readonly stopped: StopRunSide;
  readonly runs: number;
  /** The first run of the kind: its globals and each plan's outcome. */
  readonly first: {
    readonly globals: Globals;
    readonly natural: ReturnType<typeof ranWith> | null;
    readonly stopped: ReturnType<typeof ranWith>;
  } | null;
  /** `stopProblems`' violating lines, where both compiles have a plan. */
  readonly violating: readonly string[];
  /**
   * Where `unwitnessed`: each place the plans differ that no run failed either plan inside, by its plan path; with no
   * natural plan, each natural error's site. Escape-finding evidence, never a decision.
   */
  readonly untested?: readonly string[];
  /**
   * Where `unwitnessed` with no natural plan: each error whose requirement and site value resolve (`resolvedError`), by
   * its code and site, and whether a run failed at its own instruction (`failed`: a violating host ran and failed there)
   * or none did (no violating host was run).
   */
  readonly resolved?: readonly { readonly site: string; readonly failed: boolean }[];
  /**
   * With no natural plan: each error of the natural compile, by its code and site (a store's absent property at the
   * store), and what the stopped analysis checks there (`typed`, `unknown`, or `none`): the site rule of #2098's ledger.
   */
  readonly sites: readonly {
    readonly code: string;
    readonly site: string;
    readonly checks: string;
  }[];
}

/**
 * A unit's runs at a demand stop against its unstopped compile's, in a mode (`run`), over `hostValues` (#2080): see
 * `StopRuns`. Both compiles and analyses are made here, each with its `without` for `stopProblems`; `planted` (for the
 * oracle's own tests) replaces the stopped plan before it runs. `stop` names the allowance `demand` sets on the stopped
 * side: a demand allowance, or (for the oracle's own tests) the work allowance, which stops before admission settles.
 * `standIn` (for the oracle's own tests, where no stop of a unit publishes a plan, #2080 part 2) compiles the stopped
 * plan from a sibling unit whose instructions have the unit's own spans, unstopped; the stopped analysis is the unit's.
 */
export function stopRuns(
  files: readonly SourceFile[],
  globals: readonly string[],
  run: <T>(make: () => T) => T,
  demand: number,
  planted?: (plan: InstructionPlan) => InstructionPlan,
  stop: "demand" | "work" = "demand",
  standIn?: { readonly files: readonly SourceFile[]; readonly globals: readonly string[] },
): StopRuns {
  const request = coreRequest(files, globals);
  if (request === null) throw new Error("The unit does not resolve.");
  // (the sibling's compile, unstopped, in the run's mode)
  const sibling: Compiled | null =
    standIn === undefined
      ? null
      : run(() =>
          compileProjectWithBackend(standIn.files, { globals: standIn.globals }, CORE_BACKEND),
        );
  const runAt = (at: number | null): StopRun & { readonly declined: string | null } => {
    const allowed = <T>(make: () => T): T =>
      run(() =>
        at === null
          ? make()
          : stop === "work"
            ? withTestAllowance(at, make)
            : withTestDemandAllowance(at, make),
      );
    let declined: string | null = null;
    const both = () => {
      let result: Compiled;
      try {
        result =
          at !== null && sibling !== null
            ? sibling
            : compileProjectWithBackend(files, { globals }, CORE_BACKEND);
      } catch (error) {
        if (!(error instanceof CandidateOutsideSlice)) throw error;
        declined = error.what;
        result = { diagnostics: [], plan: null };
      }
      return { result, answers: analyseCore(request) };
    };
    const made = allowed(both);
    return { ...made, declined, without: (omit) => allowed(() => withoutRecords(omit, both)) };
  };
  const natural = runAt(null);
  const made = runAt(demand);
  // (each side's decline carries its reason, `StopRunSide.declined`, which every test reading `declined` compares; a slice
  // reason is carried and not required here, because the census reads thousands of items this oracle did not write,
  // whose stop-only refusals no caller names; a limit's reason stands only at the phase it belongs to, #2080 part 2)
  for (const [side, each] of [
    ["natural", natural],
    ["stopped", made],
  ] as const) {
    if (each.declined === null || !LIMIT_REASONS.includes(each.declined)) continue;
    const problem = stopDeclineProblem(each.declined, unsettledStop(each.answers.budget), null, []);
    if (problem !== null) throw new Error(`${side} run: ${problem}`);
  }
  const stopped =
    planted === undefined || made.result.plan === null
      ? made
      : { ...made, result: { ...made.result, plan: planted(made.result.plan) } };
  const side = (each: typeof natural): StopRunSide => ({
    plan: each.result.plan !== null,
    checks: each.answers.checks.length,
    declined: each.declined,
  });
  const none = {
    natural: side(natural),
    stopped: side(stopped),
    runs: 0,
    first: null,
    violating: [],
    sites: [],
  };
  if (natural.declined !== null) return { ...none, kind: "natural declined" };
  if (stopped.declined !== null) return { ...none, kind: "declined" };
  const [want, got] = [natural.result.plan, stopped.result.plan];
  if (got === null) return { ...none, kind: "no plan" };
  // (equal plans: nothing to run, and the one `closed`)
  if (want !== null && JSON.stringify(want) === JSON.stringify(got))
    return { ...none, kind: "closed" };
  // (values made from every type either plan checks join the pool, to find escapes)
  const typed: SerializableRuntimeValue[] = [];
  for (const plan of want === null ? [got] : [want, got]) {
    const { types, at } = checkedTypes(plan);
    if (at !== null) for (const type of types) typed.push(...typeValues(type, at));
  }
  const pool = hostValues(
    files,
    globals,
    4000,
    [...new Map(typed.map((v) => [JSON.stringify(v), v])).values()].slice(0, 48),
  );
  // (instruction spans carry no file, and a trace holds each instruction once: a claim from either needs one file and,
  // past the stopped plan's own failure, no loop round)
  const single = files.length === 1;
  // (a loop round: a loop that continued into its body; a loop that fails at its own start took none)
  const looped = (ran: ReturnType<typeof tracedRun>): boolean => ran.rounds > 0;
  if (want === null) {
    // (a compile error the stop turned into runtime checks: open only where a run executed the error's own store
    // instruction and passed it)
    // (C5c reports a store's absent property at the object that lacks it, an explanation: the error is the store's,
    // `rule.store`, the instruction a run must pass; several stores lacking properties of one object share its site, each
    // its own error; another error of the same code at that site is read at it too)
    const operations = new Map<string, SourceSite[]>();
    for (const d of natural.answers.diagnostics) {
      if (d.class !== "compile-error") continue;
      const key = `${d.code} ${siteKey(d.site)}`;
      const at =
        "rule" in d && d.rule.rule === "absent" && d.rule.store !== null ? d.rule.store : d.site;
      operations.set(key, [...(operations.get(key) ?? []), at]);
    }
    // (each error once, by its code and the site it is read at: two stores of one object are two errors)
    const unique = new Map<string, { readonly code: string; readonly site: SourceSite }>();
    for (const d of natural.result.diagnostics.filter((each) => each.severity === "error")) {
      // (a check of the error's own file whose site holds the error's: offsets are each file's own)
      const shown = compiledSite(d, stopped.answers);
      for (const site of operations.get(`${d.code} ${siteKey(shown)}`) ?? [shown])
        unique.set(`${d.code} ${siteKey(site)}`, { code: d.code, site });
    }
    const errors = [...unique.values()].map(({ code, site }) => {
      const at = stopped.answers.checks.filter((c) => inSite(site, c.site));
      const checks =
        at.length === 0
          ? "none"
          : at.some((c) => !c.against.includes("unknown"))
            ? "typed"
            : "unknown";
      const resolved = single ? resolvedError(natural.answers, request, code, site) : null;
      return {
        code,
        site,
        key: siteKey(site),
        checks,
        own: instructionHolding(got, site),
        resolved,
      };
    });
    const sites = errors.map(({ code, key, checks }) => ({ code, site: key, checks }));
    // (a resolved error's runs: whether one failed at its own instruction)
    const failedAt = new Set<string>();
    if (single)
      for (const each of pool) {
        const ran = tracedRun(got, each);
        for (const { own, resolved, key } of errors) {
          if (own === null) continue;
          if (resolved !== null && ran.failure !== null && within(ran.failure, own))
            failedAt.add(key);
          if (!passed(got, ran, own) || (ran.failure !== null && looped(ran))) continue;
          // (a value read at the instruction that fits the requirement passes it rightly; an unread one stays open)
          const value = resolved === null ? undefined : valueBefore(got, each, own, resolved.path);
          if (value !== undefined && resolved!.requires.includes(kindOf(value))) continue;
          return {
            ...none,
            kind: "open",
            runs: pool.length,
            first: { globals: each, natural: null, stopped: ran },
            sites,
          };
        }
      }
    return {
      ...none,
      kind: "unwitnessed",
      runs: pool.length,
      sites,
      untested: errors.map(({ key }) => key),
      resolved: errors.flatMap(({ code, key, resolved }) =>
        resolved === null ? [] : [{ site: `${code} ${key}`, failed: failedAt.has(key) }],
      ),
    };
  }
  const violating = stopProblems({
    unstopped: natural,
    stopped,
    fitting: [],
    violating: pool,
  }).filter((problem) => problem.startsWith("violating "));
  // (both fail at different sites: later only where the stopped run executed the natural failure's exact instruction
  // and passed it, in one file and with no loop round)
  const later = (a: ReturnType<typeof tracedRun>, b: ReturnType<typeof tracedRun>): boolean => {
    if (!single || a.failure === null || b.failure === null) return false;
    if (b.failure.start === a.failure.start && b.failure.end === a.failure.end) return false;
    const own = instructionHolding(want, a.failure);
    return own !== null && !looped(b) && passed(got, b, own);
  };
  let found: StopRuns | null = null;
  const differences = planDifferences(want, got);
  const failures: Span[] = [];
  for (const each of pool) {
    const [a, b] = [tracedRun(want, each), tracedRun(got, each)];
    if (a.failure !== null) failures.push(a.failure);
    if (b.failure !== null) failures.push(b.failure);
    const kind: StopRunKind | null =
      a.failure !== null && b.failure === null ? "open" : later(a, b) ? "later" : null;
    if (kind === "open")
      return {
        ...none,
        kind,
        runs: pool.length,
        first: { globals: each, natural: a, stopped: b },
        violating,
      };
    if (kind === "later" && found === null)
      found = {
        ...none,
        kind,
        runs: pool.length,
        first: { globals: each, natural: a, stopped: b },
        violating,
      };
  }
  if (found !== null) return found;
  // (plans apart with no escape shown: unresolved, the places no run failed inside listed)
  const untested = differences.filter(
    ({ node }) => node === null || !failures.some((failure) => within(failure, node)),
  );
  return {
    ...none,
    kind: "unwitnessed",
    runs: pool.length,
    violating,
    untested: untested.map(({ path }) => path),
  };
}
