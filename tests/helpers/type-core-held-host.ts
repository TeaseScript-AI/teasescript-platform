import { compileSourceWithBackend } from "../../src/compiler.js";
import {
  createSerializableObject,
  type SerializableRuntimeValue,
} from "../../src/runtime/values/serializable-values.js";
import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../src/type-inference/core/budget.js";
import { withConsumerOrder, withoutRecords } from "../../src/type-inference/core/consumers.js";
import { withoutSharing } from "../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../src/type-inference/core/solver.js";
import { coreRequest } from "./type-core-analysis.js";
import { runGlobals } from "./type-core-route.js";
import { stopProblems, type Globals, type StopRun } from "./type-core-stop-oracle.js";

/*
 * Host data a script place holds through its stores, read after a settled program stop (#1432, #1415; S3 §5, TABLE
 * r4.113, the mark-ownership rule of S8: a stop changes nothing of the unstopped analysis but what its deferred marks
 * stand for, each carrying its obligation). A generated family over the holder: a list's element, an object's
 * property, a host property, a chain of copies, copies inside objects, a selection, a `get` default, a property's
 * store, a parameter, a parameter's default, a loop variable, a function's result, an add, an `addAll`, the copy
 * graph's topology (a ring, two places copying each other, a ring with a tail), and the finishing read's other sources
 * (a typed parse, a written type). The other axes are its depth; the consumer (an interpolation, a `say`, a repeat count,
 * an arithmetic operand, a fallback's left in requirement mode, a written store); the stores around the read (none, a
 * replacement before it, one after it); and the stop's kind (a program stop alone, or with a demand allowance that stops
 * a decision, `heldDemands`). Each case runs with independent host globals whose values its own predicate sorts
 * (`needs` and the holder's literal), never the checker's, and is judged at every settled stop in four modes
 * (`heldProblems`). CI runs anchors of it; the whole family is a worker run outside CI.
 */

/** A holder at a depth: the lines that store the host data, the read's text, and what its literal requires of the data. */
interface Holder {
  readonly lines: readonly string[];
  readonly read: string;
  /** The lines the consumer's own stand in (a function's body, a loop's), where the read is there. */
  readonly around?: (body: readonly string[]) => readonly string[];
  /** The type the literal around the host data gives it (a list's other element, a receiver's), or none. */
  readonly integer: boolean;
}

const nest = (
  depth: number,
  inner: string,
  wrap: (text: string, level: number) => string,
): string => {
  let text = inner;
  for (let level = 0; level < depth; level += 1) text = wrap(text, level);
  return text;
};

const fields = (depth: number, name = "f"): string =>
  Array.from({ length: depth }, (_, i) => `.${name}${depth - 1 - i}`).join("");

