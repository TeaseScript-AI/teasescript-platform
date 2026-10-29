// #1165 / S8; Astra review.
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
