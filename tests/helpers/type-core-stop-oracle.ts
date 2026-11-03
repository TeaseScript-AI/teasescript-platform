import type { CompilationResult } from "../../src/compiler.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { run } from "../../src/runtime/engine.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import type { Answers } from "../../src/type-inference/core/answers.js";
import { withMessagesInWords } from "../../src/type-inference/core/consumer.js";
import type { Omission } from "../../src/type-inference/core/consumers.js";
import type { CoreDiagnostic, Obligation } from "../../src/type-inference/core/result.js";
import { createImmediatePacingRuntimeSnapshot } from "./immediate-pacing-runtime.js";

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

/** A record's code and site, `code start:end`. */
function recordOf(code: string, site: Span): string {
  return `${code} ${site.start}:${site.end}`;
}

/**
 * What to leave out of a compile (`StopRun.without`): the warnings and marks with the records `records` names (each
 * `code start:end`), and the boundary checks within `spans`, with its key.
 */
function omission(
  records: ReadonlySet<string>,
  spans: readonly Span[] = [],
): readonly [Omission, string] {
  return [
    {
      diagnostic: (d: CoreDiagnostic) => records.has(recordOf(d.code, d.site)),
      check: (check: Obligation) =>
        check.boundary && spans.some((span) => within(check.site, span)),
    },
    `${[...records].sort().join("|")}#${spans.map((span) => `${span.start}:${span.end}`).join("|")}`,
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
  const demands = (budget: Answers["budget"]): Map<string, number> =>
    new Map([
      ...budget.decisions.map(
        (d) => [`decision ${d.place}:${d.path.join(".")}`, d.allowance] as const,
      ),
      ...budget.demands.flatMap((d) =>
        d.bounded ? [[`read ${d.node}`, d.allowance] as const] : [],
      ),
    ]);
  const mine = demands(own);
  for (const [demand, allowance] of demands(other))
    if (mine.has(demand) && mine.get(demand) !== allowance)
      return `the demand allowance ${allowance} at its ${demand}, not the run's ${mine.get(demand)}`;
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
  const again = each.without(omit, key);
  const other = otherScope(each.answers.budget, again.answers.budget);
  if (other !== null)
    throw new Error(
      `A stop run's 'without' analysed ${other}: rerun it at the run's allowance, under its demand allowance and in its mode.`,
    );
  return again;
}

/** The items of `list` beyond those of `other`, each as often as `list` has it more (a multiset difference). */
function beyond(list: readonly string[], other: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const item of other) left.set(item, (left.get(item) ?? 0) + 1);
  return list.filter((item) => {
    const count = left.get(item) ?? 0;
    if (count > 0) left.set(item, count - 1);
    return count === 0;
  });
}

