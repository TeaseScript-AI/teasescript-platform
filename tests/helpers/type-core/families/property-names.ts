import type { SourceFile } from "../../type-core-analysis.js";
import { type WorkFamily, rows, lines, fields, main } from "./builders.js";

/**
 * #1466's stack of k diamonds of copies (`topologySources`' `diamond`): each copies one object
 * into two places, stores into one of them and replaces the next place by the other, every next place read; and its
 * siblings: both places stored, the replacing order reversed, every second right place a shared ancestor, the next place
 * written `object` with a misfitting store, the reads guarded, and the branches of unequal depth (Astra's design review);
 * and (`read`, #1610) each next place shown, written by `toJson` or read at a property no layer stores instead.
 * A read below the shared layers is answered once per layer and path from the layers below it
 * (`prefix-index/summaries.ts`), so each grows as k log k where `main` grew as k³. Beside them, Codex r1's B1
 * dimension: k copies of one record, each storing its own property below one step, joined into one place and read at
 * each property, directly and through a copy of the place, so each read asks only the layer that holds its property
 * (#1078).
 */
function diamonds(
  k: number,
  {
    both = false,
    reverse = false,
    shared = false,
    typed = false,
    guarded = false,
    read = "repeat",
  }: {
    readonly both?: boolean;
    readonly reverse?: boolean;
    readonly shared?: boolean;
    readonly typed?: boolean;
    readonly guarded?: boolean;
    readonly read?: "repeat" | "shown" | "json" | "absent";
  } = {},
): readonly SourceFile[] {
  const readOf = (place: string): string =>
    guarded
      ? `if ${place}.g != null { repeat ${place}.g {} }`
      : read === "shown"
        ? `say "\${${place}}"`
        : read === "json"
          ? `say toJson(${place})`
          : read === "absent"
            ? `repeat ${place}.h {}`
            : `repeat ${place}.g {}`;
  return main(
    lines(
      "let d0 = {f: hostValue, g: 1}",
      ...(shared ? ["let shared = d0"] : []),
      rows(k, (i) => {
        const [first, second] = reverse ? [`r${i}`, `l${i}`] : [`l${i}`, `r${i}`];
        return lines(
          `let l${i} = d${i}`,
          `let r${i} = ${shared && i % 2 === 1 ? "shared" : `d${i}`}`,
          `l${i}.g = ${typed ? '"bad"' : "hostValue"}`,
          ...(both ? [`r${i}.g = hostValue`] : []),
          `let d${i + 1}${typed ? ": object" : ""} = ${first}`,
          `d${i + 1} = ${second}`,
        );
      }),
      rows(k, (i) => readOf(`d${i + 1}`)),
      "exit",
    ),
  );
}

/** k copies of one record joined into one place (or a copy of it), each storing and read at its own property below `g`. */
function wideJoin(k: number, copied: boolean): readonly SourceFile[] {
  const place = copied ? "copy" : "joined";
  return main(
    lines(
      "let seed = {g: {z: 1}}",
      rows(k, (i) => `let arm${i} = seed\narm${i}.g.p${i} = hostValue`),
      "let joined = arm0",
      rows(k - 1, (i) => `joined = arm${i + 1}`),
      ...(copied ? ["let copy = joined"] : []),
      rows(k, (i) => `repeat ${place}.g.p${i} {}`),
      "exit",
    ),
  );
}

/**
 * Codex r2's `shared` shape: k copies of one record that stores below `g` itself, each storing its own property below
 * `g`, joined into one place and read at each property through a copy; a copy holding nothing at the property read is
 * passed through, so a read asks the copy holding its property and the record below, never every copy.
 */
function sharedJoin(k: number): readonly SourceFile[] {
  return main(
    lines(
      "let seed = {g: {z: 1}}",
      "seed.g.q = hostValue",
      rows(k, (i) => `let arm${i} = seed\narm${i}.g.p${i} = hostValue`),
      "let joined = arm0",
      rows(k - 1, (i) => `joined = arm${i + 1}`),
      "let copy = joined",
      rows(k, (i) => `repeat copy.g.p${i} {}`),
      "exit",
    ),
  );
}

