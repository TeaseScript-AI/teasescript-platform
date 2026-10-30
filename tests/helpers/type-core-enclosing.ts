import { compileSourceWithBackend, type CompilationResult } from "../../src/compiler.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import type { TypeTerm } from "../../src/type-inference/graph.js";
import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import { CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { withTestDemandAllowance } from "../../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../../src/type-inference/core/consumers.js";
import { CoreProgram, propertyName, propertyStep } from "../../src/type-inference/core/program.js";
import { withoutSharing } from "../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../src/type-inference/core/solver.js";
import { coreRequest } from "./type-core-analysis.js";
import { plannedStores, runGlobals } from "./type-core-route.js";
import {
  checkedText,
  collection,
  fits,
  formText,
  name,
  optional,
  type Form,
} from "./type-core-written.js";

/*
 * The stores at, below and above a stopped decision (#1416, #1440; S3 §5, ADR 0021 rule 1.10): a store or argument
 * whose value holds a key whose decision stopped at its demand allowance keeps that key's obligation, its check against
 * its destination's complete type or its value marked. A generated family over the destination's origin (written, a
 * copy, a copy of a copy, a property a copy decides, one named `element`, an object a literal decides, a sibling
 * property), the store's site (a declaration, a replacement with a literal or with a host value), the written form
 * (lists one, two and four deep, a nullable element, a nullable list, text leaves), each tried with the values the
 * form's own predicate (`fits`) sorts, never the implementation's matcher; judged at every allowance around each
 * decision's work in the eight orders (`enclosingProblems`). The forms the candidate route does not take (S10: an
 * argument, a dead call's argument, a return, an add or `addAll`, a dict's or a set's element type) are judged at the
 * analysis: the mark at the store and the complete type its check carries (`Answers.requirement`). A store at or below
 * the stop is judged on the same domain where the source proves it apart from the stop (`certificateFamily`). CI runs
 * anchors of it; the whole family is a worker run outside CI.
 */

/** A store's destination: its binding, parameter or function's result (`result`), and its path below, in key steps. */
export interface Destination {
  readonly binding: string;
  readonly result?: boolean;
  readonly path: readonly string[];
}

export interface EnclosingCase {
  readonly name: string;
  readonly source: string;
  readonly into: Destination;
  /** The stored value's site. */
  readonly site: { readonly start: number; readonly end: number };
  /**
   * The destination's complete type by the source (its written type, or the one a copy gives it), `null` where an
   * object literal decides it, whose properties' types the store's own decisions give.
   */
  readonly form: Form | null;
  /** Whether the destination's binding is written (`let t: F`): its type known in every phase. */
  readonly written: boolean;
  /**
   * Whether the source proves `form` at the destination apart from every decision, a stopped one at it included
   * (#1440, TABLE r4.200): the binding is written, or its declaration's start value holds, through one object literal
   * property per step, a read of a written binding at the destination or above it. Else a stop at or above the
   * destination leaves the store its mark, its type undecided.
   */
  readonly certified?: boolean;
  /** The values a run tries: each a host value, or the one the source stores (`host` false), with whether it fits. */
  readonly values: readonly { readonly value: SerializableRuntimeValue; readonly fits: boolean }[];
  readonly host: boolean;
  /** Whether the candidate route compiles it (S10): else it is judged at the analysis. */
  readonly slice: boolean;
}

const object = (
  properties: Readonly<Record<string, SerializableRuntimeValue>>,
): SerializableRuntimeValue => ({
  kind: "object",
  properties: Object.entries(properties).map(([property, value]) => ({ name: property, value })),
});

/** A value as a TeaseScript literal. */
function literalText(value: SerializableRuntimeValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value.kind === "list") return `[${value.items.map(literalText).join(", ")}]`;
  if (value.kind === "set") return `set[${value.items.map(literalText).join(", ")}]`;
  if (value.kind === "dict")
    return `dict{${value.entries.map((e) => `${e.key}: ${literalText(e.value)}`).join(", ")}}`;
  if (value.kind === "object")
    return `{${value.properties.map((p) => `${p.name}: ${literalText(p.value)}`).join(", ")}}`;
  throw new Error(`No literal of a ${value.kind}.`);
}

/** A collection of `kind` holding `items` (a dict's under the keys `a`, `b`, …). */
function wrap(
  kind: "list" | "set" | "dict",
  ...items: SerializableRuntimeValue[]
): SerializableRuntimeValue {
  if (kind === "dict")
    return {
      kind: "dict",
      entries: items.map((value, index) => ({ key: String.fromCharCode(97 + index), value })),
    };
  return { kind, items };
}

const listOf = (of: Form, depth: number): Form =>
  depth === 0 ? of : collection("list", listOf(of, depth - 1));
const integer = name("integer");

/** The written forms: lists one, two and four deep, a nullable element, a nullable list, text leaves. */
const FORMS: readonly Form[] = [
  listOf(integer, 1),
  listOf(integer, 2),
  listOf(integer, 4),
  collection("list", optional(integer)),
  optional(listOf(integer, 1)),
  listOf(name("string"), 2),
];

