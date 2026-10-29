import { compileSourceWithBackend } from "../../src/compiler.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import { CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { withTestAllowance } from "../../src/type-inference/core/budget.js";
import { withConsumerOrder, withoutRecords } from "../../src/type-inference/core/consumers.js";
import { withoutSharing } from "../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../src/type-inference/core/solver.js";
import { coreRequest } from "./type-core-analysis.js";
import { runGlobals } from "./type-core-route.js";
import { stopProblems, type Globals, type StopRun } from "./type-core-stop-oracle.js";

/*
 * Host data a script place holds through its stores, read after a settled program stop (#1432, #1415; S3 §5, TABLE
 * r4.113, the mark-ownership rule of S8: a stop changes nothing of the unstopped analysis but what its deferred marks
 * stand for, each carrying its obligation). A generated family over the holder (a list's element, an object's property,
 * a host property, a chain of copies, copies inside objects, a selection, a `get` default, a property's store, an add,
 * an `addAll`), its depth, the consumer (an interpolation, a `say`, a repeat count, an arithmetic operand, a written
 * store) and the stores around the read (none, a replacement before it, one after it), each run with the values its own
 * predicate sorts (`needs` and the holder's literal), never the checker's; judged at every settled stop in four modes
 * (`heldProblems`). CI runs anchors of it; the whole family is a worker run outside CI.
 */

/** A holder at a depth: the lines that store the host data, the read's text, and what its literal requires of the data. */
interface Holder {
  readonly lines: readonly string[];
  readonly read: string;
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
  /** Each value with what a run says where the value fits (`null`: it is rejected before the consumer's effect). */
  readonly values: readonly {
    readonly value: SerializableRuntimeValue;
    readonly says: readonly string[] | null;
  }[];
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
        // (a property store's warning gives its fix in words in a stop's unchecked region, TABLE r4.162, which the whole
        // diagnostics the oracle compares see: judged in the whole family, outside CI)
        if (few && holderName === "field" && consumerName === "repeat") continue;
        const held = holder(depth);
        const root = held.read.split(/[.[]/)[0]!;
        const declared = held.lines.find((line) => line.startsWith(`let ${root} = `))!;
        // (a replacement only of a declaration holding the host data: one of a store below it would drop the data)
        const variants =
          depth === 1 && !few && declared.includes("hostValue") ? VARIANTS : ["plain"];
        for (const variant of variants) {
          const replacement = `${root} = ${declared.slice(`let ${root} = `.length).replace("hostValue", "hostOther")}`;
          const lines = [
            ...held.lines,
            ...(variant === "overwritten" ? [replacement] : []),
            'say "BEFORE"',
            ...consumer.lines(held.read),
            ...(variant === "laterStore" ? [replacement] : []),
            'say "AFTER"',
            "exit",
          ];
          // (a host property's object is judged at the analysis: the runs' globals are plain values; an add is outside
          // the candidate route)
          const slice = consumer.slice && !["member", "add", "addAll"].includes(holderName);
          cases.push({
            name: `${holderName}-${depth}-${consumerName}-${variant}`,
            source: `${lines.join("\n")}\n`,
            slice,
            values: (consumerName === "say" ? SAID : VALUES).map((value) => ({
              value,
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

/** A case's analysis and, in the slice, its compile, unstopped or at an allowance, in a mode. */
function heldRun(c: HeldCase, mode: HeldMode, allowance?: number): StopRun {
  const request = coreRequest([{ path: "main.tease", source: c.source }], GLOBALS);
  if (request === null) throw new Error(`The case does not resolve: ${c.name}`);
  const allowed = <T>(make: () => T): T =>
    mode.run(() => (allowance === undefined ? make() : withTestAllowance(allowance, make)));
  const both = () => ({
    // (outside the slice the analysis alone is judged)
    result: c.slice
      ? compileSourceWithBackend(c.source, { globals: GLOBALS }, CORE_BACKEND)
      : { diagnostics: [], plan: null },
    answers: analyseCore(request),
  });
  return { ...allowed(both), without: (omit) => allowed(() => withoutRecords(omit, both)) };
}

/** A case's settled stops in a mode: every `step`th allowance of each settled phase from its lowest, and its highest. */
export function heldStops(
  c: HeldCase,
  mode: HeldMode,
  step = 1,
): { allowance: number; phase: string }[] {
  const request = coreRequest([{ path: "main.tease", source: c.source }], GLOBALS)!;
  const total = mode.run(() => analyseCore(request)).budget.total;
  const stops: { allowance: number; phase: string }[] = [];
  for (const [phase, [low, high]] of phaseEnds(total, (allowance) => {
    const { stoppedIn, settled } = mode.run(() =>
      withTestAllowance(allowance, () => analyseCore(request)),
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
): string[] {
  const stopped = heldRun(c, mode, allowance);
  const problems = ownership(unstopped.answers, stopped.answers);
  if (!c.slice) return problems;
  const globals = (value: SerializableRuntimeValue): Globals => ({
    hostValue: value,
    hostOther: value,
  });
  problems.push(
    ...stopProblems({
      unstopped,
      stopped,
      fitting: c.values.filter((each) => each.says !== null).map((each) => globals(each.value)),
      violating: c.values.filter((each) => each.says === null).map((each) => globals(each.value)),
    }),
  );
  return [...problems, ...runProblems(c, stopped)];
}

/** A compile's runs against the case's predicate: what each fitting value says, and each other value rejected in time. */
function runProblems(c: HeldCase, run: StopRun): string[] {
  const plan = run.result.plan;
  if (plan === null) return ["no plan"];
  const problems: string[] = [];
  for (const { value, says } of c.values) {
    const ran = runGlobals(plan, { hostValue: value, hostOther: value });
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
export function heldUnstopped(c: HeldCase, mode: HeldMode): { run: StopRun; problems: string[] } {
  const run = heldRun(c, mode);
  return { run, problems: c.slice ? runProblems(c, run) : [] };
}
