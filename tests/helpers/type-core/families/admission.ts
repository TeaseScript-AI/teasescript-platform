import { type WorkFamily, rows, lines, fields, cells, main } from "./builders.js";
import { INHERITED_FIELD_FAMILIES } from "./inherited.js";

/**
 * Admission (§10.3's admission combinations; the port plan's §3.3, M4 S6): the decided type over an empty, a
 * populated and a later mutated snapshot, several destinations of one source with different decided types, a rejected
 * destination beside its intact source, external ingresses merged with an opaque source, A5's candidates under k whole
 * presets of a record, A2's scan past external stores, the width of a record's written copies, a literal's records and a
 * replacement's misfits, the boundary checks of a literal's external cells, and the structure named elements bring to
 * a literal (projections of one record's lists, literals of one record's copies, or of the values operations carry of
 * it, added to a list), k method results or conversions of one class beside an object in one literal (#1078), k
 * copies of one nested preset joined into one place, each storing its own property below one step (#1078), and k
 * selections or choices nested in literals of two (G3 2c); each at size k, linear.
 */
export const ADMISSION_FAMILIES: readonly WorkFamily[] = [
  {
    name: "A2-empty-snapshot",
    measures: "A2, F9: k copies of empty lists, each decided by its own later add",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let a${i} = []\nlet b${i} = a${i}\nb${i}.add(${i})\na${i}.add("t${i}")`),
          rows(k, (i) => `let s${i}: integer = b${i}.first`),
          "exit",
        ),
      ),
  },
  {
    name: "A2-populated-snapshot",
    measures: "A2, A6: k copies of populated lists, each given an element of another kind",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let a${i} = [${i}]\nlet b${i} = a${i}\nb${i}.add("x${i}")`),
          rows(k, (i) => `repeat a${i}.first {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A2-later-mutation",
    measures: "A2, F9: k copies taken before their sources change kind",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let a${i} = [${i}]\nlet b${i} = a${i}\na${i}.add(1.5)\nb${i}.add(2)`),
          rows(k, (i) => `repeat b${i}.first {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A2-destinations",
    measures:
      "A2, A5: k destinations of one record's fields, decided by different kinds, then stored",
    program: (k) =>
      main(
        lines(
          `let source = {n: 1, s: "a", f: 1.5}`,
          rows(k, (i) => `let d${i} = source.${["n", "s", "f"][i % 3]}`),
          rows(k, (i) => `d${i} = ${["2", '"b"', "2.5"][i % 3]}`),
          rows(k, (i) => `if flagHost { d${i} = ${['"x"', "3", "true"][i % 3]} }`),
          "exit",
        ),
      ),
  },
  {
    name: "A6-rejected-destination",
    measures: "A6, F9: k destinations rejected at a field, their sources intact",
    program: (k) =>
      main(
        lines(
          rows(
            k,
            (i) => `let source${i} = {n: ${i}}\nlet copy${i} = source${i}\ncopy${i}.n = "bad"`,
          ),
          rows(k, (i) => `repeat source${i}.n {}\nrepeat copy${i}.n {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A5-presets",
    measures:
      "A5: k presets each giving one field of a k-field record another kind, all stored whole, every field read",
    program: (k) =>
      main(
        lines(
          `let state = {${fields(k, () => "0")}}`,
          rows(k, (i) => `let preset${i} = {${fields(k, (j) => (i === j ? '"t"' : "0"))}}`),
          rows(k, (i) => `if flagHost { state = preset${i} }`),
          rows(k, (i) => `let shown${i}: integer = state.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A5-presets-copied",
    measures: "A5: the same with each preset a copy of one seed changed at its own field",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "0")}}`,
          "let state = seed",
          rows(k, (i) => `let preset${i} = seed\npreset${i}.f${i} = "t"`),
          rows(k, (i) => `if flagHost { state = preset${i} }`),
          rows(k, (i) => `let shown${i}: integer = state.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A2-external-scan",
    measures:
      "A2: a k-field record replaced k times by external data before a literal decides it, every field read",
    program: (k) =>
      main(
        lines(
          "let state = hostValue",
          rows(k, () => "if flagHost { state = hostValue }"),
          `state = {${fields(k, () => "0")}}`,
          rows(k, (i) => `let shown${i}: integer = state.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A7-copied-wholes",
    measures:
      "A7: a list of k copies of one record replaced by external data, each of its k fields stored and read",
    program: (k) =>
      main(
        lines(
          `let source = {${fields(k, () => "1")}}`,
          "source = hostValue",
          `let xs = [${Array.from({ length: k }, () => "source").join(", ")}]`,
          rows(k, (i) => `xs[0].f${i} = 1\nlet shown${i}: integer = xs[0].f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A5-shared-presets",
    measures:
      "A2, A5: a k-field record replaced k times by copies of one record, then by external data, every field read",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "0")}}`,
          "let state = seed",
          rows(k, () => "if flagHost { state = seed }"),
          "state = hostValue",
          rows(k, (i) => `let shown${i}: integer = state.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A4-self-copies",
    measures:
      "A4 through copies, §8 width: a place copied into k fields of itself, a cycle of copies (Sol's round 3 B3 on #1049)",
    program: (k) =>
      main(
        lines(
          "let typed: object = {v: 1}",
          "let a = typed",
          `a = {${fields(k, () => "a", "p")}}`,
          "exit",
        ),
      ),
  },
  {
    name: "A4-wide-copies",
    measures:
      "A4, §8 width: one record of k fields, each a copy of one written binding, every field read",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let box = {${fields(k, () => "typed", "key")}}`,
          rows(k, (i) => `let result${i}: integer = box.key${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-wide-elements",
    measures: "A8, §8 width: a literal of two k-field records, each field's type one, a field read",
    program: (k) =>
      main(
        lines(
          `let rows = [{${fields(k, () => "0")}}, {${fields(k, () => "1")}}]`,
          "let shown: integer = rows.first.f0",
          "exit",
        ),
      ),
  },
  {
    name: "A6-wide-misfits",
    measures: "A6, r4.35, §8 width: a k-field record replaced by one whose every field misfits",
    program: (k) =>
      main(
        lines(
          `let box = {${fields(k, () => "0")}}`,
          `box = {${fields(k, () => '"bad"')}}`,
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "C9-merged-ingresses",
    measures:
      "C9: k places each merging two external ingresses with an opaque source, every boundary check kept",
    program: (k) =>
      main(
        lines(
          "speaker vera { custom: 1 }",
          rows(
            k,
            (i) =>
              `let v${i} = hostValue\nif flagHost { v${i} = fromJson("${i}", default: null, files: false) }\nif flagHost { v${i} = vera.custom }\nlet w${i}: integer = v${i}`,
          ),
          "exit",
        ),
      ),
  },
  {
    name: "C9-literal-cells",
    measures:
      "C9 r4.29, r4.35: k records each holding k external cells, one boundary each at its first cell",
    program: (k) =>
      main(
        lines(
          rows(
            k,
            (i) =>
              `let r${i} = {${fields(4, () => "hostValue")}}\nlet n${i}: integer = r${i}.f${i % 4}`,
          ),
          `let wide = [${Array.from({ length: k }, () => "hostValue").join(", ")}]`,
          "let first: integer = wide.first",
          "exit",
        ),
      ),
  },
  {
    name: "A8-projected-copies",
    measures:
      "F2, A8: k projections of a k-field record's lists named in one literal, an element read (round 10 B3)",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "[1]")}}`,
          rows(k, (i) => `let copy${i} = seed.f${i}`),
          `let xs = [${Array.from({ length: k }, (_, i) => `copy${i}`).join(", ")}]`,
          "repeat xs[0][0] {}",
          "exit",
        ),
      ),
  },
  {
    name: "A2-published-wide-copies",
    measures:
      "§8, A2, C9 r4.12: k whole copies of one record of k fields published beside named host data, every field read (Codex r17 B2)",
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          "let box = root",
          rows(k, () => "box = root"),
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  // S6-CARRIERS §4.1, §4.7: whole copies of a stable source path (R5-F1's projected copies), alias members of one class
  // where no event below the path separates them, and the conditional-write variants (Astra's fourth round M1, the
  // orchestrator's condition (a)): a conditional store below the path before or between the copies
  ...(
    [
      ["A2-projected-wide-copies", "root.nested", false, "none"],
      ["A2-projected-stable-copies", "stable", false, "none"],
      ["A2-projected-mutable-source", "root.nested", false, "store"],
      ["A2-projected-conditional-before", "root.nested", true, "before"],
      ["A2-projected-conditional-between", "root.nested", true, "between"],
    ] as const
  ).map(([name, copied, nulls, event]): WorkFamily => ({
    name,
    measures: `§4.1, A2: k + 1 whole copies of \`${copied}\`, a k-field record of named host data, every field read${event === "none" ? "" : event === "store" ? ", a store below it between the copies" : `, a conditional store below it ${event} the copies`}`,
    program: (k) => {
      const half = k >> 1;
      const copies = (count: number): string => rows(count, () => `box = ${copied}`);
      const write =
        event === "store" ? "root.nested.f0 = 1" : "if raw != null { root.nested.f0 = 1 }";
      return main(
        lines(
          "let raw = hostValue",
          `let root = {nested: {${fields(k, () => "[1, raw][1]")}}}`,
          ...(copied === "stable" ? ["let stable = root.nested"] : []),
          nulls ? `let box = {${fields(k, () => "null")}}` : `let box = ${copied}`,
          ...(event === "before" ? [write] : []),
          ...(event === "between" || event === "store"
            ? [copies(half), write, copies(k - half)]
            : [copies(k)]),
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      );
    },
  })),
  {
    name: "A2-published-wide-copies-conditional",
    measures:
      "§4.1, A2, C9 r4.12: A2-published-wide-copies with a conditional store into the record before the copies (M1)",
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          "let box = root",
          "if raw != null { root.f0 = 1 }",
          rows(k, () => "box = root"),
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  ...(["one region", "k regions"] as const).map((variant): WorkFamily => ({
    name: `A2-guarded-quiet-copies-${variant.replace(" ", "-")}`,
    measures: `§4.3, A2: k copies of a k-field record of named host data guarded in ${variant}${variant === "k regions" ? ", one unguarded" : ""}, every field read`,
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          "let box = root",
          variant === "one region"
            ? lines(
                "if root != null {",
                rows(k, () => "  box = root"),
                "}",
              )
            : lines(
                rows(k, () => "if root != null { box = root }"),
                "box = root",
              ),
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  })),
  {
    name: "A8-added-presets",
    measures:
      "F2, A8: k literals of one k-field record's copies added to one list, every field read (round 10 B4)",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          "let xs = []",
          rows(k, () => "xs.add([seed, seed])"),
          rows(k, (i) => `let shown${i}: integer = xs[0][0].f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-added-wrapped-presets",
    measures:
      "F2, A8: k literals of records wrapping one k-field record, added to one list, every field read (round 11)",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          "let xs = []",
          rows(k, () => "xs.add([{data: seed}, {data: seed}])"),
          rows(k, (i) => `let shown${i}: integer = xs[0][0].data.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-added-carried-presets",
    measures:
      "F2, A8: k literals of one k-field record that `otherwise` carries, added to one list, every field read (round 11 B4)",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          "let xs = []",
          rows(k, () => "xs.add([seed otherwise seed, seed otherwise seed])"),
          rows(k, (i) => `let shown${i}: integer = xs[0][0].f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-distinct-records",
    measures: "F2, A8: k records of distinct fields named in one literal (round 13 B2)",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let a${i} = {f${i}: 1}`),
          `let xs = [${Array.from({ length: k }, (_, i) => `a${i}`).join(", ")}]`,
          "exit",
        ),
      ),
  },
  {
    name: "A8-added-call-presets",
    measures:
      "F2, A8: k literals of one function's k-field result, added to one list, every field read (round 12 B3)",
    program: (k) =>
      main(
        lines(
          `function seed {\n  return {${fields(k, () => "1")}}\n}`,
          "let xs = []",
          rows(k, () => "xs.add([seed(), seed()])"),
          rows(k, (i) => `let shown${i}: integer = xs[0][0].f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-added-chained-presets",
    measures:
      "F2, A8: k literals of the end of a chain of k copies of one record, added to one list (round 12 B3)",
    program: (k) =>
      main(
        lines(
          "let a0 = {n: 1}",
          rows(k, (i) => `let a${i + 1} = a${i}`),
          "let xs = []",
          rows(k, () => `xs.add([a${k}, a${k}])`),
          "let shown: integer = xs[0][0].n",
          "exit",
        ),
      ),
  },
  {
    name: "A8-added-taken-presets",
    measures:
      "F2, A8: k literals of `take`s of a list of one k-field record, added to one list, every field read (round 11 B4)",
    program: (k) =>
      main(
        lines(
          `let seed = [{${fields(k, () => "1")}}]`,
          "let xs = []",
          rows(k, () => "xs.add([seed.take(1), seed.take(1)])"),
          rows(k, (i) => `let shown${i}: integer = xs[0][0][0].f${i}`),
          "exit",
        ),
      ),
  },
  // S6-CARRIERS §4.6, §4.7 (C9-fresh-wrappers) with Codex r20 B2 and B3: k stores of a wrapper holding a fresh host
  // value beside one k-field record, every field read; the level at the record's path holds it once
  ...(
    [
      ["payload", "{noise: hostValue otherwise null, data: root}", "data.", "box.noise"],
      ["get", "{tag: 0, slot: {data: xs.get(hostValue, default: root)}}", "slot.data.", null],
      ["projected", "({noise: hostValue otherwise null, data: root}).data", "", null],
      [
        "projected-get",
        "({noise: hostValue otherwise null, data: [root].get(0, default: root)}).data",
        "",
        null,
      ],
    ] as const
  ).map(([variant, wrapper, at, payload]): WorkFamily => ({
    name: `C9-fresh-wrappers-${variant}`,
    measures: `§4.6, C9: k stores of \`${wrapper}\`, every field of the record read`,
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let xs = [root]",
          `let box = ${wrapper}`,
          rows(k - 1, () => `box = ${wrapper}`),
          ...(payload === null ? [] : [`let n: integer = ${payload}`]),
          rows(k, (i) => `repeat box.${at}f${i} {}`),
          "exit",
        ),
      ),
  })),
  {
    name: "C9-fresh-wrappers-distinct",
    measures:
      "§4.6, C9: k wrappers of k distinct records, the last stored k times more, one field read (Codex r20 B3)",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let r${i} = {n: hostValue}`),
          "let box = {noise: hostValue otherwise null, data: r0}",
          rows(k - 1, (i) => `box = {noise: hostValue otherwise null, data: r${i + 1}}`),
          rows(k, () => `box = {noise: hostValue otherwise null, data: r${k - 1}}`),
          "say box.data.n",
          "exit",
        ),
      ),
  },
  // S6-CARRIERS §3.4 with Codex r20 B5: k merged host stores met by k consumers, each provenance node resolved once (the
  // nested own defaults of §3.2 are a gated known limit)
  ...(["reads", "typed"] as const).map((variant): WorkFamily => ({
    name: `C9-merged-leaves-${variant}`,
    measures: `§3.4: k conditional host stores of one place, k ${variant === "reads" ? "reads" : "typed copies"} of it (Codex r20 B5)`,
    program: (k) =>
      main(
        lines(
          'let flag = askBoolean "F"',
          "let pool = hostValue",
          rows(k, () => "if flag { pool = hostValue }"),
          rows(k, (i) => (variant === "reads" ? "repeat pool {}" : `let out${i}: integer = pool`)),
          "exit",
        ),
      ),
  })),
  // S6-CARRIERS §4.1: k stores of a literal whose one cell reads a k-field record of named host data, and k copies of a
  // literal index of one, every field read; each a class below its cell or path, never k candidates at every field
  ...(
    [
      ["cell", "{data: root}", ".data", ""],
      ["list-cell", "[root]", "[0]", ""],
      ["literal-index", "holder.items[0]", "", "let holder = {items: [root]}"],
    ] as const
  ).map(([variant, value, at, holder]): WorkFamily => ({
    name: `A2-alias-${variant}-copies`,
    measures: `§4.1, C1: k stores of \`${value}\` over a k-field record of named host data, every field read`,
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          ...(holder === "" ? [] : [holder]),
          `let box = ${value}`,
          rows(k, () => `box = ${value}`),
          rows(k, (i) => `repeat box${at}.f${i} {}`),
          "exit",
        ),
      ),
  })),
  // S6-CARRIERS §4.1's chains: k copies `let a(i + 1) = a(i)` of a k-field record of named host data, each copied into
  // one place, every field read; each link's read stands for the chain's end, one class
  {
    name: "A2-alias-chain-heads",
    measures:
      "§4.1, C1: k links of a chain of copies of a k-field record of named host data, each stored, every field read",
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let a0 = {${fields(k, () => "[1, raw][1]")}}`,
          rows(k, (i) => `let a${i + 1} = a${i}`),
          "let box = a0",
          rows(k, (i) => `box = a${i + 1}`),
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  // S6-CARRIERS §4.1's chains under a guard (Codex r22 F4): k copies of one snapshot whose definition is read under k
  // tests of the source's fields, every field read; the definition read's guards found once, whatever asks
  {
    name: "A2-alias-guarded-snapshot-copies",
    measures:
      "§4.1, §3.2: k copies of one snapshot read under k field tests of its source, every field read (Codex r22 F4)",
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          `if ${Array.from({ length: k }, (_, i) => `root.f${i} != null`).join(" and ")} {`,
          "  let stable = root",
          "  let box = stable",
          rows(k - 1, () => "  box = stable"),
          rows(k, (i) => `  repeat box.f${i} {}`),
          "}",
          "exit",
        ),
      ),
  },
  // §3.2 with S6-CARRIERS §4.6 (Codex r21 B1): k stores of a computed child over a k-field record, each under a test of
  // a different field, one field read; each operand read's marks below it come from the guard regions holding it, never
  // from each tested field in turn
  ...(
    [
      ["wrapped", "{data: [root].get(0, default: root)}", "data."],
      ["direct", "[root].get(0, default: root)", ""],
    ] as const
  ).map(([variant, value, at]): WorkFamily => ({
    name: `A2-guarded-computed-children-${variant}`,
    measures: `§3.2, §4.6: k stores of \`${value}\`, each under a test of another field, one field read (Codex r21 B1)`,
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "2.0")}}`,
          `let box = ${value}`,
          rows(k, (i) => `if root.f${i} != null { box = ${value} }`),
          `repeat box.${at}f0 {}`,
          "exit",
        ),
      ),
  })),
  // S6-CARRIERS §3.1 (Codex r23 F1): k reads of one host global in one literal, its element stored and decided at k
  // fields, each read; through an own read (a fallback's, a default's), inline, beside named data, as named data: each
  // occurrence its own leaf, the reads one entry of the literal, each path's decider and C1 site from its prefixes' stops
  ...(
    [
      ["own", "null otherwise [W][0]"],
      ["default", "[].get(7, default: [W][0])"],
      ["inline", "[W][0]"],
      ["mixed", "[raw, W][0]"],
      ["named", "null otherwise data"],
    ] as const
  ).map(([variant, value]): WorkFamily => ({
    name: `A2-wide-ingresses-${variant}`,
    measures: `§3.1: \`let out = ${value}\`, W k reads of \`hostValue\`, decided at k fields, each read (Codex r23 F1)`,
    program: (k) => {
      const wide = Array.from({ length: k }, () => "hostValue").join(", ");
      return main(
        lines(
          "let raw = hostValue",
          variant === "named" ? `let data = [${wide}][0]` : "",
          `let out = ${value.replace("W", wide)}`,
          `out = {${fields(k, () => "1")}}`,
          rows(k, (i) => `repeat out.f${i} {}`),
          "exit",
        ),
      );
    },
  })),
  // Codex r24 F1, F2 and their neighbours: k distinct ingresses at k fields, each its own provenance node, asked of the
  // store's index; and k host reads a call that stores nothing separates, one snapshot, with the calls'
  // results one entry as k calls of one function are, inline and beside named data
  ...(
    [
      ["fields", (k: number) => `{${fields(k, () => "hostValue")}}`],
      ["idle-index", (k: number) => `[${cells(k, "hostValue[idle()]")}][0]`],
      ["idle-cells", (k: number) => `[${cells(k, "hostValue, idle()")}][0]`],
      ["idle-cells-mixed", (k: number) => `[raw, [${cells(k, "hostValue, idle()")}][0]][1]`],
    ] as const
  ).map(([variant, value]): WorkFamily => ({
    name: `A2-wide-ingress-${variant}`,
    measures: `§3.1, r4.68 (1): \`let out = ${value(2)}\` at k, decided at k fields, each read (Codex r24 F1, F2)`,
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          "function idle { return 0 }",
          `let out = ${value(k)}`,
          `out = {${fields(k, () => "1")}}`,
          rows(k, (i) => `repeat out.f${i} {}`),
          "exit",
        ),
      ),
  })),
  // #1106: the menus a script writes, beside the nested choices (`I1106-nested-choices`): one choice
  // of k choice objects, and a list of k parenthesised choices of one each, every answer read; 13,675 / 27,371 and
  // 37,542 / 75,150 units at k = 64, 128 in both orders (2.0080, 2.0066; `main` alike, the list 23 units more)
  {
    name: "I1106-menu",
    measures: "r4.93: a choice of k choice objects of integers, its answer read k times",
    program: (k) =>
      main(
        lines(
          `let box = askChoice ${Array.from({ length: k }, (_, i) => `{text: "${i}", value: ${i}}`).join(", ")}`,
          rows(k, () => "repeat box {}"),
          "exit",
        ),
      ),
  },
  {
    name: "I1106-list-of-choices",
    measures:
      "r4.93: a list of k parenthesised choices of one choice object each, every element read",
    program: (k) =>
      main(
        lines(
          `let box = [${Array.from({ length: k }, (_, i) => `(askChoice {text: "${i}", value: ${i}})`).join(", ")}]`,
          rows(k, (i) => `repeat box[${i}] {}`),
          "exit",
        ),
      ),
  },
  // A product, linear since #1230 (admission's stop index keeps each operation's
  // evaluation key and chain once, a link onto the one around it): k nested own defaults, 3.94, 3.05 and 3.60 before,
  // and a sum of k terms of one list, 2.45 before
  nestedOwn("otherwise", (inner) => `null otherwise (${inner})`),
  nestedOwn("get", (inner) => `[1].get(7, default: ${inner})`),
  nestedOwn("load", (inner, i) => `load("k${i}", default: ${inner})`),
  {
    name: "S6c-nested-sum",
    measures:
      "TABLE r4.88: a sum of k terms of one list of a k-field record, every field of its last element read",
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let piece = [root]",
          `let gathered = ${Array.from({ length: k }, () => "piece").join(" + ")}`,
          rows(k, (i) => `repeat gathered.last.f${i} {}`),
          "exit",
        ),
      ),
  },
  ...(
    [
      ["method-results", (i: number) => `[a${i}].count(a${i})`],
      ["conversions", (i: number) => `toInteger(a${i}.f0, default: 0)`],
    ] as const
  ).map(([variant, element]): WorkFamily => ({
    name: `A8-${variant}-beside-object`,
    measures: `A8 (#1078): k ${variant.replace("-", " ")} of one class beside an object of k properties in one literal, read at each property`,
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          rows(k, (i) => `let a${i} = root`),
          `let out = [${Array.from({ length: k }, (_, i) => element(i)).join(", ")}, root]`,
          rows(k, (i) => `repeat out[0].f${i} {}`),
          "exit",
        ),
      ),
  })),
  {
    name: "A5-nested-preset-copies",
    measures:
      "A5 (#1078): k copies of one nested preset joined into one place, each storing its own property below one step, read at each property",
    program: (k) =>
      main(
        lines(
          `let initial = {nest: {${fields(k, () => "0", "p")}}}`,
          "let state = initial",
          rows(
            k,
            (i) => `let c${i} = initial\nc${i}.nest.p${i} = "bad"\nif hostValue { state = c${i} }`,
          ),
          rows(k, (i) => `let sink${i}: integer = state.nest.p${i}`),
          "exit",
        ),
      ),
  },
  // Witnesses (#1106), known products until #1417 and G3 2c: a list literal of k choices, which nests
  // them, each the last option of the one before (28,228 / 85,185 units at k = 64, 128 in both orders, 3.0550, each
  // choice's options' class text holding the ones inside, until #1417's short class ids), and the chain of k choices
  // with each option a list of two (review r1 B1; 45,550 / 156,845, 3.461, each literal's element structure walking
  // its nest, until G3 2c); and, G3 2c, a selection or a choice nested k deep around one variable, each
  // level a literal of two whose first element is the level inside; each literal's elements read their carriers'
  // transfers, each carrier's once (158,451 / 598,132 and 143,253 / 550,393 units at k = 64, 128 while each element
  // walked its whole nest)
  {
    name: "I1106-nested-choices",
    measures:
      'TABLE r4.93: `[askChoice "0", askChoice "1", …]` at k, k nested choices, its element read',
    program: (k) =>
      main(
        lines(
          `let box = [${Array.from({ length: k }, (_, i) => `askChoice "${i}"`).join(", ")}]`,
          "say box[0]",
          "exit",
        ),
      ),
  },
  {
    name: "I1106-nested-choice-lists",
    measures:
      'TABLE r4.93: `askChoice [(askChoice [(…), "alt"]), "alt"]` at k, k nested choices in lists of two, read',
    program: (k) => {
      let expression = 'askChoice "seed"';
      for (let i = 1; i < k; i += 1) expression = `askChoice [(${expression}), "alt"]`;
      return main(lines(`let box = ${expression}`, "say box", "exit"));
    },
  },
  ...(
    [
      ["selections", (inner: string) => `[${inner}, "other"][0]`],
      ["choices", (inner: string) => `askChoice [(${inner}), "other"]`],
    ] as const
  ).map(([shape, wrap]) => ({
    name: `G3-nested-${shape}`,
    measures: `G3 2c: k nested ${shape} around one variable, read`,
    program: (k: number) => {
      let value = shape === "choices" ? "askChoice seed" : "seed";
      for (let i = shape === "choices" ? 1 : 0; i < k; i += 1) value = wrap(value);
      return main(lines('let seed = "origin"', `let out = ${value}`, "say out", "exit"));
    },
  })),
  {
    name: "join-run",
    measures:
      "#1272: a run of k joined lists, the last of another type, each operand decided once and the last rejected",
    program: (k) =>
      main(
        lines(
          `let xs = [0] + ${Array.from({ length: k }, (_, i) => `[${i + 1}]`).join(" + ")} + ["x"]`,
          "say xs.length",
          "exit",
        ),
      ),
  },
  {
    name: "join-right-nested",
    measures: "#1272 (Codex r1 on #1310): k joins each holding the next in its right operand",
    program: (k) =>
      main(
        lines(
          `let xs = ${Array.from({ length: k }).reduce<string>((inner, _, i) => `[${i + 1}] + (${inner})`, "[0]")}`,
          "say xs.length",
          "exit",
        ),
      ),
  },
  {
    name: "join-right-nested-fields",
    measures:
      "#1272 (Codex r7's B3 on #1310): k joins each holding the next in its right operand, each element's property its own",
    program: (k) =>
      main(
        lines(
          `let xs = ${Array.from({ length: k }).reduce<string>((inner, _, i) => `[{p${i}: 1}] + (${inner})`, "[{lastValue: 0}]")}`,
          "say xs.length",
          "exit",
        ),
      ),
  },
  {
    name: "own-selection-stores",
    measures:
      "#1275 (Codex r1 on #1310): k stores of a receiver below an own selection, then k stores below it",
    program: (k) =>
      main(
        lines(
          "let a = {first: {last: {random: {n: 1}}}}",
          rows(k, () => "a.first.last = {random: {n: 1}}"),
          rows(k, () => "a.first.last.random.n = 2"),
          "exit",
        ),
      ),
  },
  ...INHERITED_FIELD_FAMILIES,
];

