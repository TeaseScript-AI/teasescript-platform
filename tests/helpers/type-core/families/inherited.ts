import { type WorkFamily, rows, lines, fields, main, copiesOf } from "./builders.js";

/**
 * A4 through copies' work (the owner's reviewer's F1 on #1049): a root of k fields, each a copy of one
 * written binding, and k whole copies of it with no field read, as a chain, a fan-out and one destination stored k
 * times; k objects with a written field, one other field of each stored into one list a copy then reads (his second
 * witness: the scan resumed, never taken again); and their controls: plain fields, one dimension fixed, one field read,
 * the root changed between its copies, each copy storing its own field, those copies held in one literal, cycles of
 * copies the root feeds held in one literal, each copy replaced by another record, the chain closed into a cycle, the
 * root copied into itself at another path; review r3's shapes (a read stored into each copy's own field, literals
 * holding the root read into one list, copies replaced by aliases that store their own field), the design review's
 * and reviews r5's to r7's (two roots met with a narrow projection each, a chain's last copy read at every field, a chain
 * of own fields copied beside a small record each, distinct records held in two lists), and Astra's (a copy storing its
 * plain fields with its written ones read, a copy of a copy storing below each record read whole). A copy costs its own
 * divergences, never its source's every field; each is gated with the sharing off too.
 */
