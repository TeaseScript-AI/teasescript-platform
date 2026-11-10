import { type WorkFamily, rows, lines, fields, main } from "./builders.js";

/**
 * Admission's hot-candidate discovery by touch tries (#1188, its design note's §1.3 and §4.1): one family per context
 * that listed a contribution again before the tries, each beside a wide typed root. A place merging two copies, each
 * then copied beside a second wide record; a literal of a plain wide record beside k such merges (Sol r2); k
 * configuration prefixes, each copying the root under its own name and under one shared name (Sol r8); k records beside
 * a wide one in one list, and the same k alone in another (Sol r8); a chain of merges with a partner three times as wide
 * as the root (Sol r1); k opaque values each copied into itself, in one list (Astra's B1); k cycles of two whole copies
 * fed by the root, each with a store below it and read through a record into a list (Astra's B3); and k such cycles
 * split by their two rejected copies, each stored whole into a third place (the design's own); and a merge place of two
 * wide records, whose k meetings no decision makes hot, copied into k places that each store into it, each beside it in
 * a list or a place (Sol r6, #1270), also projected out of an object holding a whole-copy ring beside it (Astra's
 * review B2 of #1311). Each at size k, linear.
 */
export const HOT_CANDIDATE_FAMILIES: readonly WorkFamily[] = [
  {
    name: "touch-merge-place",
    measures:
      "k merge places, each copied beside a second wide record: the root's landing per merge place",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          'let word: string = "x"',
          `let root = {${fields(k, () => "typed")}}`,
          `let other = {${fields(k, () => "word", "g")}}`,
          rows(k, (i) =>
            lines(
              `let o${i} = {h${i}: typed}`,
              `let d${i} = root`,
              `d${i} = o${i}`,
              `let a${i} = d${i}`,
              `a${i} = other`,
            ),
          ),
          "exit",
        ),
      ),
  },
  {
    name: "touch-holder-fan-in",
    measures:
      "a literal of a plain wide record beside k merge places of the root: each element's holders per path",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          `let other = {${fields(k, () => "1")}}`,
          rows(k, (i) => lines(`let o${i} = {h${i}: typed}`, `let d${i} = root`, `d${i} = o${i}`)),
          `let a = [other, ${Array.from({ length: k }, (_, i) => `d${i}`).join(", ")}]`,
          "exit",
        ),
      ),
  },
  {
    name: "touch-prefix-paths",
    measures:
      "k configuration prefixes copying the root under their own name and a shared one: the shared landing per prefix",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          rows(k, (i) =>
            lines(`let c${i}_0 = {p${i}: root, z: root}`, `let c${i}_1 = {p${i}: root, z: root}`),
          ),
          "exit",
        ),
      ),
  },
  {
    name: "touch-mix-landed",
    measures:
      "k one-field records beside a wide one in one list, and alone in another: each touched path per group",
    program: (k) => {
      const records = Array.from({ length: k }, (_, i) => `r${i}`).join(", ");
      return main(
        lines(
          "let typed: integer = 1",
          rows(k, (i) => `let r${i} = {f${i}: typed}`),
          `let wide = {${fields(k, () => "typed")}}`,
          `let a = [${records}, wide]`,
          `let b = [${records}]`,
          "exit",
        ),
      );
    },
  },
  {
    name: "touch-chain-partner",
    measures:
      "a chain of k merges of the root, each copied beside a partner three times as wide: one walk per merge",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          'let word: string = "x"',
          `let root = {${fields(k, () => "typed")}}`,
          `let other = {${fields(3 * k, () => "word", "g")}}`,
          "let m0 = root",
          rows(k, (i) =>
            lines(
              `let o${i + 1} = {h${i + 1}: typed}`,
              `let m${i + 1} = m${i}`,
              `m${i + 1} = o${i + 1}`,
              `let a${i + 1} = m${i + 1}`,
              `a${i + 1} = other`,
            ),
          ),
          "exit",
        ),
      ),
  },
  {
    name: "touch-opaque-cycles",
    measures:
      "k opaque values each copied into itself, in one list beside a record: each contributor's payload once",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          rows(k, (i) => lines(`let u${i} = hostValue`, `u${i} = u${i}`)),
          `let bag = [${Array.from({ length: k }, (_, i) => `u${i}`).join(", ")}, {x: typed}]`,
          "exit",
        ),
      ),
  },
  {
    name: "touch-fed-cycles",
    measures:
      "k cycles of two whole copies fed by the root, each read into a list: the root's landing per cycle",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          `let peer = {${fields(k, () => "typed", "g")}}`,
          rows(k, (i) =>
            lines(
              `let a${i} = root`,
              `let b${i} = a${i}`,
              `a${i} = b${i}`,
              `b${i}.f0 = typed`,
              `let c${i} = {nest: b${i}}`,
              `let pair${i} = [c${i}.nest, peer]`,
            ),
          ),
          "exit",
        ),
      ),
  },
  {
    name: "touch-split-cycles",
    measures:
      "k cycles of two whole copies split by their two rejected copies, each stored into a third place",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 17",
          'let word: string = "s"',
          `let shared = {${fields(k, () => "typed")}}`,
          rows(k, (i) =>
            lines(
              `let a${i} = shared`,
              `let b${i} = {f0: word}`,
              `a${i} = b${i}`,
              `b${i} = a${i}`,
              `let s${i} = b${i}`,
              `s${i} = a${i}`,
            ),
          ),
          "exit",
        ),
      ),
  },
  // (the merge place itself, or projected beside a whole-copy ring at its own path or one deeper (Astra's review B2 of
  // #1311): a ring-free sibling of a ring is no ring node, so its meetings are not owed again; each placement and
  // consumer is sampled, not their product)
  ...(
    [
      ["literal", ""],
      ["place", ""],
      ["literal", "sibling"],
      ["place", "nested"],
    ] as const
  ).map(([form, beside]): WorkFamily => ({
    name: `touch-dormant-meetings-${form}${beside === "" ? "" : `-${beside}-ring`}`,
    measures: `a merge place's k meetings beside k copies of it, each with a store of its own, in a ${form} with it${beside === "" ? "" : `, projected beside a ring (${beside})`}`,
    program: (k) => {
      // (the merge place, or the object holding it beside a ring, and the projection taken of it)
      const ring =
        beside === ""
          ? []
          : [
              "let r0 = {v: typed}",
              "let r1 = {v: typed}",
              "r0 = r1",
              "r1 = r0",
              beside === "sibling"
                ? "let holder = {cycle: r0, data: container}"
                : "let holder = {inner: {cycle: r0, data: container}}",
              `let selected = ${beside === "sibling" ? "holder.data" : "holder.inner.data"}`,
            ];
      const source = beside === "" ? "container" : "selected";
      return main(
        lines(
          "let typed: integer = 17",
          `let exact = {${fields(k, () => "typed")}}`,
          `let fraction = {${fields(k, () => "1.5")}}`,
          "let container = fraction",
          "container = exact",
          ...ring,
          rows(k, (i) =>
            lines(
              `let alias${i} = ${source}`,
              `alias${i}.f${i} = typed`,
              form === "literal"
                ? `let final${i} = [${source}, alias${i}]`
                : lines(`let final${i} = ${source}`, `final${i} = alias${i}`),
            ),
          ),
          "exit",
        ),
      );
    },
  })),
  {
    name: "touch-literal-contributors",
    measures:
      "k lists of one shared record, each beside its own load or fromJson default at the same position: a contributor per literal",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 7",
          "let peer = {x: typed}",
          "let good = {x: 1}",
          'let bad = {x: "bad"}',
          rows(k, (i) => {
            const fallback = i % 4 < 2 ? "good" : "bad";
            const value =
              i % 2 === 0
                ? `load("k${i}", default: ${fallback})`
                : `fromJson(hostValue, default: ${fallback}, files: false)`;
            return `let l${i} = [${value}, peer]`;
          }),
          "exit",
        ),
      ),
  },
];