const HOLDERS: Readonly<Record<string, (depth: number) => Holder>> = {
  list: (depth) => ({
    lines: [`let xs = ${nest(depth - 1, "[hostValue, 4]", (text) => `[${text}]`)}`],
    read: `xs${"[0]".repeat(depth)}`,
    integer: true,
  }),
  record: (depth) => ({
    lines: [`let root = ${nest(depth, "hostValue", (text, i) => `{f${i}: ${text}}`)}`],
    read: `root${fields(depth)}`,
    integer: false,
  }),
  member: (depth) => ({
    lines: [`let root = ${nest(depth, "hostValue.n", (text, i) => `{f${i}: ${text}}`)}`],
    read: `root${fields(depth)}`,
    integer: false,
  }),
  copies: (depth) => ({
    lines: [
      "let root = {f: hostValue}",
      ...Array.from({ length: depth }, (_, i) => `let c${i + 1} = ${i === 0 ? "root" : `c${i}`}`),
    ],
    read: `c${depth}.f`,
    integer: false,
  }),
  wrappers: (depth) => ({
    lines: [
      "let root = {f: hostValue}",
      ...Array.from(
        { length: depth },
        (_, i) => `let w${i + 1} = {q: ${i === 0 ? "root" : `w${i}`}, spare: {k: ${i + 1}}}`,
      ),
    ],
    read: `w${depth}${".q".repeat(depth)}.f`,
    integer: false,
  }),
  selection: (depth) => ({
    lines: [`let root = {f: ${nest(depth, "hostValue", (text) => `[${text}, 7][0]`)}}`],
    read: "root.f",
    integer: true,
  }),
  getDefault: (depth) => ({
    lines: [
      "let items = [1]",
      `let root = ${nest(depth - 1, "{f: items.get(4, default: hostValue)}", (text, i) => `{g${i}: ${text}}`)}`,
    ],
    read: `root${fields(depth - 1, "g")}.f`,
    integer: true,
  }),
  field: (depth) => ({
    lines: [
      `let root = ${nest(depth, "1", (text, i) => `{f${i}: ${text}}`)}`,
      `root${fields(depth)} = hostValue`,
    ],
    read: `root${fields(depth)}`,
    integer: true,
  }),
  add: (depth) => ({
    lines: [
      `let xs = ${nest(depth - 1, "[4]", (text) => `[${text}]`)}`,
      `xs${"[0]".repeat(depth - 1)}.add(hostValue)`,
    ],
    read: `xs${"[0]".repeat(depth - 1)}[1]`,
    integer: true,
  }),
  parameter: (depth) => ({
    lines: [],
    read: `v${fields(depth)}`,
    around: (body) => [
      "function show(v) {",
      ...body.map((line) => `  ${line}`),
      "}",
      `show(${nest(depth, "hostValue", (text, i) => `{f${i}: ${text}}`)})`,
    ],
    integer: false,
  }),
  default: (depth) => ({
    lines: [],
    read: `v${fields(depth)}`,
    around: (body) => [
      `function show(v = ${nest(depth, "hostValue", (text, i) => `{f${i}: ${text}}`)}) {`,
      ...body.map((line) => `  ${line}`),
      "}",
      "show()",
    ],
    integer: false,
  }),
  loop: (depth) => ({
    lines: [],
    read: `e${fields(depth)}`,
    around: (body) => [
      `for e in [${nest(depth, "hostValue", (text, i) => `{f${i}: ${text}}`)}] {`,
      ...body.map((line) => `  ${line}`),
      "}",
    ],
    integer: false,
  }),
  result: (depth) => ({
    lines: [
      "function build(seed) {",
      `  return ${nest(depth, "hostValue", (text, i) => `{f${i}: ${text}}`)}`,
      "}",
      "let r = build(1)",
    ],
    read: `r${fields(depth)}`,
    integer: false,
  }),
  // the copy graph's topology: a ring of copies, two places copying each other, a ring with a tail of copies
  ring: (depth) => ({
    lines: [
      ...Array.from({ length: depth + 1 }, (_, i) => `let c${i} = {f: hostValue}`),
      ...Array.from({ length: depth + 1 }, (_, i) => `c${i} = c${(i + 1) % (depth + 1)}`),
    ],
    read: "c0.f",
    integer: false,
  }),
  twoWay: (depth) => ({
    lines: [
      `let a = ${nest(depth, "hostValue", (text, i) => `{f${i}: ${text}}`)}`,
      "let b = a",
      "a = b",
    ],
    read: `a${fields(depth)}`,
    integer: false,
  }),
  ringTail: (depth) => ({
    lines: [
      "let r0 = {f: hostValue}",
      "let r1 = r0",
      "r0 = r1",
      ...Array.from({ length: depth }, (_, i) => `let t${i + 1} = ${i === 0 ? "r1" : `t${i}`}`),
    ],
    read: `t${depth}.f`,
    integer: false,
  }),
  // the finishing read's other sources: a typed parse (F18) and a written type, which the completion leaves alone
  typed: (depth) => ({
    lines: [
      `let root = fromJson(hostValue, default: ${nest(depth, "2", (text, i) => `{f${i}: ${text}}`)})`,
    ],
    read: `root${fields(depth)}`,
    integer: true,
  }),
  written: (depth) => ({
    lines: [
      `let xs: ${"integer" + "[]".repeat(depth)} = ${nest(depth - 1, "[hostValue, 4]", (text) => `[${text}]`)}`,
    ],
    read: `xs${"[0]".repeat(depth)}`,
    integer: true,
  }),
  addAll: (depth) => ({
    lines: [
      `let xs = ${nest(depth - 1, "[4]", (text) => `[${text}]`)}`,
      `xs${"[0]".repeat(depth - 1)}.addAll([hostValue])`,
    ],
    read: `xs${"[0]".repeat(depth - 1)}[1]`,
    integer: true,
  }),
};