/**
 * A chain of k copies, each storing its own property below `g`, read at each at the chain's end, or (`joined`) through
 * one place joining every copy of the chain; and (`stored`) each copy joined from the one before it and a copy of that
 * storing a property, storing its own too, read through a copy. Every copy lists `g`, and only one holds a read's
 * property; `main` grows superlinearly on each.
 */
function listingChain(
  k: number,
  { joined = false, stored = false, shown = false } = {},
): readonly SourceFile[] {
  const link = (i: number): string =>
    stored
      ? `let a${i} = d${i}\na${i}.g.p${i} = hostValue\nlet d${i + 1} = d${i}\nd${i + 1} = a${i}\nd${i + 1}.g.q${i} = hostValue`
      : `let d${i + 1} = d${i}\nd${i + 1}.g.p${i} = hostValue`;
  const read = stored ? "copy" : joined ? "x" : `d${k}`;
  return main(
    lines(
      "let d0 = {g: {z: 1}}",
      rows(k, link),
      ...(joined ? ["let x = d1", rows(k - 1, (i) => `x = d${i + 2}`)] : []),
      ...(stored ? [`let copy = d${k}`] : []),
      rows(k, (i) =>
        shown
          ? `say "\${d${i + 1}}"`
          : stored
            ? `repeat copy.g.p${i} {}\nrepeat copy.g.q${i} {}`
            : `repeat ${read}.g.p${i} {}`,
      ),
      "exit",
    ),
  );
}

/**
 * #1610's control (the output-bound shape for property names): k copies of one record, each storing one
 * shared wide object of k properties below `g` and a property of its own, joined into one place, read through it and
 * through a copy of it: a search lists the k copies once each and walks the wide object once, so the work grows with
 * the program where a set of names kept per layer would copy the wide object's k names into each of the k layers.
 */
function wideShared(k: number): readonly SourceFile[] {
  return main(
    lines(
      `let wide = {${fields(k, () => "1")}}`,
      "let seed = {g: {z: 1}}",
      rows(k, (i) => `let arm${i} = seed\narm${i}.g = wide\narm${i}.h${i} = hostValue`),
      "let joined = arm0",
      rows(k - 1, (i) => `joined = arm${i + 1}`),
      "let copy = joined",
      'say "${joined.g}"',
      'say "${copy.g}"',
      rows(k, (i) => `repeat joined.h${i} {}`),
      "exit",
    ),
  );
}

/**
 * #1610's Codex r1 witness: a feedback through a projection (`c = b` after `let b = root.p`, `let c = root`), a store at
 * each of k successive prefixes of `root.p` from the matching projection of `c`, below a chain of k `q` steps: its
 * searches' sources pump at their take-ups, which then follow nothing, so a listing that classified them charges only
 * what the flat search charges there.
 */
function projectedFeedback(k: number): readonly SourceFile[] {
  const nested = (depth: number, inner: string): string =>
    `${"{q:".repeat(depth)}${inner}${"}".repeat(depth)}`;
  return main(
    lines(
      `let root={p:${nested(k, "{left:1}")},q:${nested(k - 1, "{p:{right:1}}")}}`,
      "let b=root.p",
      "let c=root",
      rows(k, (i) => `root.p${".q".repeat(i + 1)}=c${".q".repeat(i + 1)}.p`),
      "c=b",
      "exit",
    ),
  );
}

/**
 * #1610: the property-name search's other askers in #1466's stack of diamonds of copies, inside the analysis (each next
 * place shown, `shownProperty`; written by `toJson`; read at a property no layer stores, `propertiesOf`), #1466's
 * listing chain with every copy shown, the wide object shared below k copies (`wideShared`), and Codex r1's projected
 * feedback (`projectedFeedback`).
 */
