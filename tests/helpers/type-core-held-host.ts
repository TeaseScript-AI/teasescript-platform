import { compileSourceWithBackend } from "../../src/compiler.js";
import {
  createSerializableObject,
  type SerializableRuntimeValue,
} from "../../src/runtime/values/serializable-values.js";
import { analyseCore, type Answers, type CorePass } from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import {
  pathText,
  withTestAllowance,
  withTestDemandAllowance,
} from "../../src/type-inference/core/budget.js";
import {
  Consumers,
  withConsumerOrder,
  withoutRecords,
} from "../../src/type-inference/core/consumers.js";
import { withoutSharing } from "../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../src/type-inference/core/solver.js";
import { coreRequest, type SourceFile } from "./type-core-analysis.js";
import { runGlobals } from "./type-core-route.js";
import { VALUE_KINDS } from "../../src/value-kinds.js";
import type { Expression, TypeAnnotation } from "../../src/ast.js";
import { expressionChildren, unwrap } from "../../src/expression-children.js";
import type { FlowGraph } from "../../src/type-inference/core/flow-graph/model.js";
import {
  kindsInOrder,
  REASON,
  type Item,
  type ItemTag,
} from "../../src/type-inference/core/items.js";
import { hasMethod, hasProperty } from "../../src/type-inference/core/consumers/kinds.js";
import { MEMBER_KINDS, REFERENCE } from "../../src/type-inference/core/contract/kinds.js";
import { described } from "../../src/type-inference/core/messages.js";
import type { PlaceId, SourceSite } from "../../src/type-inference/graph.js";
import type { Label } from "../../src/type-inference/core/contract/labels.js";
import { propertyName, stepName } from "../../src/type-inference/core/program.js";
import {
  type CoreDiagnostic,
  type DiagnosticRule,
  type Obligation,
} from "../../src/type-inference/core/result.js";
import { stopProblems, type Globals, type StopRun } from "./type-core-stop-oracle.js";
import { sampled } from "./sweep.js";

/*
 * Host data a script place holds through its stores, read after a settled program stop (#1432, #1415; S3 §5,
 * the mark-ownership rule of S8: a stop changes nothing of the unstopped analysis but what its deferred marks
 * stand for, each carrying its obligation; at a combined stop the unstopped analysis is the run at the same demand
 * allowance, except where the finishing walk answers a read the demand stop left `unknown`,
 * `combinedStop`). A generated family over the holder: a list's element, an object's property,
 * a host property, a chain of copies, copies inside objects, a selection, a `get` default, a property's store, a
 * parameter, a parameter's default, a loop variable, a function's result, an add, an `addAll` (and the owner reviewer's
 * seven `addAll` texts), a dictionary's values list through a copy and an object's own `values` property (#1452), the
 * copy graph's topology (a ring, two places copying each other, a ring with a tail), and the finishing read's other
 * sources (a typed parse, a written type, an unrestricted written type, its dictionary's values list and a copy
 * projecting below it: #1450), and reads of values no place holds (a dictionary literal's values, a list literal's
 * element, an object literal's property, a fallback, a `get`'s default: #1491, #1502). The other axes are its depth;
 * the consumer (an interpolation, a `say`, a repeat count, an arithmetic operand, a fallback's left in requirement
 * mode, a written store); the stores around the read (none, a replacement before it, one after it); and the stop's kind
 * (a program stop alone, or with a demand allowance that stops a decision, `heldDemands`). Each case runs with
 * independent host globals whose values its own predicate sorts (`needs` and the holder's literal), never the
 * checker's, and is judged at every settled stop in four modes (`heldProblems`). CI runs anchors of it; the whole
 * family is a worker run outside CI.
 */