/** A consumer of the read: its lines, whether the candidate route takes it, and the value it needs and says. */
interface Consumer {
  readonly lines: (read: string) => readonly string[];
  readonly slice: boolean;
  readonly needs: (value: SerializableRuntimeValue) => boolean;
  readonly says: (value: SerializableRuntimeValue) => readonly string[];
}

const whole = (value: SerializableRuntimeValue): value is number =>
  typeof value === "number" && Number.isInteger(value);

const CONSUMERS: Readonly<Record<string, Consumer>> = {
  interpolation: {
    lines: (read) => [`say "\${${read}}"`],
    slice: false,
    needs: () => true,
    says: (value) => [String(value)],
  },
  say: {
    lines: (read) => [`say ${read}`],
    slice: true,
    needs: (value) => ["number", "string", "boolean"].includes(typeof value),
    says: (value) => [String(value)],
  },
  repeat: {
    lines: (read) => [`repeat ${read} {say "ok"}`],
    slice: true,
    needs: (value) => whole(value) && value >= 0,
    says: (value) => Array.from({ length: Number(value) }, () => "ok"),
  },
  arithmetic: {
    lines: (read) => [`let total = ${read} + 1`, "say total"],
    slice: false,
    needs: (value) => typeof value === "number",
    says: (value) => [String(Number(value) + 1)],
  },
  fallback: {
    // (a fallback's left is read in requirement mode: its kinds give the requirement its right meets, C10)
    lines: (read) => [`let w = ${read} otherwise 1`, "say w"],
    slice: false,
    needs: (value) => ["number", "string", "boolean"].includes(typeof value) || value === null,
    says: (value) => [String(value ?? 1)],
  },
  written: {
    lines: (read) => [`let n: integer = ${read}`, "say n"],
    slice: true,
    needs: whole,
    says: (value) => [String(value)],
  },
};

/** The stores around the read: none, a replacement of the holder's root with `hostOther` before it, or one after it. */
const VARIANTS = ["plain", "overwritten", "laterStore"] as const;

/** The values each case is run with, both globals holding the same one; `say` takes only these three. */
const VALUES: readonly SerializableRuntimeValue[] = [2, 0, 2.5, -1, "bad", true, null];
const SAID: readonly SerializableRuntimeValue[] = [2, "t", true];

export interface HeldCase {
  readonly name: string;
  readonly source: string;
  /** Whether the candidate route compiles it (else it is judged at the analysis). */
  readonly slice: boolean;
  /**
   * Each run's host globals, the read's one holding a value and the other a fitting one apart from it (a host object for
   * a host property), with what the run says where the value fits (`null`: rejected before the consumer's effect).
   */
  readonly values: readonly {
    readonly globals: Globals;
    readonly says: readonly string[] | null;
  }[];
}

/** A host object as the runtime takes it, its `n` the value. */
function hostObject(value: SerializableRuntimeValue): SerializableRuntimeValue {
  return createSerializableObject([{ name: "n", value }]);
}

/**
 * The family: every holder at depths 1, 2 and 4 with every consumer, and at depth 1 the replacements before and after
 * the read. `few`: the depth 1 cases of the repeat count and the interpolation, as the anchors.
 */
