import type { CompilationResult } from "../../src/compiler.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { run } from "../../src/runtime/engine.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import type { Answers } from "../../src/type-inference/core/answers.js";
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
  /** The compile and its analysis again under `withoutRecords(omit)`; `key` names the omission (for a cache). */
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

/** Whether `inner` lies within `outer`. */
function within(inner: Span, outer: Span): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * What a stop changed of the unstopped compile that no deferred mark excuses (TABLE r4.99, r4.108–r4.111), none at a
 * sound stop, settled or not. A mark excuses the record with its code at its site and nothing else; before admission
 * settled, a store marked with its type undecided also stands for its records within its value and for the errors it
 * brought, and C5's error at a literal for the mark of the store that owes it. The diagnostics and the checks are
 * compared in their published order (r4.86 (1)) besides those records, what forms only with the marks, and the stop's
 * own warning. The plans are compared whole; a difference stands only inside the plan content of a mark whose obligation
 * is not the unstopped one at its code and site (one that is owes the same check), or of a marked store's records: the
 * content that leaving them out of each compile's analysis and discharge removes. The fitting runs are unchanged; a
 * violating run differs only where the run that stops first fails in a node holding such content.
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
  const excused = new Set(marks.map((mark) => recordOf(mark.code, mark.site)));
  // before admission settled no decision is read (r4.110 (3)): each store marked with its type undecided stands for its
  // records within its value and for the errors it brought (r4.111), and C5's error at a literal may stand as the mark
  // of the store that owes it, its receiver's shape undecided (r4.108 (2))
  const stores = stopped.answers.budget.settled
    ? []
    : marks
        .filter(
          (mark) =>
            mark.rule.rule === "store" &&
            mark.obligation.against.length === 1 &&
            mark.obligation.against[0] === "unknown",
        )
        .map((mark) => mark.site);
  const ofStore = (site: Span): boolean => stores.some((span) => within(site, span));
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
  // the diagnostics, in their published order
  const shown = (each: StopRun): string[] =>
    each.result.diagnostics
      .filter((d) => d.code !== "TSV076" && !excused.has(recordOf(d.code, offsets(d))))
      .map(
        (d) => `${d.severity} ${d.code} ${d.span.start.offset}:${d.span.end.offset} ${d.message}`,
      );
  const [before, after] = [shown(unstopped), shown(stopped)];
  if (JSON.stringify(before) !== JSON.stringify(after))
    problems.push(`diagnostics ${after.join(" | ")} against ${before.join(" | ")}`);
  // the checks, in their published order: an unstopped one a mark's record owns or one of a marked store's records; a
  // stopped one a mark's record owns, or one that forms only with the marks, their content (r4.110 (a): the stopped
  // analysis without them lacks it)
  const marked = new Set<Obligation>(
    [...unstopped.answers.diagnostics, ...stopped.answers.diagnostics, ...marks].flatMap((d) =>
      "obligation" in d && excused.has(recordOf(d.code, d.site)) ? [d.obligation] : [],
    ),
  );
  const owed = unstopped.answers.checks
    .filter((check) => !marked.has(check) && !ofStore(check.site))
    .map((check) => JSON.stringify(check));
  let kept = stopped.answers.checks
    .filter((check) => !marked.has(check))
    .map((check) => JSON.stringify(check));
  // (an extra the stopped analysis without its marks lacks is their content; a check both have stays compared)
  const extra = beyond(kept, owed);
  if (extra.length > 0 && marks.length > 0) {
    const without = stopped.without(...omission(excused)).answers.checks;
    kept = beyond(
      kept,
      beyond(
        extra,
        without.map((check) => JSON.stringify(check)),
      ),
    );
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
    unstopped.answers.diagnostics.flatMap((d) =>
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
  if (differences.length > 0 && changing.size > 0) {
    const own = (each: StopRun): PlanDifference[] =>
      planDifferences(
        each.without(...omission(new Set())).result.plan,
        each.without(...omission(new Set([...changing, ...storeRecords]), stores)).result.plan,
      );
    content.push(...own(unstopped), ...own(stopped));
  }
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

/**
 * A difference the oracle knows and does not excuse (TABLE r4.110): the source it is found in, its exact problems, its
 * mechanism, the issue that owns it, and the stop points of the every-unit sweep it is found at over its four modes. The
 * sweep fails where the count moves; the exception goes when its issue lands.
 */
export interface NamedException {
  readonly source: string;
  /** The exact problems it shows, one at each of its stop points. */
  readonly problems: readonly string[];
  readonly mechanism: string;
  readonly issue: string;
  readonly count: number;
  /** Where CI counts it (`type-core-stop.test.ts`): its stop points in the settled phases, the analysis's own order. */
  readonly settled?: number;
}

export const NAMED_EXCEPTIONS: readonly NamedException[] = [
  {
    source:
      'let seed = {ticks: 2, title: "ok"}\nlet state = seed\nstate = hostValue\nrepeat state.ticks {}\nsay state.title\nexit\n',
    problems: [
      'extra check {"kind":"copy-type","target":"state.ticks","against":["unknown"],"on":"validate external data state.ticks","site":{"file":0,"start":77,"end":88},"boundary":true}',
    ],
    mechanism:
      "a settled walk stop reads `state.ticks` by its key's finished contract, whose external item lost the ingress the value read keeps, so the count's consumer checks it as host data no ingress store brought: a redundant runtime check",
    issue: "#1216",
    count: 504,
    settled: 126,
  },
  {
    source:
      'let value = fromJson(hostValue, default: {list: [{n: fromJson("3", default: 0), open: null}]})\nsay value.list.get(0, default: {n: 0, open: null}).n\nsay "DONE"\nexit\n',
    problems: [
      "plan /instructions/8/typeCheck/type/properties/0/type/element",
      "plan /instructions/8/typeCheck/type/properties/0/type/element/properties",
    ],
    mechanism:
      "a settled walk stop leaves `value.list.element` or its fields undecided (admission decides them lazily, never after a stop), so the store's check opens there; part 3's syntax decision (source 4) decides them from the default literal",
    issue: "#1165",
    count: 802,
  },
];