/** A diagnostic's offsets. */
function offsets(d: Compiled["diagnostics"][number]): Span {
  return { start: d.span.start.offset, end: d.span.end.offset };
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

/** Whether `inner` lies within `outer`. */
function within(inner: Span, outer: Span): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
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
  // (a compile's diagnostics name no file, the entry file's: a record the rule accepts excuses them there alone, its own
  // whole site kept apart, so a record of another file at the same offsets excuses nothing)
  const excused = new Set([
    ...marks.map((mark) => recordOf(mark.code, mark.site)),
    ...[...(c.excused?.records ?? [])].flatMap((record) => {
      const found = /^(\S+) 0:(\d+):(\d+)$/.exec(record);
      return found === null ? [] : [`${found[1]} ${found[2]}:${found[3]}`];
    }),
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
  const ofStore = (site: Span): boolean => values.some((span) => within(site, span));
  const storeRecords = new Set<string>();
  if (!stopped.answers.budget.settled)
    for (const d of unstopped.answers.diagnostics) {
      if (!("rule" in d)) continue;
      const { rule } = d;
      if (
        ofStore(d.site) ||
        (rule.rule === "store" &&
          rule.brought !== null &&
          stores.some(
            (span) => span.start === rule.brought!.start && span.end === rule.brought!.end,
          )) ||
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
  const shown = (each: Pick<StopRun, "result">) =>
    each.result.diagnostics.filter(
      (d) => d.code !== "TSV076" && !excused.has(recordOf(d.code, offsets(d))),
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
  // the checks, in their published order: an unstopped one a mark's record owns or one of a marked store's records; a
  // stopped one a mark's record owns, one of a marked store's records the unstopped analysis has too (the record kept,
  // on both sides alike, TABLE r4.122), or one that forms only with the marks, their content (r4.110 (a): the stopped
  // analysis without them lacks it); any other stopped check inside a marked store's value is compared. Each side's
  // checks are owned by its own excused records, its marks included (#1642: the reference's mark owned the receiver's
  // check, which then stayed compared against a stopped one its mark owned), by content and one check per owning record;
  // a record of the stopped compile owns only a check that compile publishes, so an obligation it holds is never lost
  // with its check.
  const owners = (list: readonly CoreDiagnostic[]): Map<string, number> => {
    const objects = new Set<Obligation>();
    for (const d of list)
      if ("obligation" in d && excused.has(recordOf(d.code, d.site))) objects.add(d.obligation);
    const counts = new Map<string, number>();
    for (const each of objects) {
      const text = JSON.stringify(each);
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    return counts;
  };
  const unowned = (
    checks: readonly Obligation[],
    owned: ReadonlyMap<string, number>,
  ): Obligation[] => {
    const left = new Map(owned);
    return checks.filter((check) => {
      const text = JSON.stringify(check);
      const count = left.get(text) ?? 0;
      if (count > 0) left.set(text, count - 1);
      return count === 0;
    });
  };
  const ownedBefore = owners([
    ...unstopped.answers.diagnostics,
    ...unstopped.answers.budget.deferred,
  ]);
  const ownedAfter = owners([...stopped.answers.diagnostics, ...marks]);
  const published = new Map<string, number>();
  for (const check of stopped.answers.checks) {
    const text = JSON.stringify(check);
    published.set(text, (published.get(text) ?? 0) + 1);
  }
  for (const [text, count] of ownedAfter)
    for (let missing = count - (published.get(text) ?? 0); missing > 0; missing -= 1)
      problems.push(`lost check ${text}`);
  // (a check the combined stop's rule accepts is left out once on each side, as one its record owns: the rule's credit
  // and a record's are one, never two)
  const credited = (owned: ReadonlyMap<string, number>): Map<string, number> => {
    const credits = new Map(owned);
    for (const text of accepted) credits.set(text, Math.max(credits.get(text) ?? 0, 1));
    return credits;
  };
  const checksBefore = unowned(unstopped.answers.checks, credited(ownedBefore));
  const checksAfter = unowned(stopped.answers.checks, credited(ownedAfter));
  const ofStores = checksBefore
    .filter((check) => ofStore(check.site))
    .map((check) => JSON.stringify(check));
  const owed = checksBefore
    .filter((check) => !ofStore(check.site))
    .map((check) => JSON.stringify(check));
  let kept = beyond(
    checksAfter.map((check) => JSON.stringify(check)),
    ofStores,
  );
  // (an extra the stopped analysis without its marks lacks is their content; a check both have stays compared)
  const extra = beyond(kept, owed);
  let formed: string[] = [];
  if (extra.length > 0 && marks.length > 0) {
    const without = rerun(stopped, ...omission(excused)).answers.checks;
    formed = beyond(
      extra,
      without.map((check) => JSON.stringify(check)),
    );
    kept = beyond(kept, formed);
  }
  if (JSON.stringify(owed) !== JSON.stringify(kept)) {
    const [lost, extra] = [beyond(owed, kept), beyond(kept, owed)];
    for (const check of lost) problems.push(`lost check ${check}`);
    for (const check of extra) problems.push(`extra check ${check}`);
    if (lost.length + extra.length === 0) problems.push(`checks order ${kept.join(" | ")}`);
  }
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
      ...planDifferences(
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
      planDifferences(
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
      ...planDifferences(
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
