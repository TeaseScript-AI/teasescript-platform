import {
  type WorkFamily,
  rows,
  lines,
  fields,
  cells,
  main,
  type KnownProduct,
} from "./builders.js";
import type { SourceFile } from "../../type-core-analysis.js";

/**
 * A6's chain of k dependent rejections (Sol's twelve-step witness at size k): each copy reads its source after the
 * source's misfit, so each rejection shows only in the pass after the one before it, k passes in all: passes × stores,
 * each pass charged. A gated known limit by the owner's decision
 * (docs/specifications/type-inference-accepted-record/admission.md#r4-49, option A): its doubling at k = 64 → 128 as
 * measured, re-measured and proposed with its counts on a change to admission's passes, never retuned; its trigger, a
 * realistic script reaching the allowance through cascading rejections. Beside it, copies interleaved with conditional
 * stores below their path (S6-CARRIERS §4.7, condition (b)), accepted in the same form, copies separated by calls
 * storing their source, accepted in it too, and the dormant meetings a fitting ring makes owed again (#1338, the
 * owner's decision of 2026-11-10, recorded in docs/RESOURCE-LIMITS.md).
 */
export const ADMISSION_KNOWN_PRODUCTS: readonly KnownProduct[] = [
  {
    name: "A6-chain",
    measures: "A6: a chain of k rejections, every copy taken after its source's misfit",
    // 552,834 / 2,133,218 units at k = 64, 128, k + 2 passes (3.9139, the allowance reached at k = 487), each pass also
    // following the structure its stores copy through the values projections and operations carry (F2, the carrier
    // walk); 557,189 / 2,150,117 before that walk (3.9141, k = 485); at the measurement 526,905 / 2,032,217 (3.9120),
    // each pass charging its index of the previous pass's rejections (3.908 before, 452,803 / 1,744,803) and its
    // literals' contributions by path (3.9103 before, 496,487 / 1,914,055)
    measured: 3.92,
    program: (k) =>
      main(
        lines(
          "let v0 = 0",
          'v0 = "x"',
          rows(k, (i) => `let v${i + 1} = v${i}\nv${i + 1} = "x"`),
          `let final: integer = v${k}`,
          "exit",
        ),
      ),
  },
  {
    name: "A6-ring-dormant-meetings-list",
    measures:
      "#1338: k copies of a record holding a fitting ring in one property, each stored and listed beside the record",
    // 663,718 / 2,340,824 units at k = 64, 128 in both orders (3.5867; sharing off 3.6106; 3.7754 at 128 → 256), the
    // allowance reached at k = 482
    measured: 3.59,
    program: (k) => ringDormantMeetings(k, "list"),
  },
  {
    name: "A6-ring-dormant-meetings-place",
    measures:
      "#1338: k copies of a record holding a fitting ring in one property, each stored and merged with the record",
    // 414,257 / 1,371,798 units at k = 64, 128 in both orders (3.3649; sharing off 3.4078; 3.6369 at 128 → 256), the
    // allowance reached at k = 653
    measured: 3.37,
    program: (k) => ringDormantMeetings(k, "place"),
  },
  {
    name: "A2-interleaved-conditional-copies",
    measures:
      "§4.1, condition (b): k copies of a k-field record of named host data, each after a conditional store below it",
    // A gated known limit by the owner's decision (option A): each copy sees one more conditional store below the
    // copied path, so each has its own signature, k classes, each answered at each of the k fields read (S6-CARRIERS
    // §4.7's first unmerged shape; a rule beyond the class rule merges them). 377,525 / 1,357,501 units at k = 64, 128
    // in both orders (3.6080; 3.6222 before Codex r23's repairs, 3.6236 earlier); the allowance
    // reached at k = 618; at k = 1,024 82,410,069 units under a raised test allowance, 274.7 % of its 30,000,000 (the
    // analysis itself stops at the allowance with the budget error)
    measured: 3.63,
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {nested: {${fields(k, () => "[1, raw][1]")}}}`,
          `let box = {${fields(k, () => "null")}}`,
          rows(k, () => "if raw != null {\n  root.nested.f0 = 1\n}\nbox = root.nested"),
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A2-copies-separated-by-storing-calls",
    measures:
      "§4.1, condition (b): k copies of a global another callable stores, each after a call storing it, at k fields",
    // A gated known limit by the owner's decision (option A): each copy reads the global after one more
    // call that stores it, so each has its own snapshot, k entries of the literal, each read at each of the k
    // fields (S6-CARRIERS §4.7's second unmerged shape, copies separated by calls while the source is owned away; a rule
    // beyond the class rule, or S6c's normalization, merges them). 190,319 / 660,474 units at k = 64, 128 in both orders
    // (3.5213; `main` 1.99, the output linear), without the narrowing index since #1251 (194,553 / 669,322 and 3.4908
    // before), X6's searches of the global's events charged by comparison since #1221 (132,548 / 453,830 and 3.4742).
    // Under #1221's charges the allowance was reached at k = 911 (1,129 before); since #1251 k = 911 completes
    // (29,943,385 units)
    measured: 3.53,
    program: (k) =>
      main(
        lines(
          "global g = hostValue",
          "function bump {\n  g = 2.0\n  return 0\n}",
          `let out = [${cells(k, "g, bump()")}][0]`,
          `out = {${fields(k, () => "1")}}`,
          rows(k, (i) => `repeat out.f${i} {}`),
          "exit",
        ),
      ),
  },
];

/**
 * S6-CARRIERS §4.5, §4.7 and S6c: k adds of one record to one list, a choice of k options of one
 * record, and a literal of k `get`s of one list with one default, every field read; plain, and with a root of host data
 * whose fields admission reads (Astra r5 B2); the same through k stable aliases of the source (a chain whose first link
 * is a direct alias, `get`s whose alias writers cross, adds of aliases) and adds of two sources in two blocks (reviews r1, r2):
 * each class and boundary once, not every combination (the owner's test-cost rule). Adds of several
 * sources strictly in turn keep the chain's one step per add per path, which the PR measures. The value side reads each class once per field (S6c: a run of adds of one
 * class answers as its third add, `ExactPath`; a choice's options and a literal's computed values by their classes,
 * `Contract.classOf`), so every counter grows with the program (§3.3's gate; the known-product gates of S6 are gone).
 */
export const ADMISSION_SAME_SOURCES: readonly WorkFamily[] = [
  {
    name: "A5-same-source-adds",
    measures: "§4.5, A5: k `xs.add(root)` of one k-field record, every field of `xs[0]` read",
    // 42,163 / 84,912 units at k = 64, 128 in both orders (2.0213; `main` 41,382 / 83,363)
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let xs = []",
          rows(k, () => "xs.add(root)"),
          rows(k, (i) => `repeat xs[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-same-source-choices",
    measures: "§4.5, A8: a choice of k options whose value is one k-field record, every field read",
    // 37,733 / 75,524 units at k = 64, 128 in both orders (2.0089; `main` 58,319 / 157,678, 2.71, the value side's
    // choice items one per option at each field read)
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          `let box = askChoice ${Array.from({ length: k }, (_, i) => `{text: "a${i}", value: root}`).join(", ")}`,
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-same-source-gets",
    measures:
      "S6c, A8: a literal of k `xs.get(0, default: root)` of one k-field record, every field read",
    // 51,535 / 103,047 units at k = 64, 128 in both orders (2.0094; `main` 112,830 / 348,534, 3.10, the literal's
    // computed values each read at each field, `LiteralIndex.others`)
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let xs = [root]",
          `let box = [${cells(k, "xs.get(0, default: root)")}]`,
          rows(k, (i) => `repeat box[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  // reviews r2, r3 (S6c): `get`s of aliases whose writers cross, and a chain of aliases as options and as defaults
  {
    name: "A8-same-source-crossed-alias-gets",
    measures:
      "S6c, A8: k `list_i.get(0, default: alias_(k-1-i))`, aliases of one list and one record whose writers cross",
    // receivers' alias writers ascending, defaults' descending (review r3 B1): no value's writers all come first
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let xs = [root]",
          rows(k, (i) => `let list${i} = xs`),
          rows(k, (i) => `let alias${i} = root`),
          `let box = [${Array.from({ length: k }, (_, i) => `list${i}.get(0, default: alias${k - 1 - i})`).join(", ")}]`,
          rows(k, (i) => `repeat box[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  ...(["choices", "gets"] as const).map((use) => ({
    name: `A8-same-source-chained-alias-${use}`,
    measures: `S6c, A8: k aliases of one k-field record, each of the one before, as ${use === "choices" ? "options of one choice" : "`get` defaults in one literal"}, every field read`,
    // 47,447 / 94,966 and 72,526 / 145,230 units at k = 64, 128 (2.0078, 2.0099; `main` 3.46, 3.64)
    program: (k: number) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let xs = [root]",
          "let alias0 = root",
          rows(k - 1, (i) => `let alias${i + 1} = alias${i}`),
          use === "choices"
            ? `let box = askChoice ${Array.from({ length: k }, (_, i) => `{text: "${i}", value: alias${i}}`).join(", ")}`
            : `let box = [${Array.from({ length: k }, (_, i) => `xs.get(0, default: alias${i})`).join(", ")}]`,
          rows(k, (i) => (use === "choices" ? `repeat box.f${i} {}` : `repeat box[0].f${i} {}`)),
          "exit",
        ),
      ),
  })),
  // Astra r5 B2: the same with a root of unknown-bearing fields, whose adds and options admission reads at every field:
  // an add's class and a choice's options of one snapshot read once (S6-CARRIERS §4.5)
  {
    name: "A5-same-source-adds-unknown",
    measures:
      "§4.5, A5: k `xs.add(root)` of one k-field record of host data, every field of `xs[0]` read",
    // 96,856 / 195,175 units at k = 64, 128 in both orders (2.0233; `main` 341,464 / 1,208,423, 3.55, the value side's
    // exact add chain walked per field)
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          "let xs = []",
          rows(k, () => "xs.add(root)"),
          rows(k, (i) => `repeat xs[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  // review r1/r2 (S6c): adds of one source in two blocks, each a run of one class, the second after another source
  {
    name: "A5-two-blocks-adds-unknown",
    measures:
      "S6c, A5: k / 2 adds of each of two k-field records of host data, in two blocks, every field read",
    // 161,051 / 324,558 units at k = 64, 128 in both orders (2.0231; `main` 389,088 / 1,304,083, 3.36)
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          `let other = {${fields(k, () => "[2, raw][1]")}}`,
          "let xs = []",
          rows(k, (i) => (i < k / 2 ? "xs.add(root)" : "xs.add(other)")),
          rows(k, (i) => `repeat xs[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A5-same-source-alias-adds-unknown",
    measures:
      "S6c, A5: k adds of k stable aliases of one k-field record of host data, every field read",
    // 110,704 / 223,221 units at k = 64, 128 in both orders (2.0236; `main` 387,427 / 1,366,248, 3.54)
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          rows(k, (i) => `let alias${i} = root`),
          "let xs = []",
          rows(k, (i) => `xs.add(alias${i})`),
          rows(k, (i) => `repeat xs[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-same-source-choices-unknown",
    measures:
      "§4.5, A8: a choice of k options whose value is one k-field record of host data, every field read",
    // 82,323 / 165,189 units at k = 64, 128 in both orders (2.0148; `main` 195,133 / 620,207, 3.19)
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          `let box = askChoice ${Array.from({ length: k }, (_, i) => `{text: "a${i}", value: root}`).join(", ")}`,
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  // #1077: a class of stores checked at a path that each of its members reaches as its own candidate too (an add at
  // its element, directly and through its list; a return into a written result, A9), each member checked once
  {
    name: "A5-same-source-adds-decided-element",
    measures:
      "A5, #1077: k `xs.add(root)` of one host-bearing number into a list its initializer types, k reads of its last",
    program: (k) =>
      main(
        lines(
          "let root = [1.5, hostValue].first",
          "let xs = [1.5]",
          rows(k, () => "xs.add(root)"),
          rows(k, () => "repeat xs.last {}"),
          "exit",
        ),
      ),
  },
  {
    name: "A5-same-source-add-alls-decided-element",
    measures:
      "A5, #1077: k `xs.addAll(more)` of one list of a host-bearing number into a list its initializer types, k reads",
    program: (k) =>
      main(
        lines(
          "let root = [1.5, hostValue].first",
          "let more = [root]",
          "let xs = [1.5]",
          rows(k, () => "xs.addAll(more)"),
          rows(k, () => "repeat xs.last {}"),
          "exit",
        ),
      ),
  },
  {
    name: "A9-same-source-returns-written-result",
    measures:
      "A9, #1077: k + 1 returns of one list of a host-bearing number from a function whose result is `number[]`, k calls",
    program: (k) =>
      main(
        lines(
          "let root = [1.5, hostValue].first",
          "let more = [root]",
          "function pick(c): number[] {",
          rows(k, (i) => `if c == ${i} {\nreturn more\n}`),
          "return more",
          "}",
          rows(k, (i) => `let picked${i} = pick(${i})`),
          "exit",
        ),
      ),
  },
];

/**
 * one family per site of the value side's discovery that a class reached only by `Contract.classOf` keys,
 * each of one source read at k fields (the PR's inventory; the other sites' families are `ADMISSION_SAME_SOURCES` and
 * `ADMISSION_INGRESS_PRESETS`): a choice's computed options (review r4 B1) and its literal ones, a literal's `get`s
 * whose defaults are `get`s, adds of literals of host data (the exact add chain's runs and the prefix's entries), and a
 * literal's parses of host data (#1196).
 */
export const VALUE_CLASS_SITES: readonly WorkFamily[] = [
  {
    name: "S6c-choice-crossed-gets",
    measures:
      "TABLE r4.85, review r4 B1: a choice of k `l_i.get(0, default: a_(k-1-i))`, aliases of one list and one record, every field read",
    // 83,231 / 166,448 units at k = 64, 128 in both orders (2.0059; `main` 375,053 / 1,355,246, 3.62: the choice's
    // options read one by one at each field, a computed value having no read class)
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let xs = [root]",
          rows(k, (i) => `let l${i} = xs`),
          rows(k, (i) => `let a${i} = root`),
          `let box = askChoice ${Array.from({ length: k }, (_, i) => `{text: "${i}", value: l${i}.get(0, default: a${k - 1 - i})}`).join(", ")}`,
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "S6c-choice-records",
    measures:
      "TABLE r4.85: a choice of k records `{g: a_i}` of aliases of one record, every field read",
    // 69,454 / 139,052 units at k = 64, 128 (2.0071, reversed 2.0069; `main` 212,767 / 732,257, 3.45)
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          rows(k, (i) => `let a${i} = root`),
          `let box = askChoice ${Array.from({ length: k }, (_, i) => `{text: "${i}", value: {g: a${i}}}`).join(", ")}`,
          rows(k, (i) => `repeat box.g.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "S6c-nested-defaults",
    measures:
      "TABLE r4.85: a literal of k `l_i.get(0, default: l_(k-1-i).get(0, default: a_i))` of one list and one record, every field read",
    // 99,659 / 200,084 units at k = 64, 128 in both orders (2.0134; `main` 429,058 / 1,545,947, 3.61)
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let xs = [root]",
          rows(k, (i) => `let l${i} = xs`),
          rows(k, (i) => `let a${i} = root`),
          `let box = [${Array.from({ length: k }, (_, i) => `l${i}.get(0, default: l${k - 1 - i}.get(0, default: a${i}))`).join(", ")}]`,
          rows(k, (i) => `repeat box[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  // each other operation family that composes below its root, its members k values of one source in one
  // choice of k options, every field read
  ...(
    [
      [
        "selections",
        (i: number) => `[a${i}].first`,
        "review r5 B1: an element selection of a literal",
      ],
      ["properties", (i: number) => `({g: a${i}}).g`, "a property of a literal"],
      ["otherwises", (i: number) => `maybe otherwise a${i}`, "an `otherwise` of a null-or-record"],
      ["calls", () => "give()", "a call's result"],
      ["loads", (i: number) => `load("k", default: a${i})`, "a `load` landing in no written type"],
      ["removals", (i: number) => `[a${i}].removeFirst()`, "a removal's result"],
      ["copies", (i: number) => `[a${i}].take(1)[0]`, "an element of a copy"],
      ["sums", (i: number) => `([a${i}] + [a${i}])[0]`, "an element of a list `+`"],
      ["choices", (i: number) => `askChoice {text: "a", value: a${i}}`, "a choice's answer"],
    ] as const
  ).map(([family, member, what]): WorkFamily => ({
    name: `S6c-choice-${family}`,
    measures: `TABLE r4.87: a choice of k options whose values are ${what} of aliases of one k-field record, every field read`,
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          rows(k, (i) => `let a${i} = root`),
          "function give {\n  return root\n}",
          "let maybe = [null, root][0]",
          `let box = askChoice ${Array.from({ length: k }, (_, i) => `{text: "${i}", value: ${member(i)}}`).join(", ")}`,
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  })),
  // review r6 B2: adds of one typed ingress of one default, each its own source, at the prefix entries and the add run
  ...(
    [
      ["load", 'load("saved", default: seed)'],
      ["parse", 'fromJson("{}", default: seed, files: false)'],
    ] as const
  ).map(([kind, ingress]): WorkFamily => ({
    name: `S6c-${kind}-adds`,
    measures: `TABLE r4.87, review r6 B2: k adds of \`${ingress}\` of one k-field record, every field of the last read`,
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          "let gathered = []",
          rows(k, () => `gathered.add(${ingress})`),
          rows(k, (i) => `repeat gathered.last.f${i} {}`),
          "exit",
        ),
      ),
  })),
  {
    name: "S6c-record-adds-unknown",
    measures:
      "TABLE r4.85: k `ys.add({g: a_i})` of aliases of one k-field record of host data, every field read",
    // 152,934 / 307,973 units at k = 64, 128 in both orders (2.0197; `main` 487,159 / 1,729,478, 3.56: the exact
    // add chain walked per field, a literal having no read class)
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          rows(k, (i) => `let a${i} = root`),
          "let ys = []",
          rows(k, (i) => `ys.add({g: a${i}})`),
          rows(k, (i) => `repeat ys[0].g.f${i} {}`),
          "exit",
        ),
      ),
  },
  // #1196: a literal's parses of one host input with one default, each its own ingress, by the input's form: a read of
  // a host global, its projection and its element, which had no class (the leaf is the read's own), against a named
  // input and constant text, the controls. 47,078 / 94,472, 50,606 / 101,520 and 62,122 / 124,778 units at k = 64, 128
  // in both orders (2.0130, 2.0118, 2.0140; `main` 83,099 / 240,253, 86,307 / 246,661 and 95,968 / 266,208, 2.90, 2.87,
  // 2.78: each parse read at each field); the controls 2.0136 and 2.0122 on both
  ...(
    [
      ["direct", "hostValue"],
      ["projected", "hostValue.text"],
      ["indexed", "[hostValue][0]"],
      ["named", "raw"],
      ["constant", '"{}"'],
    ] as const
  ).map(([form, input]): WorkFamily => ({
    name: `I1196-${form}-input-parses`,
    measures: `#1196: a literal of k \`fromJson(${input}, default: seed, files: false)\` of one k-field record, every field read`,
    program: (k) =>
      main(
        lines(
          ...(form === "named" ? ["let raw = hostValue"] : []),
          `let seed = {${fields(k, () => "1")}}`,
          `let box = [${cells(k, `fromJson(${input}, default: seed, files: false)`)}]`,
          rows(k, (i) => `repeat box[0].f${i} {}`),
          "exit",
        ),
      ),
  })),
  // #1203: k loads of a computed key, one class, each read below its root at every field (F19: host data whatever the
  // path), the issue's shape and every key form beside every default
  {
    name: "I1203-computed-loads",
    measures: "#1203: a list of k `load(hostValue, default: 0)`, a field of its first read k times",
    // 36,641 / 73,481 units at k = 64, 128 in both orders (2.0132; `main` 56,667 / 154,499, 2.74: each load read at
    // each field)
    program: (k) =>
      main(
        lines(
          `let box = [${cells(k, "load(hostValue, default: 0)")}]`,
          rows(k, (i) => `repeat box[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "I1203-computed-load-forms",
    measures:
      "#1203: a list of k loads whose keys are a host value, a variable, a property, an element and a sum, their defaults `null`, a number, records of their own fields (a class each) and a choice of a list's buttons (no class), then a record added (the contract side), a field of its first read k times",
    // 56,979 / 113,229 units at k = 64, 128 in both orders (2.0130; `main` 85,065 / 226,755, 2.70; 2.32 with one
    // answer per class of loads, a class per default, #1208 review r1; `mergeItems` 3.11 where a load needs its
    // default's class, review r3)
    program: (k) => {
      const keys = ["hostValue", "key", "names.key", "keys[0]", 'key + "1"'];
      const defaults = (i: number): string =>
        ["null", "0", `{a${i}: 1}`, `{f0: {a${i}: 1}}`, "(askChoice [1, 2])"][(i * 2) % 5]!;
      return main(
        lines(
          'let key = "k"\nlet names = {key: "k"}\nlet keys = ["k"]',
          `let box = [${Array.from({ length: k }, (_, i) => `load(${keys[i % 5]}, default: ${defaults(i)})`).join(", ")}]`,
          "box.add({f0: 1})",
          rows(k, (i) => `repeat box[0].f${i} {}`),
          "exit",
        ),
      );
    },
  },
  {
    name: "I1203-written-loads",
    measures:
      "#1203: k loads into a written `object[]` (defaults of their own fields, and a number that does not fit) and k into a written `integer[]`, a record added to the first, a field of each list's first element read k times",
    // 97,092 / 194,520 units at k = 64, 128 (2.0217; reversed 2.0216; `main` 145,078 / 388,810, 2.70; 2.43 while a
    // load landing in a written type was read at every field, before the lead lifted that exclusion on #1208)
    program: (k) => {
      const defaults = (i: number): string =>
        [`{a${i}: 1}`, `{f0: {a${i}: 1}}`, "(askChoice [{a: 1}, {b: 2}])", `{a${i}: 1}`, "0"][
          i % 5
        ]!;
      return main(
        lines(
          'let key = "k"',
          `let box: object[] = [${Array.from({ length: k }, (_, i) => `load(${i % 2 === 0 ? "hostValue" : "key"}, default: ${defaults(i)})`).join(", ")}]`,
          `let ints: integer[] = [${cells(k, "load(hostValue, default: 0)")}]`,
          "box.add({f0: 1})",
          rows(k, (i) => `repeat box[0].f${i} {}`),
          rows(k, (i) => `repeat ints[0].f${i} {}`),
          "exit",
        ),
      );
    },
  },
  // #1210: a literal of k projections of one host read, bare or in records, read at k typed fields. Each keeps its own
  // leaf and its own landing stop, while the literal's entry, its elements' identity and their conflict class stay
  // shared (Codex review r1 B1: a fresh identity per projection read each element at each field in admission's
  // `literalElements`, 3.01 and 3.14). 34,422 / 68,854 and 52,186 / 104,378 units at k = 64, 128 in both orders
  // (2.0074, 2.0050; `main` 33,152 / 66,048 and 51,044 / 101,828: each keeps its own exact entry and stop)
  ...(
    [
      ["bare", "hostValue.root", "box[0]"],
      ["record", "{q: hostValue.root}", "box[0].q"],
    ] as const
  ).map(([form, member, receiver]): WorkFamily => ({
    name: `I1210-${form}-projected-reads`,
    measures: `#1210: a literal of k \`${member}\`, read at k typed fields of \`${receiver}\``,
    program: (k) =>
      main(
        lines(
          `let box = [${cells(k, member)}]`,
          rows(k, (i) => `let n${i}: integer = ${receiver}.f${i}`),
          "exit",
        ),
      ),
  })),
];

/**
 * Product (c) of W34's class: k literals of two typed ingresses (a `load` or a parse) of one k-field record default
 * added to one list, every field read. Each literal holding an ingress is its own source, so the key's
 * contract met k entries at each of the k reads (S4's product); S6c reads the entries of one shape once per field where
 * no unknown answers there (an unknown's ingress stores are each entry's own, C9), so every counter grows with the
 * program (§3.3's gate): 90,737 / 182,712 and 92,017 / 185,016 units at k = 64, 128 (2.0181, 2.0142; `main` 3.17, 3.16).
 */
export const ADMISSION_INGRESS_PRESETS: readonly WorkFamily[] = [
  ["A8-added-load-presets", 'load("k", default: seed)'],
  ["A8-added-parse-presets", 'fromJson("{}", default: seed)'],
].map(([name, ingress]) => ({
  name: name!,
  measures: `§8, A8: k literals of two \`${ingress}\` added to one list, every field read (Codex r12, Astra r2 D-W1)`,
  program: (k: number) =>
    main(
      lines(
        `let seed = {${fields(k, () => "1")}}`,
        "let xs = []",
        rows(k, () => `xs.add([${ingress}, ${ingress}])`),
        rows(k, (i) => `let shown${i}: integer = xs[0][0].f${i}`),
        "exit",
      ),
    ),
}));

/**
 * Read chains through nested literals (S6's PR, "Inherited products"; S6c): a list nested k deep read through k
 * `.first`, the same around a record read through k index steps, and a record nested k deep read through its k
 * properties. Each link reads a key one step longer, so the k keys' contracts and their texts grow with the chain's
 * depth (a lookup costs the key's depth): gated known limits
 * (docs/specifications/type-inference-accepted-record/solver-and-work.md#r4-83) at their measured 64 → 128 step, not a
 * bound at larger sizes; reconsidered when a realistic chain approaches the allowance. On `main` the `.first` chain
 * grew as 2^k (each selection read its owner twice, at its step and whole, neither once: the allowance at k = 20); S6c
 * reads a selection's whole answer once per value, and a projection's path scans its member steps once.
 */
export const READ_CHAIN_PRODUCTS: readonly KnownProduct[] = [
  {
    name: "F12-first-chain",
    measures: "F12, §8: a list nested k deep read through k `.first` into a written destination",
    // 125,852 / 493,911 units at k = 64, 128 (4.0137; reversed 494,215, 4.0161): S8 part 3 makes each key prefix of
    // the literal's paths once (admission's `groups`) and walks no held literal's identity again (`#collectMarks`),
    // where S8 part 2 charged 204,495 / 982,598 (4.9150); `main` before S6c stops at the allowance from k = 20
    measured: 4.02,
    program: (k) =>
      main(
        lines(
          `let value = ${"[".repeat(k)}1${"]".repeat(k)}`,
          `let n: integer = value${".first".repeat(k)}`,
          "exit",
        ),
      ),
  },
  {
    name: "F12-index-chain",
    measures:
      "F12, §8: a list nested k deep around a 4-field record of host data, each field read through k index steps",
    // 252,377 / 922,560 units at k = 64, 128 (3.8340; reversed 3.8325; S8 part 2 346,019 / 1,469,854, 4.4550; `main`
    // 707,530 / 4,318,378, 6.4008)
    measured: 3.84,
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(4, () => "[1, raw][1]")}}`,
          `let box = ${"[".repeat(k)}root${"]".repeat(k)}`,
          rows(4, (i) => `repeat box${"[0]".repeat(k)}.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "F12-member-chain",
    measures:
      "F12, §8: a record nested k deep read through its k properties into a written destination",
    // 75,901 / 293,585 units at k = 64, 128 in both orders (3.9216; `main` 261,675 / 1,496,830, 5.80)
    measured: 3.93,
    program: (k) =>
      main(
        lines(
          `let value = ${Array.from({ length: k }, (_, i) => `{m${i}: `).join("")}1${"}".repeat(k)}`,
          `let n: integer = value${Array.from({ length: k }, (_, i) => `.m${i}`).join("")}`,
          "exit",
        ),
      ),
  },
];

