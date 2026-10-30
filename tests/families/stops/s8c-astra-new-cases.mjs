// literal-grid, number-promotion and related fixed cases; #1165 / S8, Astra review, round unrecorded
// (R/astra-m4-s8c-review-evidence/worker/new-cases.mjs).
export const cases = (() => {
  const cases = [
    [
      "literal-grid",
      "let box = {rows: [[6, 9]]}\nbox = {rows: [[12, 15]]}\nsay box.rows.first.get(hostOther, default: hostValue)",
    ],
    [
      "number-promotion",
      "let box = {rows: [[6]]}\nbox = {rows: [[2.5]]}\nsay box.rows.first.get(hostOther, default: hostValue)",
    ],
    [
      "written-copy",
      "let original: integer[][] = [[8]]\nlet box = {rows: original}\nsay box.rows.first.get(hostOther, default: hostValue)",
    ],
    [
      "inferred-copy",
      "let original = [[8]]\nlet box = {rows: original}\nsay box.rows.first.get(hostOther, default: hostValue)",
    ],
    [
      "host-literal",
      "let box = {rows: [[8]]}\nbox = hostValue\nsay box.rows.first.get(hostOther, default: 0)",
    ],
    [
      "host-stored",
      'let mutable = hostValue\nmutable = {rows: [["bad"]]}\nlet box = {rows: [[8]]}\nbox = mutable\nsay box.rows.first.get(hostOther, default: 0)',
    ],
    [
      "conditional",
      "let box = {rows: [[8]]}\nif hostOther { box = hostValue }\nsay box.rows.first.get(0, default: 0)",
    ],
    [
      "missing-sibling",
      "let box = {rows: [[8]]}\nbox = {other: [[9]]}\nsay box.rows.first.get(hostOther, default: 0)",
    ],
    [
      "null-sibling",
      "let box = {rows: [[8], [null]]}\nsay box.rows.first.get(hostOther, default: hostValue)",
    ],
    [
      "parse-nested",
      "let box = fromJson(hostValue, default: {rows: [[{id: 8, ok: true}]]})\nsay box.rows.get(hostOther, default: [{id: 0, ok: false}])[0].id",
    ],
    [
      "load-nested",
      'let box = load("memo", default: {rows: [[{id: 8, ok: true}]]})\nsay box.rows.get(hostOther, default: [{id: 0, ok: false}])[0].id',
    ],
    [
      "parse-copy-default",
      "let seed: integer[] = [8]\nlet box = fromJson(hostValue, default: {rows: [seed]})\nsay box.rows.get(hostOther, default: [0])[0]",
    ],
    [
      "load-inferred-default",
      'let seed = [8]\nlet box = load("memo", default: {rows: [seed]})\nsay box.rows.get(hostOther, default: [0])[0]',
    ],
    [
      "parse-load-chain",
      'let box = fromJson(hostValue, default: load("memo", default: {rows: [[8]]}))\nsay box.rows.get(hostOther, default: [0])[0]',
    ],
    [
      "written-unknown-cell",
      "let seed = hostValue\nlet groups: integer[][] = [[seed]]\nsay groups",
    ],
    [
      "written-mixed-cell",
      'let seed = hostValue\nlet groups: integer[][] = [[seed, "wrong"]]\nsay groups',
    ],
    [
      "call-copy-result",
      "function build(p: integer[]) { return {rows: [p]} }\nlet box = build([6])\nsay box.rows.get(hostOther, default: [0])[0]",
    ],
    [
      "literal-selected-copy",
      "let original = [6, 9]\nlet shadow = original\nsay {a: [shadow.first], b: dict{x: original.last}}",
    ],
    [
      "set-nested-default",
      "let box = fromJson(hostValue, default: {rows: set[[8]]})\nsay box.rows.first.first",
    ],
    [
      "dict-nested-default",
      'let box = fromJson(hostValue, default: {rows: dict{x: [8]}})\nsay box.rows.get("x", default: [0]).first',
    ],
    [
      "literal-mismatch-after",
      'let box = {rows: [[8]]}\nbox = {rows: [["wrong"]]}\nsay [box.rows.first.first]',
    ],
    [
      "typed-null-source",
      "let seed: integer? = 8\nlet box = {rows: [[seed]]}\nsay box.rows.first.get(hostOther, default: hostValue)",
    ],
    [
      "prefix-write",
      "let box = {rows: [[8]]}\nbox.rows = [[4]]\nbox.rows[0] = [7]\nsay box.rows.first.get(hostOther, default: hostValue)",
    ],
    [
      "recursive-return",
      "function chain(n: integer) { if n == 0 { return {value: 8, next: null} }\nreturn {value: n, next: chain(n - 1)} }\nlet tree = chain(2)\nsay tree.next.value",
    ],
  ].map(([name, source]) => [name, source + '\nsay "DONE"\nexit\n']);
  return cases.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "| `node stops.mjs <0..3>` | four `stops-N` logs; `new-cases.mjs` |",
      "R/astra-m4-s8c-review-evidence/README.md:12",
    ],
    [
      "ROOT=…/main ONLY=host-literal,conditional node stops.mjs <0..3>`",
      "R/astra-m4-s8c-review-evidence/README.md:13",
    ],
    [
      "/home/peter/opt/node-24.18/bin/node stops.mjs 0 quick",
      "R/astra-m4-s8c-review-evidence/worker/next.sh:4",
    ],
    [
      '/home/peter/opt/node-24.18/bin/node stops.mjs "$mode"',
      "R/astra-m4-s8c-review-evidence/worker/sweeps.sh:4",
    ],
    [
      'ROOT=/home/peter/work/o4-m4-s8-r6/main ONLY=host-literal,conditional /home/peter/opt/node-24.18/bin/node stops.mjs "$mode"',
      "R/astra-m4-s8c-review-evidence/worker/last-checks.sh:6",
    ],
  ],
  sources: 24,
  sha256: "b83d8b5a9d491330f70c5c151a6553b69d0b7a29c5f45985d44d43bde7c4c30d",
};