export function heldFamily(few = false): HeldCase[] {
  const cases: HeldCase[] = [];
  for (const [holderName, holder] of Object.entries(HOLDERS))
    for (const depth of few ? [1] : [1, 2, 4])
      for (const [consumerName, consumer] of Object.entries(CONSUMERS)) {
        if (few && consumerName !== "repeat" && consumerName !== "interpolation") continue;
        // (two classes the oracle reports, outside this family's rule, judged in the whole family outside CI: a property
        // store's warning gives its fix in words in a stop's unchecked region, #1449; a ring's domain holds every
        // member's host store, the unstopped read the reaching one's, #1448)
        if (few && consumerName === "repeat" && (holderName === "field" || holderName === "ring"))
          continue;
        const held = holder(depth);
        const root = held.read.split(/[.[]/)[0]!;
        const declared = held.lines.find((line) => line.startsWith(`let ${root} = `)) ?? "";
        // (a replacement only of a declaration holding the host data: one of a store below it would drop the data)
        const variants =
          depth === 1 && !few && declared.includes("hostValue") ? VARIANTS : ["plain"];
        for (const variant of variants) {
          const replacement = `${root} = ${declared.slice(`let ${root} = `.length).replace("hostValue", "hostOther")}`;
          const lines = [
            ...held.lines,
            ...(variant === "overwritten" ? [replacement] : []),
            'say "BEFORE"',
            ...(held.around ?? ((body) => body))(consumer.lines(held.read)),
            ...(variant === "laterStore" ? [replacement] : []),
            'say "AFTER"',
            "exit",
          ];
          // (an add, a function, a loop and a typed parse of host text are judged at the analysis: outside the candidate
          // route, or a value the predicate does not model)
          const slice =
            consumer.slice &&
            !["add", "addAll", "parameter", "default", "loop", "result", "typed"].includes(
              holderName,
            );
          // (the read's global holds the value; the other one, independent of it, a value every holder takes)
          const read = variant === "overwritten" ? "hostOther" : "hostValue";
          const other = read === "hostValue" ? "hostOther" : "hostValue";
          const host =
            holderName === "member" ? hostObject : (value: SerializableRuntimeValue) => value;
          cases.push({
            name: `${holderName}-${depth}-${consumerName}-${variant}`,
            source: `${lines.join("\n")}\n`,
            slice,
            values: (consumerName === "say" ? SAID : VALUES).map((value) => ({
              globals: { [read]: host(value), [other]: host(3) },
              says:
                consumer.needs(value) && (!held.integer || whole(value))
                  ? ["BEFORE", ...consumer.says(value), "AFTER"]
                  : null,
            })),
          });
        }
      }
  return cases;
}

/** An order of the analysis: the consumers' and the solver's worklists forward or reversed, the sharing on or off. */
export interface HeldMode {
  readonly name: string;
  readonly run: <T>(make: () => T) => T;
}

export const HELD_MODES: readonly HeldMode[] = [true, false].flatMap((sharing) =>
  [false, true].map((reversed): HeldMode => ({
    name: `${reversed ? "reversed" : "forward"}${sharing ? "" : ", unshared"}`,
    run: <T>(make: () => T): T => {
      const ordered = (): T =>
        reversed
          ? withSolverSeam({ reverseWorklist: true }, () =>
              withConsumerOrder((list) => [...list].reverse(), make),
            )
          : make();
      return sharing ? ordered() : withoutSharing(ordered);
    },
  })),
);

const GLOBALS = ["hostValue", "hostOther"];

/**
 * A mode's settled phases, each with its lowest and highest stopping allowance, found by bisection: below the analysis's
 * total `phaseOf` (an analysis stopped at the allowance: its phase where admission had settled, else `null`) names
 * contiguous ranges, the publication's above the walk's, down to the first stop that is not settled. A phase found twice
 * is not contiguous and throws.
 */
export function phaseEnds(
  total: number,
  phaseOf: (allowance: number) => string | null,
): Map<string, readonly [number, number]> {
  const ends = new Map<string, readonly [number, number]>();
  for (let high = total - 1; high > 0;) {
    const phase = phaseOf(high);
    if (phase === null) break;
    if (ends.has(phase)) throw new Error(`${phase} again below ${high + 1}`);
    let low = 1;
    for (let top = high; low < top;) {
      const middle = (low + top) >> 1;
      if (phaseOf(middle) === phase) top = middle;
      else low = middle + 1;
    }
    ends.set(phase, [low, high]);
    high = low - 1;
  }
  return ends;
}

/** The cases the candidate route declined at some compile: judged at the analysis from then on. */
const declined = new WeakSet<HeldCase>();

/** A case's analysis and, in the slice, its compile, unstopped or at an allowance, in a mode. */
function heldRun(c: HeldCase, mode: HeldMode, allowance?: number, demand?: number): StopRun {
  const request = coreRequest([{ path: "main.tease", source: c.source }], GLOBALS);
  if (request === null) throw new Error(`The case does not resolve: ${c.name}`);
  const capped = <T>(make: () => T): T =>
    demand === undefined ? make() : withTestDemandAllowance(demand, make);
  const allowed = <T>(make: () => T): T =>
    mode.run(() =>
      allowance === undefined ? capped(make) : withTestAllowance(allowance, () => capped(make)),
    );
  // (outside the slice the analysis alone is judged: a case the candidate route declines in some mode or stop too)
  const compiled = () => {
    if (!c.slice || declined.has(c)) return { diagnostics: [], plan: null };
    try {
      return compileSourceWithBackend(c.source, { globals: GLOBALS }, CORE_BACKEND);
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice)) throw error;
      declined.add(c);
      return { diagnostics: [], plan: null };
    }
  };
  const both = () => ({ result: compiled(), answers: analyseCore(request) });
  return { ...allowed(both), without: (omit) => allowed(() => withoutRecords(omit, both)) };
}