/**
 * #1338's family: a record of k meeting properties beside a fitting whole-copy ring in `side`, copied k times, each copy
 * storing one property and then listed (`elements`) or merged (`meet`) with the record. A containment whose node holds a
 * ring owes all its meetings (#1311's conservative exception in `touch.ts`), so each copy owes and decides the k
 * unrelated meetings again. This gate catches work per owed meeting growing with k; the exception's removal fails
 * cells' B1 ring witness and its widening work-b's dormant-meetings gate; a widening that leaves those ring-free
 * families linear fails none of the three.
 */
function ringDormantMeetings(k: number, form: "list" | "place"): readonly SourceFile[] {
  return main(
    lines(
      "let ti: integer = 7",
      "let r0 = {v: ti}",
      "let r1 = {v: ti}",
      "r0 = r1",
      "r1 = r0",
      `let exact = {side: r0, ${fields(k, () => "ti")}}`,
      `let fraction = {side: r0, ${fields(k, () => "1.5")}}`,
      "let container = fraction",
      "container = exact",
      rows(k, (i) =>
        lines(
          `let alias${i} = container`,
          `alias${i}.f0 = ti`,
          form === "list"
            ? `let final${i} = [container, alias${i}]`
            : lines(`let final${i} = container`, `final${i} = alias${i}`),
        ),
      ),
      "exit",
    ),
  );
}