/** A form's collections from the outermost in, and its leaf's fitting and forbidden values. */
function spine(form: Form): {
  kinds: ("list" | "set" | "dict")[];
  good: SerializableRuntimeValue;
  bad: SerializableRuntimeValue;
} {
  const kinds: ("list" | "set" | "dict")[] = [];
  let at = form.kind === "optional" ? form.of : form;
  while (at.kind === "collection") {
    kinds.push(at.collection);
    at = at.of.kind === "optional" ? at.of.of : at.of;
  }
  const text = at.kind === "name" && at.name === "string";
  return { kinds, good: text ? "ok" : 1, bad: text ? 1 : "bad" };
}

/**
 * A form's values by its structure: the fitting one, a forbidden leaf, a forbidden sibling beside a fitting leaf, a
 * scalar where each level holds a list (the outer one a non-list), an empty list at each level, `null` as the value and
 * as its leaf; `few` keeps the fitting one, the forbidden leaf, the sibling and the innermost wrong container.
 */
function valuesOf(form: Form, few: boolean): SerializableRuntimeValue[] {
  const { kinds, good, bad } = spine(form);
  const depth = kinds.length;
  // (`levels` collections from the outermost in, the innermost holding `items`)
  const holding = (
    levels: number,
    items: readonly SerializableRuntimeValue[],
    at = 0,
  ): SerializableRuntimeValue =>
    levels === 1
      ? wrap(kinds[at]!, ...items)
      : wrap(kinds[at]!, holding(levels - 1, items, at + 1));
  const nest = (levels: number, inner: SerializableRuntimeValue): SerializableRuntimeValue =>
    levels === 0 ? inner : holding(levels, [inner]);
  const out = [nest(depth, good), nest(depth, bad), holding(depth, [good, bad])];
  if (few) out.push(nest(depth - 1, bad));
  else {
    for (let level = 0; level < depth; level += 1)
      out.push(nest(level, bad), holding(level + 1, []));
    out.push(null, nest(depth, null));
  }
  const seen = new Set<string>();
  return out.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type Origin =
  | "written"
  | "copy"
  | "copy of a copy"
  | "copied property"
  | "property named element"
  | "object"
  | "sibling property";

const ORIGINS: readonly Origin[] = [
  "written",
  "copy",
  "copy of a copy",
  "copied property",
  "property named element",
  "object",
  "sibling property",
];

/** An origin's lines before the store, the store's target text, and its destination. */
function originOf(
  origin: Origin,
  type: string,
  seed: string,
): { readonly lines: readonly string[]; readonly target: string; readonly into: Destination } {
  switch (origin) {
    case "written":
      return { lines: [`let t: ${type} = ${seed}`], target: "t", into: { binding: "t", path: [] } };
    case "copy":
      return {
        lines: [`let seed: ${type} = ${seed}`, "let t = seed"],
        target: "t",
        into: { binding: "t", path: [] },
      };
    case "copy of a copy":
      return {
        lines: [`let seed: ${type} = ${seed}`, "let mid = seed", "let t = mid"],
        target: "t",
        into: { binding: "t", path: [] },
      };
    case "copied property":
      return {
        lines: [`let seed: ${type} = ${seed}`, "let box = {items: seed}"],
        target: "box.items",
        into: { binding: "box", path: [propertyStep("items")] },
      };
    case "property named element":
      return {
        lines: [`let seed: ${type} = ${seed}`, "let box = {element: seed}"],
        target: "box.element",
        into: { binding: "box", path: [propertyStep("element")] },
      };
    case "object":
      return {
        lines: [`let seed: ${type} = ${seed}`, "let box = {items: seed}"],
        target: "box",
        into: { binding: "box", path: [] },
      };
    case "sibling property":
      // (the sibling's decisions scan more stores, so an allowance stops them alone)
      return {
        lines: [
          `let seedA: ${type} = ${seed}`,
          `let seedB: ${type} = ${seed}`,
          "let box = {a: seedA, b: seedB}",
          ...Array.from({ length: 40 }, () => "box.b = seedB"),
        ],
        target: "box.a",
        into: { binding: "box", path: [propertyStep("a")] },
      };
  }
}

/**
 * The family: every origin and form, a host value's replacement trying every value, a literal's replacement per value
 * (`few` of them in the anchors), and a written binding's declaration per value.
 */
export function enclosingFamily(few = false): EnclosingCase[] {
  const cases: EnclosingCase[] = [];
  for (const form of FORMS) {
    const type = formText(form);
    const seed = literalText(valuesOf(form, true)[0]!);
    for (const origin of ORIGINS) {
      const { lines, target, into } = originOf(origin, type, seed);
      const whole = origin === "object";
      // (an object a literal decides holds the form at its property)
      const stored = (value: SerializableRuntimeValue): SerializableRuntimeValue =>
        whole ? object({ items: value }) : value;
      const add = (site: string, value: string, values: EnclosingCase["values"]): void => {
        const store = site === "declaration" ? `let t: ${type} = ${value}` : `${target} = ${value}`;
        const head = site === "declaration" ? [] : lines;
        const source = [...head, 'say "BEFORE"', store, 'say "AFTER"', "exit"].join("\n") + "\n";
        const start = source.indexOf(store) + store.length - value.length;
        cases.push({
          name: `${origin}, ${type}, ${site}${site === "host" ? "" : ` ${value}`}`,
          source,
          into,
          site: { start, end: start + value.length },
          form: whole ? null : form,
          written: origin === "written",
          values,
          host: site === "host",
          slice: true,
        });
      };
      add(
        "host",
        "hostValue",
        valuesOf(form, false).map((value) => ({ value: stored(value), fits: fits(form, value) })),
      );
      for (const value of valuesOf(form, few)) {
        const entry = [{ value: stored(value), fits: fits(form, value) }];
        add("literal", literalText(stored(value)), entry);
        if (origin === "written") add("declaration", literalText(value), entry);
      }
    }
  }
  return [...cases, ...analysisFamily(few)];
}

/**
 * The forms the candidate route leaves out (S10), each into a written destination: an argument to a written parameter,
 * one of a dead call, a return into a written result, an add and an `addAll` into a written list of the form, and a
 * replacement of a written dict or set of lists; a literal per value (`few` in the anchors) and a host value.
 */
/** Whole replacements of `xs` before an add: each costs a deeper decision more, so an allowance stops those alone. */
const REPLACED = (seed: string): string[] => Array.from({ length: 40 }, () => `xs = [${seed}]`);

function analysisFamily(few: boolean): EnclosingCase[] {
  const cases: EnclosingCase[] = [];
  const forms = [
    ...FORMS,
    collection("dict", listOf(integer, 1)),
    collection("set", listOf(integer, 1)),
  ];
  const shapes: readonly {
    readonly name: string;
    readonly lines: (type: string, value: string, seed: string) => readonly string[];
    readonly into: Destination;
    /** The written type of the destination's place: the form's, or a list of it (an add's). */
    readonly holds: (form: Form) => Form;
    /** The stored value's text for a value of the form (an `addAll`'s list of it), and the line storing it. */
    readonly stored: (value: string) => string;
    readonly line: string;
    readonly collections: boolean;
  }[] = [
    {
      name: "argument",
      line: "f(",
      lines: (type, value) => [
        `function f(xs: ${type}) {`,
        '  say "CALLEE"',
        "}",
        'say "BEFORE"',
        `f(${value})`,
        'say "AFTER"',
      ],
      into: { binding: "xs", path: [] },
      holds: (form) => form,
      stored: (value) => value,
      collections: false,
    },
    {
      name: "dead argument",
      line: "f(",
      lines: (type, value) => [
        `function f(xs: ${type}) {`,
        '  say "CALLEE"',
        "}",
        'say "BEFORE"',
        "exit",
        `f(${value})`,
      ],
      into: { binding: "xs", path: [] },
      holds: (form) => form,
      stored: (value) => value,
      collections: false,
    },
    {
      name: "return",
      line: "  return ",
      lines: (type, value) => [
        `function g(n): ${type} {`,
        `  return ${value}`,
        "}",
        'say "BEFORE"',
        "let r = g(1)",
        'say "AFTER"',
      ],
      into: { binding: "g", result: true, path: [] },
      holds: (form) => form,
      stored: (value) => value,
      collections: false,
    },
    {
      name: "add",
      line: "xs.add(",
      lines: (type, value, seed) => [
        `let xs: ${type} = [${seed}]`,
        ...REPLACED(seed),
        'say "BEFORE"',
        `xs.add(${value})`,
        'say "AFTER"',
      ],
      into: { binding: "xs", path: ["element"] },
      holds: (form) => collection("list", form),
      stored: (value) => value,
      collections: false,
    },
    {
      name: "addAll",
      line: "xs.addAll(",
      lines: (type, value, seed) => [
        `let xs: ${type} = [${seed}]`,
        ...REPLACED(seed),
        'say "BEFORE"',
        `xs.addAll(${value})`,
        'say "AFTER"',
      ],
      into: { binding: "xs", path: ["element"] },
      holds: (form) => collection("list", form),
      stored: (value) => `[${value}]`,
      collections: false,
    },
    {
      name: "written collection",
      line: "t = ",
      lines: (type, value, seed) => [
        `let t: ${type} = ${seed}`,
        'say "BEFORE"',
        `t = ${value}`,
        'say "AFTER"',
      ],
      into: { binding: "t", path: [] },
      holds: (form) => form,
      stored: (value) => value,
      collections: true,
    },
  ];
  for (const form of forms)
    for (const shape of shapes) {
      // (a dict's or a set's element type at a written replacement alone; a list's in every other shape)
      if (shape.collections !== (form.kind === "collection" && form.collection !== "list"))
        continue;
      const type = formText(shape.holds(form));
      const seed = literalText(valuesOf(form, true)[0]!);
      const add = (value: string, values: EnclosingCase["values"]): void => {
        const stored = shape.stored(value);
        const lines = shape.lines(type, stored, seed);
        const source = [...lines, "exit"].join("\n") + "\n";
        // (the value's site on the line that stores it: its text may stand elsewhere too, as `g(1)`'s `1`)
        const at = lines.findIndex((line) => line.startsWith(`${shape.line}${stored}`));
        const start =
          lines.slice(0, at).reduce((sum, line) => sum + line.length + 1, 0) + shape.line.length;
        cases.push({
          name: `${shape.name}, ${type}, ${value === "hostValue" ? "host" : `literal ${value}`}`,
          source,
          into: shape.into,
          site: { start, end: start + stored.length },
          form,
          written: true,
          values,
          host: value === "hostValue",
          slice: false,
        });
      };
      add(
        "hostValue",
        valuesOf(form, false).map((value) => ({ value, fits: fits(form, value) })),
      );
      for (const value of valuesOf(form, few))
        add(literalText(value), [{ value, fits: fits(form, value) }]);
    }
  return cases;
}

/** A leaf's values, the fitting one first; the form's own predicate sorts them (`fits`). */
const LEAVES: Readonly<Record<string, readonly SerializableRuntimeValue[]>> = {
  integer: [1, "bad", 2.5],
  number: [1.5, "bad"],
  string: ["ok", 1],
  boolean: [true, "bad"],
  object: [object({ n: 1 }), "bad"],
  list: [wrap("list", "x"), "bad"],
};

/** #1440's written forms: each leaf bare and in a list, integers two and four deep, a nullable element and list. */
const CERTIFIED_FORMS: readonly Form[] = [
  ...["integer", "number", "string", "boolean", "object"].flatMap((leaf) => [
    name(leaf),
    listOf(name(leaf), 1),
  ]),
  listOf(integer, 2),
  listOf(integer, 4),
  collection("list", optional(integer)),
  optional(listOf(integer, 1)),
  name("list"),
];

/** A form's lists from the outside in and its leaf name, through its optionals. */
function shapeOf(form: Form): { readonly depth: number; readonly leaf: string } {
  let depth = 0;
  let at = form;
  while (at.kind === "optional" || at.kind === "collection") {
    if (at.kind === "collection") depth += 1;
    at = at.of;
  }
  return { depth, leaf: at.kind === "name" ? at.name : "object" };
}

const nested = (depth: number, value: SerializableRuntimeValue): SerializableRuntimeValue =>
  depth === 0 ? value : wrap("list", nested(depth - 1, value));

/**
 * A form's whole values: the fitting one, each forbidden leaf, a fitting and a forbidden leaf side by side, a leaf
 * where a list stands, an empty list, `null` and a `null` leaf; `few`: the fitting one, a forbidden leaf, the pair.
 */
function wholeValues(form: Form, few: boolean): SerializableRuntimeValue[] {
  const { depth, leaf } = shapeOf(form);
  const [good, ...bad] = LEAVES[leaf]!;
  const mixed = depth > 0 ? [nested(depth - 1, wrap("list", good!, bad[0]!))] : [];
  if (few) return [nested(depth, good!), nested(depth, bad[0]!), ...mixed];
  const out = [nested(depth, good!), ...bad.map((each) => nested(depth, each)), ...mixed];
  if (depth > 0) out.push(nested(depth - 1, good!), wrap("list"), nested(depth, null));
  out.push(null);
  return out;
}

/** A form's leaf values for a literal holding host data at its innermost element (`[[hostValue]]`). */
function leafValues(form: Form): SerializableRuntimeValue[] {
  return [...LEAVES[shapeOf(form).leaf]!, null];
}

/** Where a start value holds the copy (`certified`), or the forms that leave the destination unproved. */
type Spine =
  | "root copy"
  | "property"
  | "nested property"
  | "property named element"
  | "property named entry"
  | "property beside another"
  | "written"
  | "many landings"
  | "many stores at one landing"
  | "earlier literal"
  | "null before the copy"
  | "inferred copy"
  | "copy of a copy"
  | "copy of a copy in a property"
  | "indexed copy";

const CERTIFIED_SPINES: ReadonlySet<Spine> = new Set([
  "root copy",
  "property",
  "nested property",
  "property named element",
  "property named entry",
  "property beside another",
  "written",
  "many landings",
  "many stores at one landing",
]);

/** A spine's lines before the store, the store's target, its destination and its complete type by the source. */
function spineOf(
  spine: Spine,
  form: Form,
): {
  readonly lines: readonly string[];
  readonly target: string;
  readonly into: Destination;
  readonly form: Form;
} {
  const type = formText(form);
  const seed = literalText(wholeValues(form, true)[0]!);
  const written = `let seed: ${type} = ${seed}`;
  const box = (properties: string, target: string, path: readonly string[]) => ({
    lines: [written, `let box = {${properties}}`],
    target,
    into: { binding: "box", path: path.map(propertyStep) },
    form,
  });
  switch (spine) {
    case "root copy":
      return {
        lines: [written, "let t = seed"],
        target: "t",
        into: { binding: "t", path: [] },
        form,
      };
    case "property":
      return box("slot: seed", "box.slot", ["slot"]);
    case "nested property":
      return box("outer: {slot: seed}", "box.outer.slot", ["outer", "slot"]);
    case "property named element":
      return box("element: seed", "box.element", ["element"]);
    case "property named entry":
      return box("entry: seed", "box.entry", ["entry"]);
    case "property beside another":
      return box('slot: seed, other: "ok"', "box.slot", ["slot"]);
    case "written":
      return {
        lines: [`let t: ${type} = ${seed}`],
        target: "t",
        into: { binding: "t", path: [] },
        form,
      };
    case "many landings":
      return box("a: seed, b: seed, c: seed, d: seed", "box.c", ["c"]);
    case "many stores at one landing": {
      const at = box("slot: seed", "box.slot", ["slot"]);
      return { ...at, lines: [...at.lines, ...Array.from({ length: 4 }, () => "box.slot = seed")] };
    }
    case "earlier literal":
      return {
        ...box(`slot: ${seed}`, "box.slot", ["slot"]),
        lines: [written, `let box = {slot: ${seed}}`, "box.slot = seed"],
      };
    case "null before the copy":
      return {
        ...box("slot: null", "box.slot", ["slot"]),
        lines: [written, "let box = {slot: null}", "box.slot = seed"],
        form: form.kind === "optional" ? form : optional(form),
      };
    case "inferred copy":
      return {
        ...box("slot: seed", "box.slot", ["slot"]),
        lines: [`let seed = ${seed}`, "let box = {slot: seed}"],
      };
    case "copy of a copy":
      return {
        lines: [written, "let mid = seed", "let t = mid"],
        target: "t",
        into: { binding: "t", path: [] },
        form,
      };
    case "copy of a copy in a property":
      return {
        ...box("slot: mid", "box.slot", ["slot"]),
        lines: [written, "let mid = seed", "let box = {slot: mid}"],
      };
    case "indexed copy":
      return {
        lines: [`let seeds: ${formText(collection("list", form))} = [${seed}]`, "let t = seeds[0]"],
        target: "t",
        into: { binding: "t", path: [] },
        form,
      };
  }
}

/** The spines whose source decides their destination by its own literal's kinds: integer lists alone keep `form`. */
const LITERAL_DECIDED: ReadonlySet<Spine> = new Set(["earlier literal", "inferred copy"]);

/**
 * #1440's family (TABLE r4.200): a store at a destination whose decision stops, at or below it, the destination's
 * complete type proved by the source apart from that decision (`certified`: its written type, or a read of a written
 * binding its declaration's start value holds through object literal properties, the root's own, one, two levels down,
 * a property named `element` or `entry`, one beside another, one of many, one of many stores) or not (an earlier
 * literal, `null` before the copy, a copy of an inferred or a copied place, at the root or in a property, a selected
 * element). Each over the forms (every leaf bare and in a list, integers two and four deep, a nullable element and
 * list, an open `list`), stored as a host value whole and inside literals and as a literal per value (`few` in the
 * anchors), and the wrong-choice controls: a later `integer[]` after a first `number[]`, a later open `list` after a
 * first `integer[]`. The index stores the candidate route leaves out (S10) are judged at the analysis: a written list's
 * element, a root copy's, a list literal's and one an earlier index store decides.
 */
export function certificateFamily(few = false): EnclosingCase[] {
  const cases: EnclosingCase[] = [];
  const add = (
    title: string,
    lines: readonly string[],
    store: string,
    value: string,
    c: Pick<EnclosingCase, "into" | "form" | "written" | "values" | "host" | "slice" | "certified">,
  ): void => {
    const source = [...lines, 'say "BEFORE"', store, 'say "AFTER"', "exit"].join("\n") + "\n";
    const start = source.lastIndexOf(store) + store.length - value.length;
    cases.push({ name: title, source, site: { start, end: start + value.length }, ...c });
  };
  for (const form of CERTIFIED_FORMS)
    for (const spine of [
      ...CERTIFIED_SPINES,
      ...([
        "earlier literal",
        "null before the copy",
        "inferred copy",
        "copy of a copy",
        "copy of a copy in a property",
        "indexed copy",
      ] as const),
    ]) {
      if (
        LITERAL_DECIDED.has(spine) &&
        !(
          shapeOf(form).leaf === "integer" &&
          form.kind === "collection" &&
          form.of.kind !== "optional"
        )
      )
        continue;
      const at = spineOf(spine, form);
      const type = formText(form);
      const shared = {
        into: at.into,
        form: at.form,
        written: spine === "written",
        slice: true,
        certified: CERTIFIED_SPINES.has(spine),
      };
      const { depth } = shapeOf(form);
      add(`${spine}, ${type}, host`, at.lines, `${at.target} = hostValue`, "hostValue", {
        ...shared,
        host: true,
        values: wholeValues(form, false).map((value) => ({ value, fits: fits(at.form, value) })),
      });
      // (host data inside literals of the form's lists: its leaf checked where the literal lands)
      const lists = form.kind === "collection" && form.of.kind !== "optional" && depth > 0;
      if (lists) {
        const inline = `${"[".repeat(depth)}hostValue${"]".repeat(depth)}`;
        add(`${spine}, ${type}, inline host`, at.lines, `${at.target} = ${inline}`, inline, {
          ...shared,
          host: true,
          values: leafValues(form).map((value) => ({
            value,
            fits: fits(at.form, nested(depth, value)),
          })),
        });
      }
      for (const value of wholeValues(form, true).slice(few ? 1 : 0, few ? 2 : undefined)) {
        const text = literalText(value);
        add(`${spine}, ${type}, literal ${text}`, at.lines, `${at.target} = ${text}`, text, {
          ...shared,
          host: false,
          values: [{ value, fits: fits(at.form, value) }],
        });
      }
    }
  // the wrong-choice controls: the first copy decides, a later one never does
  const controls: readonly (readonly [
    string,
    readonly string[],
    Form,
    readonly SerializableRuntimeValue[],
  ])[] = [
    [
      "a later integer[] after a first number[]",
      [
        "let first: number[] = [1.5]",
        "let later: integer[] = [1]",
        "let box = {slot: first}",
        "box.slot = later",
      ],
      listOf(name("number"), 1),
      [wrap("list", 1.5), wrap("list", 1), wrap("list", "bad"), "bad"],
    ],
    [
      "a later open list after a first integer[]",
      [
        "let first: integer[] = [1]",
        "let later: list = []",
        "let box = {slot: first}",
        "box.slot = later",
      ],
      listOf(integer, 1),
      [wrap("list", 1), wrap("list", "bad"), wrap("list", 1.5), "bad"],
    ],
  ];
  for (const [title, lines, form, values] of controls)
    add(title, lines, "box.slot = hostValue", "hostValue", {
      into: { binding: "box", path: [propertyStep("slot")] },
      form,
      written: false,
      slice: true,
      certified: true,
      host: true,
      values: values.map((value) => ({ value, fits: fits(form, value) })),
    });
  // the index stores, at the analysis: a written list's, a root copy's, a list literal's, one an earlier store decides
  for (const form of [listOf(integer, 1), listOf(integer, 2), listOf(name("string"), 1)]) {
    const type = formText(form);
    const seed = literalText(wholeValues(form, true)[0]!);
    const many = formText(collection("list", form));
    const shapes: readonly (readonly [string, readonly string[], string, boolean, boolean])[] = [
      ["written list's element", [`let t: ${many} = [${seed}]`], "t", true, true],
      [
        "root copy's element",
        [`let seeds: ${many} = [${seed}]`, "let t = seeds"],
        "t",
        false,
        true,
      ],
      [
        "list literal's element",
        [`let seed: ${type} = ${seed}`, "let t = [seed]"],
        "t",
        false,
        false,
      ],
      [
        "element an earlier index store decides",
        [`let seeds: ${many} = [${seed}]`, "let t = hostValue", `t[0] = ${seed}`, "t = seeds"],
        "t",
        false,
        false,
      ],
    ];
    for (const [title, lines, target, written, certified] of shapes)
      add(`${title}, ${type}, host`, lines, `${target}[0] = hostValue`, "hostValue", {
        into: { binding: target, path: ["element"] },
        form,
        written,
        slice: false,
        certified,
        host: true,
        values: wholeValues(form, few).map((value) => ({ value, fits: fits(form, value) })),
      });
  }
  return cases;
}

/** An order of the analysis: the consumers' and the solver's worklist forward or reversed, the sharing on or off. */
export interface Mode {
  readonly name: string;
  readonly run: <T>(make: () => T) => T;
}

export const MODES: readonly Mode[] = [false, true].flatMap((consumers) =>
  [false, true].flatMap((solver) =>
    [true, false].map((sharing): Mode => ({
      name:
        `${consumers ? "reversed" : "forward"} consumers, ${solver ? "reversed" : "forward"} solver` +
        (sharing ? "" : ", unshared"),
      run: <T>(make: () => T): T => {
        const ordered = consumers
          ? (): T => withConsumerOrder((items) => [...items].reverse(), make)
          : make;
        const solved = solver
          ? (): T => withSolverSeam({ reverseWorklist: true }, ordered)
          : ordered;
        return sharing ? solved() : withoutSharing(solved);
      },
    })),
  ),
);

/** How a store relates to the stopped decisions of its binding: one at or above its path, one below it only, none. */
export type Relation = "at" | "above" | "none";

/** One judged compile of a case: the stops, the store's relation and phase, and what the oracle found wrong. */
export interface EnclosingVerdict {
  readonly allowance: number | null;
  readonly stops: readonly string[];
  readonly relation: Relation;
  /** `unsettled`: a program stop before admission settled, which marks every store into an inferred place (#1252). */
  readonly phase: "settled" | "unsettled" | "unstopped";
  /**
   * What the oracle judged: the full domain, an owned mark, or at a stop at or above the store's path its mark and no
   * requirement where `certified` is `false` (#1440), nothing for a case that does not say (#1275).
   */
  readonly judged: "domain" | "mark" | "exact";
  readonly problems: readonly string[];
}

/**
 * The allowances around each decision's work in a case's uncapped analysis in a mode, and 1; `own`: the decisions of
 * the destination's binding alone.
 */
export function allowancesOf(c: EnclosingCase, mode: Mode, own = false): number[] {
  const request = coreRequest([{ path: "main.tease", source: c.source }])!;
  const place = own ? placeOf(request, c) : null;
  const units = new Set(
    mode
      .run(() => analyseCore(request))
      .budget.decisions.filter((d) => place === null || d.place === place)
      .map((d) => d.units),
  );
  const out = new Set<number>([1]);
  for (const unit of units) for (const at of [unit - 1, unit, unit + 1]) if (at >= 1) out.add(at);
  return [...out].sort((a, b) => a - b);
}

/** The place of a case's destination: its binding or parameter, or its function's result. */
function placeOf(request: NonNullable<ReturnType<typeof coreRequest>>, c: EnclosingCase): number {
  const program = new CoreProgram(request);
  if (c.into.result === true) program.index();
  return program.places.find(({ kind }) =>
    c.into.result === true
      ? kind.kind === "result" && program.functionOf(kind.fn).name === c.into.binding
      : (kind.kind === "binding" || kind.kind === "parameter") && kind.name === c.into.binding,
  )!.id;
}

/** A complete type as `checkedText` prints a form. */
function termText(term: TypeTerm): string {
  switch (term.kind) {
    case "atom":
      return term.name;
    case "list":
    case "set":
    case "dict":
      return `${term.kind}<${termText(term.element)}>`;
    case "union":
      return term.members.map(termText).join("|");
    case "dynamic":
      return "any";
    default:
      return term.kind;
  }
}

/**
 * A type's text as `checkedText` and `termText` print it, compared as a type: each union's members in one order, and a
 * written `object` as the plan prints it (`{}`) named `object`.
 */
function typeText(text: string): string {
  const members: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at <= text.length; at += 1) {
    const char = text[at];
    if (char === "<") depth += 1;
    else if (char === ">") depth -= 1;
    else if ((char === "|" && depth === 0) || at === text.length) {
      const member = text.slice(start, at);
      const open = member.indexOf("<");
      members.push(
        open < 0
          ? member === "{}"
            ? "object"
            : member
          : `${member.slice(0, open)}<${typeText(member.slice(open + 1, -1))}>`,
      );
      start = at + 1;
    }
  }
  return members.sort().join("|");
}

