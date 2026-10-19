/**
 * The target suite over the input dimensions of the constraint solver (O4 stage 3a, the owner's condition of
 * 2026-10-19 after PR review r6, with Sol's review of the dimension list folded in: work note §10, the research
 * folder's `evidence/target-suite-dimensions.md`). A series fixes every dimension but one and walks that one over
 * geometric sizes; its expectations are written from the decided rules, never from a run. A series the solver is
 * known to fail carries the backlog row it waits on: the test file puts that one assertion under a `todo` and keeps
 * every other assertion hard.
 */

export type Phase =
  | "evaluations"
  | "asks"
  | "combinations"
  | "foldStates"
  | "cells"
  | "items"
  | "orders"
  | "selections";

export interface Series {
  readonly name: string;
  /** The dimension walked, and the setting of the others. */
  readonly dimension: string;
  readonly setting: string;
  readonly sizes: readonly number[];
  source(n: number): string;
  /** The bindings and their exported types, from the rules, at every size; `statuses` when any are expected. */
  expect(n: number): {
    readonly bindings: readonly (readonly [string, string])[];
    readonly statuses?: readonly string[];
  };
  /** The phases whose counted work must be linear in the size (every phase when omitted). */
  readonly linear?: readonly Phase[];
  /** A known failure (the backlog row), narrowed to one assertion: the work bound, or the budget cut it meets. */
  readonly todo?: { readonly assertion: "work" | "cut"; readonly backlog: string };
}

const lines = (n: number, line: (i: number) => string): string =>
  Array.from({ length: n }, (_, i) => line(i)).join("\n");
const repeat = (n: number, text: string): string =>
  Array.from({ length: n }, () => text).join(", ");
const nested = (depth: number, inner: string): string =>
  `${"list<".repeat(depth)}${inner}${">".repeat(depth)}`;

export const SERIES: readonly Series[] = [
  // --- rebuild sites × initializer role (the owner's feedback acceptance; the full set in the work-bounds test)
  {
    name: "a literal appended at k sites",
    dimension: "rebuild sites",
    setting: "literal initializer, one base, no other cycle",
    sizes: [25, 50, 100, 200],
    source: (n) => `let xs = [1]\n${lines(n, (i) => `xs = xs + [${i + 2}]`)}\nexit`,
    expect: () => ({ bindings: [["xs", "list<integer>"]] }),
  },
  {
    name: "a get default appended at k sites",
    dimension: "rebuild sites",
    setting: "permitted initializer (get with a default)",
    sizes: [25, 50, 100, 200],
    source: (n) => `let xs = [[1]].get(0, default: [2])\n${lines(n, () => "xs = xs + []")}\nexit`,
    expect: () => ({ bindings: [["xs", "list<integer>"]] }),
  },
  {
    name: "two bindings appended to each other at k sites (mutual feedback)",
    dimension: "cycle",
    setting: "literal initializers, mutual rebuilds",
    sizes: [10, 20, 40, 80],
    source: (n) => `let a = [1]\nlet b = [2]\n${lines(n, () => "a = a + b\nb = b + a")}\nexit`,
    expect: () => ({
      bindings: [
        ["a", "list<integer>"],
        ["b", "list<integer>"],
      ],
    }),
  },
  // --- independent bases
  {
    name: "a chain of distinct written unions joined by +",
    dimension: "independent bases",
    setting:
      "written-bound initializers, one statement (below the budget; the budget's own test takes it past)",
    sizes: [2, 4, 6],
    source: (n) =>
      `${lines(n, (i) => `let a${i}: integer[] | number[] = [1]`)}\nlet r = ${Array.from({ length: n }, (_, i) => `a${i}`).join(" + ")}\nexit`,
    expect: () => ({ bindings: [["r", "list<number>"]] }),
    todo: {
      assertion: "work",
      backlog: "o4-review-backlog.md: the distinct-union chain (site-based identity granularity)",
    },
  },
  // --- argument shape
  {
    name: "toString with k extra positional arguments (arity exceeded)",
    dimension: "argument shape",
    setting: "one binding repeated, malformed call",
    sizes: [4, 8, 16, 32],
    source: (n) => `let a: integer | number = 1\nlet r = toString(${repeat(n, "a")})\nexit`,
    expect: () => ({ bindings: [["r", "string"]] }),
  },
  {
    name: "min over k occurrences with an unknown named argument",
    dimension: "argument shape",
    setting: "one binding repeated, malformed call",
    sizes: [4, 8, 16, 32],
    source: (n) => `let a: integer | number = 1\nlet r = min(${repeat(n, "a")}, other: 1)\nexit`,
    expect: () => ({ bindings: [["r", "number"]] }),
  },
  {
    name: "min over k distinct bindings",
    dimension: "argument shape",
    setting: "distinct bindings, well-formed",
    sizes: [4, 8, 16, 32],
    source: (n) =>
      `${lines(n, (i) => `let a${i}: integer | number = 1`)}\nlet r = min(${Array.from({ length: n }, (_, i) => `a${i}`).join(", ")})\nexit`,
    expect: () => ({ bindings: [["r", "number"]] }),
  },
  // --- options
  {
    name: "a choice over k options of one binding",
    dimension: "options",
    setting: "scalar literal initializer",
    sizes: [4, 8, 16, 32],
    source: (n) => `let a = 1\nlet r = askChoice ${repeat(n, "a")}\nexit`,
    expect: () => ({ bindings: [["r", "integer"]] }),
  },
  {
    name: "a form field with k options of one binding",
    dimension: "options",
    setting: "scalar literal initializer",
    sizes: [4, 8, 16, 32],
    source: (n) =>
      `let a = 1\nlet r = askForm("Q", fields: {q: {options: [${repeat(n, "a")}]}})\nexit`,
    expect: () => ({ bindings: [["r", '{"q":integer}']] }),
  },
  {
    name: "a choice over a computed list with a host element and k other elements",
    dimension: "options",
    setting: "computed collection, dynamic element",
    sizes: [4, 8, 16, 32],
    source: (n) =>
      `let xs = [1]\n${lines(n, (i) => `xs.add(${i + 2})`)}\nxs.add(hostValue)\nlet r = askChoice xs\nexit`,
    expect: () => ({
      bindings: [
        ["xs", "list<integer!>"],
        ["r", "integer!"],
      ],
    }),
  },
  // --- nesting
  {
    name: "a list nested k deep",
    dimension: "nesting",
    setting: "literal initializers",
    sizes: [2, 4, 8, 16],
    source: (n) => `let x0 = [1]\n${lines(n, (i) => `let x${i + 1} = [x${i}]`)}\nexit`,
    expect: (n) => ({ bindings: [[`x${n}`, nested(n + 1, "integer")]] }),
  },
  // --- object population × property vocabulary (Sol's D1)
  {
    name: "k objects each with its own stored property name",
    dimension: "object population × vocabulary",
    setting: "distinct names",
    sizes: [25, 50, 100, 200],
    source: (n) => `${lines(n, (i) => `let a${i} = {}\na${i}.p${i} = 1`)}\nexit`,
    expect: (n) => ({ bindings: [[`a${n - 1}`, `{"p${n - 1}":integer}`]] }),
    todo: {
      assertion: "work",
      backlog: "o4-review-backlog.md: object slots per stored property name (Sol's D1)",
    },
  },
  {
    name: "k objects each with the same stored property name",
    dimension: "object population × vocabulary",
    setting: "one name",
    sizes: [25, 50, 100, 200],
    source: (n) => `${lines(n, (i) => `let a${i} = {}\na${i}.p = 1`)}\nexit`,
    expect: (n) => ({ bindings: [[`a${n - 1}`, '{"p":integer}']] }),
  },
  // --- sharing (Sol's D3): the solve work is linear; the exported text expands the shared graph (output-sensitive)
  {
    name: "a shared object graph k deep",
    dimension: "sharing",
    setting: "acyclic diamonds",
    sizes: [2, 4, 6, 8],
    source: (n) =>
      `let x0 = {v: 1}\n${lines(n, (i) => `let x${i + 1} = {l: x${i}, r: x${i}}`)}\nexit`,
    expect: () => ({ bindings: [["x0", '{"v":integer}']] }),
  },
  {
    name: "a copy chain k long of a written union",
    dimension: "sharing",
    setting: "copies",
    sizes: [8, 16, 32, 64],
    source: (n) =>
      `let v0: integer | string = 1\n${lines(n, (i) => `let v${i + 1} = v${i}`)}\nexit`,
    expect: (n) => ({ bindings: [[`v${n}`, "(integer|string)"]] }),
  },
];