/**
 * G5 (5a, #1339): cycles of whole copies, each member read, whose every entry walked the cycle again: a cycle of k
 * whole copies of one object, each member but the first then given another object of the other type (one error per
 * member), and the same cycle with each member also copying the member two ahead, fed objects of k agreeing properties.
 */
export const COPY_RING_FAMILIES: readonly WorkFamily[] = [
  {
    name: "ring-many-fed",
    measures:
      "k members of a cycle of copies, each but the first fed another object, each read: its cut per member",
    program: (k) =>
      main(
        lines(
          "let good = {p0: 1}",
          'let other = {p0: "x"}',
          "let a0 = good",
          rows(k - 1, (i) => `let a${i + 1} = a${i}`),
          `a0 = a${k - 1}`,
          rows(k - 1, (i) => `a${i + 1} = other`),
          rows(k, (i) => `say "\${a${i}.p0}"`),
          "exit",
        ),
      ),
  },
  {
    name: "ring-chords",
    measures:
      "k members of a cycle of copies of k properties, each also copying the member two ahead, each read",
    program: (k) =>
      main(
        lines(
          `let source = {${fields(k, () => "1", "p")}}`,
          `let other = {${fields(k, () => "2", "p")}}`,
          "let a0 = source",
          rows(k - 1, (i) => `let a${i + 1} = a${i}`),
          `a0 = a${k - 1}`,
          rows(k, (i) => `a${i} = a${(i + 2) % k}`),
          `a${k - 1} = other`,
          rows(k, (i) => `say "\${a${i}.p0}"`),
          "exit",
        ),
      ),
  },
];

