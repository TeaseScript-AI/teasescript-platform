// The stores at and below a stop judged on the same domain where the source proves them apart from the stop
// (`certificateFamily`).

import type { SerializableRuntimeValue } from "../../../../src/runtime/values/serializable-values.js";
import { propertyStep } from "../../../../src/type-inference/core/program.js";
import {
  collection,
  fits,
  formText,
  name,
  optional,
  type Form,
} from "../written/type-core-written.js";
import {
  type Destination,
  type EnclosingCase,
  object,
  literalText,
  wrap,
  listOf,
  integer,
} from "./type-core-enclosing.js";

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

/**
 * #1440's family: a store at a destination whose decision stops, at or below it, the destination's
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