/** A case's settled stops in a mode: every `step`th allowance of each settled phase from its lowest, and its highest. */
export function heldStops(
  c: HeldCase,
  mode: HeldMode,
  step = 1,
  demand?: number,
): { allowance: number; phase: string }[] {
  const request = coreRequest([{ path: "main.tease", source: c.source }], GLOBALS)!;
  const capped = <T>(make: () => T): T =>
    demand === undefined ? make() : withTestDemandAllowance(demand, make);
  const total = mode.run(() => capped(() => analyseCore(request))).budget.total;
  const stops: { allowance: number; phase: string }[] = [];
  for (const [phase, [low, high]] of phaseEnds(total, (allowance) => {
    const { stoppedIn, settled } = mode.run(() =>
      withTestAllowance(allowance, () => capped(() => analyseCore(request))),
    ).budget;
    return settled ? stoppedIn : null;
  }))
    for (let allowance = low; allowance <= high; allowance += 1)
      if ((allowance - low) % step === 0 || allowance === high) stops.push({ allowance, phase });
  return stops;
}

/**
 * The mark-ownership rule at the analysis (S8): every check of the unstopped analysis the stop removed is a deferred
 * mark's obligation, and every warning or error it removed is a mark's record (its code at its site).
 */
function ownership(unstopped: Answers, stopped: Answers): string[] {
  const marks = stopped.budget.deferred;
  const owned = new Set(marks.map((mark) => JSON.stringify(mark.obligation)));
  const kept = new Set(stopped.checks.map((check) => JSON.stringify(check)));
  const record = (d: { readonly code: string; readonly site: { start: number; end: number } }) =>
    `${d.code} ${d.site.start}:${d.site.end}`;
  const records = new Set([...stopped.diagnostics, ...marks].map(record));
  return [
    ...unstopped.checks
      .map((check) => JSON.stringify(check))
      .filter((check) => !kept.has(check) && !owned.has(check))
      .map((check) => `unowned check ${check}`),
    ...unstopped.diagnostics
      .filter((d) => d.kind !== "budget" && !records.has(record(d)))
      .map((d) => `unowned record ${record(d)}`),
  ];
}

/**
 * What a settled stop changed of a case that its marks do not stand for, in a mode (`unstopped`: the case's unstopped
 * run there, made once): the mark-ownership rule at the analysis; in the slice the stop oracle (`stopProblems`) and the
 * runs: a fitting value says what its predicate does, and a value that does not fit is rejected before the consumer's
 * effect, having said at most `BEFORE`.
 */
