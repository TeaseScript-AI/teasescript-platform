import { type WorkFamily, rows, lines, fields, main } from "./builders.js";

/**
 * #1605: a value copied through a chain of k/2 wrappers (`let wi = {q: w(i-1)}`) into a binding that stores external
 * data at its long key below them: the stored key `b.q^d.f` itself (the issue's shape), its element, or a property of
 * its element (a property step after an element step). The store's check reads the key's contract at every level of
 * the stored value (its element, its element's element), each level one step below its parent's position, never every
 * wrapper's whole path again (`positions.ts`). Host global `hostValue`.
 */
export const COPY_CHAIN_FAMILIES: readonly WorkFamily[] = (
  [
    ["copy-chain-store", "the issue's shape: a store at the long key", "[[1]]", ""],
    ["copy-chain-element-store", "a store at the long key's element", "[[1]]", "[0]"],
    [
      "copy-chain-element-property-store",
      "a store at a property of its element",
      "[{r: [[1]]}]",
      "[0].r",
    ],
  ] as const
).map(([name, measures, leaf, below]) => ({
  name,
  measures: `#1605: ${measures}`,
  program: (k: number) => {
    const depth = Math.max(2, k / 2);
    const path = Array.from({ length: depth }, () => "q").join(".");
    return main(
      lines(
        `let a = {f: ${leaf}}`,
        rows(depth, (i) => `let w${i} = {q: ${i === 0 ? "a" : `w${i - 1}`}}`),
        `let b = w${depth - 1}`,
        `b.${path}.f${below} = hostValue`,
        'say "AFTER"',
        "exit",
      ),
    );
  },
}));

/** #1605: the depth of `COPY_CHAIN_SOURCES`' chains. */
export const COPY_CHAIN_DEPTH = 3;

/**
 * #1605: a value copied through `depth` wrappers (`let wi = {q: w(i-1)}`) into `b`, whose long key `b.q…q.f` is used
 * (`use`) with `leaf` at its end and `breaker` keeping a wrapper from being one or changing the frontier's binding.
 */
function copiedChain(depth: number, leaf: string, use: string, breaker: string): string {
  const middle = Math.floor(depth / 2);
  const path = (k: number): string => Array.from({ length: k }, () => "q").join(".");
  const inner = (value: string): string =>
    `{${"q: {".repeat(middle)}f: ${value}${"}".repeat(middle)}}`;
  const uses: Record<string, readonly string[]> = {
    store: [`b.${path(depth)}.f = hostValue`],
    "element-store": [`b.${path(depth)}.f[0] = hostValue`],
    "element-property-store": [`b.${path(depth)}.f[0].r = hostValue`],
    read: [`let x = b.${path(depth)}.f[0]`],
  };
  const breakers: Record<string, readonly string[]> = {
    none: [],
    "prefix-store": [`w${middle}.q = ${inner("[[3]]")}`],
    "prefix-store-host": [`w${middle}.q = ${inner("hostOther")}`],
    "copy-store": [`let c = w${middle}`, `c.${path(middle + 1)}.f = hostOther`],
    "frontier-store": [`a.f[0] = hostOther`],
    guarded: [`if w${middle}.q is object {`, `  say "here"`, `}`],
  };
  return lines(
    "let typed: integer[][] = [[1]]",
    `let a = {f: ${leaf}}`,
    rows(depth, (i) => `let w${i} = {q: ${i === 0 ? "a" : `w${i - 1}`}}`),
    `let b = w${depth - 1}`,
    ...(breakers[breaker] ?? []),
    ...(uses[use] ?? []),
    'say "AFTER"',
    "exit",
    "",
  );
}

/**
 * #1605: the element levels' family through wrappers (`copiedChain`, depth `COPY_CHAIN_DEPTH`), each axis against the
 * issue's shape: the leaf (nested lists, a list of objects, an empty list, two kinds, a written type, a scalar and
 * external data, whose receivers hold no structure) under each use (a store of external data at `b`'s long key, at its
 * element, a read of its element), a store at a property of the element (a property step after an element step), and
 * what breaks the chain (a store into a wrapper, of a literal or of external
 * data, a store through a copy of one, a store into the frontier's own binding, a test of a wrapper) under the two
 * stores. Host globals `hostValue` and `hostOther`.
 */
export const COPY_CHAIN_SOURCES: readonly { readonly name: string; readonly source: string }[] = [
  ...["[[1]]", "[{r: [1]}]", "[]", '[1, "x"]', "typed", "5", "hostOther"].flatMap((leaf) =>
    ["store", "element-store", "read"].map((use) => ({
      name: `leaf ${leaf}, ${use}`,
      source: copiedChain(COPY_CHAIN_DEPTH, leaf, use, "none"),
    })),
  ),
  {
    name: "leaf [{r: [[1]]}], element-property-store",
    source: copiedChain(COPY_CHAIN_DEPTH, "[{r: [[1]]}]", "element-property-store", "none"),
  },
  ...["prefix-store", "prefix-store-host", "copy-store", "frontier-store", "guarded"].flatMap(
    (breaker) =>
      ["store", "element-store"].map((use) => ({
        name: `${breaker}, ${use}`,
        source: copiedChain(COPY_CHAIN_DEPTH, "[[1]]", use, breaker),
      })),
  ),
];

/**
 * #1948: the property index's pay rule (`propertyItems`) over a family: k objects stored into one place in turn, each
 * read below a property after the stores, by how the objects hold the read properties, in which mix they are read and
 * how often. The
 * index is built only where its reads save what it costs, so each family's work grows with its source as `main`'s does
 * (`main`: its growth, measured once, where it is steeper than the gate's bound).
 */