/**
 * The budget-context records at a site, shown or deferred, whose obligation is the destination's (`target`): the stop's
 * owned marks of the store there, not a decision's own warning at another level of its value.
 */
function marksAt(answers: Answers, site: EnclosingCase["site"], target: string): number {
  return [...answers.diagnostics, ...answers.budget.deferred].filter(
    (d) =>
      d.class === "warning-runtime-check" &&
      "provenance" in d &&
      d.provenance.context === "budget" &&
      d.obligation.target === target &&
      d.site.start === site.start &&
      d.site.end === site.end,
  ).length;
}

/**
 * #1440: a store at or below a stop the source leaves unproved (`EnclosingCase.certified`) keeps its mark, its type
 * undecided, beside no requirement; so does a store at or above a stop into an inferred place before admission settled
 * (#1252, TABLE r4.135: the fresh pass decides no inferred place). Nothing such a store owes is invented.
 */
function unprovedProblems(
  answers: Answers,
  c: EnclosingCase,
  relation: Relation,
  unproved: boolean,
  unsettledInferred: boolean,
  rejects: boolean,
  target: string,
  place: number,
): string[] {
  const problems: string[] = [];
  if (relation === "at" && unproved && marksAt(answers, c.site, target) < 1 && !rejects)
    problems.push("no mark at an unproved store at the stop");
  if ((relation === "at" && unproved) || (relation !== "none" && unsettledInferred)) {
    const required = answers.requirement(place, c.into.path);
    if (required !== null) problems.push(`unproved requirement ${termText(required)}`);
  }
  return problems;
}

