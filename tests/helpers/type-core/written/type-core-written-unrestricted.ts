// The unrestricted matrices: contents a written list, set, dict or an object's property takes, which every kind fits,
// so nothing is owed.

import {
  type Collection,
  name,
  optional,
  union,
  collection,
  formText,
  levelsOf,
  valueOf,
  inSlice,
  depthOf,
} from "./type-core-written.js";

/**
 * One source of `UNRESTRICTED_COLLECTION_MATRIX` or `OBJECT_PROPERTY_MATRIX`: contents an unrestricted part takes, which
 * every kind fits, so nothing is owed.
 */
export interface UnrestrictedCase {
  readonly name: string;
  readonly source: string;
  readonly place: string;
  /** The steps from the place down to its unrestricted part: elements, a property. */
  readonly path: readonly string[];
  /** The kinds the place admits at each prefix of `path`, from the place itself, `unknown` (every kind) last. */
  readonly levels: readonly (readonly string[])[];
  /** Whether the candidate route takes the source by its own axes: a list's or an object's literals, never a set's or dict's. */
  readonly executable: boolean;
}

/**
 * The merged S6's B2 (the reviewer's unrestricted-collection matrix, rebuilt by axes): `list`, `set` and `dict`, plain,
 * optional or as a list's element (`list[]`) × known contents (an integer, text, a boolean, `null`, a nested list) ×
 * how they arrive: the initial value, a named value, a later store into an initially empty one, or a copy of the written
 * collection, at the end of a chain of one to three copies, that then takes them. Nothing is owed: no diagnostic, no check, the run says DONE. The host-fed controls
 * are `writtenCase`s of the unrestricted names.
 */
export const UNRESTRICTED_COLLECTION_MATRIX: readonly UnrestrictedCase[] = (() => {
  const out: UnrestrictedCase[] = [];
  const shell = (kind: Collection, inner: string): string =>
    kind === "list" ? `[${inner}]` : kind === "set" ? `set[${inner}]` : `dict{a: ${inner}}`;
  const empty = (kind: Collection): string =>
    kind === "list" ? "[]" : kind === "set" ? "set[]" : "dict{}";
  for (const kind of ["list", "set", "dict"] as const)
    for (const shape of ["plain", "optional", "nested"] as const)
      for (const [content, contentName] of [
        ["1", "an integer"],
        ['"text"', "text"],
        ["true", "a boolean"],
        ["null", "null"],
        ["[1]", "a nested list"],
      ] as const)
        for (const arrival of [
          "initial",
          "named",
          "later",
          "copy",
          "copy of a copy",
          "copy of a copy of a copy",
        ] as const) {
          const type = shape === "plain" ? kind : shape === "optional" ? `${kind}?` : `${kind}[]`;
          const known = (inner: string): string =>
            shape === "nested" ? `[${shell(kind, inner)}]` : shell(kind, inner);
          const blank = shape === "nested" ? "[]" : empty(kind);
          const place = arrival.startsWith("copy") ? "copy" : "out";
          const chain =
            arrival === "copy"
              ? ["let copy = out"]
              : arrival === "copy of a copy"
                ? ["let middle = out", "let copy = middle"]
                : ["let first = out", "let second = first", "let copy = second"];
          const lines =
            arrival === "initial"
              ? [`let out: ${type} = ${known(content)}`]
              : arrival === "named"
                ? [`let v = ${content}`, `let out: ${type} = ${known("v")}`]
                : arrival === "later"
                  ? [`let out: ${type} = ${blank}`, `out = ${known(content)}`]
                  : [`let out: ${type} = ${blank}`, ...chain, `copy = ${known(content)}`];
          const levels: string[][] =
            shape === "nested"
              ? [["list"], [kind], ["unknown"]]
              : [shape === "optional" ? [kind, "null"].sort() : [kind], ["unknown"]];
          out.push({
            name: `${type} holding ${contentName}, ${arrival}`,
            source: `${[...lines, 'say "DONE"', "exit"].join("\n")}\n`,
            place,
            path: Array<string>(levels.length - 1).fill("element"),
            levels,
            executable: kind === "list",
          });
        }
  return out;
})();

/**
 * Sol's round 1 on #1049 (B2's invariant through optionals, unions and projections): an `object`'s properties admit
 * every kind (V30 §13) in each form that holds one, `object`, `object?`, `object | string`, and as a list's
 * element at depths 1 and 2, optional or in a union too × the property's contents (an integer, text, a boolean, `null`,
 * a list, the host value) × the place written, a copy of it at the end of a chain of one to three copies, a copy of the
 * property (a projection) or a copy of that copy, a copy of a place typed after a `null` start, each then taking them.
 * Nothing is owed: no diagnostic, no check, no boundary. The candidate route does not take object literals: the decision
 * layer only.
 */
export const OBJECT_PROPERTY_MATRIX: readonly UnrestrictedCase[] = (() => {
  const out: UnrestrictedCase[] = [];
  const object = name("object");
  const forms = [
    object,
    optional(object),
    union(object, name("string")),
    collection("list", object),
    collection("list", optional(object)),
    collection("list", union(object, name("string"))),
    optional(collection("list", object)),
    collection("list", collection("list", object)),
    collection("list", collection("list", optional(object))),
  ];
  for (const form of forms) {
    const type = formText(form);
    const index = "[0]".repeat(depthOf(form));
    const property = [...Array<string>(depthOf(form)).fill("element"), "p"];
    for (const [content, contentName] of [
      ["1", "an integer"],
      ['"text"', "text"],
      ["true", "a boolean"],
      ["null", "null"],
      ["[1]", "a list"],
      ["hostValue", "the host value"],
    ] as const)
      for (const arrival of [
        "written",
        "copy",
        "copy of a copy",
        "copy of a copy of a copy",
        "projection",
        "copy of a projection",
        "copy of a null intermediate",
      ] as const) {
        const projected = arrival === "projection" || arrival === "copy of a projection";
        const place = arrival === "written" ? "typed" : "copy";
        const chain: Record<typeof arrival, readonly string[]> = {
          written: [],
          copy: ["let copy = typed"],
          "copy of a copy": ["let middle = typed", "let copy = middle"],
          "copy of a copy of a copy": [
            "let first = typed",
            "let second = first",
            "let copy = second",
          ],
          projection: [`let copy = typed${index}.p`],
          "copy of a projection": [`let middle = typed${index}.p`, "let copy = middle"],
          "copy of a null intermediate": [
            "let middle = null",
            "middle = typed",
            "let copy = middle",
          ],
        };
        const lines = [
          `let typed: ${type} = ${valueOf(form, "{p: 1}")}`,
          ...chain[arrival],
          projected ? `copy = ${content}` : `${place}${index}.p = ${content}`,
        ];
        out.push({
          name: `${type} holding ${contentName}, ${arrival}`,
          source: `${[...lines, 'say "DONE"', "exit"].join("\n")}\n`,
          place,
          path: projected ? [] : property,
          // (a `null` start before the written copy keeps its `null` in the copy, Astra's F2)
          levels: projected
            ? [["unknown"]]
            : [
                ...levelsOf(arrival === "copy of a null intermediate" ? optional(form) : form),
                ["unknown"],
              ],
          // (S7's slice takes object literals, property stores and reads)
          executable: inSlice(form),
        });
      }
  }
  return out;
})();
