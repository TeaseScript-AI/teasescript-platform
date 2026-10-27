import type { CompilationResult } from "../../src/compiler.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { run } from "../../src/runtime/engine.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import { propertyStep } from "../../src/type-inference/core/program.js";
import { createImmediatePacingRuntimeSnapshot } from "./immediate-pacing-runtime.js";

/*
 * The stop oracle (D4 a′, TABLE r4.90, r4.99): what a compile stopped at some unit keeps of the unstopped compile. One
 * function for `tests/type-core-stop.test.ts` and the every-unit sweep kept outside CI.
 */

/** A plan's fields that carry a check: a stored value's, a default's or fallback's, an index's, a typed read's, a repair. */
const CHECK_FIELDS = ["typeCheck", "fallbackCheck", "indexCheck", "expected", "repair"] as const;

/** A plan's globals for one run. */
export type Globals = Readonly<Record<string, SerializableRuntimeValue>>;

/** The parts of a plain value: an array's items, an object's fields; none for anything else. */
function partsOf(value: unknown): Map<string, unknown> | null {
  if (Array.isArray(value)) return new Map(value.map((item, index) => [String(index), item]));
  return value !== null && typeof value === "object" ? new Map(Object.entries(value)) : null;
}

/** A plan node's span as the plan serializes it: `so:eo` (an instruction's compact span), else its offsets. */
function spanText(span: unknown): string {
  const parts = partsOf(span);
  if (parts === null) return "-";
  if (parts.has("so")) return `${String(parts.get("so"))}:${String(parts.get("eo"))}`;
  const offset = (end: string): string => String(partsOf(parts.get(end))?.get("offset") ?? "?");
  return `${offset("start")}:${offset("end")}`;
}

/**
 * Every check a plan carries, by its field, the kind of the node that holds it and that node's span: the serialized
 * values at each, in plan order; the storage types by their place.
 */
export function planChecks(plan: InstructionPlan): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (at: string, value: unknown): void => {
    const list = out.get(at);
    if (list === undefined) out.set(at, [JSON.stringify(value)]);
    else list.push(JSON.stringify(value));
  };
  const pending: unknown[] = [];
  for (const [name, value] of partsOf(plan) ?? [])
    if (name === "storageTypes")
      for (const entry of partsOf(value)?.values() ?? []) add("storageTypes", entry);
    else pending.push(value);
  while (pending.length > 0) {
    const fields = partsOf(pending.pop());
    if (fields === null) continue;
    const at = `${String(fields.get("kind") ?? "-")}|${spanText(fields.get("span"))}`;
    for (const field of CHECK_FIELDS)
      if (fields.get(field) !== undefined) add(`${field}|${at}`, fields.get(field));
    for (const value of fields.values()) pending.push(value);
  }
  return out;
}

/** Every diagnostic: its severity, code, span and message. */
function diagnosticTexts(result: CompilationResult): string[] {
  return result.diagnostics.map(
    (d) => `${d.severity} ${d.code} ${d.span.start.offset}:${d.span.end.offset} ${d.message}`,
  );
}

/** A run of a plan to its end with `globals`: what it said and the failure's code and span. */
function ranWith(plan: InstructionPlan, globals: Globals): string {
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals }));
  const failure = result.events.find((event) => event.kind === "runtimeFailure");
  return JSON.stringify({
    said: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    failure:
      failure?.kind === "runtimeFailure"
        ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
        : null,
  });
}

export interface StopCase {
  readonly unstopped: CompilationResult;
  readonly stopped: CompilationResult;
  /** Whether the stopped pass's admission had settled, by the unstopped analysis's passes (not the stop's own claim). */
  readonly settled: boolean;
  /** Whether the stop came in the publication of a settled pass or later: the unstopped diagnostics exactly. */
  readonly exact: boolean;
  /** The warnings the stop moved to the runtime and does not show, each `code start:end`. */
  readonly deferred: readonly string[];
  /** Whether the stopped analysis left a place's path undecided, where a check may stay open. */
  readonly undecided?: (place: string, path: readonly string[]) => boolean;
  readonly fitting: readonly Globals[];
  readonly violating: readonly Globals[];
}