export const SEARCH_FAMILIES: readonly WorkFamily[] = [
  {
    name: "diamonds-shown",
    measures: "#1610: each next place of the stack shown",
    program: (k) => diamonds(k, { read: "shown" }),
  },
  {
    name: "diamonds-json",
    measures: "#1610: each next place of the stack written by toJson",
    program: (k) => diamonds(k, { read: "json" }),
  },
  {
    name: "diamonds-absent",
    measures: "#1610: each next place of the stack read at a property no layer stores",
    program: (k) => diamonds(k, { read: "absent" }),
  },
  {
    name: "listing-chain-shown",
    measures: "#1610: #1466's listing chain with every copy shown",
    program: (k) => listingChain(k, { shown: true }),
  },
  {
    name: "wide-shared",
    measures:
      "#1610's control: one wide object stored below k joined copies, read through a copy too",
    program: (k) => wideShared(k),
  },
  {
    name: "projected-feedback",
    measures:
      "#1610's Codex r1 witness: a projected feedback with a store at each of k successive prefixes",
    program: (k) => projectedFeedback(k),
  },
];

/**
 * Codex r4's positive-hit dimension: k records each storing two properties of their own, each copied and storing its own
 * property below a step of its own, joined into one place and read at each property: every read's step is listed by one
 * of the k layers joined, so a read finds that layer by the place's map, never by each layer joined.
 */
function distinctSteps(k: number): readonly SourceFile[] {
  return main(
    lines(
      "let seed = {z: 1}",
      rows(
        k,
        (i) =>
          `let root${i} = seed\nroot${i}.h = hostValue\nroot${i}.j = hostValue\nlet arm${i} = root${i}\narm${i}.g${i} = hostValue`,
      ),
      "let joined = arm0",
      rows(k - 1, (i) => `joined = arm${i + 1}`),
      rows(k, (i) => `repeat joined.g${i} {}`),
      "exit",
    ),
  );
}

/**
 * Codex r2's sibling: k copies of one record, each storing its own property below `depth` steps, joined in pairs `levels`
 * times (pairs, then pairs of pairs), then all into one place, read at each property directly or through `copies`
 * copies of the place; a read asks only the layer that lists its property's first step, never a joining one.
 */
function nestedJoin(k: number, { levels = 2, depth = 1, copies = 0 } = {}): readonly SourceFile[] {
  const path = `${"g.".repeat(depth)}p`;
  const out = [
    `let seed = ${"{g: ".repeat(depth)}{z: 1}${"}".repeat(depth)}`,
    rows(k, (i) => `let arm${i} = seed\narm${i}.${path}${i} = hostValue`),
  ];
  let tops = Array.from({ length: k }, (_, i) => `arm${i}`);
  for (let level = 1; level <= levels; level++) {
    const pairs = Array.from({ length: tops.length / 2 }, (_, i) => `join${level}_${i}`);
    out.push(
      rows(
        pairs.length,
        (i) => `let ${pairs[i]} = ${tops[2 * i]}\n${pairs[i]} = ${tops[2 * i + 1]}`,
      ),
    );
    tops = pairs;
  }
  out.push(`let place = ${tops[0]}`, ...tops.slice(1).map((top) => `place = ${top}`));
  let read = "place";
  for (let i = 1; i <= copies; i++) {
    out.push(`let copy${i} = ${read}`);
    read = `copy${i}`;
  }
  return main(
    lines(
      ...out,
      rows(k, (i) => `repeat ${read}.${path}${i} {}`),
      "exit",
    ),
  );
}