export const INHERITED_FIELD_FAMILIES: readonly WorkFamily[] = [
  ...(["chain", "fan-out"] as const).map((form): WorkFamily => ({
    name: `A4-inherited-${form}`,
    measures: `A4 through copies: a root of k written-typed fields and a ${form} of k whole copies, no field read`,
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          copiesOf(k, form),
          "exit",
        ),
      ),
  })),
  {
    name: "A4-inherited-repeated",
    measures:
      "A4 through copies: a root of k written-typed fields stored k times into one destination",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          "let a = root",
          rows(k, () => "a = root"),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-objects",
    measures:
      "A4 through copies: k records with a written field, another field of each stored into one list, read through a copy",
    program: (k) =>
      main(
        lines(
          "let copy = []",
          "let out = []",
          "let typed: integer = 1",
          rows(k, (i) => `let a${i} = {n: hostValue, p: typed}`),
          rows(k, (i) => `out = [a${i}.n]`),
          "out = [1]",
          "copy = out",
          "repeat copy[0] {}",
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-plain-chain",
    measures:
      "A4 through copies, control: a root of k plain fields and a chain of k whole copies, no written type",
    program: (k) =>
      main(lines(`let root = {${fields(k, () => "1")}}`, copiesOf(k, "chain"), "exit")),
  },
  {
    name: "A4-inherited-narrow-chain",
    measures:
      "A4 through copies, control: a root of four written-typed fields and a chain of k whole copies",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(4, () => "typed")}}`,
          copiesOf(k, "chain"),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-few-copies",
    measures:
      "A4 through copies, control: a root of k written-typed fields and a chain of four whole copies",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          copiesOf(4, "chain"),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-read",
    measures: "A4 through copies, control: A4-inherited-chain with one field of the last copy read",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          copiesOf(k, "chain"),
          `let shown: integer = a${k - 1}.f0`,
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-changed-root",
    measures:
      "A4 through copies, control: A4-inherited-fan-out with host data stored into one field of the root between its copies",
    // (each copy made after the host store owes a check of the whole root, an object node and its k typed fields, and the
    // host store one of its field: output-bound)
    output: (k) => (k - (k >> 1)) * (k + 1) + 1,
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          rows(k >> 1, (i) => `let a${i} = root`),
          "root.f0 = hostValue",
          rows(k - (k >> 1), (i) => `let b${i} = root`),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-own-fields",
    measures: "A4 through copies, control: A4-inherited-chain with each copy storing its own field",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          rows(k, (i) => `let a${i} = ${i > 0 ? `a${i - 1}` : "root"}\na${i}.f${i} = 2`),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-fed-cycles",
    measures:
      "Sol's review r2: k cycles of two whole copies each fed by the root, each copy storing its own plain field, held in one literal",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}, extra: 1}`,
          rows(k, (i) => `let a${i} = root\nlet b${i} = a${i}\na${i} = b${i}\na${i}.extra = 2`),
          `let out = [${Array.from({ length: k }, (_, i) => `a${i}`).join(", ")}]`,
          "exit",
        ),
      ),
  },
  ...(["2", "typed"] as const).map((value): WorkFamily => ({
    name: `A4-inherited-replaced${value === "typed" ? "-typed" : ""}`,
    measures: `Sol's reviews r1 B3 and r2 B2: k copies of a root of k written-typed fields, each storing its own plain field, then replaced by a record of k ${value === "typed" ? "written-typed" : "plain"} fields`,
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}, extra: 1}`,
          `let other = {${fields(k, () => value)}, extra: 1}`,
          rows(k, (i) => `let a${i} = root\na${i}.extra = 2\na${i} = other`),
          "exit",
        ),
      ),
  })),
  {
    name: "A4-inherited-closed-chain",
    measures:
      "A4 through copies, control: A4-inherited-chain closed into a cycle of whole copies, its first copy taking the last",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          copiesOf(k, "chain"),
          `a0 = a${k - 1}`,
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-fan-in",
    measures:
      "Sol's review r1 B3: k whole copies of a root of k written-typed fields, each storing its own plain field, held in one literal",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}, extra: 1}`,
          rows(k, (i) => `let a${i} = root\na${i}.extra = 2`),
          `let out = [${Array.from({ length: k }, (_, i) => `a${i}`).join(", ")}]`,
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-own-read",
    measures:
      "Sol's review r3 B2: k whole copies of a root of k written-typed fields, each storing a read of one plain binding into its own field",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          "let value = 2",
          `let root = {${fields(k, () => "typed")}, extra: 1}`,
          rows(k, (i) => `let a${i} = root\na${i}.f${i} = value`),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-projected-fan-in",
    measures:
      "Sol's review r3 B2: k literals each holding a root of k written-typed fields beside a plain field they store, their held roots read into one list",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}, extra: 1}`,
          rows(k, (i) => `let a${i} = {p: root, extra: 1}\na${i}.extra = 2`),
          `let out = [${Array.from({ length: k }, (_, i) => `a${i}.p`).join(", ")}]`,
          "exit",
        ),
      ),
  },
  ...(["2", "typed"] as const).map((value): WorkFamily => ({
    name: `A4-inherited-replaced-aliases${value === "typed" ? "-typed" : ""}`,
    measures: `Sol's review r3 B2: k copies of a root of k written-typed fields, each storing a plain field, then replaced by one of k aliases of a record of k ${value === "typed" ? "written-typed" : "plain"} fields, each alias storing a plain field`,
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}, extra: 1}`,
          `let other = {${fields(k, () => value)}, extra: 1}`,
          rows(
            k,
            (i) =>
              `let b${i} = other\nb${i}.extra = 2\nlet a${i} = root\na${i}.extra = 2\na${i} = b${i}`,
          ),
          "exit",
        ),
      ),
  })),
  {
    name: "A4-inherited-two-roots-and-one",
    measures:
      "Sol's design review B2 and review r5: k places each copying two roots of k written-typed fields, then one of k narrow projections of a wide written record",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}, extra: 1}`,
          `let other = {${fields(k, () => "typed")}, extra: 1}`,
          `let packed = {${Array.from({ length: k }, (_, i) => `p${i}: {extra: typed, tiny: typed}`).join(", ")}}`,
          rows(k, (i) => `let c${i} = root\nc${i} = other\nc${i} = packed.p${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-chain-and-one",
    measures:
      "Sol's reviews r5 and r6: a chain of k whole copies of a root of two written-typed and k plain fields, each storing its own plain field, its last copy copied by k places that each also take one of k records of three written-typed fields",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {f0: typed, f1: typed, extra: 1, ${fields(k, () => "1", "x")}}`,
          rows(k, (i) => `let a${i} = ${i > 0 ? `a${i - 1}` : "root"}\na${i}.x${i} = 2`),
          rows(
            k,
            (i) =>
              `let s${i} = {o0: typed, o1: typed, o2: typed}\nlet c${i} = a${k - 1}\nc${i} = s${i}`,
          ),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-chain-read-fields",
    measures:
      "Sol's design review B3: a chain of k whole copies of a root of k written-typed fields, its last copy's every field read into one list",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          copiesOf(k, "chain"),
          `let out = [${Array.from({ length: k }, (_, i) => `a${k - 1}.f${i}`).join(", ")}]`,
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-records-twice",
    measures:
      "Sol's review r7: k distinct records of written-typed fields held in two lists, each record a group both places hold",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          rows(k, (i) => `let r${i} = {fixed: typed, x${i}: typed}`),
          `let a = [${Array.from({ length: k }, (_, i) => `r${i}`).join(", ")}]`,
          `let b = [${Array.from({ length: k }, (_, i) => `r${i}`).join(", ")}]`,
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-disjoint-stores",
    measures:
      "Astra's review B2: a copy of a root of k written-typed and k plain fields, storing each plain field, each written one read",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}, ${fields(k, () => "1", "g")}}`,
          "let a = root",
          rows(k, (i) => `a.g${i} = 2`),
          rows(k, (i) => `let c${i} = a.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-overlap-ancestor",
    measures:
      "Astra's review r2 B2 (`forest-overlap-ancestor`): a copy of a copy of a root of k records, storing one field below each record, each record read",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "{left: typed, right: 1}")}}`,
          "let a = root",
          "let b = a",
          rows(k, (i) => `b.f${i}.right = 2`),
          rows(k, (i) => `let r${i} = b.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-self-copy",
    measures:
      "A4 through copies, control: a root of k written-typed fields copied into itself at another path (`root.q = root`), then k whole copies",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          "root.q = root",
          copiesOf(k, "fan-out"),
          "exit",
        ),
      ),
  },
];