/** A check's type the stopped plan keeps of the unstopped one's: equal, or open only where the path is undecided. */
function keptType(
  c: StopCase,
  place: string,
  want: unknown,
  got: unknown,
  path: readonly string[],
): string[] {
  if (JSON.stringify(want) === JSON.stringify(got)) return [];
  const label = `${place}${path.map((step) => `/${step}`).join("")}`;
  if (got === null || got === undefined)
    return c.undecided?.(place, path) === true ? [] : [`lost ${label}`];
  const [w, g] = [partsOf(want), partsOf(got)];
  if (w === null || g === null || w.get("kind") !== g.get("kind")) return [`changed ${label}`];
  if (w.get("kind") === "object") {
    const fields = (parts: Map<string, unknown>): Map<string, unknown> =>
      new Map(
        [...(partsOf(parts.get("properties"))?.values() ?? [])].map((property) => {
          const p = partsOf(property);
          return [String(p?.get("name")), p?.get("type")];
        }),
      );
    const [wf, gf] = [fields(w), fields(g)];
    return [...wf].flatMap(([name, type]) =>
      keptType(c, place, type, gf.get(name) ?? null, [...path, propertyStep(name)]),
    );
  }
  if (w.has("element"))
    return keptType(c, place, w.get("element"), g.get("element"), [...path, "element"]);
  return [`changed ${label}`];
}

/**
 * What a stop lost of the unstopped compile: at any stop, never an error it lacks, a plan wherever it has one, and its
 * fitting runs unchanged; where admission settled, each of its diagnostics (the same code at the same span, or among
 * the stop's deferred warnings there), every check its plan carries (the same value at the same node, a stored type
 * open only where the stopped analysis left the path undecided), and each violating run failing at the same check;
 * from a settled publication on, its diagnostics exactly, besides the stop's own.
 */
export function stopProblems(c: StopCase): string[] {
  const problems: string[] = [];
  const key = (text: string): string => text.split(" ").slice(0, 3).join(" ");
  const full = diagnosticTexts(c.unstopped);
  const got = diagnosticTexts(c.stopped);
  for (const d of got)
    if (d.startsWith("error ") && !full.some((f) => key(f) === key(d)))
      problems.push(`new ${key(d)}`);
  if (
    c.unstopped.plan !== null &&
    c.stopped.plan === null &&
    !got.some((d) => d.startsWith("error "))
  )
    problems.push("no plan");
  const runs = (plan: InstructionPlan | null, globals: readonly Globals[]): string[] =>
    plan === null ? [] : globals.map((each) => ranWith(plan, each));
  const [fullFitting, gotFitting] = [
    runs(c.unstopped.plan, c.fitting),
    runs(c.stopped.plan, c.fitting),
  ];
  if (c.unstopped.plan !== null && c.stopped.plan !== null)
    fullFitting.forEach((run, index) => {
      if (gotFitting[index] !== run) problems.push(`fitting ${gotFitting[index]} against ${run}`);
    });
  if (!c.settled) return problems;
  for (const d of full) {
    const [, code, at] = d.split(" ");
    if (
      !got.some((g) => key(g).endsWith(` ${code} ${at}`)) &&
      !c.deferred.includes(`${code} ${at}`)
    )
      problems.push(`lost ${key(d)}`);
  }
  if (c.unstopped.plan !== null && c.stopped.plan !== null) {
    const kept = planChecks(c.stopped.plan);
    for (const [at, values] of planChecks(c.unstopped.plan))
      values.forEach((value, index) => {
        const other = kept.get(at)?.[index];
        if (other === value) return;
        const typed = (text: string | undefined): Map<string, unknown> | null =>
          text === undefined ? null : partsOf(JSON.parse(text));
        const [want, have] = [typed(value), typed(other)];
        if (at.startsWith("typeCheck|") && want !== null)
          problems.push(
            ...keptType(
              c,
              String(want.get("place")),
              want.get("type"),
              have?.get("type") ?? null,
              [],
            ),
          );
        else problems.push(`lost ${at} ${value}`);
      });
    const [fullViolating, gotViolating] = [
      runs(c.unstopped.plan, c.violating),
      runs(c.stopped.plan, c.violating),
    ];
    fullViolating.forEach((run, index) => {
      const failure = (text: string | undefined): string =>
        text === undefined ? "-" : String(partsOf(JSON.parse(text))?.get("failure") ?? null);
      if (failure(gotViolating[index]) !== failure(run))
        problems.push(`violating ${gotViolating[index]} against ${run}`);
    });
  }
  if (c.exact) {
    const own = got.filter((d) => !d.includes(" TSV076 ")).sort();
    if (JSON.stringify(own) !== JSON.stringify([...full].sort()))
      problems.push(`diagnostics ${own.join(" | ")} against ${full.join(" | ")}`);
  }
  return problems;
}