export function heldProblems(
  c: HeldCase,
  mode: HeldMode,
  allowance: number,
  unstopped: StopRun = heldRun(c, mode),
  demand?: number,
): string[] {
  const stopped = heldRun(c, mode, allowance, demand);
  const problems = ownership(unstopped.answers, stopped.answers);
  if (!c.slice || declined.has(c)) return problems;
  problems.push(
    ...stopProblems({
      unstopped,
      stopped,
      fitting: c.values.filter((each) => each.says !== null).map((each) => each.globals),
      violating: c.values.filter((each) => each.says === null).map((each) => each.globals),
    }),
  );
  return [...problems, ...runProblems(c, stopped)];
}

/** A compile's runs against the case's predicate: what each fitting value says, and each other value rejected in time. */
function runProblems(c: HeldCase, run: StopRun): string[] {
  const plan = run.result.plan;
  if (plan === null) return ["no plan"];
  const problems: string[] = [];
  for (const { globals, says } of c.values) {
    const ran = runGlobals(plan, globals);
    const value = globals;
    const said = ran.said.map((each) => each.text);
    if (says !== null && JSON.stringify(said) !== JSON.stringify(says))
      problems.push(
        `fitting ${JSON.stringify(value)} said ${JSON.stringify(said)}: ${ran.failure}`,
      );
    // (rejected before the consumer's effect: at its store, or at the consumer after `BEFORE`)
    if (says === null && (ran.status !== "failed" || said.some((text) => text !== "BEFORE")))
      problems.push(`forbidden ${JSON.stringify(value)} said ${JSON.stringify(said)}`);
  }
  return problems;
}

/** The unstopped run `heldProblems` compares a case's stops with, in a mode, and its own runs against the predicate. */
export function heldUnstopped(
  c: HeldCase,
  mode: HeldMode,
  demand?: number,
): { run: StopRun; problems: string[] } {
  const run = heldRun(c, mode, undefined, demand);
  return { run, problems: c.slice && !declined.has(c) ? runProblems(c, run) : [] };
}

/**
 * The stop kinds beside a settled program stop (S3 §5): demand allowances that stop a decision of a case, alone (a
 * decision stop) and with a program stop (a combined one), each judged against the unstopped run at the same demand
 * allowance. Tried one unit below each decision's work in the case's unstopped analysis, largest first, then halving
 * below the smallest; kept only where a decision then stops, up to three. A case with none has no such rows.
 *
 * @public (the whole family's driver outside CI reads it, with the family)
 */
export function heldDemands(c: Pick<HeldCase, "source">, mode: HeldMode): number[] {
  const request = coreRequest([{ path: "main.tease", source: c.source }], GLOBALS)!;
  const units = [
    ...new Set(mode.run(() => analyseCore(request)).budget.decisions.map((d) => d.units)),
  ].sort((a, b) => b - a);
  const worked = units.filter((unit) => unit > 1);
  const tried = worked.map((unit) => unit - 1);
  for (let unit = Math.floor((worked.at(-1) ?? 0) / 2); unit >= 1; unit = Math.floor(unit / 2))
    tried.push(unit);
  const stopping: number[] = [];
  for (const demand of new Set(tried)) {
    if (stopping.length === 3) break;
    const { decisions } = mode.run(() =>
      withTestDemandAllowance(demand, () => analyseCore(request)),
    ).budget;
    if (decisions.some((d) => d.stopped)) stopping.push(demand);
  }
  return stopping;
}

/** Rows of `line(i)` for i < k. */
const lines = (k: number, line: (i: number) => string): string[] =>
  Array.from({ length: k }, (_, i) => line(i));

/** An object literal of properties `f0` … `f(k-1)`, each `value(i)`. */
const fields0 = (k: number, value: (i: number) => string): string =>
  `{${lines(k, (i) => `f${i}: ${value(i)}`).join(", ")}}`;

