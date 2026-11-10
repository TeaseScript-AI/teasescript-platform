import type { SourceFile } from "../../type-core-analysis.js";
import { parsed } from "./builders.js";

/**
 * The member-answer oracle's own programs (S6-CARRIERS §4.1, condition (a)): Astra's two M1 witnesses (a conditional
 * store below the copied path before and between the copies), every alias form (a copy, a literal's cell, a list's, a
 * nested one, a literal index, a chain's link) beside the events its class answers through (a conditional store before
 * or between the copies, a copy under a test of its source or of a field, a store between them), literal cells beside
 * their literal's own contribution, which no alias may hold, and Astra's round-5 B1 shape (a written copy of a source
 * beside an unwritten one, at depths one and two, either first: two classes by their written types,
 * docs/specifications/type-inference-accepted-record/sharing.md#r4-72). The work test's oracle and the sharing
 * differential run them.
 */
export const ORACLE_PROGRAMS: readonly {
  readonly name: string;
  readonly files: readonly SourceFile[];
}[] = (() => {
  const witnesses = ["before", "between"].map((at) => ({
    name: `M1, the conditional store ${at} the copies`,
    files: [
      {
        path: "main.tease",
        source: [
          "let raw = hostValue",
          "let root = {nested: {f0: [1, raw][1], f1: [1, raw][1]}}",
          "let box = {f0: null, f1: null}",
          ...(at === "before"
            ? ["if raw != null { root.nested.f0 = 1 }", "box = root.nested", "box = root.nested"]
            : ["box = root.nested", "if raw != null { root.nested.f0 = 1 }", "box = root.nested"]),
          "repeat box.f0 {}",
          "repeat box.f1 {}",
          "exit",
        ].join("\n"),
      },
    ],
  }));
  // every alias form (a copy, a literal's cell, a list's, a nested one, a literal index, a chain's link) beside the
  // events its class answers through: a conditional store before or between the copies, a copy under a test of its
  // source or of a field, a store between them
  const forms = [
    ["a copy", "root.nested", "", "root.nested"],
    ["a cell", "{data: root.nested}", ".data", "root.nested"],
    ["a list cell", "[root.nested]", "[0]", "root.nested"],
    ["a nested cell", "{a: {b: root.nested}}", ".a.b", "root.nested"],
    ["a literal index", "root.items[0]", "", "root.items[0]"],
    ["a chain's link", "link", "", "root.nested"],
  ] as const;
  const aliases = forms.flatMap(([form, value, at, source]) => {
    const copy = `box = ${value}`;
    const situations: readonly (readonly [string, readonly string[]])[] = [
      ["a conditional store before", [`if raw != null { ${source}.f0 = 1 }`, copy, copy]],
      ["a conditional store between", [copy, `if raw != null { ${source}.f0 = 1 }`, copy]],
      ["a guarded copy", [copy, `if ${source} != null { ${copy} }`, copy]],
      ["a field-guarded copy", [`if ${source}.f0 != null { ${copy} }`, copy]],
      ["a store between", [copy, `${source}.f1 = 2`, copy]],
    ];
    return situations.map(([situation, steps]) => ({
      name: `${form}, ${situation}`,
      files: [
        {
          path: "main.tease",
          source: [
            "let raw = hostValue",
            "let root = {nested: {f0: [1, raw][1], f1: [1, raw][1]}, items: [{f0: 1, f1: [1, raw][1]}]}",
            "let link = root.nested",
            at === "" ? "let box = {f0: null, f1: null}" : `let box = ${value}`,
            ...steps,
            `repeat box${at}.f0 {}`,
            `repeat box${at}.f1 {}`,
            "exit",
          ].join("\n"),
        },
      ],
    }));
  });
  // a cell beside a term of its literal's own at its path, or below an object of it without the cell's property (its
  // `missing` there), plain and guarded: no alias (Codex r22 F5, r23 F2)
  const beside = (
    [
      ["[root, 2.0]", "[0]"],
      ["[{f: root}, {g: 1}]", "[0].f"],
      ["dict{a: {f: root}, b: {g: 1}}", '["a"].f'],
    ] as const
  ).flatMap(([literal, read]) =>
    [`box = ${literal}`, `if root != null {\n  box = ${literal}\n}`].map((copy) => ({
      name: `a cell beside its literal's own contribution: ${copy}`,
      files: [
        {
          path: "main.tease",
          source: `let root = 1\nlet box = ${literal}\n${copy}\nrepeat box${read} {}\nexit`,
        },
      ],
    })),
  );
  const written = [false, true].flatMap((nested) =>
    [
      ["a", "b"],
      ["b", "a"],
    ].map(([first, second]) => ({
      name: `a written copy beside a copy of its source, ${nested ? "depth two" : "depth one"}, ${first} first`,
      files: [
        {
          path: "main.tease",
          source: [
            `let raw = [${nested ? "[hostValue]" : "hostValue"}]`,
            "let a = raw",
            `let b: integer[]${nested ? "[]" : ""} = raw`,
            `let out = ${first}`,
            `out = ${second}`,
            `out = [${nested ? "[hostValue]" : "hostValue"}]`,
            'say "AFTER"',
            "exit",
          ].join("\n"),
        },
      ],
    })),
  );
  return [...witnesses, ...aliases, ...beside, ...written];
})();