/**
 * #1456: a place replaced k times by objects of distinct properties, each read after its store (the issue's shape,
 * `plain`), and its controls (Sol's prototype rounds): two properties per object, a property every object holds, one
 * half of them hold, typed and open property values, every other store a host value (an open root), the reads under a
 * test (marked), a value of two provenances, each read before its store, the properties in reversed order, every
 * other object holding a value whose operand's test marks its structure (no level's member), and two objects alike at
 * the root per property, stored in the other order than their literals stand (F11 names the first stored where the
 * levels fold them). Host globals `hostValue` and `hostOther`.
 */
export const PROPERTY_STORE_FAMILIES: readonly WorkFamily[] = (
  [
    ["plain", "the issue's shape"],
    ["two", "two properties per object, each read"],
    ["shared", "a property every object holds, read after each store"],
    ["half", "a property every other object holds, read after each store"],
    ["typed", "typed property values"],
    ["open-value", "open property values"],
    ["open-root", "every other store a host value: no closed object"],
    ["guarded", "the stores and reads under a test: marked"],
    ["provenance", "a property value of two provenances"],
    ["before", "each property read before its store too"],
    ["reverse", "the properties in reversed order"],
    ["marked", "every other object's value a carrier of a tested operand: a marked structure"],
    [
      "alike",
      "two objects of each property, stored in turn from bindings written the other way round",
    ],
  ] as const
).map(([kind, measures]): WorkFamily => ({
  name: `property-stores-${kind}`,
  measures: `#1456: ${measures}`,
  program: (k) => {
    if (kind === "alike")
      // (each property's two objects alike at the root, so where they lack another they fold into the first stored)
      return main(
        lines(
          "let typed: integer = hostValue",
          rows(k, (i) => `let b${i} = {f${i}: typed}\nlet a${i} = {f${i}: 1.25}`),
          rows(
            k,
            (i) => `${i === 0 ? "let " : ""}root = a${i}\nroot = b${i}\nrepeat root.f${i} {}`,
          ),
          "exit",
        ),
      );
    const ids = Array.from({ length: k }, (_, i) => (kind === "reverse" ? k - 1 - i : i));
    const object = (i: number): string =>
      kind === "two"
        ? `{f${i}: hostValue, g${i}: hostOther}`
        : kind === "shared"
          ? `{f${i}: hostValue, common: hostOther}`
          : kind === "half"
            ? `{f${i}: hostValue${i % 2 === 0 ? ", common: hostOther" : ""}}`
            : kind === "typed"
              ? `{f${i}: typed}`
              : kind === "open-value"
                ? `{f${i}: hostValue.member}`
                : kind === "open-root" && i % 2 === 1
                  ? "hostOther"
                  : kind === "guarded"
                    ? `{f${i}: narrowed}`
                    : kind === "provenance"
                      ? `{f${i}: hostValue otherwise hostOther}`
                      : kind === "marked" && i % 2 === 0
                        ? `{f${i}: tested otherwise 1}`
                        : `{f${i}: hostValue}`;
    let text =
      kind === "typed"
        ? "let typed: integer = hostValue\n"
        : kind === "guarded"
          ? "let narrowed = hostValue\nif narrowed is integer {\n"
          : kind === "marked"
            ? "let tested = hostValue\nif tested.a is integer {\n"
            : "";
    text += `let root = ${object(ids[0]!)}\n`;
    for (const [j, i] of ids.entries()) {
      if (kind === "before" && j > 0) text += `repeat root.f${i} {}\n`;
      if (j > 0) text += `root = ${object(i)}\n`;
      if (kind !== "before" || j === 0) text += `repeat root.f${i} {}\n`;
      if (kind === "two") text += `repeat root.g${i} {}\n`;
      if (kind === "shared" || kind === "half") text += "repeat root.common {}\n";
    }
    return main(`${text}${kind === "guarded" || kind === "marked" ? "}\n" : ""}exit`);
  },
}));

