import type { CompilationResult } from "../../src/compiler.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { run } from "../../src/runtime/engine.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import type { Answers } from "../../src/type-inference/core/answers.js";
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
  /** The compile again, the warnings whose `recordOf` `records` has left out of its discharge (`withoutRecords`). */
  readonly without: (records: ReadonlySet<string>) => Compiled;
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

/** A diagnostic of the core as a record (`StopRun.without`). */
export function recordOfDiagnostic(diagnostic: CoreDiagnostic): string {
  return recordOf(diagnostic.code, diagnostic.site);
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
 * What a stop changed of the unstopped compile that no deferred mark excuses (TABLE r4.99, r4.108), none at a sound stop.
 * At any stop: no error the unstopped compile lacks, a plan wherever it has one, the fitting runs unchanged. Where
 * admission settled, the rest whole (r4.108 (1)): a mark excuses the record with its code at its site and nothing
 * else. The diagnostics and the checks are compared in their published order (r4.86 (1)) besides those records and
 * the stop's own warning. The plans are compared whole; a difference stands only inside the plan content of a mark
 * whose obligation is not the unstopped one at its code and site (one that is owes the same check): the content that
 * leaving it, and the unstopped warning with its code and site, out of each compile's discharge removes. A violating
 * run differs only where the run that stops first fails in a node holding such content. C5's error at a literal never
 * moves to its store's mark there: a settled stop decides its receiver's shape (r4.108 (2)).
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
  if (!stopped.answers.budget.settled) {
    // (before admission settled nothing it found stands, r4.99: no error the unstopped compile lacks, a plan wherever
    // it has one, the fitting runs unchanged; C5's error may stand as its store's mark there, r4.108 (2))
    const errors = new Set(
      unstopped.result.diagnostics.flatMap((d) =>
        d.severity === "error" ? [recordOf(d.code, offsets(d))] : [],
      ),
    );
    for (const d of stopped.result.diagnostics)
      if (d.severity === "error" && !errors.has(recordOf(d.code, offsets(d))))
        problems.push(`new error ${recordOf(d.code, offsets(d))}`);
    if (want !== null && got === null) problems.push("no plan");
    if (want !== null && got !== null) fitting();
    return problems;
  }
  const excused = new Set(marks.map((mark) => recordOf(mark.code, mark.site)));
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
  // the checks, in their published order
  const marked = new Set<Obligation>(
    [...unstopped.answers.diagnostics, ...stopped.answers.diagnostics, ...marks].flatMap((d) =>
      "obligation" in d && excused.has(recordOf(d.code, d.site)) ? [d.obligation] : [],
    ),
  );
  const checks = (each: StopRun): string[] =>
    each.answers.checks.filter((check) => !marked.has(check)).map((check) => JSON.stringify(check));
  const [owed, kept] = [checks(unstopped), checks(stopped)];
  if (JSON.stringify(owed) !== JSON.stringify(kept))
    problems.push(`checks ${kept.join(" | ")} against ${owed.join(" | ")}`);
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
      planDifferences(each.without(new Set()).plan, each.without(changing).plan);
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