/**
 * #1196's controls: values over reads of host data in one literal, choice or run of adds, each beside what a coarser
 * class would merge: a parse without a default (open) and a default with a field of host data, every form of input,
 * another default, a written destination, a guard of the input, a store of the default between parses, literals of one
 * and of two host reads, records holding host data and adds of host reads. Each keeps its own leaves, diagnostics and
 * checks: the sharing differential and the leaf comparison (`type-core-sharing.test.ts`) run them in both orders.
 */
export const DIRECT_INGRESS_PROGRAMS: readonly {
  readonly name: string;
  readonly files: readonly SourceFile[];
}[] = (
  [
    [
      "open: a parse without a default among parses of one default",
      "let seed = {f0: 1, f1: 1}",
      `let box = [${parsed("hostValue")}, ${parsed("hostValue", null)}, ${parsed("hostValue")}]`,
      "repeat box[0].f0 {}",
      "let n: integer = box[0].f1",
    ],
    [
      "open: a default's field of host data",
      "let seed = {f0: 1, f1: [1, hostValue][1]}",
      `let box = [${parsed("hostValue")}, ${parsed("hostValue.text")}, ${parsed("hostValue")}]`,
      "repeat box[0].f0 {}",
      "let n: integer = box[0].f1",
    ],
    [
      "inputs: direct, projected, indexed, named, constant and computed",
      "let raw = hostValue",
      "let seed = {f0: 1, f1: 1}",
      `let box = [${["hostValue", "hostValue.text", "[hostValue][0]", "raw", '"{}"', 'hostValue otherwise "{}"', "hostValue"].map((input) => parsed(input)).join(", ")}]`,
      "repeat box[0].f0 {}",
      "let n: integer = box[0].f1",
    ],
    [
      "defaults: two of one shape and another kind",
      "let a = {f0: 1}",
      "let b = {f0: 2.5}",
      `let box = [${parsed("hostValue", "a")}, ${parsed("hostValue", "b")}, ${parsed("hostValue", "a")}]`,
      "let n: integer = box[0].f0",
    ],
    [
      "written: parses landing in a written list beside unwritten ones",
      "let seed = [1]",
      `let ws: number[][] = [${parsed("hostValue")}, ${parsed("hostValue")}]`,
      `let w: number[] = ${parsed("hostValue")}`,
      `let box = [${parsed("hostValue")}, ws[0], w, ${parsed("hostValue")}]`,
      "let n: integer = box[0][0]",
    ],
    [
      "guarded: parses of a tested host field beside one outside the test",
      "let seed = {f0: 1}",
      `let outside = ${parsed("hostValue.t")}`,
      "if hostValue.t is string {",
      `  let box = [${parsed("hostValue.t")}, outside, ${parsed("hostValue.t")}, ${parsed("hostValue")}]`,
      "  repeat box[0].f0 {}",
      "}",
    ],
    [
      "stored: a call storing the default between parses",
      "global seed = {f0: 1}",
      "function bump {",
      "  seed.f0 = 2.5",
      '  return "{}"',
      "}",
      `let box = [${parsed("hostValue")}, ${parsed("bump()")}, ${parsed("hostValue")}]`,
      "let n: integer = box[0].f0",
    ],
    [
      "stored: the default stored between two literals of parses",
      "let seed = {f0: 1}",
      `let one = [${parsed("hostValue")}, ${parsed("hostValue")}]`,
      "seed.f0 = 2.5",
      `let two = [${parsed("hostValue")}, ${parsed("hostValue")}]`,
      "let n: integer = one[0].f0",
      "let m: integer = two[0].f0",
    ],
    [
      "literals of one and of two host reads, and one beside a known element",
      "let box = [[hostValue][0], [hostValue, hostValue][1], [hostValue, 1][0], [hostValue][0]]",
      "let n: integer = box[0]",
    ],
    [
      "choice: records holding host data, one with a second host field",
      "let seed = {f0: 1}",
      'let box = askChoice {text: "a", value: {g: hostValue, s: seed}}, {text: "b", value: {g: hostValue, h: hostValue.t, s: seed}}, {text: "c", value: {g: hostValue, s: seed}}',
      "repeat box.s.f0 {}",
      "let n: integer = box.g",
    ],
    [
      "adds: parses of host data, one of another default and one without",
      "let seed = {f0: 1, f1: 1}",
      "let other = {f0: 2.5, f1: 1}",
      "let gathered = []",
      `gathered.add(${parsed("hostValue")})`,
      `gathered.add(${parsed("hostValue")})`,
      `gathered.add(${parsed("hostValue", "other")})`,
      `gathered.add(${parsed("hostValue")})`,
      `gathered.add(${parsed("hostValue", null)})`,
      "let n: integer = gathered.last.f0",
      "let m: integer = gathered[0].f1",
    ],
    [
      "adds: host reads in a run",
      "let gathered = []",
      "gathered.add(hostValue)",
      "gathered.add(hostValue)",
      "gathered.add(hostValue.t)",
      "gathered.add(hostValue)",
      "let n: integer = gathered[0]",
    ],
  ] as const
).map(([name, ...source]) => ({
  name,
  files: [{ path: "main.tease", source: `${source.join("\n")}\nexit\n` }],
}));