/**
 * #1456: k places, each replaced by the same two wide objects of k properties (one object's names, then the other's)
 * and read at two of their properties: a place's index of 2k names would cost more than its two reads, so its levels
 * answer them (`propertyItems`). Host globals `hostValue` and `hostOther`.
 */
export const WIDE_COPIES_READ_TWICE: WorkFamily = {
  name: "wide-copies-read-twice",
  measures: "#1456: k places of two wide objects each read twice, never indexed",
  program: (k) =>
    main(
      lines(
        `let a = {${fields(k, () => "hostValue")}}`,
        `let b = {${fields(k, () => "hostOther", "g")}}`,
        rows(k, (i) => `let r${i} = a\nr${i} = b\nrepeat r${i}.f${i} {}\nrepeat r${i}.g${i} {}`),
        "exit",
      ),
    ),
};

/**
 * #1426: a selection nested k deep whose options are objects, read at a property; each level a literal of two whose one
 * element is the level inside. Each level's literal at the path is read once, its answer composed from the level
 * inside's, never merged again per level above (`mergeItems` 8,969 → 34,313 at k = 64, 128 on `bf9b655a9`). By index
 * with the level inside first; by name with it last, at two properties, one named `element`; and a method between
 * levels, read two steps down.
 */
export const NESTED_OBJECT_SELECTIONS: readonly WorkFamily[] = (
  [
    ["by index", '{p: "origin"}', (inner: string) => `[${inner}, {p: "other"}][0]`, "out.p"],
    [
      "by name, the level inside last",
      '{element: "origin", q: 1}',
      (inner: string) => `[{element: "other", q: 2}, ${inner}].last`,
      "out.element} ${out.q",
    ],
    [
      "through a method",
      '{p: {q: "origin"}}',
      (inner: string) => `[${inner}, {p: {q: "other"}}].get(0, default: {p: {q: "none"}})`,
      "out.p.q",
    ],
  ] as const
).map(([shape, seed, wrap, read]) => ({
  name: `nested-object-selections ${shape}`,
  measures: `#1426: k selections of objects nested ${shape}, read at a property`,
  program: (k: number) => {
    let value = "seed";
    for (let i = 0; i < k; i += 1) value = wrap(value);
    return main(lines(`let seed = ${seed}`, `let out = ${value}`, `say "\${${read}}"`, "exit"));
  },
}));