/**
 * The copy graph's topologies at size k, each read after a settled stop through the host-data completion (#1445): a
 * chain of copies, a ring, a fan-out of copies of one base, a fan-in of branches (one base, each branch changing its own
 * property, all read through one root: Codex r4's B2), a stack of diamonds, a shared base with branch deltas read at every
 * field, nested cycles, two-way copies, and a chain whose links each store their own property. Codex r5's B1 and T1: k
 * readers each holding the same two unrelated objects (`unshared-readers`), or one object and the tip of a chain whose
 * links store their own property (`unshared-chain-readers`), and k readers each holding a chain's root and its tip, root
 * first (`tie-root-first`) or tip first (`tie-tip-first`). Sol's design round r1 (TABLE r4.208): reader i holding the
 * i+1-th link of one chain and the k-i-th of another, each link storing its own property (`staggered-pairs`), and k
 * branches of one object, each storing its own property, each read through a reader that also holds another object
 * (`branch-disjoint-readers`).
 */
export function topologySources(k: number): { readonly name: string; readonly source: string }[] {
  const shapes: Record<string, string[]> = {
    chain: [
      "let c0 = {f: hostValue}",
      ...lines(k, (i) => `let c${i + 1} = c${i}`),
      ...lines(k, (i) => `repeat c${i + 1}.f {}`),
    ],
    ring: [
      ...lines(k, (i) => `let c${i} = {f: hostValue}`),
      ...lines(k, (i) => `c${i} = c${(i + 1) % k}`),
      ...lines(k, (i) => `repeat c${i}.f {}`),
    ],
    "fan-out": [
      "let base = {f: hostValue}",
      ...lines(k, (i) => `let c${i} = base`),
      ...lines(k, (i) => `repeat c${i}.f {}`),
    ],
    "fan-in": [
      `let base = {common: hostOther, ${lines(k, (i) => `f${i}: 1`).join(", ")}}`,
      ...lines(k, (i) => `let a${i} = base\na${i}.f${i} = hostValue`),
      "let root = a0",
      ...lines(k, (i) => `${i > 0 ? `root = a${i}\n` : ""}repeat root.f${i} {}`),
    ],
    diamond: [
      "let d0 = {f: hostValue, g: 1}",
      ...lines(
        k,
        (i) =>
          `let l${i} = d${i}\nlet r${i} = d${i}\nl${i}.g = hostValue\nlet d${i + 1} = l${i}\nd${i + 1} = r${i}`,
      ),
      ...lines(k, (i) => `repeat d${i + 1}.g {}`),
    ],
    "shared-deltas": [
      `let base = ${fields0(k, () => "1")}`,
      ...lines(k, (i) => `let a${i} = base\na${i}.f${i} = hostValue`),
      ...lines(k, (i) => lines(k, (j) => `repeat a${i}.f${j} {}`).join("\n")),
    ],
    "nested-cycles": [
      ...lines(k, (i) => `let a${i} = {f: hostValue}`),
      ...lines(k, (i) => `a${i} = a${(i + 1) % k}`),
      ...lines(k, (i) => `let b${i} = [{q: a${i}}]`),
      ...lines(k, (i) => `b${i} = b${(i + 1) % k}`),
      ...lines(k, (i) => `repeat b${i}[0].q.f {}`),
    ],
    "two-way": [
      ...lines(k, (i) => `let a${i} = {f: hostValue}\nlet b${i} = a${i}\na${i} = b${i}`),
      ...lines(k, (i) => `repeat a${i}.f {}`),
    ],
    "chain-own": [
      `let c0 = ${fields0(k, (i) => (i === 0 ? "hostValue" : "1"))}`,
      ...lines(k - 1, (i) => `let c${i + 1} = c${i}\nc${i + 1}.f${i + 1} = hostValue`),
      ...lines(k, (j) => `repeat c${k - 1}.f${j} {}`),
    ],
    "unshared-readers": [
      `let a = ${fields0(k, (i) => (i === 0 ? "hostValue" : "1"))}`,
      `let b = ${fields0(k, (i) => (i === 0 ? "hostOther" : "1"))}`,
      ...lines(k, (i) => `let r${i} = a\nr${i} = b\nrepeat r${i}.f${i} {}`),
    ],
    "unshared-chain-readers": [
      `let a = ${fields0(k, (i) => (i === 0 ? "hostValue" : "1"))}`,
      `let b = ${fields0(k, (i) => (i === 0 ? "hostOther" : "1"))}`,
      ...lines(k, (i) => `let b${i} = ${i > 0 ? `b${i - 1}` : "b"}\nb${i}.f${i} = hostOther`),
      ...lines(k, (i) => `let r${i} = a\nr${i} = b${k - 1}\nrepeat r${i}.f${i} {}`),
    ],
    "staggered-pairs": [
      `let a0 = ${fields0(k, (i) => (i === 0 ? "hostValue" : "1"))}`,
      `let b0 = ${fields0(k, (i) => (i === 0 ? "hostOther" : "1"))}`,
      ...lines(
        k,
        (i) =>
          `let a${i + 1} = a${i}\na${i + 1}.f${i} = hostValue\nlet b${i + 1} = b${i}\nb${i + 1}.f${i} = hostOther`,
      ),
      ...lines(k, (i) => `let r${i} = a${i + 1}\nr${i} = b${k - i}\nrepeat r${i}.f${i} {}`),
    ],
    "branch-disjoint-readers": [
      `let a = ${fields0(k, (i) => (i === 0 ? "hostValue" : "1"))}`,
      `let b = ${fields0(k, (i) => (i === 0 ? "hostOther" : "1"))}`,
      ...lines(
        k,
        (i) =>
          `let t${i} = b\nt${i}.f${i} = hostOther\nlet r${i} = a\nr${i} = t${i}\nrepeat r${i}.f${i} {}`,
      ),
    ],
    ...Object.fromEntries(
      [true, false].map((rootFirst) => [
        rootFirst ? "tie-root-first" : "tie-tip-first",
        [
          `let c0 = ${fields0(k, (i) => (i === 0 ? "hostValue" : "1"))}`,
          ...lines(k, (i) => `let c${i + 1} = c${i}\nc${i + 1}.f${i} = hostValue`),
          ...lines(
            k,
            (i) =>
              `let r${i} = ${rootFirst ? "c0" : `c${k}`}\nr${i} = ${rootFirst ? `c${k}` : "c0"}\nrepeat r${i}.f${i} {}`,
          ),
        ],
      ]),
    ),
  };
  return Object.entries(shapes).map(([name, rows]) => ({
    name,
    source: `${rows.join("\n")}\nexit\n`,
  }));
}