/**
 * S6's sharing faults that, with the sharing on, published their diagnostics in another order on
 * `main`: publication in source order of their sites makes them neutral (`type-core-sharing`'s own test).
 */
export const REORDERING_SHARING_FAULTS: readonly {
  readonly name: string;
  readonly files: readonly SourceFile[];
}[] = (
  [
    [
      "chain: a period of three",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let b = {f0: 2.5, f1: [1, raw][1]}",
      'let c = {f0: ["s", raw][1], f1: 1}',
      "let xs = []",
      ...Array.from({ length: 3 }, () => ["xs.add(root)", "xs.add(b)", "xs.add(c)"]).flat(),
      "repeat xs[0].f0 {}",
      "repeat xs[0].f1 {}",
    ],
    [
      "chain: alternation with a call storing the list",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let other = {f0: 1.5, f1: 1}",
      "global xs = []",
      "function push {",
      '  xs.add({f0: "s", f1: "s"})',
      "  return 0",
      "}",
      "xs.add(root)",
      "xs.add(other)",
      "xs.add(root)",
      "xs.add(other)",
      "let t = push()",
      "xs.add(root)",
      "xs.add(other)",
      "xs.add(root)",
      "let n: integer = xs[0].f0",
    ],
  ] as const
).map(([name, ...source]) => ({
  name,
  files: [{ path: "main.tease", source: `${source.join("\n")}\nexit\n` }],
}));

/**
 * S6's sharing faults repaired, in the differential: #1077's adds of one class, each a candidate at the list's element
 * directly and through the list, published 16 diagnostics and 17 checks against 11 and 12 (Sol's r3).
 */
export const REPAIRED_SHARING_FAULTS: readonly {
  readonly name: string;
  readonly files: readonly SourceFile[];
}[] = [
  {
    name: "chain: six adds of a host element, its last and a random element read",
    files: [
      {
        path: "main.tease",
        source: `${[
          "let root = [1.5, hostValue].first",
          "let xs = [1.5]",
          ...Array.from({ length: 6 }, () => "xs.add(root)"),
          "let chosen = [xs.first, null].first",
          "chosen = 1",
          "repeat xs.last {}",
          "repeat xs.random {}",
        ].join("\n")}\nexit\n`,
      },
    ],
  },
];