/** k adds of `n` records of host data in turn, each field read: a mixed-add cycle's program. */
function cycleOfSourcesAdds(n: number, k: number): readonly SourceFile[] {
  return main(
    lines(
      "let raw = hostValue",
      rows(n, (j) => `let s${j} = {${fields(k, () => `[${j}, raw][1]`)}}`),
      "let xs = []",
      rows(k, (i) => `xs.add(s${i % n})`),
      rows(k, (i) => `repeat xs[0].f${i} {}`),
      "exit",
    ),
  );
}

/**
 * Adds of several sources into one list strictly in turn (S6c's review r1, r2 B4): an add's certainty depends on the
 * state the adds before it leave, so each add of a mixed run is answered at each field read. Gated known limits at
 * their measured 64 → 128 step (in the source order only on CI,
 * docs/specifications/type-inference-accepted-record/sharing.md#r4-85), not a bound at larger sizes; reconsidered when
 * a realistic straight-line run of dozens of alternating adds of several sources into one list appears. A script writes
 * tens of such adds at most (a loop body is one add to the analysis); two alternating sources reach the allowance near
 * 650 adds (29,924,630 units at 647 since #1221 charges the event searches by comparison). The sound fix, an
 * order-aware summary of a mixed run, is a redesign of the exact add chain's representation that buys linear work only
 * beyond those tens; the cheaper forms are unsound (a window of several classes dropped a warning and its check, r2 B4)
 * or share nothing (a prefix memo keyed by the class sequence has k keys).
 */