/**
 * A random copy graph, by a seeded generator: `places` objects of `fields` properties, some holding host data, then
 * `statements` stores at random, each a copy of another place, a copy through a selection, a property store of host
 * data, or a read of a property by a count; then each place read, and `readers` new places each holding two places at
 * random and read (Codex r5's readers of unrelated lineages; none leaves the graph as it was).
 */
export function randomCopyGraph(
  seed: number,
  places: number,
  fields: number,
  statements: number,
  readers = 0,
): string {
  let state = seed >>> 0;
  const next = (n: number): number => {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    return state % n;
  };
  const rows = lines(
    places,
    (i) => `let p${i} = ${fields0(fields, () => (next(3) === 0 ? "hostValue" : "1"))}`,
  );
  for (let s = 0; s < statements; s += 1) {
    const [i, j, f] = [next(places), next(places), next(fields)];
    switch (next(4)) {
      case 0:
        if (i !== j) rows.push(`p${i} = p${j}`);
        break;
      case 1:
        if (i !== j) rows.push(`p${i} = [p${j}, p${j}][0]`);
        break;
      case 2:
        rows.push(`p${i}.f${f} = hostValue`);
        break;
      default:
        rows.push(`repeat p${i}.f${f} {}`);
    }
  }
  rows.push(...lines(places, (i) => `repeat p${i}.f${next(fields)} {}`));
  for (let r = 0; r < readers; r += 1) {
    const [i, j, f] = [next(places), next(places), next(fields)];
    rows.push(`let q${r} = p${i}\nq${r} = p${j}\nrepeat q${r}.f${f} {}`);
  }
  return `${rows.join("\n")}\nexit\n`;
}
