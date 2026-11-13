// The generated family of stores around a stopped decision: each destination's origin, site and written form, tried
// with the values the form's own predicate sorts, and the forms the candidate route does not take, judged at the
// analysis.

import type { SerializableRuntimeValue } from "../../../../src/runtime/values/serializable-values.js";
import { propertyStep } from "../../../../src/type-inference/core/program.js";
import { collection, fits, formText, type Form } from "../written/type-core-written.js";
import {
  type Destination,
  type EnclosingCase,
  object,
  literalText,
  wrap,
  listOf,
  integer,
  FORMS,
} from "./type-core-enclosing.js";

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

/** Whole replacements of `xs` before an add: each costs a deeper decision more, so an allowance stops those alone. */
const REPLACED = (seed: string): string[] => Array.from({ length: 40 }, () => `xs = [${seed}]`);

/**
 * The forms the candidate route leaves out (S10), each into a written destination: an argument to a written parameter,
 * one of a dead call, a return into a written result, an add and an `addAll` into a written list of the form, and a
 * replacement of a written dict or set of lists; a literal per value (`few` in the anchors) and a host value.
 */
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