const PAY_HOLDINGS = {
  // (every object holds the read property: an index saves no read)
  every: { object: (i: number) => `{p: {n: hostValue}, q${i}: 1}`, read: (j: number) => `p.m${j}` },
  // (no object holds it: an index saves every object a read)
  none: { object: (i: number) => `{f${i}: hostValue}`, read: (j: number) => `m${j}.n` },
  // (one object each holds a distinct property, read in turn)
  distinct: {
    object: (i: number) => `{f${i}: {n: hostValue}}`,
    read: (j: number, k: number) => `f${j % k}.n${Math.floor(j / k)}`,
  },
  // (Codex r2's F1: every object holds the same k properties, each read at an absent one)
  shared: {
    object: (_: number, k: number) => `{${fields(k, () => "hostValue")}}`,
    read: (j: number) => `m${j}`,
  },
  // (two properties every object holds beside one of its own, read in turn)
  mixed: {
    object: (i: number) => `{s0: {n: hostValue}, s1: {n: hostValue}, f${i}: {n: hostValue}}`,
    read: (j: number, k: number) =>
      j % 2 === 0 ? `s${(j >> 1) % 2}.n${j}` : `f${(j >> 1) % k}.n${j}`,
  },
  // (one property every object holds beside one of its own: one read in k below its own, the rest below the shared)
  "rare-own": {
    object: (i: number) => `{common: {n: hostValue}, f${i}: {n: hostValue}}`,
    read: (j: number, k: number) => (j % k === 0 ? `f${(j / k) % k}.n` : `common.m${j}`),
  },
  // (the same objects, one read in k below the shared property, the rest below their own)
  "rare-common": {
    object: (i: number) => `{common: {n: hostValue}, f${i}: {n: hostValue}}`,
    read: (j: number, k: number) => (j % k === 0 ? `common.m${j}` : `f${j % k}.m${j}`),
  },
} as const;

/** The reads of each family: below the index's first bound, at it, and k² past it. */
const PAY_READS = { below: () => 2, at: () => 3, past: (k: number) => k * k } as const;

/** An object literal's own property names: the keys at its top level. */
const ownNames = (object: string): number => {
  let depth = 0;
  let names = 0;
  for (const char of object) {
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ":" && depth === 1) names += 1;
  }
  return names;
};

/** A family of the pay rule, with `names`: its k stored objects' property names, which the holding count reads. */
export interface PayRuleFamily extends WorkFamily {
  readonly names: (k: number) => number;
}

export const PAY_RULE_FAMILIES: readonly PayRuleFamily[] = Object.entries(PAY_HOLDINGS).flatMap(
  ([holding, { object, read }]) =>
    Object.entries(PAY_READS).map(([reads, count]): PayRuleFamily => ({
      name: `pay-${holding}-${reads}`,
      measures: `#1948: k objects, ${holding} holding the read property, read ${reads} the index's bound`,
      names: (k) =>
        Array.from({ length: k }, (_, i) => ownNames(object(i, k))).reduce((a, b) => a + b, 0),
      program: (k) =>
        main(
          lines(
            `let root = ${object(0, k)}`,
            rows(k - 1, (i) => `root = ${object(i + 1, k)}`),
            rows(count(k), (j) => `let r${j}: integer = root.${read(j, k)}`),
            "exit",
          ),
        ),
    })),
);

/**
 * #2065: the decision index's pay rule (`holdersOf`) over a family: k objects stored into one place in turn (`direct`)
 * or k terminal places copied into it (`copy`), each decided below a property after the stores (`repeat`), by how the
 * objects hold the decided property: one holder each, none, every one, or every other store a copy of a place of two
 * stores (unproved); and how often, below the index's first bound, at it, and k times. The index is built only where
 * its reads save what it costs, so each family's work grows with its source as `main`'s does or slower.
 */
const HOLDER_OBJECTS = {
  holders: {
    object: (i: number) => `{f${i}: {n: value}}`,
    read: (j: number, k: number) => `f${j % k}.n`,
  },
  none: { object: (i: number) => `{f${i}: {n: value}}`, read: (j: number) => `m${j}.n` },
  every: { object: (i: number) => `{p: {n: value}, q${i}: 1}`, read: (j: number) => `p.m${j}` },
  unproved: {
    object: (i: number) => (i % 2 === 0 ? "u" : `{f${i}: {n: value}}`),
    read: (j: number, k: number) => `f${(2 * j + 1) % k}.n`,
  },
} as const;

/** The decided reads of each family: below the index's first bound, at it, and k. */
const HOLDER_READS = { below: () => 2, at: () => 6, past: (k: number) => k } as const;

export const DECISION_HOLDER_FAMILIES: readonly WorkFamily[] = (
  ["direct", "copy"] as const
).flatMap((source) =>
  Object.entries(HOLDER_OBJECTS).flatMap(([holding, { object, read }]) =>
    Object.entries(HOLDER_READS).map(([reads, count]): WorkFamily => ({
      name: `holders-${source}-${holding}-${reads}`,
      measures: `#2065: k objects ${source === "direct" ? "stored into" : "copied into"} one place, ${holding} holding the decided property, decided ${reads} the index's bound`,
      program: (k) =>
        main(
          lines(
            "let value:integer = 1",
            'let u = {f1: {n: value}}\nu = {g: "s"}',
            ...(source === "direct"
              ? [`let root = ${object(0)}`, rows(k - 1, (i) => `root = ${object(i + 1)}`)]
              : [
                  rows(k, (i) => `let root${i} = ${object(i)}`),
                  "let a = root0",
                  rows(k - 1, (i) => `a = root${i + 1}`),
                ]),
            rows(count(k), (j) => `repeat ${source === "direct" ? "root" : "a"}.${read(j, k)} {}`),
            "exit",
          ),
        ),
    })),
  ),
);