export const MIXED_ADD_PRODUCTS: readonly KnownProduct[] = [
  {
    name: "A5-two-sources-alternating-adds",
    measures: "§3.3: k adds alternating between two records of host data, each field read",
    // 405,404 / 1,336,783 units at k = 64, 128 in both orders (3.3102)
    measured: 3.36,
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          `let other = {${fields(k, () => "[2, raw][1]")}}`,
          "let xs = []",
          rows(k, (i) => (i % 2 === 0 ? "xs.add(root)" : "xs.add(other)")),
          rows(k, (i) => `repeat xs[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A5-three-sources-adds",
    measures: "§3.3: k adds of three records of host data in the turn a, b, c, b, each field read",
    // 470,597 / 1,483,590 units at k = 64, 128 in both orders (3.1642)
    measured: 3.22,
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let a = {${fields(k, () => "[1, raw][1]")}}`,
          `let b = {${fields(k, () => '["s", raw][1]')}}`,
          `let c = {${fields(k, () => "[2.5, raw][1]")}}`,
          "let xs = []",
          rows(k, (i) => `xs.add(${"abcb"[i % 4]})`),
          rows(k, (i) => `repeat xs[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A5-cycle-of-8-sources-adds",
    measures: "§3.3: k adds of 8 records of host data in turn, each field read",
    // 740,812 / 2,008,769 units at k = 64, 128 in both orders (2.7212)
    measured: 2.78,
    program: (k) => cycleOfSourcesAdds(8, k),
  },
  {
    name: "A5-cycle-of-9-sources-adds",
    measures: "§3.3: k adds of 9 records of host data in turn, each field read",
    // 798,340 / 2,124,045 units at k = 64, 128 (2.6700; reversed 2.6699)
    measured: 2.73,
    program: (k) => cycleOfSourcesAdds(9, k),
  },
];