/** A holder at a depth: the lines that store the host data, the read's text, and what its literal requires of the data. */
interface Holder {
  readonly lines: readonly string[];
  readonly read: string;
  /** The lines the consumer's own stand in (a function's body, a loop's), where the read is there. */
  readonly around?: (body: readonly string[]) => readonly string[];
  /** The type the literal around the host data gives it (a list's other element, a receiver's), or none. */
  readonly integer: boolean;
  /** The value the read gives for the host data's, where it is another (a fallback's for `null`). */
  readonly gives?: (value: SerializableRuntimeValue) => SerializableRuntimeValue;
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
  // (an unrestricted written element, which admits every kind: its read holds the host data, and its store owes no
  // boundary by the literal beside it, #1450)
  writtenList: (depth) => ({
    lines: [
      `let xs: list${"[]".repeat(depth - 1)} = ${nest(depth - 1, "[hostValue, 4]", (text) => `[${text}]`)}`,
    ],
    read: `xs${"[0]".repeat(depth)}`,
    integer: false,
  }),
  // (an unrestricted written dictionary's values list, a list of its elements: Codex r1's B1 on #1487)
  writtenDictValues: (depth) => ({
    lines: [
      `let xs: dict${"[]".repeat(depth - 1)} = ${nest(depth - 1, "dict {a: hostValue, b: 4}", (text) => `[${text}]`)}`,
    ],
    read: `xs${"[0]".repeat(depth - 1)}.values[0]`,
    integer: false,
  }),
  // (a copy projecting below an unrestricted written part, its nearest written prefix admitting every kind, and the
  // object twin: Codex r2's N1 on #1487)
  writtenListBelow: (depth) => ({
    lines: [
      `let xs: list = [${nest(depth, "hostValue", (text, i) => `{f${i}: ${text}}`)}]`,
      `let ys = xs[0]${fields(depth)}`,
    ],
    read: "ys",
    integer: false,
  }),
  writtenObjectBelow: (depth) => ({
    lines: [
      `let root: object = ${nest(depth, "[hostValue, 4]", (text, i) => `{f${i}: ${text}}`)}`,
      `let ys = root${fields(depth)}`,
    ],
    read: "ys[0]",
    integer: false,
  }),
  // (a dictionary's values list, read through a copy, whose element is the dictionary's, #1452; and an object's own
  // `values` property beside it)
  dictValues: (depth) => ({
    lines: [
      `let xs = ${nest(depth - 1, "dict {a: hostValue, b: 4}", (text) => `dict {a: ${text}}`)}`,
      "let root = {f: xs.values}",
    ],
    read: `root.f[0]${".values[0]".repeat(depth - 1)}`,
    integer: true,
  }),
  objectValues: (depth) => ({
    lines: [
      `let o = ${nest(depth, "[hostValue, 4]", (text) => `{values: ${text}}`)}`,
      "let root = {f: o.values}",
    ],
    read: `root.f${".values".repeat(depth - 1)}[0]`,
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
  // (reads of values no place holds, nested to the depth: a dictionary literal's values list, a list literal's element,
  // an object literal's property, a fallback and a `get`'s default, #1491, #1502; a literal no store holds, and a
  // fallback's left, leave the host data's type open, a `get`'s default fits the list's element)
  literalValues: (depth) => ({
    lines: [],
    read: nest(depth, "hostValue", (text) => `(dict {a: ${text}, b: 4}).values[0]`),
    integer: false,
  }),
  literalElement: (depth) => ({
    lines: [],
    read: nest(depth, "hostValue", (text) => `[${text}, 4][0]`),
    integer: false,
  }),
  literalProperty: (depth) => ({
    lines: [],
    read: nest(depth, "hostValue", (text) => `({f: ${text}, g: 4}).f`),
    integer: false,
  }),
  fallbackRead: (depth) => ({
    lines: ["let root = {f: hostValue}"],
    read: nest(depth, "root.f", (text) => `(${text} otherwise 2)`),
    integer: false,
    gives: (value) => value ?? 2,
  }),
  getRead: (depth) => ({
    lines: ["let items = [1]"],
    read: nest(depth, "hostValue", (text) => `items.get(4, default: ${text})`),
    integer: true,
  }),
  // (the owner reviewer's `addAll` texts, #1445 review of 2026-10-30, at depth 1 alone: host data stored below the
  // source list's element, in a field, a deeper field, a nested list and an object copied into the list, and the
  // controls of a replaced element, an inline literal and a single `add`)
  addAllField: () => ({
    lines: [
      "let source = [{n: 0}]",
      "source[0].n = hostValue",
      "let xs = [{n: 0}]",
      "xs.addAll(source)",
    ],
    read: "xs[1].n",
    integer: true,
  }),
  addAllDeeper: () => ({
    lines: [
      "let source = [{m: {n: 0}}]",
      "source[0].m.n = hostValue",
      "let xs = [{m: {n: 0}}]",
      "xs.addAll(source)",
    ],
    read: "xs[1].m.n",
    integer: true,
  }),
  addAllNested: () => ({
    lines: [
      "let source = [[0]]",
      "source[0][0] = hostValue",
      "let xs = [[0]]",
      "xs.addAll(source)",
    ],
    read: "xs[1][0]",
    integer: true,
  }),
  addAllCopied: () => ({
    lines: [
      "let item = {n: 0}",
      "item.n = hostValue",
      "let source = [item]",
      "let xs = [{n: 0}]",
      "xs.addAll(source)",
    ],
    read: "xs[1].n",
    integer: true,
  }),
  addAllReplaced: () => ({
    lines: [
      "let source = [{n: 0}]",
      "source[0] = {n: hostValue}",
      "let xs = [{n: 0}]",
      "xs.addAll(source)",
    ],
    read: "xs[1].n",
    integer: true,
  }),
  addAllLiteral: () => ({
    lines: ["let xs = [{n: 0}]", "xs.addAll([{n: hostValue}])"],
    read: "xs[1].n",
    integer: true,
  }),
  addSingle: () => ({
    lines: ["let item = {n: 0}", "item.n = hostValue", "let xs = [{n: 0}]", "xs.add(item)"],
    read: "xs[1].n",
    integer: true,
  }),
};

/** The holders taken at depth 1 alone (fixed texts). */
const FIXED_HOLDERS = new Set([
  "addAllField",
  "addAllDeeper",
  "addAllNested",
  "addAllCopied",
  "addAllReplaced",
  "addAllLiteral",
  "addSingle",
]);

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
  // (an operation a later statement reads, which a stop leaves to the finishing walk, #1448)
  laterOperation: {
    lines: (read) => ['repeat 2 {say "x"}', `say "\${${read} * 2}"`],
    slice: false,
    needs: (value) => typeof value === "number",
    says: (value) => ["x", "x", String(Number(value) * 2)],
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
    for (const depth of few || FIXED_HOLDERS.has(holderName) ? [1] : [1, 2, 4])
      for (const [consumerName, consumer] of Object.entries(CONSUMERS)) {
        if (few && consumerName !== "repeat" && consumerName !== "interpolation") continue;
        // (of the fixed texts, the anchors take the reviewer's witness alone; of the reads no place holds, the issues')
        if (few && FIXED_HOLDERS.has(holderName) && holderName !== "addAllField") continue;
        if (few && ["literalElement", "literalProperty", "getRead"].includes(holderName)) continue;
        const held = holder(depth);
        // (a fallback's read starts with its parenthesis)
        const root = held.read.replace(/^\(+/, "").split(/[.[]/)[0]!;
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
          // (an add, a function, a loop, a dictionary and a typed parse of host text are judged at the analysis: outside
          // the candidate route, or a value the predicate does not model)
          const slice =
            consumer.slice &&
            ![
              "add",
              "addAll",
              "parameter",
              "default",
              "loop",
              "result",
              "typed",
              "dictValues",
              "writtenDictValues",
              "literalValues",
            ].includes(holderName) &&
            !FIXED_HOLDERS.has(holderName);
          // (the read's global holds the value; the other one, independent of it, a value every holder takes)
          const read = variant === "overwritten" ? "hostOther" : "hostValue";
          const other = read === "hostValue" ? "hostOther" : "hostValue";
          const host =
            holderName === "member" ? hostObject : (value: SerializableRuntimeValue) => value;
          cases.push({
            name: `${holderName}-${depth}-${consumerName}-${variant}`,
            source: `${lines.join("\n")}\n`,
            slice,
            values: (consumerName === "say" ? SAID : VALUES).map((value) => {
              const given = held.gives?.(value) ?? value;
              return {
                globals: { [read]: host(value), [other]: host(3) },
                says:
                  consumer.needs(given) && (!held.integer || whole(given))
                    ? ["BEFORE", ...consumer.says(given), "AFTER"]
                    : null,
              };
            }),
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

/** The compiles the candidate route declined (outside the slice): no plan, each judged alone (Astra r1's B1 on #1597). */
const declined = new WeakSet<object>();

/** Whether a run's compile was declined by the candidate route. */
const declinedRun = (run: StopRun): boolean => declined.has(run.result);

/**
 * A case's analysis and, in the slice, its compile, unstopped or at an allowance, in a mode, its `without` at the same
 * allowance and mode (`StopRun.without`; drivers outside CI build their stopped runs with it, #1594). A compile the
 * candidate route declines has no plan; it decides nothing of another (a declined reference leaves a stopped plan to run).
 */
export function heldRun(c: HeldCase, mode: HeldMode, allowance?: number, demand?: number): StopRun {
  const request = coreRequest([{ path: "main.tease", source: c.source }], GLOBALS);
  if (request === null) throw new Error(`The case does not resolve: ${c.name}`);
  const capped = <T>(make: () => T): T =>
    demand === undefined ? make() : withTestDemandAllowance(demand, make);
  const allowed = <T>(make: () => T): T =>
    mode.run(() =>
      allowance === undefined ? capped(make) : withTestAllowance(allowance, () => capped(make)),
    );
  // (outside the slice the analysis alone is judged; a compile the candidate route declines is marked, as no other's)
  const compiled = () => {
    if (!c.slice) return { diagnostics: [], plan: null };
    try {
      return compileSourceWithBackend(c.source, { globals: GLOBALS }, CORE_BACKEND);
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice)) throw error;
      const none = { diagnostics: [], plan: null };
      declined.add(none);
      return none;
    }
  };
  const both = () => ({ result: compiled(), answers: analyseCore(request) });
  // (a run under a demand allowance, a combined stop's reference or the stopped run, with its consumers' reads recorded:
  // its analysis alone, after the compile)
  const recorded = () => {
    const result = compiled();
    return { result, ...recordingReads(() => ({ answers: analyseCore(request) })) };
  };
  return {
    ...allowed(demand === undefined ? both : recorded),
    without: (omit) => allowed(() => withoutRecords(omit, both)),
  };
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

/** The stops a test visits of a case's settled stops (`heldStops`'s): each phase's sample (`sampled`). */
export function testedStops<T extends { readonly phase: string }>(stops: readonly T[]): T[] {
  const kept = new Set<T>();
  for (const phase of new Set(stops.map((stop) => stop.phase)))
    for (const stop of sampled(stops.filter((each) => each.phase === phase))) kept.add(stop);
  return stops.filter((stop) => kept.has(stop));
}

/**
 * The stops a test searches for one where something happens (`heldStops`'s): the capture's extraction (#1526 phase B)
 * sampled, as `testedStops`, every other phase whole.
 */
export function searchedStops<T extends { readonly phase: string }>(stops: readonly T[]): T[] {
  const kept = new Set(testedStops(stops.filter((stop) => stop.phase === "extraction")));
  return stops.filter((stop) => stop.phase !== "extraction" || kept.has(stop));
}

/**
 * The allowances a test searches in a settled phase from `low` to `high`, every `step`th: in the capture's extraction
 * sampled, as `searchedStops`.
 */
export function testedAllowances(phase: string, low: number, high: number, step = 1): number[] {
  const all: number[] = [];
  for (let allowance = low; allowance <= high; allowance += step) all.push(allowance);
  return phase === "extraction" ? sampled(all) : all;
}

/** A diagnostic's record: its code at its site (`code start:end`, as the problems name it). */
const recordOf = (d: { readonly code: string; readonly site: { start: number; end: number } }) =>
  `${d.code} ${d.site.start}:${d.site.end}`;

/** A site's identity: its file and offsets, never offsets alone. */
const siteKey = (site: {
  readonly file: number;
  readonly start: number;
  readonly end: number;
}): string => `${site.file}:${site.start}:${site.end}`;

/** A diagnostic's record by its code at its whole site. */
const recordKey = (d: { readonly code: string; readonly site: SourceSite }): string =>
  `${d.code} ${siteKey(d.site)}`;

/** Every value kind (`VALUE_KINDS`), `null` among them. */
const ALL_KINDS: readonly string[] = Object.keys(VALUE_KINDS);

/**
 * A check's accepted domain, the kinds it lets through, by its `against` alone (never its words): `unknown` every kind,
 * `non-null` every kind but `null`, else the kinds it names, a `number` with its whole numbers; as a sorted text.
 */
function domainOf(against: Obligation["against"]): ReadonlySet<string> {
  const kinds = new Set<string>();
  for (const kind of against)
    if (kind === "unknown") ALL_KINDS.forEach((each) => kinds.add(each));
    else if (kind === "non-null")
      ALL_KINDS.filter((each) => each !== "null").forEach((each) => kinds.add(each));
    else {
      kinds.add(kind);
      if (kind === "number") kinds.add("integer");
    }
  return kinds;
}

/** An empty check's accepted domain: non-emptiness, whatever family it names (the plan reads no `against` of it). */
const NON_EMPTY: ReadonlySet<string> = new Set(["non-empty"]);

/**
 * A check's accepted domain: an empty check's non-emptiness, the family it names its
 * label alone (its plan content, a member read's store requirement, reads no `against`: `runtimeChecks` in
 * `core/check-result/runtime-plan.ts`);
 * any other check's kinds by its `against` (`domainOf`).
 */
const domainOfCheck = (check: Obligation): ReadonlySet<string> =>
  check.kind === "empty-check" ? NON_EMPTY : domainOf(check.against);

/** What a check's domain is of: a value's emptiness, or its kinds; checks of one value compare within one. */
const dimensionOf = (check: Obligation): "emptiness" | "kinds" =>
  check.kind === "empty-check" ? "emptiness" : "kinds";

/** A domain as a text, for a comparison of sets. */
const domainText = (kinds: ReadonlySet<string>): string => [...kinds].sort().join("|");

/** The kinds two domains share: what two checks on one value let through together. */
const intersect = (a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> =>
  new Set([...a].filter((kind) => b.has(kind)));

/** A check's place: its whole site, its target and its boundary flag (every filter's, kind apart). */
const placeOf = (check: Obligation): string =>
  JSON.stringify([siteKey(check.site), check.target, check.boundary]);

/** A check's slot: its place and its kind; its accepted domain is compared apart. */
const slotOf = (check: Obligation): string => JSON.stringify([placeOf(check), check.kind]);

/** The domains of the checks at a slot, as one text (a set of sets). */
const domainsAt = (list: readonly Obligation[], slot: string): string =>
  JSON.stringify(
    [
      ...new Set(list.filter((x) => slotOf(x) === slot).map((x) => domainText(domainOfCheck(x)))),
    ].sort(),
  );

/** What a combined stop's rule accepts of the demand-only reference, each check and record with its clause. */
export interface CombinedStop {
  readonly checks: ReadonlyMap<string, "a" | "w" | "z">;
  /** Each accepted record by its code at its whole site (`code file:start:end`). */
  readonly records: ReadonlyMap<string, "a" | "w" | "z">;
  /**
   * The reference's checks the stop owes by a more precise label alone, as the natural analysis spells it
   * (`provenRelabel`, docs/specifications/type-inference-accepted-record.md#r4-322), and the records that go with them.
   */
  readonly relabelled: {
    readonly checks: ReadonlySet<string>;
    readonly records: ReadonlySet<string>;
  };
  /**
   * The reference's checks the stop owes in proof-derived words (`provenRewording`), each with the stopped
   * check that pairs with it (both by their JSON), and the records that go with them.
   */
  readonly reworded: {
    readonly pairs: ReadonlyMap<string, string>;
    readonly records: ReadonlySet<string>;
  };
  /** The stopped analysis's checks at the accepted slots, which the reference does not have. */
  readonly owing: ReadonlySet<string>;
  /**
   * The checks a candidate relabel needed whose label the recorder did not capture (`LabelIdentities.missing`): each
   * refused, never inferred; a finding wherever it is not empty.
   */
  readonly unidentified: ReadonlySet<string>;
  /**
   * The coarse (a) reading's counted class, never a pass
   * (docs/specifications/type-inference-accepted-record.md#r4-299): the reference's consumer checks (a) would take but
   * for open reads of their unit the stopped analysis did not answer, each with those reads' keys; and their records.
   */
  readonly coarse: {
    readonly checks: ReadonlyMap<string, readonly string[]>;
    readonly records: ReadonlySet<string>;
  };
}

/** Every expression of an analysis's program by its whole site, parentheses among them, with its parent expression. */
function syntaxOf(answers: Answers): {
  readonly at: ReadonlyMap<string, Expression>;
  readonly parent: ReadonlyMap<string, Expression>;
} {
  const at = new Map<string, Expression>();
  const parent = new Map<string, Expression>();
  for (const node of answers.graph.nodes) {
    const pending = node.expression === undefined ? [] : [node.expression];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const key = siteKey(siteOf(node.file, next));
      if (at.has(key)) continue;
      at.set(key, next);
      for (const child of expressionChildren(next)) {
        parent.set(siteKey(siteOf(node.file, child)), next);
        pending.push(child);
      }
    }
  }
  return { at, parent };
}

/** An expression's whole site. */
const siteOf = (file: number, expression: Expression): SourceSite => ({
  file,
  start: expression.span.start.offset,
  end: expression.span.end.offset,
});

/** A read's identity: its value's whole site and its steps. */
const readKey = (site: SourceSite, steps: readonly string[]): string =>
  `${siteKey(site)}|${steps.join("\u0000")}`;

/** Whether an answer holds a value a stop left undecided: an `unknown` item with the reason `budget`. */
const unsettled = (items: readonly Item[]): boolean =>
  items.some((item) => item.tag === "unknown" && (item.reasons & REASON.budget) !== 0);

/** The collection and record literals, whose values a store holding them holds. */
const LITERAL_KINDS = new Set(["listLiteral", "setLiteral", "dictLiteral", "objectLiteral"]);

/**
 * Whether the store whose value stands at `store` holds the value at `value`: that
 * value itself, or one its literals hold, through any parentheses (`unwrap`, which the lowering does not materialize),
 * each compared by its whole site.
 */
function holds(syntax: ReturnType<typeof syntaxOf>, store: SourceSite, value: SourceSite): boolean {
  const root = syntax.at.get(siteKey(store));
  const pending = root === undefined ? [] : [root];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const inner = unwrap(next);
    if (siteKey(siteOf(store.file, inner)) === siteKey(value)) return true;
    if (LITERAL_KINDS.has(inner.kind)) pending.push(...expressionChildren(inner));
  }
  return false;
}

/**
 * A consumer's read as `recordingReads` records it: its answer, whether the finishing walk made it, whether the consumer
 * left the value to its contract instead (`Consumers.skip`), and the walk's unit it was made in (`Consumers.runs`, by its
 * count, and by its stage and site, which name the unit in another analysis of the program).
 */
interface RecordedRead {
  readonly key: string;
  readonly items: readonly Item[];
  readonly finishing: boolean;
  /** A value the consumer left to its contract: its quiet path, which needs every contract it reads settled. */
  readonly skipped: boolean;
  readonly unit: number;
  readonly unitSite: string;
}

/** A warning a consumer emitted (`Consumers.rules`, which `warning` fills): its obligation and its walk's unit. */
interface Emission {
  readonly obligation: string;
  readonly unit: number;
}

/** A walk's recorded reads by read (`readKey`) and the warnings it emitted, in order. */
interface Recorded {
  readonly reads: ReadonlyMap<string, readonly RecordedRead[]>;
  readonly emissions: readonly Emission[];
  /** The labels the last walk made for the checks it emitted, with what places them (`labelIdentities`). */
  readonly labels?: RecordedLabels;
}

/**
 * A check's label as the compiler made it (#1595, the lead's ruling on Codex r6): its recipe's root, a place's own label
 * (`labelRoot`, `"path"`) or a value's own text (`ownLabel`, `"own"`), that place, and the steps its recipe takes below.
 */
export interface LabelIdentity {
  readonly kind: "path" | "own";
  readonly place: PlaceId;
  readonly steps: readonly string[];
}

/** A walk's labels as recorded (`recordingReads`): each emitted check's, by its text, and its program's places. */
interface RecordedLabels {
  readonly labelled: ReadonlyMap<string, LabelIdentity | null>;
  readonly program: CorePass["program"];
  readonly getOf: ReadonlyMap<PlaceId, PlaceId>;
  readonly resultOfCall: ReadonlyMap<PlaceId, PlaceId>;
}

/**
 * The reads an analysis's consumers made (`Consumers.valueItems`, their one read, unstopped or finishing), the values
 * they left to their contracts and the warnings they emitted: the last walk's, as it published the analysis's checks.
 */
const consumerReads = new WeakMap<object, Recorded>();

/** An analysis's recorded reads; a stopped analysis changed for a control (`Object.create`) has its original's. */
function readsOf(answers: Answers): Recorded | undefined {
  // (`Object.getPrototypeOf` gives an object or `null`)
  for (let at: object | null = answers; at !== null; at = Object.getPrototypeOf(at)) {
    const found = consumerReads.get(at);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Test-only, for a control: `shadow` (made from `answers` by `Object.create`) records `answers`' reads but those `change`
 * gives at the read of `site` with `steps`.
 */
export function withReadsChanged(
  answers: Answers,
  shadow: Answers,
  site: SourceSite,
  steps: readonly string[],
  change: (reads: readonly RecordedRead[]) => readonly RecordedRead[],
): Answers {
  const recorded = readsOf(answers);
  const reads = new Map(recorded?.reads ?? []);
  const key = readKey(site, steps);
  reads.set(key, change(reads.get(key) ?? []));
  consumerReads.set(shadow, { ...recorded, reads, emissions: recorded?.emissions ?? [] });
  return shadow;
}

/** `Consumers.rules` recording each warning its consumers emit. */
class EmissionsOf extends Map<CoreDiagnostic, number> {
  // (a plain field: `Map`'s constructor sets the entries before a subclass's fields exist)
  into: ((diagnostic: CoreDiagnostic) => void) | undefined;
  constructor(
    entries: Iterable<readonly [CoreDiagnostic, number]>,
    into: (d: CoreDiagnostic) => void,
  ) {
    super(entries);
    this.into = into;
  }
  override set(diagnostic: CoreDiagnostic, rule: number): this {
    this.into?.(diagnostic);
    return super.set(diagnostic, rule);
  }
}

/**
 * Runs `make`, an analysis under a demand allowance, recording each read its consumers make through
 * `Consumers.valueItems`, each value they leave to its contract (`Consumers.skip`) and each warning they emit
 * (`Consumers.rules`), each in its walk's unit (`Consumers.runs`, `Consumers.enter`). Each wrap is for the run alone,
 * restored in any case, and fails loudly where its method is not the one it expects.
 */
function recordingReads<T extends { readonly answers: Answers }>(make: () => T): T {
  const prototype = Consumers.prototype;
  const { valueItems, runs, enter, check, finish, skip } = prototype;
  if (
    typeof valueItems !== "function" ||
    valueItems.length !== 3 ||
    typeof runs !== "function" ||
    runs.length !== 1 ||
    typeof enter !== "function" ||
    enter.length !== 1 ||
    typeof check !== "function" ||
    typeof finish !== "function" ||
    typeof skip !== "function"
  )
    throw new Error(
      "Consumers.prototype is not the walk the recorder wraps (valueItems, runs, enter, check, finish, skip)",
    );
  interface Walk {
    readonly reads: Map<string, RecordedRead[]>;
    readonly emissions: Emission[];
    readonly labelled: Map<string, LabelIdentity | null>;
    unit: number;
    stage: string;
    unitSite: string;
  }
  const walks = new Map<Consumers, Walk>();
  const walkOf = (consumers: Consumers): Walk => {
    let walk = walks.get(consumers);
    if (walk === undefined)
      walks.set(
        consumers,
        (walk = {
          reads: new Map(),
          emissions: [],
          labelled: new Map(),
          unit: 0,
          stage: "",
          unitSite: "",
        }),
      );
    return walk;
  };
  // (each walk's warnings as `warning` and `error` record them, whatever map the walk began with, for the run alone)
  const maps: EmissionsOf[] = [];
  // (each check's label as the compiler made it, #1595, the lead's ruling on Codex r6: every recipe a place's label
  // roots (`Contract.labelRoots`) or a walk's label memo holds (`Consumers.labels`: a value's own text at its place), and
  // every recipe below them as it is made, keeps its text in place, observed as it is shown; a check takes the recipe
  // last shown with its target's text, where no recipe of another identity showed that text since the check before;
  // else no label, which the oracle refuses and counts. The maps and recipes stay the compiler's own objects, observed
  // through their own properties, so nothing the analysis computes changes.)
  let live = true;
  let shown = 0;
  let emittedAt = 0;
  const hooked = new WeakSet<object>();
  const rootPlaces = new WeakMap<Label, PlaceId>();
  const ownPlaces = new WeakMap<Label, PlaceId>();
  const touched = new Map<string, Map<Label, number>>();
  // (a recipe's own text slot, read without showing it; a recipe's text where it is shown, made or plain: its nearest
  // made text above it and its steps below, as `labelText` and `labelPlainText` join them, `pathText`)
  const slots = new WeakMap<Label, () => string | null>();
  const slotText = (recipe: Label): string | null => {
    const slot = slots.get(recipe);
    return slot === undefined ? recipe.text : slot();
  };
  const plain = (recipe: Label): string | null => {
    const parts: string[] = [];
    let at: Label | null = recipe;
    for (; at !== null && slotText(at) === null; at = at.parent) parts.push(at.step);
    const made = at === null ? null : slotText(at);
    return made === null ? null : pathText([made, ...parts.reverse()]);
  };
  const touch = (recipe: Label, text: string): void => {
    if (!live) return;
    let recipes = touched.get(text);
    if (recipes === undefined) touched.set(text, (recipes = new Map()));
    recipes.set(recipe, (shown += 1));
  };
  const onSet = <K, V>(map: Map<K, V>, each: (key: K, value: V) => void): void => {
    if (hooked.has(map)) return;
    hooked.add(map);
    for (const [key, value] of map) each(key, value);
    Object.defineProperty(map, "set", {
      configurable: true,
      writable: true,
      value(this: Map<K, V>, key: K, value: V) {
        if (live) each(key, value);
        return Map.prototype.set.call(this, key, value);
      },
    });
  };
  const onPush = (list: Obligation[], each: (check: Obligation) => void): void => {
    if (hooked.has(list)) return;
    hooked.add(list);
    Object.defineProperty(list, "push", {
      configurable: true,
      writable: true,
      value(this: Obligation[], ...checks: Obligation[]) {
        if (live) for (const check of checks) each(check);
        return Array.prototype.push.apply(this, checks);
      },
    });
  };
  const observe = (recipe: Label): void => {
    if (hooked.has(recipe)) return;
    hooked.add(recipe);
    let text = recipe.text;
    let below = recipe.below;
    slots.set(recipe, () => text);
    if (below !== null) onSet(below, (_, child) => observe(child));
    Object.defineProperties(recipe, {
      text: {
        configurable: true,
        enumerable: true,
        get: () => {
          const shownText = text ?? plain(recipe);
          if (shownText !== null) touch(recipe, shownText);
          return text;
        },
        set: (value: string | null) => {
          text = value;
          if (value !== null) touch(recipe, value);
        },
      },
      below: {
        configurable: true,
        enumerable: true,
        get: () => below,
        set: (value: Map<string, Label> | null) => {
          below = value;
          if (value !== null) onSet(value, (_, child) => observe(child));
        },
      },
    });
  };
  const identityOf = (recipe: Label): LabelIdentity | null => {
    const steps: string[] = [];
    let root = recipe;
    for (; root.parent !== null; root = root.parent) steps.push(root.step);
    steps.reverse();
    const path = rootPlaces.get(root);
    if (path !== undefined) return { kind: "path", place: path, steps };
    const own = ownPlaces.get(root);
    return own === undefined ? null : { kind: "own", place: own, steps };
  };
  const identityText = (identity: LabelIdentity | null | undefined): string =>
    JSON.stringify(identity ?? null);
  const emitted = (walk: Walk, check: Obligation): void => {
    const recipes = [...(touched.get(check.target) ?? [])].sort((a, b) => b[1] - a[1]);
    const since = new Set(
      recipes
        .filter(([, at]) => at > emittedAt)
        .map(([recipe]) => identityText(identityOf(recipe))),
    );
    const found = recipes[0] === undefined || since.size > 1 ? null : identityOf(recipes[0][0]);
    emittedAt = shown;
    const key = JSON.stringify(check);
    walk.labelled.set(
      key,
      walk.labelled.has(key) && identityText(walk.labelled.get(key)) !== identityText(found)
        ? null
        : found,
    );
  };
  const labelling = (consumers: Consumers): void => {
    const walk = walkOf(consumers);
    onSet(consumers.pass.contract.labelRoots, (place, recipe) => {
      rootPlaces.set(recipe, place);
      observe(recipe);
    });
    onSet(consumers.labels, (place, recipe) => {
      observe(recipe);
      if (recipe.parent === null && !rootPlaces.has(recipe) && !ownPlaces.has(recipe))
        ownPlaces.set(recipe, place);
    });
    const { admission } = consumers;
    onPush(admission.readChecks, (check) => emitted(walk, check));
    if (!hooked.has(admission.boundaries)) {
      for (const list of admission.boundaries.values())
        onPush(list, (check) => emitted(walk, check));
      onSet(admission.boundaries, (_, list) => {
        for (const check of list) emitted(walk, check);
        onPush(list, (check) => emitted(walk, check));
      });
    }
  };
  const recording = (consumers: Consumers): void => {
    labelling(consumers);
    if (consumers.rules instanceof EmissionsOf) return;
    const walk = walkOf(consumers);
    const map = new EmissionsOf(consumers.rules, (diagnostic) => {
      if ("obligation" in diagnostic) {
        walk.emissions.push({ obligation: JSON.stringify(diagnostic.obligation), unit: walk.unit });
        emitted(walk, diagnostic.obligation);
      }
    });
    maps.push(map);
    Object.defineProperty(consumers, "rules", {
      value: map,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  };
  prototype.check = function (this: Consumers) {
    recording(this);
    return check.call(this);
  };
  prototype.finish = function (this: Consumers, ...args: Parameters<Consumers["finish"]>) {
    recording(this);
    return finish.apply(this, args);
  };
  prototype.enter = function (this: Consumers, ...args: Parameters<Consumers["enter"]>) {
    labelling(this);
    const walk = walkOf(this);
    walk.unit += 1;
    walk.stage = String(args[0]);
    walk.unitSite = `stage ${walk.stage}`;
    return enter.apply(this, args);
  };
  prototype.runs = function (this: Consumers, ...args: Parameters<Consumers["runs"]>) {
    labelling(this);
    const walk = walkOf(this);
    walk.unit += 1;
    walk.unitSite = `stage ${walk.stage} ${siteKey(args[0])}`;
    return runs.apply(this, args);
  };
  const record = (
    consumers: Consumers,
    value: Parameters<Consumers["valueItems"]>[0],
    rest: readonly string[],
    items: readonly Item[],
    skipped: boolean,
  ): void => {
    const site = consumers.pass.program.places[value]?.site;
    if (site === null || site === undefined) return;
    const walk = walkOf(consumers);
    const key = readKey(site, rest);
    const read = {
      key,
      items,
      finishing: consumers.finishing,
      skipped,
      unit: walk.unit,
      unitSite: walk.unitSite,
    };
    const reads = walk.reads.get(key);
    if (reads === undefined) walk.reads.set(key, [read]);
    else reads.push(read);
  };
  prototype.valueItems = function (this: Consumers, ...args: Parameters<Consumers["valueItems"]>) {
    const items = valueItems.apply(this, args);
    const [value, , rest] = args;
    if (Array.isArray(rest)) record(this, value, rest, items, false);
    return items;
  };
  // (a value a consumer leaves to its contract, the quiet path; `skip`'s own rest parameter, as `Parameters` gives
  // `never` for a readonly rest array)
  prototype.skip = function (
    this: Consumers,
    ...values: readonly (Parameters<Consumers["valueItems"]>[0] | undefined)[]
  ) {
    for (const value of values) if (value !== undefined) record(this, value, [], [], true);
    skip.call(this, ...values);
  };
  try {
    const made = make();
    // (the analysis's last walk: a receiving completion pass's store checks, #1526 phase C, are none of its walks)
    const last = [...walks].filter(([consumers]) => !consumers.pass.closure).at(-1);
    consumerReads.set(made.answers, {
      ...(last?.[1] ?? { reads: new Map(), emissions: [] }),
      ...(last === undefined
        ? {}
        : {
            labels: {
              labelled: last[1].labelled,
              program: last[0].pass.program,
              getOf: last[0].getOf,
              resultOfCall: last[0].resultOfCall,
            },
          }),
    });
    return made;
  } finally {
    live = false;
    Object.assign(prototype, { valueItems, runs, enter, check, finish, skip });
    for (const map of maps) map.into = undefined;
  }
}

/** An analysis of a program's files with its reads recorded (`recordingReads`), for its label source. */
export function recordedAnalysis(files: readonly SourceFile[]): Answers {
  const request = coreRequest([...files], GLOBALS);
  if (request === null) throw new Error("The files do not resolve.");
  return recordingReads(() => ({ answers: analyseCore(request) })).answers;
}

/**
 * A combined stop's analyses of a program's files in a mode under a demand allowance, for an oracle's control: the
 * natural one (no demand, no stop), the demand-only reference with its consumers' reads recorded, and the stopped one at
 * a program allowance.
 */
export function combinedAnalyses(
  files: readonly SourceFile[],
  mode: HeldMode,
  demand: number,
): {
  readonly natural: Answers;
  readonly reference: Answers;
  readonly stoppedAt: (allowance: number) => Answers;
} {
  const request = coreRequest([...files], GLOBALS);
  if (request === null) throw new Error("The files do not resolve.");
  return {
    natural: mode.run(() => analyseCore(request)),
    reference: mode.run(() =>
      withTestDemandAllowance(demand, () =>
        recordingReads(() => ({ answers: analyseCore(request) })),
      ),
    ).answers,
    stoppedAt: (allowance) =>
      mode.run(() =>
        withTestAllowance(allowance, () =>
          withTestDemandAllowance(demand, () =>
            recordingReads(() => ({ answers: analyseCore(request) })),
          ),
        ),
      ).answers,
  };
}

/** A dictionary's derived lists (`dictList`): a read through one is named by its own text (`keyLabel`, §10.5). */
const DERIVED = new Set(["values", "keys"]);

/**
 * The written types a program declares, by the whole site (file and offsets) of the place that holds them, as the
 * compiler sites its places: a `let` or `global` statement, a parameter, a function's name for its result.
 */
const declaredTypes = new WeakMap<FlowGraph, ReadonlyMap<string, TypeAnnotation | null>>();
function declaredIn(graph: FlowGraph): ReadonlyMap<string, TypeAnnotation | null> {
  let types = declaredTypes.get(graph);
  if (types !== undefined) return types;
  const made = new Map<string, TypeAnnotation | null>();
  const at = (file: number, node: { readonly span: Expression["span"] }) =>
    siteKey({ file, start: node.span.start.offset, end: node.span.end.offset });
  for (const { file, statement } of graph.nodes)
    if (statement?.kind === "letStatement" || statement?.kind === "globalStatement")
      made.set(at(file, statement), statement.typeAnnotation);
  for (const region of graph.regions)
    if (region.kind === "function") {
      const { declaration, file } = region;
      made.set(at(file, declaration.name), declaration.returnTypeAnnotation);
      for (const parameter of declaration.parameters)
        made.set(at(file, parameter), parameter.typeAnnotation);
    }
  declaredTypes.set(graph, (types = made));
  return types;
}

/**
 * An analysis's labels as the compiler made them (`recordingReads`): each emitted check's (`of`, `null` where none was
 * recorded, which the oracle refuses and counts in `missing`), its program's places and the path its projections give a
 * place up to its root (`climb`: `keyLabel`'s walk, its element steps spelled `element`).
 */
export interface LabelIdentities {
  readonly of: (check: Obligation) => LabelIdentity | null;
  readonly site: (place: PlaceId) => SourceSite | null;
  readonly climb: (
    place: PlaceId,
  ) => { readonly root: PlaceId; readonly steps: readonly string[] } | null;
  readonly missing: Set<string>;
  /** The number of the program's places (ids `0` to it). */
  readonly places: number;
}

/**
 * Test-only: `labels` with the given checks' labels (`LabelIdentity`) in place of the recorded ones, for a unit case of
 * the predicate on a label the compiler never made.
 */
export function withLabels(
  labels: LabelIdentities,
  given: readonly (readonly [Obligation, LabelIdentity])[],
): LabelIdentities {
  const set = new Map(given.map(([check, identity]) => [JSON.stringify(check), identity]));
  return { ...labels, of: (check) => set.get(JSON.stringify(check)) ?? labels.of(check) };
}

/** An analysis's recorded labels (`LabelIdentities`), `null` where it was made without them. */
export function labelIdentities(answers: Answers): LabelIdentities | null {
  const labels = readsOf(answers)?.labels;
  if (labels === undefined) return null;
  const { labelled, program, getOf, resultOfCall } = labels;
  const missing = new Set<string>();
  return {
    of: (check) => {
      const text = JSON.stringify(check);
      const found = labelled.get(text) ?? null;
      if (found === null) missing.add(text);
      return found;
    },
    site: (place) => program.places[place]?.site ?? null,
    climb: (place) => {
      const steps: string[] = [];
      let at = place;
      for (let depth = 0; depth < 256; depth += 1) {
        const binding = program.occurrenceOf.get(at);
        if (binding !== undefined) return { root: binding, steps: steps.reverse() };
        const owner = getOf.get(at);
        const projection: { readonly owner: PlaceId; readonly step: string } | undefined =
          program.projOf.get(at) ?? (owner === undefined ? undefined : { owner, step: "index" });
        if (projection === undefined) {
          const result = resultOfCall.get(at);
          return result === undefined ? null : { root: result, steps: steps.reverse() };
        }
        steps.push(
          stepName(projection.step) === "element" && projection.step !== "element"
            ? "element"
            : propertyName(projection.step),
        );
        at = projection.owner;
      }
      return null;
    },
    missing,
    places: program.places.length,
  };
}

/**
 * The precise label forms a stopped check carries where the demand-only reference spells the generic one (#1595),
 * compared as the compiler made both labels (`LabelIdentity`), never read back from a site, an expression
 * or a name (the lead's ruling on Codex r6). The compiler's label grammar (`keyLabel` in `consumers/names.ts`):
 * - a root: a place's label, a binding's name, a parameter `F.P`, a result `F.result`; else the value's own text;
 * - each step below it: a property's name; a selection, an index or a `get`, spelled `element`, or `entry` where every
 *   kind of its owner is a dictionary (`elementStepOf`); a dictionary's `values` or `keys`;
 * - and where the chain passes a `values` or `keys` step with a dictionary among its owner's kinds (`derivedChain`), the
 *   whole label is the value's own text instead (`ownLabel`).
 * After a stop the stopped analysis may prove more of an owner's kinds than the reference (`labelDomain`), which gives
 * exactly two precise forms of the reference's path label, never mixed:
 * - `"entry"`: the same root place and some `element` steps below it spelled `entry`, every other step the same;
 * - `"own"`: a place's own text with no step below it, the place whose path up the compiler's projections (`climb`) is
 *   the reference's, root and steps, with at least one `values` or `keys` step.
 * The form of the stopped label `x` beside the reference's `u`, else `null`. A place is one in both runs where its id
 * and its whole site are.
 */
function relabelForm(
  u: LabelIdentity,
  x: LabelIdentity,
  reference: LabelIdentities,
  stopped: LabelIdentities,
): "entry" | "own" | null {
  if (u.kind !== "path") return null;
  const same = (place: PlaceId): boolean => {
    const [a, b] = [reference.site(u.place), stopped.site(place)];
    return place === u.place && a !== null && b !== null && siteKey(a) === siteKey(b);
  };
  // (an element step the reference spells `entry` already, as a reference that read part of its key settled does)
  const spells = (path: readonly string[], each: readonly string[]): boolean =>
    path.length === each.length &&
    path.every((step, i) => step === each[i] || (step === "element" && each[i] === "entry"));
  if (x.kind === "path")
    return same(x.place) &&
      spells(u.steps, x.steps) &&
      u.steps.some((step, i) => step !== x.steps[i])
      ? "entry"
      : null;
  const path = x.steps.length === 0 ? stopped.climb(x.place) : null;
  return path !== null &&
    same(path.root) &&
    spells(path.steps, u.steps) &&
    u.steps.some((step) => DERIVED.has(step))
    ? "own"
    : null;
}

/** A written type's members, an optional's `null` and a union's own members each one (`T?`, `A | B`). */
const membersOf = (type: TypeAnnotation): (TypeAnnotation | null)[] =>
  type.kind === "optionalType"
    ? [...membersOf(type.value), null]
    : type.kind === "unionType"
      ? type.members.flatMap(membersOf)
      : [type];

/** Whether every value a written type's members admit is a dictionary (`dict`, `T dict`): never with a `null` among them. */
const writtenDict = (members: readonly (TypeAnnotation | null)[]): boolean =>
  members.length > 0 &&
  members.every(
    (type) =>
      type !== null &&
      (type.kind === "dictType" || (type.kind === "namedType" && type.name === "dict")),
  );

/** Whether some value a written type's members admit is a dictionary: a derived list's owner (`derivedChain`). */
const writtenSomeDict = (members: readonly (TypeAnnotation | null)[]): boolean =>
  members.some(
    (type) =>
      type !== null &&
      (type.kind === "dictType" || (type.kind === "namedType" && type.name === "dict")),
  );

/**
 * A written type's members one `element` step down, as the compiler's `termAt` takes one (`typeAtStep`): each member's
 * element where it has one, the others left out (`null`, a scalar); none where no member has one.
 */
const elementsOf = (members: readonly (TypeAnnotation | null)[]): (TypeAnnotation | null)[] =>
  members.flatMap((type) =>
    type !== null &&
    (type.kind === "listType" || type.kind === "setType" || type.kind === "dictType")
      ? membersOf(type.element)
      : [],
  );

/**
 * Whether a written type at the key proves `x`'s form (#1595, the lead's ruling on Q4: the author's own proof, as the
 * compiler reads it). The root's written type (`written`: the declaration at the reference label's root place's whole site)
 * is followed along `u`'s steps below the root, element steps (an `entry` it already spells among them) through its
 * elements, optionals and unions as `termAt` follows them; a step it cannot follow proves nothing past it. `x` is the
 * stopped label's steps below the root (none for own text). One clause per form:
 * - `"entry"`: every step `x` spells `entry` has a written dictionary as its owner, every kind of it
 *   (`elementStepOf`), and no `values` or `keys` step on the way has a dictionary among its owner's kinds, where the
 *   compiler names the value by its own text instead (`derivedChain`);
 * - `"own"`: a `values` or `keys` step on the way has a dictionary among its owner's written kinds (`derivedChain`).
 */
function writtenProves(
  written: TypeAnnotation | null,
  u: readonly string[],
  x: readonly string[],
  form: "entry" | "own",
): boolean {
  if (written === null) return false;
  let members = membersOf(written);
  // (the last step `x` spells `entry`: past it a step the type cannot follow leaves nothing to prove)
  const last = Math.max(...u.flatMap((step, i) => (form === "entry" && step !== x[i] ? [i] : [])));
  for (let at = 0; at < u.length; at += 1) {
    const step = u[at]!;
    if (form === "entry" && x[at] === "entry" && !writtenDict(members)) return false;
    // (a derived list: its own text, never an `entry` path, the two forms exclusive as `keyLabel` makes them)
    if (DERIVED.has(step) && writtenSomeDict(members)) return form === "own";
    // (an element step, the reference's own `entry` among them: an element spelled as its dictionary's already)
    if (step !== "element" && step !== "entry") return form === "entry" && at > last;
    members = elementsOf(members);
  }
  return form === "entry";
}

/**
 * The owner's one accepted difference at a combined stop (docs/specifications/type-inference-accepted-record.md#r4-322,
 * #1595, the lead's rulings on its HEAD 0 and on Q3/Q4): the stopped analysis owes the reference's check `u` under a
 * more precise label than the reference's, which ran out of demand reading the key, where all three hold for the
 * stopped check `x`:
 * 1. the label follows from a proven type: the natural analysis (no demand, no stop) names that very value so, a check of
 *    its own at `x`'s whole site, the value read there, targeting the label or a path below it (it need not owe `x`
 *    itself: knowing more, it may owe another check there; the value, never a label's text alone nor a read beside it
 *    in the same walk unit: Codex r1's and r2's B1 on #1687), or a written type at the key proves its form
 *    (`writtenProves`, the written type the reference label's root place declares);
 * 2. the check, its location and its expected types are identical: kind, whole site, boundary and `against`;
 * 3. no other difference is ignored: the label is one of the compiler's two precise forms of the reference's
 *    (`relabelForm`), the words are `u`'s with only the label replaced, and every other part is equal.
 * Both labels are the compiler's own as recorded (`labelIdentities`: `reference` the reference's, `stopped` the stopped
 * analysis's): a check of these whose label was not recorded is refused and counted (`LabelIdentities.missing`), never
 * read back from its site, its expression or a name. The stopped check accepted, else `undefined`. `natural` is the
 * natural analysis's checks; `graph` the program's.
 */
export function provenRelabel(
  u: Obligation,
  owed: readonly Obligation[],
  natural: readonly Obligation[],
  graph: FlowGraph,
  reference: LabelIdentities | null,
  stopped: LabelIdentities | null,
): Obligation | undefined {
  return owed.find((x) => {
    if (
      x.target === u.target ||
      // (2)
      x.kind !== u.kind ||
      siteKey(x.site) !== siteKey(u.site) ||
      x.boundary !== u.boundary ||
      JSON.stringify(x.against) !== JSON.stringify(u.against) ||
      // (3) (beside (2)'s parts, every other part equal: the words with only the label replaced)
      x.on !== u.on.split(u.target).join(x.target) ||
      JSON.stringify({
        ...u,
        kind: x.kind,
        site: x.site,
        boundary: x.boundary,
        against: x.against,
        target: x.target,
        on: x.on,
      }) !== JSON.stringify(x) ||
      reference === null ||
      stopped === null
    )
      return false;
    // (3)'s form, of the two labels as the compiler made them
    const [from, to] = [reference.of(u), stopped.of(x)];
    if (from === null || to === null) return false;
    // (1)
    return labelProved(x, from, to, natural, graph, reference, stopped);
  });
}

/**
 * Proof of a more precise label (`provenRelabel`'s condition (1), #1595): the stopped label is one of the
 * compiler's two precise forms of the reference's (`relabelForm`), and the natural analysis names that very value so
 * (a check of its own at `x`'s whole site targeting the label or below it), or the written type at the reference
 * label's root proves its form (`writtenProves`).
 */
function labelProved(
  x: Obligation,
  from: LabelIdentity,
  to: LabelIdentity,
  natural: readonly Obligation[],
  graph: FlowGraph,
  reference: LabelIdentities,
  stopped: LabelIdentities,
): boolean {
  const form = relabelForm(from, to, reference, stopped);
  if (form === null) return false;
  const site = reference.site(from.place);
  return (
    natural.some(
      (n) =>
        siteKey(n.site) === siteKey(x.site) &&
        (n.target === x.target ||
          n.target.startsWith(`${x.target}.`) ||
          n.target.startsWith(`${x.target}[`)),
    ) ||
    writtenProves(
      site === null ? null : (declaredIn(graph).get(siteKey(site)) ?? null),
      from.steps,
      to.kind === "path" ? to.steps : [],
      form,
    )
  );
}

/**
 * #1708, A′: the 17 diagnostic rule variants (`DiagnosticRule`) and, for each, whether its consumer
 * builds the obligation's words from the kinds it read. Only `member`'s does (`memberChecks`: a lacking kind `has`, an
 * unknown the method table's takers, a null `is not null`); every other variant's words are its rule's and label's,
 * compared exactly. A variant missing from this table is refused. `tests/type-core-stop.test.ts` holds the table to the
 * consumers (its kind-reading sites, the drift guard).
 */
export const SENTENCE_VARIANTS: Readonly<Record<string, "memberChecks" | null>> = {
  member: "memberChecks",
  absent: null,
  count: null,
  boolean: null,
  key: null,
  iterable: null,
  operator: null,
  argument: null,
  elements: null,
  shown: null,
  json: null,
  store: null,
  fallback: null,
  choice: null,
  mixed: null,
  "mixed-choice": null,
  selection: null,
};

/**
 * Which kinds have a `member` rule's member, as its consumer asks (`memberChecks`' `takes`): a call's method
 * (`hasMethod`); a store's added method, its element store a list or a dict, its property store an object; a read's
 * property an object's, else `hasProperty`; `null` for any other form, which refuses.
 */
function memberTakes(
  rule: Extract<DiagnosticRule, { rule: "member" }>,
): ((kind: ItemTag) => boolean) | null {
  const method = /^\.(\w+)\(\)$/.exec(rule.member)?.[1];
  const property = /^\.(\w+)$/.exec(rule.member)?.[1];
  if (rule.use === "call") return method === undefined ? null : (kind) => hasMethod(kind, method);
  if (rule.use === "store") {
    if (method !== undefined) return (kind) => hasMethod(kind, method);
    if (rule.member === "[i]") return (kind) => kind === "list" || kind === "dict";
    return property === undefined ? null : (kind) => kind === "object";
  }
  return property === undefined ? null : (kind) => kind === "object" || hasProperty(kind, property);
}

/**
 * Condition (3)'s derived record (the lead's ruling on #1708's decision note): the fields a consumer
 * derives from the read it made, each as the proven kinds and the leaf proof imply it, never free to differ; every
 * other field the reference record's own. `null` where a field cannot be derived (a variant without its entry), which
 * refuses.
 * - `kinds`: the proven kinds (condition (1));
 * - `fits`: for a `member`, the kinds that have its member (`memberTakes`, each form's) or a reference's runtime
 *   members, as `memberChecks` lets through (`having`, `warning`'s `fits`); any other variant's the reference's;
 * - `besides`: a stopped mark's none (the published answers' `withBesides` gives a published warning's), a published
 *   warning's from its answers' other diagnostics at its site and rule;
 * - `present`, `keeps`: none where the stopped analysis stopped (no fact is asked after a stop, `withFacts`), else the
 *   reference's;
 * - `provenance`: its writers the reference's; the written read's word (`unknown`, not direct, the detail's other parts
 *   the reference's), the leaf proof the route a written read takes.
 */
function derivedRecord(
  ru: Extract<CoreDiagnostic, { readonly obligation: unknown }>,
  kinds: readonly ItemTag[],
  stopped: Answers,
  mark: boolean,
): string | null {
  const rule = ru.rule;
  const concrete = (kind: ItemTag): boolean =>
    kind !== "null" && kind !== "unknown" && kind !== "empty";
  let fits: readonly ItemTag[] = ru.fits;
  if (rule.rule === "member") {
    const takes = memberTakes(rule);
    if (takes === null) return null;
    fits = kindsInOrder(
      kinds.filter((kind) => concrete(kind) && (REFERENCE.has(kind) || takes(kind))),
    );
  }
  const siteText = siteKey(ru.site);
  const reported = new Set<ItemTag>();
  if (!mark)
    for (const d of stopped.diagnostics)
      if (
        d.kind !== "budget" &&
        "rule" in d &&
        siteKey(d.site) === siteText &&
        d.rule.rule === rule.rule
      )
        for (const kind of d.kinds) reported.add(kind);
  const besides = kindsInOrder(
    [...reported].filter((kind) => concrete(kind) && !kinds.includes(kind)),
  );
  const { provenance } = ru;
  const { obligation: _obligation, present: _present, keeps: _keeps, ...rest } = ru;
  // (no fact is asked after a stop: `present` and `keeps` the reference's only where the stopped analysis ran to its end)
  const facts =
    stopped.budget.stoppedIn !== null
      ? {}
      : {
          ...(ru.present === undefined ? {} : { present: ru.present }),
          ...(ru.keeps === undefined ? {} : { keeps: ru.keeps }),
        };
  return canonical({
    ...rest,
    ...facts,
    kinds,
    fits,
    besides,
    provenance: {
      writers: provenance.writers,
      context: "unknown",
      detail: { ...provenance.detail, direct: false },
    },
  });
}

/**
 * The words `memberChecks` gives a member's check for one kind, as its consumer builds them (`receivers.ts`): the member
 * as its use writes it (`what`: a call's and a read's member, a store's added method, `an element store`, `a store of
 * .p`), then `is not null` for a null, `has <what>` for a kind that lacks the member, `is <the kinds that have it> with
 * <what>` for an unknown (`MEMBER_KINDS` that take it, `described`), each `before the <use>`; `null` for a form or kind
 * the table does not reconstruct, which refuses.
 */
function memberWords(
  rule: Extract<DiagnosticRule, { rule: "member" }>,
  kind: ItemTag,
): string | null {
  const takes = memberTakes(rule);
  if (takes === null) return null;
  const property = /^\.(\w+)$/.exec(rule.member)?.[1];
  const what =
    rule.use !== "store"
      ? rule.member.startsWith(".")
        ? rule.member
        : null
      : rule.member.endsWith("()")
        ? rule.member
        : rule.member === "[i]"
          ? "an element store"
          : property === undefined
            ? null
            : `a store of .${property}`;
  if (what === null) return null;
  const ending = ` before the ${rule.use}`;
  if (kind === "null") return `is not null${ending}`;
  if (kind === "unknown") {
    const takers = MEMBER_KINDS.filter((each) => takes(each));
    return `is ${takers.length === 0 ? "a value" : described(takers)} with ${what}${ending}`;
  }
  if (kind === "empty" || REFERENCE.has(kind) || takes(kind)) return null;
  return `has ${what}${ending}`;
}

/** Whether a `member` check's words are exactly those its own record's one kind gives (`memberWords`). */
function memberSentence(
  check: Obligation,
  rule: Extract<DiagnosticRule, { rule: "member" }>,
  kinds: readonly ItemTag[],
): boolean {
  if (kinds.length !== 1) return false;
  const words = memberWords(rule, kinds[0]!);
  return words !== null && check.on === `check that ${check.target} ${words}`;
}

/** A written type's members as kinds (`integer`, `list`, …; `null` for an optional's), `null` where one names none. */
function writtenKinds(members: readonly (TypeAnnotation | null)[]): ReadonlySet<string> | null {
  const kinds = new Set<string>();
  for (const type of members)
    if (type === null) kinds.add("null");
    else if (type.kind === "namedType") kinds.add(type.name);
    else if (type.kind === "listType") kinds.add("list");
    else if (type.kind === "setType") kinds.add("set");
    else if (type.kind === "dictType") kinds.add("dict");
    else return null;
  return kinds;
}

/**
 * Condition (1)'s strict leaf proof: the kinds a written declaration gives the stopped check's label, the
 * declaration at its root's recorded place followed through every step of its recorded label to the leaf (element and
 * `entry` steps through the element types, optionals and unions as `termAt` follows them); `null` where a step cannot be
 * followed, the root declares no type, or the label was not recorded. Never read from a name, a site nearby or a text.
 */
function leafKinds(
  graph: FlowGraph,
  labels: LabelIdentities,
  check: Obligation,
): ReadonlySet<string> | null {
  const identity = labels.of(check);
  if (identity === null || identity.kind !== "path") return null;
  const site = labels.site(identity.place);
  const written = site === null ? null : (declaredIn(graph).get(siteKey(site)) ?? null);
  if (written === null) return null;
  let members = membersOf(written);
  for (const step of identity.steps) {
    if (step !== "element" && step !== "entry") return null;
    // (an `entry` is a dictionary's value: a step the written type does not make so proves nothing)
    if (step === "entry" && !writtenDict(members)) return null;
    members = elementsOf(members);
    if (members.length === 0) return null;
  }
  return writtenKinds(members);
}

/** A record's JSON with its objects' keys in order, so two records compare by their fields, not the order they were made. */
const canonical = <T extends { readonly code: string }>(value: T): string =>
  JSON.stringify(value, (_key, each: unknown) =>
    typeof each === "object" && each !== null && !Array.isArray(each)
      ? Object.fromEntries(Object.entries(each).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : each,
  );

/** Whether two kind lists name the same kinds, `null` and the empty marker apart. */
const sameKinds = (kinds: readonly string[], domain: ReadonlySet<string>): boolean => {
  const own = new Set(kinds.filter((kind) => kind !== "null" && kind !== "empty"));
  const written = [...domain].filter((kind) => kind !== "null");
  return own.size === written.length && written.every((kind) => own.has(kind));
};

/**
 * The owner's extension to sentence parts (#1708, A′): the stopped analysis owes the reference's
 * check `u` in words derived from a proven type where all three hold for the stopped check `x`:
 * 1. the stopped record's kinds rest on independently proven type information: the written leaf domain of its label
 *    (`leafKinds`), or a settled read of the same key in the unit that emitted it (never a finishing read, never
 *    `budget`), the very kinds;
 * 2. the check, its location and its expected types are identical: kind, whole site, boundary and `against`;
 * 3. no other difference hides: the two records (the compiler's own, each owning its check) are equal in every field but
 *    their kinds and obligations; the words are `u`'s with only the label replaced, or, for a variant whose consumer
 *    builds its words from the kinds (`SENTENCE_VARIANTS`), each the sentence its own record's kinds select; a variant
 *    missing from the table is refused; the labels are recorded, `x`'s the one `u`'s relabel accepts (`relabelForm`) or
 *    the same.
 * The stopped check paired, else `undefined`.
 */
export function provenRewording(
  u: Obligation,
  owed: readonly Obligation[],
  reference: Answers,
  stopped: Answers,
  referenceLabels: LabelIdentities | null,
  stoppedLabels: LabelIdentities | null,
  natural: readonly Obligation[],
): Obligation | undefined {
  if (referenceLabels === null || stoppedLabels === null) return undefined;
  const recordOf = (answers: Answers, check: Obligation) => {
    const text = JSON.stringify(check);
    const found = [...answers.diagnostics, ...answers.budget.deferred].filter(
      (d): d is Extract<CoreDiagnostic, { readonly obligation: unknown }> =>
        "obligation" in d && JSON.stringify(d.obligation) === text,
    );
    // (one record, or the same record twice, as a stopped walk may make it)
    return found.length > 0 && found.every((d) => JSON.stringify(d) === JSON.stringify(found[0]))
      ? found[0]!
      : undefined;
  };
  const ru = recordOf(reference, u);
  if (ru === undefined || !("rule" in ru) || !("kinds" in ru)) return undefined;
  const variant = SENTENCE_VARIANTS[ru.rule.rule];
  if (variant === undefined) return undefined;
  return owed.find((x) => {
    // (2)
    if (
      x.kind !== u.kind ||
      siteKey(x.site) !== siteKey(u.site) ||
      x.boundary !== u.boundary ||
      JSON.stringify(x.against) !== JSON.stringify(u.against)
    )
      return false;
    const rx = recordOf(stopped, x);
    if (rx === undefined || !("rule" in rx) || !("kinds" in rx)) return false;
    if (JSON.stringify(ru.kinds) === JSON.stringify(rx.kinds)) return false;
    // (3): the labels as recorded, the same or the relabel #1687 proves; the words
    const [from, to] = [referenceLabels.of(u), stoppedLabels.of(x)];
    if (from === null || to === null) return false;
    // (a changed label carries its own proof, whatever the words: Codex r1's B2 on #1759)
    if (
      x.target !== u.target &&
      !labelProved(x, from, to, natural, reference.graph, referenceLabels, stoppedLabels)
    )
      return false;
    if (variant === null) {
      if (x.on !== u.on.split(u.target).join(x.target)) return false;
    } else if (
      ru.rule.rule !== "member" ||
      !memberSentence(u, ru.rule, ru.kinds) ||
      !memberSentence(x, ru.rule, rx.kinds)
    )
      return false;
    // (1): the declaration followed to the leaf (the strict leaf proof; a settled read of the same key is the ruling's
    // other route, which this oracle does not take: Codex r1's B1 and B4 on #1759), and (3): the stopped record as the
    // proven kinds derive it
    const leaf = leafKinds(stopped.graph, stoppedLabels, x);
    if (leaf === null || !sameKinds(rx.kinds, leaf)) return false;
    const mark = stopped.budget.deferred.some((each) => each === rx);
    const derived = derivedRecord(ru, rx.kinds, stopped, mark);
    if (derived === null) return false;
    const { obligation: _x, ...actual } = rx;
    return derived === canonical(actual);
  });
}

/**
 * A combined stop's rule (S8 and its inventory). The demand-only run is the reference, recorded with
 * its consumers' reads (`recordingReads`); each of its checks the stopped analysis neither keeps nor marks is accepted only
 * by one clause, every site whole (file and offsets), a slot a site, target, boundary and kind, a domain the kinds a check
 * lets through (`domainOf`):
 * - (a) a consumer's check, never a store's, whose reference unit (the walk's unit that emitted it) read something
 *   `unknown` with the reason `budget` (a recovered contract tagged `budget` is no such read), each such read answered at
 *   its key by the stopped analysis's last run of that unit (its finishing walk's where that ran it again): read there
 *   again, every such read settled, or left to its contract (`Consumers.skip`, the quiet path, which needs every contract
 *   it reads settled); and at whose slot the natural analysis (no demand, no stop) and the stopped one owe the same
 *   domains, the natural one not the check itself. The coarse reading: a finer one, by the consumer
 *   invocation that emitted the check, has no entry to hook, as the consumers are module functions no test can replace
 *   and a call stack names no call; where (a) is denied only by such a read, the check is the counted class (`coarse`);
 * - (w) marks at its place (site, target, boundary), of any kind, the only checks owed there, together letting through
 *   exactly its domain (their domains' intersection: checks on one value): the reference satisfied in other words;
 * - (z) a boundary against `unknown`, no plan content (S3 §4), nothing owed at its slot, where an undecided store record
 *   stands at the site of a store whose value holds the boundary's value (`holds`).
 * A record goes with its obligations, never one the natural analysis reports itself. A check the stop owes by a more
 * precise label alone, the natural analysis's, is accepted (`provenRelabel`,
 * docs/specifications/type-inference-accepted-record.md#r4-322).
 */
export function combinedStop(reference: Answers, natural: Answers, stopped: Answers): CombinedStop {
  const [reads, finished] = [readsOf(reference), readsOf(stopped)];
  if (reads === undefined || finished === undefined)
    throw new Error(
      "A combined stop's reference and stopped analysis must be made with their reads recorded (`recordingReads`).",
    );
  const marks = stopped.budget.deferred;
  const markChecks = new Set(marks.map((mark) => JSON.stringify(mark.obligation)));
  const owed = [...stopped.checks, ...marks.map((mark) => mark.obligation)];
  const owedTexts = new Set(owed.map((check) => JSON.stringify(check)));
  const naturalTexts = new Set(natural.checks.map((check) => JSON.stringify(check)));
  const [referenceLabels, stoppedLabels] = [labelIdentities(reference), labelIdentities(stopped)];
  let parsed: ReturnType<typeof syntaxOf> | undefined;
  const syntax = (): ReturnType<typeof syntaxOf> => (parsed ??= syntaxOf(reference));
  const classOf = (u: Obligation): "a" | "w" | "z" | "relabelled" | readonly string[] | null => {
    const text = JSON.stringify(u);
    if (owedTexts.has(text)) return null;
    // (the open reads of its unit that leave it to the coarse class, where no clause takes it)
    let unanswered: readonly string[] | null = null;
    const slot = slotOf(u);
    if (!naturalTexts.has(text) && domainsAt(natural.checks, slot) === domainsAt(owed, slot)) {
      const owner = reference.diagnostics.find(
        (d) => "obligation" in d && JSON.stringify(d.obligation) === text,
      );
      if (owner !== undefined && "rule" in owner && owner.rule.rule !== "store") {
        // (every read of the reference's unit that emitted the check got `unknown` with the reason `budget` open; the
        // stopped analysis's last run of a unit of that stage and site, its finishing walk's where that ran it again,
        // answering each at its key: read again, every such read settled, or left to its contract)
        const units = new Set(
          reads.emissions.filter((emission) => emission.obligation === text).map((e) => e.unit),
        );
        const open = [...reads.reads.values()]
          .flat()
          .filter((read) => units.has(read.unit) && unsettled(read.items));
        const answered = (read: RecordedRead): boolean => {
          const run = [...finished.reads.values()]
            .flat()
            .filter((each) => each.unitSite === read.unitSite);
          const finishing = run.some((each) => each.finishing);
          const there = run.filter((each) => each.finishing === finishing && each.key === read.key);
          return (
            there.length > 0 &&
            there.filter((each) => !each.skipped).every((each) => !unsettled(each.items))
          );
        };
        const left = [...new Set(open.filter((read) => !answered(read)).map((read) => read.key))];
        if (open.length > 0 && left.length === 0) return "a";
        if (left.length > 0) unanswered = left;
      }
    }
    // ((w): every check owed at the place a mark; those of the check's dimension letting through its domain together)
    const there = owed.filter((x) => placeOf(x) === placeOf(u));
    const here = there.filter((x) => dimensionOf(x) === dimensionOf(u));
    if (
      here.length > 0 &&
      there.every((x) => markChecks.has(JSON.stringify(x))) &&
      domainText(here.map(domainOfCheck).reduce(intersect)) === domainText(domainOfCheck(u))
    )
      return "w";
    if (
      u.boundary &&
      u.against.length === 1 &&
      u.against[0] === "unknown" &&
      domainsAt(owed, slot) === "[]" &&
      [...stopped.diagnostics, ...marks].some(
        (d) =>
          "rule" in d &&
          d.rule.rule === "store" &&
          "obligation" in d &&
          d.obligation.against.length === 1 &&
          d.obligation.against[0] === "unknown" &&
          d.site.file === u.site.file &&
          holds(syntax(), d.site, u.site),
      )
    )
      return "z";
    return provenRelabel(
      u,
      owed,
      natural.checks,
      reference.graph,
      referenceLabels,
      stoppedLabels,
    ) === undefined
      ? unanswered
      : "relabelled";
  };
  // (each reference check the stop does not owe as it is, paired with a stopped check in proof-derived
  // words where one is, whatever clause takes it: the pair stands for one check on both sides of the inventory)
  const pairs = new Map<string, string>();
  for (const u of reference.checks) {
    const text = JSON.stringify(u);
    if (owedTexts.has(text)) continue;
    const x = provenRewording(
      u,
      owed,
      reference,
      stopped,
      referenceLabels,
      stoppedLabels,
      natural.checks,
    );
    if (x !== undefined) pairs.set(text, JSON.stringify(x));
  }
  const checks = new Map<string, "a" | "w" | "z">();
  const coarse = { checks: new Map<string, readonly string[]>(), records: new Set<string>() };
  const relabelled = { checks: new Set<string>(), records: new Set<string>() };
  const owing = new Set<string>();
  for (const u of reference.checks) {
    const found = classOf(u);
    if (found === null) continue;
    const text = JSON.stringify(u);
    if (pairs.has(text) && typeof found !== "string") continue;
    if (found === "relabelled") relabelled.checks.add(text);
    else if (typeof found !== "string") coarse.checks.set(text, found);
    else {
      checks.set(text, found);
      for (const x of owed) if (slotOf(x) === slotOf(u)) owing.add(JSON.stringify(x));
    }
  }
  const records = new Map<string, "a" | "w" | "z">();
  const rewordedRecords = new Set<string>();
  const kept = new Set([...stopped.diagnostics, ...marks].map(recordKey));
  const naturalRecords = new Set(natural.diagnostics.map(recordKey));
  for (const d of reference.diagnostics) {
    const record = recordKey(d);
    if (d.kind === "budget" || kept.has(record) || naturalRecords.has(record)) continue;
    const each = reference.diagnostics
      .filter((x) => x.kind !== "budget" && recordKey(x) === record)
      .map((x) => ("obligation" in x ? JSON.stringify(x.obligation) : null));
    if (each.some((text) => text === null)) continue;
    if (
      each.every((text) => checks.has(text!) || owedTexts.has(text!)) &&
      each.some((text) => checks.has(text!))
    )
      records.set(record, checks.get(each.find((text) => checks.has(text!))!)!);
    else if (
      each.every(
        (text) => relabelled.checks.has(text!) || checks.has(text!) || owedTexts.has(text!),
      )
    )
      relabelled.records.add(record);
    else if (
      each.every(
        (text) =>
          pairs.has(text!) ||
          relabelled.checks.has(text!) ||
          checks.has(text!) ||
          owedTexts.has(text!),
      )
    )
      rewordedRecords.add(record);
    else if (
      each.every(
        (text) =>
          coarse.checks.has(text!) ||
          relabelled.checks.has(text!) ||
          checks.has(text!) ||
          owedTexts.has(text!),
      )
    )
      coarse.records.add(record);
  }
  const unidentified = new Set([
    ...(referenceLabels?.missing ?? []),
    ...(stoppedLabels?.missing ?? []),
  ]);
  return {
    checks,
    records,
    relabelled,
    reworded: { pairs, records: rewordedRecords },
    owing,
    coarse,
    unidentified,
  };
}

/**
 * The mark-ownership rule at the analysis (S8): every check of the unstopped analysis the stop removed is a deferred
 * mark's obligation, and every warning or error it removed is a mark's record (its code at its site). At a combined
 * stop (`rule`), what the combined stop's rule accepts is owned too (a proven relabel's checks and records among them,
 * docs/specifications/type-inference-accepted-record.md#r4-322), and the coarse (a) reading's counted class
 * (`CombinedStop.coarse`, with its open reads' keys) is named.
 */
function ownership(unstopped: Answers, stopped: Answers, rule?: CombinedStop): string[] {
  const marks = stopped.budget.deferred;
  const owned = new Set(marks.map((mark) => JSON.stringify(mark.obligation)));
  const kept = new Set(stopped.checks.map((check) => JSON.stringify(check)));
  const records = new Set([...stopped.diagnostics, ...marks].map(recordKey));
  const problems: string[] = [];
  for (const check of unstopped.checks.map((each) => JSON.stringify(each)))
    if (
      kept.has(check) ||
      owned.has(check) ||
      rule?.checks.has(check) ||
      rule?.relabelled.checks.has(check) ||
      rule?.reworded.pairs.has(check)
    )
      continue;
    else if (rule?.coarse.checks.has(check))
      problems.push(
        `exception coarse(a) rejection check ${check} open ${rule.coarse.checks.get(check)!.join(" ")}`,
      );
    else problems.push(`unowned check ${check}`);
  for (const d of unstopped.diagnostics) {
    const record = recordKey(d);
    if (
      d.kind === "budget" ||
      records.has(record) ||
      rule?.records.has(record) ||
      rule?.relabelled.records.has(record) ||
      rule?.reworded.records.has(record)
    )
      continue;
    if (rule?.coarse.records.has(record))
      problems.push(`exception coarse(a) rejection record ${recordOf(d)}`);
    else problems.push(`unowned record ${recordOf(d)}`);
  }
  return problems;
}

/**
 * Whether a problem `heldProblems` reports is a named exception (counted, never a pass): an issue's, or the coarse (a)
 * reading's class (docs/specifications/type-inference-accepted-record.md#r4-299).
 *
 * @public (the whole family's driver outside CI reads it)
 */
export function isNamedException(problem: string): boolean {
  return problem.startsWith("exception #") || problem.startsWith("exception coarse(a) ");
}

/**
 * Where a stop lets through more than a requirement (a run's checks): each place (whole site, target, boundary) and
 * dimension the requirement checks where the stop's owed checks (kept and marks' obligations) are none, or together let
 * through a kind the requirement's do not; with the requirement's first check there. Words apart: a check lost, never one
 * said otherwise (#1604).
 */
export function widerThan(required: readonly Obligation[], stopped: Answers): string[] {
  const owed = [...stopped.checks, ...stopped.budget.deferred.map((mark) => mark.obligation)];
  const domains = (list: readonly Obligation[]) => {
    const map = new Map<string, ReadonlySet<string>>();
    for (const check of list) {
      const place = JSON.stringify([placeOf(check), dimensionOf(check)]);
      const known = map.get(place);
      map.set(
        place,
        known === undefined ? domainOfCheck(check) : intersect(known, domainOfCheck(check)),
      );
    }
    return map;
  };
  const [want, have] = [domains(required), domains(owed)];
  return [...want]
    .filter(([place, kinds]) => [...(have.get(place) ?? ["none"])].some((kind) => !kinds.has(kind)))
    .map(([place]) => `wider ${place}`);
}

/**
 * #1604's invariant at a combined stop, against the demand-only run R (clause (w) made exact by count): at each
 * place (whole site, target, boundary) and dimension, the checks the stop owes (kept and marks' obligations) are R's
 * there, or replace R's one for one (no more of them than R has) letting through together exactly R's domain, or are
 * none where the rule's (a) takes every check R owes there. Each other place is a problem: `missing` (R owes there, the
 * stop nothing, not (a)), `beyond` (the stop owes where R owes nothing), `differs` (another domain), `excess` (R's
 * domain by more marks than R's), with the stop's first check there.
 */
export function combinedMarkProblems(
  reference: Answers,
  natural: Answers,
  stopped: Answers,
): string[] {
  const rule = combinedStop(reference, natural, stopped);
  // (a stopped check paired with a reference check in proof-derived words stands at that check's place, as
  // that check, on both sides of the inventory)
  const paired = new Map<string, Obligation>();
  for (const u of reference.checks) {
    const x = rule.reworded.pairs.get(JSON.stringify(u));
    if (x !== undefined) paired.set(x, u);
  }
  const owed = [...stopped.checks, ...stopped.budget.deferred.map((mark) => mark.obligation)].map(
    (check) => paired.get(JSON.stringify(check)) ?? check,
  );
  const places = (list: readonly Obligation[]) => {
    const map = new Map<string, Obligation[]>();
    for (const check of list) {
      const place = JSON.stringify([placeOf(check), dimensionOf(check)]);
      map.set(place, [...(map.get(place) ?? []), check]);
    }
    return map;
  };
  const domain = (list: readonly Obligation[]): string =>
    domainText(list.map(domainOfCheck).reduce(intersect));
  const [mine, theirs] = [places(owed), places(reference.checks)];
  const problems: string[] = [];
  for (const place of new Set([...mine.keys(), ...theirs.keys()])) {
    const [c, r] = [mine.get(place), theirs.get(place)];
    const texts = (list: readonly Obligation[] | undefined) =>
      new Set((list ?? []).map((check) => JSON.stringify(check)));
    if (c !== undefined && r !== undefined) {
      const [own, ref] = [texts(c), texts(r)];
      if (own.size === ref.size && [...ref].every((text) => own.has(text))) continue;
    }
    const kind =
      c === undefined
        ? r!.every((check) => rule.checks.get(JSON.stringify(check)) === "a")
          ? null
          : "missing"
        : r === undefined
          ? "beyond"
          : domain(c) !== domain(r)
            ? "differs"
            : texts(c).size > texts(r).size
              ? "excess"
              : null;
    if (kind !== null) problems.push(`${kind} ${JSON.stringify((c ?? r)![0])}`);
  }
  return problems;
}

/** The natural analysis (no demand allowance, no stop) beside each demand-only reference run, made once per run. */
const naturals = new WeakMap<StopRun, Answers>();

/**
 * At a combined stop (a demand allowance that stops a decision, with a settled program stop), the combined stop's rule
 * against the demand-only run `unstopped` (`combinedStop`).
 */
export function combinedStopRule(
  c: HeldCase,
  mode: HeldMode,
  unstopped: StopRun,
  stopped: Answers,
): CombinedStop {
  let natural = naturals.get(unstopped);
  if (natural === undefined) {
    const request = coreRequest([{ path: "main.tease", source: c.source }], GLOBALS)!;
    natural = mode.run(() => analyseCore(request));
    naturals.set(unstopped, natural);
  }
  return combinedStop(unstopped.answers, natural, stopped);
}

/**
 * What a settled stop changed of a case that its marks do not stand for, in a mode (`unstopped`: the case's unstopped
 * run there, made once; with `demand`, the run at that demand allowance, a combined stop's reference under its rule): the
 * mark-ownership rule at the analysis; in the slice the stop oracle (`stopProblems`) and the runs: a fitting value says
 * what its predicate does, and a value that does not fit is rejected before the consumer's effect, having said at most
 * `BEFORE`. A named exception is reported as one (`isNamedException`).
 */
export function heldProblems(
  c: HeldCase,
  mode: HeldMode,
  allowance: number,
  unstopped: StopRun = heldRun(c, mode),
  demand?: number,
): string[] {
  const stopped = heldRun(c, mode, allowance, demand);
  const rule =
    demand === undefined ? undefined : combinedStopRule(c, mode, unstopped, stopped.answers);
  const problems = ownership(unstopped.answers, stopped.answers, rule);
  if (!c.slice || declinedRun(stopped)) return problems;
  // (a stopped plan runs its fitting and forbidden values whatever the reference's compile did; the two compiles are
  // compared where both are had)
  if (declinedRun(unstopped)) return [...problems, ...runProblems(c, stopped)];
  problems.push(
    ...stopProblems({
      unstopped,
      stopped,
      fitting: c.values.filter((each) => each.says !== null).map((each) => each.globals),
      violating: c.values.filter((each) => each.says === null).map((each) => each.globals),
      ...(rule === undefined
        ? {}
        : {
            excused: {
              records: new Set([
                ...rule.records.keys(),
                ...rule.relabelled.records,
                ...rule.reworded.records,
                ...rule.coarse.records,
              ]),
              checks: new Set([
                ...rule.checks.keys(),
                ...rule.owing,
                ...rule.relabelled.checks,
                ...rule.reworded.pairs.keys(),
                ...rule.reworded.pairs.values(),
                ...rule.coarse.checks.keys(),
              ]),
            },
          }),
    }),
  );
  return [...problems, ...runProblems(c, stopped)];
}

/** A compile's runs against the case's predicate: what each fitting value says, and each other value rejected in time. */
export function runProblems(c: HeldCase, run: Pick<StopRun, "result">): string[] {
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
  return { run, problems: c.slice && !declinedRun(run) ? runProblems(c, run) : [] };
}

/**
 * The stop kinds beside a settled program stop (S3 §5): demand allowances that stop a decision of a case, alone (a
 * decision stop) and with a program stop (a combined one), each judged against the unstopped run at the same demand
 * allowance, a combined one under its rule (`combinedStop`). Tried one unit below each decision's work in the case's unstopped analysis, largest first, then halving
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
 * first (`tie-root-first`) or tip first (`tie-tip-first`). Sol's design round r1: reader i holding the
 * i+1-th link of one chain and the k-i-th of another, each link storing its own property (`staggered-pairs`), and k
 * branches of one object, each storing its own property, each read through a reader that also holds another object
 * (`branch-disjoint-readers`). Codex r6's B1: one `addAll` of k copies holding host data (`addAll-copies`). The owner
 * reviewer's (#1445 review of 2026-10-30): a root of k host properties, each of k places copying it and the previous one
 * and storing its own property, read at every property (`overlapping-ancestor`), and a ladder of two places per level,
 * each copying both of the level below, read at every level (`two-holder-ladder`).
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
    "addAll-copies": [
      ...lines(k, (i) => `let a${i} = {f: hostValue}`),
      "let xs = [{f: 1}]",
      `xs.addAll([${lines(k, (i) => `a${i}`).join(", ")}])`,
      "repeat xs[0].f {}",
    ],
    "overlapping-ancestor": [
      `let root = ${fields0(k, () => "hostValue")}`,
      "let c0 = root",
      ...lines(k, (i) => `let c${i + 1} = root\nc${i + 1} = c${i}\nc${i + 1}.f${i} = hostOther`),
      ...lines(k, (j) => `repeat c${k}.f${j} {}`),
    ],
    "two-holder-ladder": [
      "let a0 = {f: hostValue}",
      "let b0 = {f: hostOther}",
      ...lines(
        k,
        (i) => `let a${i + 1} = a${i}\nlet b${i + 1} = b${i}\na${i + 1} = b${i}\nb${i + 1} = a${i}`,
      ),
      ...lines(k, (i) => `repeat a${i + 1}.f {}\nrepeat b${i + 1}.f {}`),
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

/**
 * The finishing growth gate's shapes: the copy graph's topologies, three shapes of a place's many stores, seven of
 * reads no place holds, and three of copies of an inferred place repeated at two levels, wide or reconverging, read
 * through wrappers (#1604).
 */
function gateShapes(): Record<string, (k: number) => string> {
  const rows = (k: number, line: (i: number) => string) => lines(k, line).join("\n");
  return {
    ...Object.fromEntries(
      topologySources(1).map(({ name }) => [
        name,
        (k: number) => topologySources(k).find((each) => each.name === name)!.source,
      ]),
    ),
    stores: (k) =>
      `let root = {f0: hostValue}\n${rows(k, (i) => `${i === 0 ? "" : `root = {f${i}: hostValue}\n`}repeat root.f${i} {}`)}\nexit`,
    copies: (k) =>
      `${rows(k, (i) => `let c${i} = {f${i}: hostValue}`)}\nlet root = c0\n${rows(k, (i) => `${i === 0 ? "" : `root = c${i}\n`}repeat root.f${i} {}`)}\nexit`,
    selected: (k) =>
      `${rows(k, (i) => `let c${i} = {f${i}: hostValue}`)}\nlet root = [c0, c0][0]\n${rows(k, (i) => `${i === 0 ? "" : `root = [c${i}, c${i}][0]\n`}repeat root.f${i} {}`)}\nexit`,
    // (reads no place holds, #1491, #1502: k fallbacks nested in their right, k `get` defaults nested, a literal read k
    // levels down)
    "fallback-right": (k) =>
      `let root = ${fields0(k, () => "hostValue")}\nrepeat ${lines(k, (i) => `(root.f${i} otherwise `).join("")}2${")".repeat(k)} {}\nexit`,
    "get-default": (k) =>
      `let xs = [1]\nlet root = ${fields0(k, () => "hostValue")}\nrepeat ${lines(k, (i) => `xs.get(${i + 5}, default: `).join("")}root.f0${")".repeat(k)} {}\nexit`,
    "nested-literal": (k) =>
      `repeat ${"[".repeat(k)}hostValue${"]".repeat(k)}${"[0]".repeat(k)} {}\nexit`,
    // (and below a copy at its root, Codex r1's B1 on #1559; below two, and a `get`'s default k deep each holding the
    // next in a literal's cell, Astra r1's B2 and B1)
    "copied-literal": (k) =>
      `repeat [${"[".repeat(k)}hostValue${"]".repeat(k)}].toList()[0]${"[0]".repeat(k)} {}\nexit`,
    "double-copied-literal": (k) =>
      `repeat [[${"[".repeat(k)}hostValue${"]".repeat(k)}].toList()].toList()[0][0]${"[0]".repeat(k)} {}\nexit`,
    "nested-get-cells": (k) =>
      `repeat ${nest(k, "hostValue", (text) => `[1].get(5, default: [${text}][0])`)} {}\nexit`,
    // (#1604, Codex r1's B1 on #1653: k stores copying `a` into `b` and k copying `b` into `c`, each wrapper's read
    // through the stores' syntax meeting `a`'s shapes once a level, not once a store)
    // (and k sources stored into one, copied k times into another, or through k places into a third: Codex r2's B1)
    "wide-repeated-copies": (k) =>
      `${rows(k, (i) => `let a${i} = {f: hostValue}`)}\nlet source = a0\n${rows(k - 1, (i) => `source = a${i + 1}`)}\nlet b = source\n${rows(k, () => "b = source")}\nlet w = {q: b}\nrepeat w.q.f {}\nexit`,
    "wide-reconverging-copies": (k) =>
      `${rows(k, (i) => `let a${i} = {f: hostValue}`)}\nlet source = a0\n${rows(k - 1, (i) => `source = a${i + 1}`)}\n${rows(k, (i) => `let b${i} = source`)}\nlet c = b0\n${rows(k - 1, (i) => `c = b${i + 1}`)}\n${rows(k, (i) => `let w${i} = {q: c}\nrepeat w${i}.q.f {}`)}\nexit`,
    "repeated-copies": (k) =>
      `let a = {f: hostValue}\nlet b = a\n${rows(k, () => "b = a")}\nlet c = b\n${rows(k, () => "c = b")}\n${rows(k, (i) => `let w${i} = {q: c}\nrepeat w${i}.q.f {}`)}\nexit`,
    // (a literal of k copies read k deep: past eight copies every read is cut, its root found once along the chain)
    "cut-chain": (k) =>
      `${rows(k, (i) => `let x${i} = hostValue`)}\nrepeat [${lines(k, (i) => `x${i}`).join(", ")}][0]${"[0]".repeat(k)} {}\nexit`,
  };
}

/** The phases a first settled stop may be in: the walk, or the stores' extraction before it (#1556's phase B). */
const FIRST_SETTLED: readonly string[] = ["extraction", "walk"];

/**
 * The finishing growth gate (#1445): each shape at its two sizes (`sizes`, one doubling), in both orders,
 * measured at its first settled stop (in the walk, or the extraction before it). Per doubling of the syntax nodes, the frontier's own counter (`checks`) grows
 * within 2.35; the ring and the chain whose links store their own property are also gated whole, finishing within 2.15
 * and every finishing counter within 2.35. The other shapes' admission and contract work and decision-stop bookkeeping
 * (`readerRecords`, `stopAsks`) grow faster on `main` already (#1456, #1464). Each problem as a line.
 *
 * @public (the worker-side probe runs it at the larger size pair, beside `tests/type-core-budget.test.ts`'s smaller one)
 */
export function frontierGrowthProblems(
  sizes: (shape: string) => readonly [number, number],
): string[] {
  const problems: string[] = [];
  // (the shapes gated whole besides their `checks`)
  const whole = new Set(["ring", "chain-own"]);
  for (const [shape, make] of Object.entries(gateShapes()))
    for (const reversed of [false, true]) {
      const mode = HELD_MODES[reversed ? 1 : 0]!;
      const measured = (k: number) => {
        const request = coreRequest([{ path: "main.tease", source: make(k) }], GLOBALS);
        if (request === null) throw new Error(`${shape} ${k} does not resolve`);
        const analysed = (allowance?: number) =>
          mode.run(() =>
            allowance === undefined
              ? analyseCore(request)
              : withTestAllowance(allowance, () => analyseCore(request)),
          );
        // (the first settled stop: the settled phases, the walk and the publication, are the last; a later stop also
        // measures finishing work that grows faster on `main`, #1464)
        let first = 1;
        for (let top = analysed().budget.total - 1; first < top;) {
          const middle = (first + top) >> 1;
          if (analysed(middle).budget.settled) top = middle;
          else first = middle + 1;
        }
        const { budget } = analysed(first);
        // (the first settled phase: the walk, or the extraction before it, #1556's phase B)
        if (!FIRST_SETTLED.includes(budget.stoppedIn ?? ""))
          problems.push(
            `${shape} ${k}: the first settled stop is not in the walk or the extraction`,
          );
        return {
          units: budget.finishing,
          nodes: budget.counts.get("syntaxNodes")!,
          apart: budget.apart,
        };
      };
      const [smaller, larger] = sizes(shape);
      const [small, large] = [measured(smaller), measured(larger)];
      const nodes = large.nodes / small.nodes;
      const where = `${shape}${reversed ? " reversed" : ""} ${smaller} -> ${larger}`;
      const doubling = (2 * (large.units / small.units)) / nodes;
      if (whole.has(shape) && doubling > 2.15)
        problems.push(`${where}: ${small.units} -> ${large.units} units: ${doubling.toFixed(3)}`);
      for (const [counter, count] of small.apart) {
        if (count < 64 || (!whole.has(shape) && counter !== "checks")) continue;
        const grown = (2 * ((large.apart.get(counter) ?? 0) / count)) / nodes;
        if (grown > 2.35)
          problems.push(
            `${where} ${counter}: ${count} -> ${large.apart.get(counter)}: ${grown.toFixed(3)}`,
          );
      }
    }
  return problems;
}
