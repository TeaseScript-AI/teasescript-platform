// V30 §13's union rule matrix: a union never holds a whole list, set or dict beside another type.

import {
  type Form,
  SCALAR_NAMES,
  CONTROL_NAMES,
  name,
  optional,
  union,
  collection,
  formText,
  members,
} from "./type-core-written.js";

/** A source of V30 §13's union rule (`UNION_RULE_MATRIX`): one written type at one place. */
export interface UnionRuleCase {
  readonly name: string;
  /** Where the type is written: a holder (`UNION_PLACES`), or a nesting inside a variable's type (`UNION_NESTINGS`). */
  readonly placement: string;
  readonly source: string;
  /**
   * Its one diagnostic, a compile error at the written type (`start:end`) naming the offending union (`start:end`) and
   * the suggestion V30 gives for its example `h`'s form, else `null`; `null` for a valid control, which has none.
   */
  readonly error: {
    readonly site: string;
    readonly union: string;
    readonly suggestion: string | null;
  } | null;
}

/** The places a type is written (V30 §13; ADR 0021 3.4, and 4.1 for a type test), each with a value that fits it. */
const UNION_PLACES: readonly (readonly [string, (type: string, value: string) => string])[] = [
  ["a variable", (type, value) => `let x: ${type} = ${value}`],
  ["a global", (type, value) => `global x: ${type} = ${value}`],
  ["a parameter", (type) => `function use(x: ${type}) {\n}`],
  ["a result", (type, value) => `function make: ${type} {\n return ${value}\n}`],
  ["a type test", (type) => `if hostValue is ${type} {\n say "yes"\n}`],
  [
    "a case's type test",
    (type) => `switch hostValue {\n case is ${type} { say "yes" }\n default { say "no" }\n}`,
  ],
];

/** The places inside another type, at a variable: a list or set element, a dict value, an optional, a list's list. */
const UNION_NESTINGS: readonly (readonly [string, (of: Form) => Form])[] = [
  ["a list's element", (of) => collection("list", of)],
  ["a set's element", (of) => collection("set", of)],
  ["a dict's value", (of) => collection("dict", of)],
  ["an optional", (of) => optional(of)],
  ["a list's list's element", (of) => collection("list", collection("list", of))],
];

/** An empty value of a form's first whole collection, else `null`: a value that every form here admits. */
function emptyOf(form: Form): string {
  for (const member of members(form)) {
    const kind =
      member.kind === "collection"
        ? member.collection
        : member.kind === "name"
          ? member.name
          : null;
    if (kind === "list") return "[]";
    if (kind === "set") return "set[]";
    if (kind === "dict") return "dict{}";
  }
  return "null";
}

/**
 * The whole collections of `integer` that have V30's suggestion for its example `h`'s form (the owner's #1104 point 3),
 * each with the text that stands for it inside the union and the collection around the union, a `?` where it is written.
 */
const SUGGESTED: Readonly<Record<string, readonly [string, (inside: string) => string]>> = {
  "integer[]": ["integer", (inside) => `(${inside})[]`],
  "integer set": ["integer", (inside) => `(${inside}) set`],
  "integer dict": ["integer", (inside) => `(${inside}) dict`],
  "integer?[]": ["integer?", (inside) => `(${inside})[]`],
  "integer[]?": ["integer", (inside) => `(${inside})[]?`],
};

/**
 * V30's suggestion for its example `h`'s form, here a `SUGGESTED` collection beside a type name that is no collection,
 * not `null` and not `integer` (`g`'s form has none): the union inside the collection, its members in their written order.
 */
function suggestionOf(pair: readonly Form[]): string | null {
  const texts = pair.map(formText);
  const at = texts.findIndex((text) => Object.hasOwn(SUGGESTED, text));
  const other = pair[1 - at];
  if (
    at < 0 ||
    other?.kind !== "name" ||
    ["integer", "null", "list", "set", "dict"].includes(other.name)
  )
    return null;
  const [element, around] = SUGGESTED[texts[at]!]!;
  return around(texts.map((text, index) => (index === at ? element : text)).join(" | "));
}