export const LAYER_FAMILIES: readonly WorkFamily[] = [
  {
    name: "diamonds",
    measures: "#1466: a stack of k diamonds of copies",
    program: (k) => diamonds(k),
  },
  {
    name: "diamonds-both",
    measures: "#1466: each diamond storing into both places",
    program: (k) => diamonds(k, { both: true }),
  },
  {
    name: "diamonds-reversed",
    measures: "#1466: each next place replaced by the stored one",
    program: (k) => diamonds(k, { reverse: true }),
  },
  {
    name: "diamonds-shared",
    measures: "#1466: every second right place a copy of one shared ancestor",
    program: (k) => diamonds(k, { shared: true }),
  },
  {
    name: "diamonds-typed",
    measures: "#1466: every next place written `object`, each stored place's property misfitting",
    program: (k) => diamonds(k, { typed: true }),
  },
  {
    name: "diamonds-guarded",
    measures: "#1466: every read guarded",
    program: (k) => diamonds(k, { guarded: true }),
  },
  {
    name: "wide-join",
    measures:
      "Codex r1's B1: k copies each storing its own property below one step, joined, read at each",
    program: (k) => wideJoin(k, false),
  },
  {
    name: "wide-join-copied",
    measures: "Codex r1's B1, one layer down: the same join read through a copy of the place",
    program: (k) => wideJoin(k, true),
  },
  {
    name: "nested-join",
    measures:
      "Codex r2's sibling: the copies joined in pairs of pairs, then into one place, read at each",
    program: (k) => nestedJoin(k),
  },
  {
    name: "nested-join-copied",
    measures: "Codex r2's sibling: the pairs of pairs read through a copy of the place",
    program: (k) => nestedJoin(k, { copies: 1 }),
  },
  {
    name: "nested-join-deep",
    measures: "Codex r2's sibling: the pairs of pairs, each property below three steps",
    program: (k) => nestedJoin(k, { depth: 3 }),
  },
  {
    name: "nested-join-deep-copied",
    measures:
      "Codex r2's sibling: the pairs of pairs, each property below three steps, read through two copies",
    program: (k) => nestedJoin(k, { depth: 3, copies: 2 }),
  },
  {
    name: "nested-join-witness",
    measures:
      "Codex r2's witness: the copies joined in pairs, then into one place, read through a copy",
    program: (k) => nestedJoin(k, { levels: 1, copies: 1 }),
  },
  {
    name: "distinct-steps",
    measures:
      "Codex r4's positive hits: k joined layers, each listing a step of its own, read at each",
    program: (k) => distinctSteps(k),
  },
  {
    name: "shared-join",
    measures:
      "Codex r2's shared shape: the joined copies over a record that stores below the same step",
    program: (k) => sharedJoin(k),
  },
  {
    name: "listing-chain",
    measures: "a chain of copies each storing its own property below one step, read at its end",
    program: (k) => listingChain(k),
    main: { total: 2.733, invSteps: 3.85 },
  },
  {
    name: "listing-chain-joined",
    measures: "the chain's copies all joined into one place, read through it",
    program: (k) => listingChain(k, { joined: true }),
    main: { total: 4.804, invSteps: 7.327 },
  },
  {
    name: "listing-chain-stored",
    measures:
      "each copy joined from the one before and a stored copy of it, storing its own too, read through a copy",
    program: (k) => listingChain(k, { stored: true }),
    main: { total: 5.805, invSteps: 7.371 },
  },
  {
    name: "diamonds-unequal-depth",
    measures:
      "#1466, Astra's design review: branches of one to two and two to four copies, both stored",
    program: (k) =>
      main(
        lines(
          "let d0 = {f: hostValue, g: 1}",
          rows(k, (i) => {
            const left = Array.from({ length: 1 + (i % 2) }, (_, j) => `l${i}x${j}`);
            const right = Array.from({ length: 2 + (i % 3) }, (_, j) => `r${i}x${j}`);
            return lines(
              ...left.map((name, j) => `let ${name} = ${j === 0 ? `d${i}` : left[j - 1]}`),
              ...right.map((name, j) => `let ${name} = ${j === 0 ? `d${i}` : right[j - 1]}`),
              `${left.at(-1)}.g = hostValue`,
              `${right.at(-1)}.g = hostValue`,
              `let d${i + 1} = ${left.at(-1)}`,
              `d${i + 1} = ${right.at(-1)}`,
            );
          }),
          rows(k, (i) => `repeat d${i + 1}.g {}`),
          "exit",
        ),
      ),
  },
];