/** The categorical cases (one setting each, no size), from the decided rules; the dimension names their class. */
export interface Case {
  readonly name: string;
  readonly dimension: string;
  readonly files: readonly { readonly path: string; readonly source: string }[];
  readonly bindings: readonly (readonly [string, string])[];
  readonly statuses?: readonly string[];
}

export const CASES: readonly Case[] = [
  {
    name: "equal-shape permitted members stay apart through a rebuild (D5)",
    dimension: "shape distinctions",
    files: [
      {
        path: "main.tease",
        source:
          'let a = [[{x: 1}]].get(0, default: [{x: "s"}])\nlet b = a + []\nlet r = b.first.x\nexit',
      },
    ],
    bindings: [
      ["a", '(list<{"x":integer}>|list<{"x":string}>)'],
      ["b", '(list<{"x":integer}>|list<{"x":string}>)'],
      ["r", "(integer|string)"],
    ],
  },
  {
    name: "a dict get with a default keeps the pair of members (D7)",
    dimension: "consumers",
    files: [
      {
        path: "main.tease",
        source:
          'let a = dict {"q": [1]}\nlet b = a.get("q", default: ["s"])\nlet r = b.first\nexit',
      },
    ],
    bindings: [["r", "(integer|string)"]],
  },
  {
    name: "a null default beside a witness is optionality with the check kept (D6, Q3.2c)",
    dimension: "evidence role",
    files: [
      {
        path: "main.tease",
        source: 'let xs = [fromJson("null", default: null), 1]\nlet r = xs.first\nexit',
      },
    ],
    bindings: [
      ["xs", "list<(integer|null)!>"],
      ["r", "(integer|null)!"],
    ],
  },
  {
    name: "two local bindings of one name in two files are two (D4)",
    dimension: "project layout",
    files: [
      { path: "main.tease", source: "let x = 1\nexit" },
      { path: "other.tease", source: 'let x = "s"\nexit' },
    ],
    bindings: [
      ["main.tease:x", "integer"],
      ["other.tease:x", "string"],
    ],
  },
  {
    name: "a self-rebuild stored back merges into the binding; a store into another place keeps its own",
    dimension: "self-rebuild",
    files: [
      {
        path: "main.tease",
        source: "let xs = [1]\nlet ys = xs + [2.5]\nlet zs = [1]\nzs = zs + [2.5]\nexit",
      },
    ],
    bindings: [
      ["xs", "list<integer>"],
      ["ys", "list<number>"],
      ["zs", "list<number>"],
    ],
  },
];