/**
 * #1310 (the lead's rule for the join check): k joins, each operand reaching the previous join's result through a
 * literal's property, a nested list element, either side of an `otherwise`, a kept variable or a copy, the joins nested to the
 * left and to the right; the first list of a written union (no error), or of whole numbers, the last join adding text
 * (an error there), or each link an object of its own property, so the composed type grows with the chain (Codex r15's
 * B1). Each operand that reaches an earlier join takes its composed type, never copied: no tree is composed again.
 */
export const JOIN_REACH_FAMILIES: readonly WorkFamily[] = (
  [
    ["property", (x: string) => `({n: ${x}}).n`],
    ["element", (x: string) => `[${x}][0]`],
    ["choice", (x: string, fallback: string) => `((${x}) otherwise ${fallback})`],
    ["choice-later", (x: string) => `([] otherwise (${x}))`],
    ["kept", null],
    ["copy", null],
  ] as const
).flatMap(([way, wrap]) =>
  [true, false].flatMap((left) =>
    (["", "-conflict", "-width"] as const).map((leaf): WorkFamily => {
      const element = (i: number): string => (leaf === "-width" ? `{p${i}: ${i}}` : `${i}`);
      const join = (x: string, i: number): string =>
        left ? `${x} + [${element(i)}]` : `[${element(i)}] + ${x}`;
      // (the width's first list a literal: a variable read beside each join of distinct properties is #1384's)
      const first = {
        "": "let xs: (integer | string)[] = [0]",
        "-conflict": "let xs = [0]",
        "-width": null,
      }[leaf];
      const last = { "": '["x"]', "-conflict": '["x"]', "-width": "[{q: 0}]" }[leaf];
      return {
        name: `join-reach-${way}-${left ? "left" : "right"}${leaf}`,
        measures: `#1310: k joins nested to the ${left ? "left" : "right"}, each reaching the last through ${{ kept: "a kept variable", copy: "a copy", choice: "an otherwise's first side", "choice-later": "an otherwise's later side", property: "a property", element: "an element" }[way]}${leaf === "-conflict" ? ", the last adding text" : leaf === "-width" ? ", each link an object of its own property" : ""}`,
        program: (k) => {
          const body: string[] = first === null ? [] : [first];
          const fallback = leaf === "-width" ? "[{p0: 0}]" : "[0]";
          let value = first === null ? "[{p0: 0}]" : "xs";
          if (wrap !== null) for (let i = 1; i <= k; i += 1) value = wrap(join(value, i), fallback);
          else {
            body.push(`let v0 = ${value}`);
            for (let i = 1; i <= k; i += 1) {
              if (way === "copy") body.push(`let c${i} = v${i - 1}`);
              body.push(`let v${i} = ${join(way === "copy" ? `c${i}` : `v${i - 1}`, i)}`);
            }
            value = `v${k}`;
          }
          return main(
            lines(
              ...body,
              `let s = ${left ? `${value} + ${last}` : `${last} + ${value}`}`,
              "say s.length",
              "exit",
            ),
          );
        },
      };
    }),
  ),
);

/** §3.2, C10: k nested own defaults of one kind around one host value (Codex r20 B4). */
function nestedOwn(variant: string, wrap: (inner: string, i: number) => string): WorkFamily {
  return {
    name: `C9-nested-own-${variant}`,
    measures: `§3.2, C10: k nested own ${variant} defaults around one host value (Codex r20 B4)`,
    program: (k) => {
      let value = "hostValue";
      for (let i = k - 1; i >= 0; i -= 1) value = wrap(value, i);
      return main(lines(`let out = ${value}`, "repeat out {}", "exit"));
    },
  };
}
