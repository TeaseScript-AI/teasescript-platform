import type { CompilationResult } from "../../src/compiler.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { run } from "../../src/runtime/engine.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import type { Answers } from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice } from "../../src/type-inference/core/backend.js";
import { withMessagesInWords } from "../../src/type-inference/core/check-result/check-result.js";
import type { Omission } from "../../src/type-inference/core/consumers.js";
import type { CoreDiagnostic, Obligation } from "../../src/type-inference/core/result.js";
import type { SourceSite } from "../../src/type-inference/graph.js";
import { createImmediatePacingRuntimeSnapshot } from "./immediate-pacing-runtime.js";
import { decisionsByKey } from "./type-core-oracles.js";
import { siteKey } from "./site-keys.js";

/*
 * The stop oracle (D4 a′, TABLE r4.99, r4.100, r4.108): a compile stopped at some unit against the unstopped compile,
 * whole. One function for `tests/type-core-stop.test.ts` and the every-unit sweep kept outside CI.
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
   * What a combined stop's rule accepts of its demand-only reference (`combinedStop`, TABLE r4.285, r4.290): records, each
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
 * unstopped one's or that one with every fix in words (`words`), as a stop's unchecked region gives a fix (TABLE r4.162).
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
 * What a stop changed of the unstopped compile that no deferred mark excuses (TABLE r4.99, r4.108–r4.111), none at a
 * sound stop, settled or not. A mark excuses the record with its code at its site and nothing else; before admission
 * settled, a store marked with its type undecided also stands for its records within its value and for the errors it
 * brought, a written store's mark for its records within its value (TABLE r4.152 (1)), and C5's error at a literal for
 * the mark of the store that owes it. The diagnostics, each whole but for a fix the stop gives in words (r4.162), and the
 * checks are compared in their published order (r4.86 (1)) besides those records, what forms only with the marks, and the
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
  // before admission settled no decision is read (r4.110 (3)): each store marked with its type undecided stands for its
  // records within its value and for the errors it brought (r4.111), and C5's error at a literal may stand as the mark
  // of the store that owes it, its receiver's shape undecided (r4.108 (2)); a written store's mark stands for its
  // records within its value too (an element its literal holds that admission left undecided), never for one outside
  // it (TABLE r4.152 (1))
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
  // the diagnostics, in their published order, each whole but for its fix in words (r4.162): the unstopped ones in words
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
  // store's record (TABLE r4.122), on the stopped side as many of those as the unstopped side has; and on the stopped
  // side one copy of a content no record, rule or unstopped copy stands for that forms only with the marks, their
  // content (r4.110 (a): the stopped analysis without them has fewer). The two counts of each content must be equal, and
  // the checks left compared stand in the same published order (r4.86 (1)).
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