/**
 * V30 §13's union rule (the forms `f`–`p`): a union never holds a whole list, set or dict beside
 * another type. Axes: each whole collection form (`integer[]`, `integer set`, `integer dict`, `list`, `set`, `dict`,
 * `integer[]?`, `integer?[]`) beside each type name that is no collection (at a variable all of them, elsewhere `integer`,
 * the collections' own element type as in `g`, `string` as in `h`, `object` and `range`) or beside another collection
 * (`string[]`, `string set`, `string dict`, `list`, `set`, `dict`; not the same name twice) × the members in both orders
 * × the place it is written: a variable, a global, a parameter, a result, a type test, a case's type test, and at a
 * variable inside a list, a set, a dict, an optional and a list of lists. Each is one compile error at the written type,
 * naming the union, with V30's suggestion for `h`'s form (`suggestionOf`). Valid controls, with no diagnostic, at the
 * same places: each whole collection beside `null`, its optional form, in both orders, and beside itself, also with
 * `null` between (one type written twice). A union inside a collection and the other valid forms are
 * `V30_TYPE_MATRIX`'s.
 */
export const UNION_RULE_MATRIX: readonly UnionRuleCase[] = (() => {
  const integer = name("integer");
  const string = name("string");
  const wholes = [
    collection("list", integer),
    collection("set", integer),
    collection("dict", integer),
    name("list"),
    name("set"),
    name("dict"),
    optional(collection("list", integer)),
    collection("list", optional(integer)),
  ];
  const otherWholes = [
    collection("list", string),
    collection("set", string),
    collection("dict", string),
    name("list"),
    name("set"),
    name("dict"),
  ];
  const everyName = [...SCALAR_NAMES, "object", ...CONTROL_NAMES].map(name);
  const representatives = ["integer", "string", "object", "range"].map(name);
  const places = [
    ...UNION_PLACES.map(([place, line], index) => ({
      place,
      placement: place,
      line,
      around: (of: Form) => of,
      every: index === 0,
    })),
    ...UNION_NESTINGS.map(([nesting, around]) => ({
      place: "a variable",
      placement: `a variable, inside ${nesting}`,
      line: UNION_PLACES[0]![1],
      around,
      every: false,
    })),
  ];
  const out: UnionRuleCase[] = [];
  const sources = new Set<string>();
  for (const { place, placement, line, around, every } of places)
    for (const whole of wholes) {
      const besides = [
        ...(every ? everyName : representatives),
        ...otherWholes.filter((other) => formText(other) !== formText(whole)),
      ];
      const pairs = [
        ...besides.flatMap((other) =>
          [
            [whole, other],
            [other, whole],
          ].map((pair) => ({ pair, valid: false })),
        ),
        { pair: [whole, name("null")], valid: true },
        { pair: [name("null"), whole], valid: true },
        // (the same collection twice is one type, also beside `null`)
        { pair: [whole, whole], valid: true },
        { pair: [whole, name("null"), whole], valid: true },
      ];
      for (const { pair, valid } of pairs) {
        const type = formText(around(union(...pair)));
        const source = `${line(type, emptyOf(around(union(...pair))))}\nexit\n`;
        // (a pair of two unrestricted collections comes from either of them)
        if (sources.has(source)) continue;
        sources.add(source);
        const start = source.indexOf(type);
        if (start < 0 || source.lastIndexOf(type) !== start)
          throw new Error(`The written type is not once in ${JSON.stringify(source)}.`);
        const unionText = formText(union(...pair));
        const unionStart = start + type.indexOf(unionText);
        out.push({
          name: `${place}: ${type}`,
          placement,
          source,
          error: valid
            ? null
            : {
                site: `${start}:${start + type.length}`,
                union: `${unionStart}:${unionStart + unionText.length}`,
                suggestion: suggestionOf(pair),
              },
        });
      }
    }
  return out;
})();
