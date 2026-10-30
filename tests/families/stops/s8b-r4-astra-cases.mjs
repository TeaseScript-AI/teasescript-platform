// set-record, list-record and related fixed cases; #1165 / S8, Astra review, r4 (R/astra-m4-s8b-r4-evidence/cases.mjs).
export const cases = (() => {
  const cases = [
    ["set-record", "let rows: object set = set[{n: 4}, {n: hostValue}]\nexit\n"],
    ["list-record", "let rows: object[] = [{n: hostValue}]\nexit\n"],
    ["dict-record", "let rows: object dict = dict{one: {n: hostValue}}\nexit\n"],
    ["open-list", 'let rows: list[] = [[hostValue, "text"]]\nexit\n'],
    ["open-dict", "let rows: dict[] = [dict{one: hostValue}]\nexit\n"],
    ["wrong-record", "let rows: integer[] = [{n: hostValue}]\nexit\n"],
    ["wrong-record-set", "let rows: integer set = set[{n: 4}]\nexit\n"],
    ["nested-record", "let rows: object[][] = [[{n: hostValue}]]\nexit\n"],
    ["nested-dict-set", "let rows: integer set[] dict = dict{one: [set[false]]}\nexit\n"],
    ["union-collection", "let rows: integer[] | string set = [false]\nexit\n"],
    ["union-leaf", "let rows: (integer | string)[] = [false, 2]\nexit\n"],
    ["union-level", "let rows: (integer[] | string[])[] = [[false]]\nexit\n"],
    ["nullable-leaf", 'let rows: integer?[] = ["bad", null]\nexit\n'],
    ["nullable-level", 'let rows: integer[]?[] = [["bad"], null]\nexit\n'],
    ["two-bad", 'let rows: integer[] = ["one", "two"]\nexit\n'],
    ["mixed-fit", 'let rows: integer[] = [4, "bad"]\nexit\n'],
    ["set-two-bad", 'let rows: integer set = set["one", "two"]\nexit\n'],
    ["dict-two-bad", 'let rows: integer dict = dict{one: "one", two: "two"}\nexit\n'],
    ["add-host", "let rows: integer[][] = []\nrows.add([hostValue])\nexit\n"],
    ["add-set-host", "let rows: integer set[] = []\nrows.add(set[hostValue])\nexit\n"],
    ["add-wrong-shape", "let rows: integer[] set = set[]\nrows.add(dict{one: 4})\nexit\n"],
    ["nested-dual", 'let rows: integer[][] = [["one"], [false]]\nexit\n'],
    [
      "dict-default",
      'let rows = fromJson(hostValue, default: dict{one: [{n: 4}]})\nsay rows.get("one", default: [{n: 3}])[0].n\nexit\n',
    ],
    [
      "copy-record",
      "let root = {visible: 3}\nlet second = root\nlet third = second\nthird.missing = hostValue\nexit\n",
    ],
    [
      "copy-field",
      "let root = {inner: {visible: 3}}\nlet second = root.inner\nsecond.missing = hostValue\nexit\n",
    ],
    [
      "unknown-record",
      "let root = hostValue\nlet second = root\nsecond.missing = hostOther\nexit\n",
    ],
    ["host-at", "hostValue.n = 4\nsay 2 otherwise hostValue.n\nexit\n"],
    ["host-above", "hostValue.inner = {n: 4}\nsay 2 otherwise hostValue.inner.n\nexit\n"],
    ["host-below", "hostValue.inner.n = 4\nsay hostValue.inner otherwise hostOther\nexit\n"],
    ["host-beside", "hostValue.inner.a = 4\nsay 2 otherwise hostValue.inner.b\nexit\n"],
    [
      "nested-parse",
      'let parsed = fromJson(hostValue, default: {parts: [dict{key: fromJson("4", default: 0)}]})\nsay parsed.parts.get(0, default: dict{key: 0}).get("key", default: 0)\nexit\n',
    ],
  ];
  cases.push(
    [
      "nullable-contract",
      "let quantity: number? = null\nlet parcel = {quantity: quantity}\nlet copy = parcel\nsay copy.quantity otherwise hostValue\nquantity = 7\nexit\n",
      { fitting: [{ hostValue: "fallback" }, { hostValue: 3 }] },
    ],
    [
      "nullable-list-copy",
      "let values: integer?[] = [null]\nlet pack = {values: values}\nlet copied = pack\nsay copied.values.get(9, default: hostValue)\nexit\n",
      { fitting: [{ hostValue: "fallback" }, { hostValue: 4 }] },
    ],
    [
      "null-chain",
      "let blank = null\nlet one = blank\nlet two = one\nsay two otherwise hostValue\nexit\n",
      { fitting: [{ hostValue: "ready" }, { hostValue: 4 }] },
    ],
    [
      "fixed-destination",
      "let amount: integer? = null\nlet copy = amount\nlet final: integer = copy\nexit\n",
    ],
    [
      "parameter",
      "function show(value: integer?) {\n say value otherwise hostValue\n}\nshow(null)\nexit\n",
    ],
    [
      "function-result",
      "function value: integer? { return null }\nlet record = {n: value()}\nsay record.n otherwise hostValue\nexit\n",
    ],
    ["conversion", "say toInteger(hostValue, default: hostOther)\nexit\n"],
    ["argument", "function keep(value: integer) { return value }\nsay keep(hostValue)\nexit\n"],
    ["operand", "let total = hostValue + 8\nrepeat hostOther { say total }\nexit\n"],
    [
      "record-default-host",
      "let records = [{n: 3}]\nlet chosen = records.get(hostOther, default: {n: hostValue})\nsay chosen.n\nexit\n",
    ],
    [
      "list-default-host",
      "let records = [[3]]\nlet chosen = records.get(hostOther, default: [hostValue])\nsay chosen.get(0, default: 2)\nexit\n",
    ],
    ["literal-projection", "say [hostValue].get(hostOther, default: 9)\nexit\n"],
    [
      "parse-nested-record",
      "let parsed = fromJson(hostValue, default: {chunks: [[{id: 5}]]})\nsay parsed.chunks.get(0, default: [{id: 4}])[0].id\nexit\n",
    ],
    [
      "parse-nested-host",
      "let parsed = fromJson(hostValue, default: {chunks: [[hostOther]]})\nsay parsed.chunks.get(0, default: [3])[0]\nexit\n",
    ],
  );
  return cases.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ['node sweep.mjs "$1"', "R/astra-m4-s8b-r4-evidence/queue.sh:5"],
    [
      'for name in $(node --input-type=module -e \'import {cases} from "./cases.mjs"; console.log(cases.map(c=>c[0]).join(" "))\') exception-1216 exception-1165; do',
      "R/astra-m4-s8b-r4-evidence/queue3.sh:4",
    ],
    ["ROOT=<checkout> node sweep.mjs two-bad", "R/astra-m4-s8b-r4-evidence/README.md:10"],
    ["ROOT=<checkout> node sweep.mjs wrong-record", "R/astra-m4-s8b-r4-evidence/README.md:11"],
    ["ROOT=<checkout> node sweep.mjs operand", "R/astra-m4-s8b-r4-evidence/README.md:12"],
    ["ROOT=<checkout> node sweep.mjs exception-1165", "R/astra-m4-s8b-r4-evidence/README.md:13"],
  ],
  sources: 45,
  sha256: "56a3f80b44e1fdd1cdf57646cfb4066fa0092a96ce75ab82747c840c9d87e85b",
};