/**
 * The oracle at one allowance (`null`: uncapped) in one mode. Every fitting value reaches `AFTER`. Where the
 * destination's complete type is the source's (`form`) and the store is neither an exact target of a stop the source
 * does not prove it apart from (`certified`, #1440; #1275) nor into an inferred place before admission settled (#1252,
 * whose mark stands for its value), every forbidden value is rejected before `AFTER`, by the compile or at its store,
 * the plan checks the store against the whole form, and a store at or above a stop has exactly one owned mark at its
 * own site and the form as its requirement; where an object literal decides the destination, or the source leaves it
 * unproved, a store above a stop has that mark, and one at the stop the mark beside no requirement.
 */
export function enclosingProblems(
  c: EnclosingCase,
  allowance: number | null,
  mode: Mode,
): EnclosingVerdict {
  const request = coreRequest([{ path: "main.tease", source: c.source }]);
  if (request === null) throw new Error(`The case does not resolve: ${c.name}`);
  const place = placeOf(request, c);
  // (the destination's obligation target, as a store's mark names it: its place's label and steps)
  const target = [
    new CoreProgram(request).place(place).label,
    ...c.into.path.map(propertyName),
  ].join(".");
  const capped = <T>(make: () => T): T =>
    mode.run(() => (allowance === null ? make() : withTestDemandAllowance(allowance, make)));
  const answers = capped(() => analyseCore(request));
  const stopped = answers.budget.decisions
    .filter((d) => d.stopped && d.place === place)
    .map((d) => d.path);
  const prefix = (of: readonly string[], path: readonly string[]): boolean =>
    of.length <= path.length && of.every((step, index) => path[index] === step);
  const relation: Relation = stopped.some((path) => prefix(path, c.into.path))
    ? "at"
    : stopped.some((path) => prefix(c.into.path, path))
      ? "above"
      : "none";
  const phase =
    answers.budget.exhausted === null
      ? stopped.length > 0
        ? "settled"
        : "unstopped"
      : answers.budget.settled
        ? "settled"
        : "unsettled";
  const unsettledInferred = phase === "unsettled" && !c.written;
  // (#1440: a store at or below a stop is judged on its whole domain where the source proves it apart from the stop
  // and the pass's results stand; one the source leaves unproved keeps its mark, its type undecided, above a stop too)
  const unproved = c.certified === false || (c.certified === true && unsettledInferred);
  const judged =
    relation === "at"
      ? c.certified === true && !unsettledInferred && c.form !== null
        ? "domain"
        : "exact"
      : c.form === null || unsettledInferred || (relation === "above" && unproved)
        ? "mark"
        : "domain";
  const problems: string[] = [];
  const inside = (d: { readonly site: EnclosingCase["site"] }): boolean =>
    d.site.start >= c.site.start && d.site.end <= c.site.end;
  const errors = answers.diagnostics.filter((d) => d.class === "compile-error" && inside(d)).length;
  // (C1's error at the store's value rejects it and stands for its mark, A6; another rule's error, as a literal's mixed
  // elements', leaves the mark)
  const rejects = answers.diagnostics.some(
    (d) => d.class === "compile-error" && "rule" in d && d.rule.rule === "store" && inside(d),
  );
  // (one owned mark at a store above a stop, none beside its rejection)
  const owned = (marks: number): boolean => marks === (rejects ? 0 : 1);
  if (!c.slice) {
    // (at the analysis: a literal's error uncapped, and above a stop the mark and the complete type its check carries)
    if (phase === "unstopped" && !c.host && errors > 0 !== !c.values[0]!.fits)
      problems.push(`${errors} errors at the store of ${JSON.stringify(c.values[0]!.value)}`);
    if (relation !== "none" && judged === "domain") {
      const marks = marksAt(answers, c.site, target);
      if (!owned(marks)) problems.push(`${marks} owned marks at the store ${relation} the stop`);
      const required = answers.requirement(place, c.into.path);
      if (required === null || typeText(termText(required)) !== typeText(checkedText(c.form!)))
        problems.push(`requirement ${required === null ? "none" : termText(required)}`);
    }
    problems.push(
      ...unprovedProblems(
        answers,
        c,
        relation,
        unproved,
        unsettledInferred,
        rejects,
        target,
        place,
      ),
    );
    return {
      allowance,
      stops: stopped.map((path) => path.join(".")),
      relation,
      phase,
      judged,
      problems,
    };
  }
  const compiled: CompilationResult = capped(() =>
    compileSourceWithBackend(c.source, { globals: ["hostValue"] }, CORE_BACKEND),
  );
  const plan = compiled.plan;
  const within = (d: CompilationResult["diagnostics"][number]): boolean =>
    d.span.start.offset >= c.site.start && d.span.end.offset <= c.site.end;
  const rejected =
    plan === null && compiled.diagnostics.some((d) => d.severity === "error" && within(d));
  if (plan === null && !rejected)
    problems.push(
      `no plan, no error at the store: ${compiled.diagnostics.map((d) => `${d.code}@${d.span.start.offset}`).join(",")}`,
    );
  for (const { value, fits: fitting } of c.values) {
    const what = JSON.stringify(value);
    // (a fitting value plays whatever is judged: a mark with its type undecided rejects none, #1440's family)
    const judgesFitting = judged !== "exact" || c.certified !== undefined;
    if (plan === null) {
      if (fitting && judgesFitting) problems.push(`fitting ${what} rejected by the compile`);
      continue;
    }
    const ran = runGlobals(plan, { hostValue: c.host ? value : null });
    const after = ran.said.some((said) => said.text === "AFTER");
    if (fitting && !after && judgesFitting)
      problems.push(`fitting ${what} stopped: ${ran.failure ?? ran.status}`);
    if (!fitting && after && judged === "domain") problems.push(`forbidden ${what} reached AFTER`);
  }
  if (plan !== null && judged === "domain" && c.form !== null) {
    const site = `${c.site.start}:${c.site.end}`;
    const planned = plannedStores(plan).find((store) => store.includes(` ${site} `));
    const type = planned?.slice(planned.lastIndexOf(" ") + 1);
    if (type !== undefined && typeText(type) !== typeText(checkedText(c.form)))
      problems.push(`planned ${planned}, not ${checkedText(c.form)}`);
    if (planned === undefined && c.values.some((each) => !each.fits))
      problems.push(`no planned check at ${site}`);
  }
  if (relation === "above" || (relation === "at" && judged === "domain")) {
    const marks = marksAt(answers, c.site, target);
    if (judged === "domain" ? !owned(marks) : marks < 1 && !rejects)
      problems.push(`${marks} owned marks at the store ${relation} the stop`);
  }
  if (relation === "at" && judged === "domain") {
    const required = answers.requirement(place, c.into.path);
    if (required === null || typeText(termText(required)) !== typeText(checkedText(c.form!)))
      problems.push(`requirement ${required === null ? "none" : termText(required)}`);
  }
  if (unsettledInferred && relation !== "at" && marksAt(answers, c.site, target) < 1)
    problems.push("no mark at a store into an inferred place before admission settled");
  problems.push(
    ...unprovedProblems(answers, c, relation, unproved, unsettledInferred, rejects, target, place),
  );
  return {
    allowance,
    stops: stopped.map((path) => path.join(".")),
    relation,
    phase,
    judged,
    problems,
  };
}
