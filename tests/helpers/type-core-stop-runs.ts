import { compileProjectWithBackend } from "../../src/compiler.js";
import type { InstructionPlan, TypePlan } from "../../src/plan/model.js";
import { assertValueType } from "../../src/runtime/values/value-types.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { CORE_BACKEND, CandidateOutsideSlice } from "../../src/type-inference/core/backend.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../src/type-inference/core/budget.js";
import { LIMIT_REASONS } from "../../src/type-inference/core/check-result/slice-index.js";
import { withoutRecords } from "../../src/type-inference/core/consumers/reports/left-out.js";
import type { SourceSite } from "../../src/type-inference/graph.js";
import { coreRequest, type SourceFile } from "./type-core-analysis.js";
import { siteKey } from "./site-keys.js";
import {
  type Globals,
  type Compiled,
  type StopRun,
  type Span,
  unsettledStop,
  stopDeclineProblem,
  planDifferences,
  ranWith,
  tracedRun,
  instructionHolding,
  passed,
  inSite,
  compiledSite,
  within,
  stopProblems,
} from "./type-core-stop-oracle.js";

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
 *   diagnostic names) and passes it: it ends, or it fails elsewhere with no loop round in its trace;
 * - `later`: a run where both fail at different sites and the stopped run executed the natural failure's exact
 *   instruction and passed it, in a single-file unit with no loop round in its trace (the instruction trace,
 *   `docs/RUNTIME.md#instruction-trace`);
 * - `closed`: the two plans are equal. Nothing else is `closed`, and nothing without a natural plan ever is;
 * - `unwitnessed`: plans that differ with no `open` or `later` run: multi-file units, loops, an earlier or stricter
 *   failure, a failure of a sibling or of another check, a no-plan error not shown passed. Unresolved evidence, never
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
      return { code, site, key: siteKey(site), checks, own: instructionHolding(got, site) };
    });
    const sites = errors.map(({ code, key, checks }) => ({ code, site: key, checks }));
    if (single)
      for (const each of pool) {
        const ran = tracedRun(got, each);
        for (const { own } of errors)
          if (own !== null && passed(got, ran, own) && (ran.failure === null || !looped(ran)))
            return {
              ...none,
              kind: "open",
              runs: pool.length,
              first: { globals: each, natural: null, stopped: ran },
              sites,
            };
      }
    return {
      ...none,
      kind: "unwitnessed",
      runs: pool.length,
      sites,
      untested: errors.map(({ key }) => key),
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
