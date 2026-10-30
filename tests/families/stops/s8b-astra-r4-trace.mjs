// S8b's review r4 (Astra): its 45 cases (cases.mjs) and the nested list scaling at 4 to 128 its trace appends
// (R/astra-m4-s8b-r4-evidence/trace.mjs).
export const cases = [
  ["075-0-1", "let rows: object set = set[{n: 4}, {n: hostValue}]\nexit\n"],
  ["075-0-2", "let rows: object[] = [{n: hostValue}]\nexit\n"],
  ["075-0-3", "let rows: object dict = dict{one: {n: hostValue}}\nexit\n"],
  ["075-0-4", "let rows: list[] = [[hostValue, \"text\"]]\nexit\n"],
  ["075-0-5", "let rows: dict[] = [dict{one: hostValue}]\nexit\n"],
  ["075-0-6", "let rows: integer[] = [{n: hostValue}]\nexit\n"],
  ["075-0-7", "let rows: integer set = set[{n: 4}]\nexit\n"],
  ["075-0-8", "let rows: object[][] = [[{n: hostValue}]]\nexit\n"],
  ["075-0-9", "let rows: integer set[] dict = dict{one: [set[false]]}\nexit\n"],
  ["075-0-10", "let rows: integer[] | string set = [false]\nexit\n"],
  ["075-0-11", "let rows: (integer | string)[] = [false, 2]\nexit\n"],
  ["075-0-12", "let rows: (integer[] | string[])[] = [[false]]\nexit\n"],
  ["075-0-13", "let rows: integer?[] = [\"bad\", null]\nexit\n"],
  ["075-0-14", "let rows: integer[]?[] = [[\"bad\"], null]\nexit\n"],
  ["075-0-15", "let rows: integer[] = [\"one\", \"two\"]\nexit\n"],
  ["075-0-16", "let rows: integer[] = [4, \"bad\"]\nexit\n"],
  ["075-0-17", "let rows: integer set = set[\"one\", \"two\"]\nexit\n"],
  ["075-0-18", "let rows: integer dict = dict{one: \"one\", two: \"two\"}\nexit\n"],
  ["075-0-19", "let rows: integer[][] = []\nrows.add([hostValue])\nexit\n"],
  ["075-0-20", "let rows: integer set[] = []\nrows.add(set[hostValue])\nexit\n"],
  ["075-0-21", "let rows: integer[] set = set[]\nrows.add(dict{one: 4})\nexit\n"],
  ["075-0-22", "let rows: integer[][] = [[\"one\"], [false]]\nexit\n"],
  ["075-0-23", "let rows = fromJson(hostValue, default: dict{one: [{n: 4}]})\nsay rows.get(\"one\", default: [{n: 3}])[0].n\nexit\n"],
  ["075-0-24", "let root = {visible: 3}\nlet second = root\nlet third = second\nthird.missing = hostValue\nexit\n"],
  ["075-0-25", "let root = {inner: {visible: 3}}\nlet second = root.inner\nsecond.missing = hostValue\nexit\n"],
  ["075-0-26", "let root = hostValue\nlet second = root\nsecond.missing = hostOther\nexit\n"],
  ["075-0-27", "hostValue.n = 4\nsay 2 otherwise hostValue.n\nexit\n"],
  ["075-0-28", "hostValue.inner = {n: 4}\nsay 2 otherwise hostValue.inner.n\nexit\n"],
  ["075-0-29", "hostValue.inner.n = 4\nsay hostValue.inner otherwise hostOther\nexit\n"],
  ["075-0-30", "hostValue.inner.a = 4\nsay 2 otherwise hostValue.inner.b\nexit\n"],
  ["075-0-31", "let parsed = fromJson(hostValue, default: {parts: [dict{key: fromJson(\"4\", default: 0)}]})\nsay parsed.parts.get(0, default: dict{key: 0}).get(\"key\", default: 0)\nexit\n"],
  ["075-0-32", "let quantity: number? = null\nlet parcel = {quantity: quantity}\nlet copy = parcel\nsay copy.quantity otherwise hostValue\nquantity = 7\nexit\n"],
  ["075-0-33", "let values: integer?[] = [null]\nlet pack = {values: values}\nlet copied = pack\nsay copied.values.get(9, default: hostValue)\nexit\n"],
  ["075-0-34", "let blank = null\nlet one = blank\nlet two = one\nsay two otherwise hostValue\nexit\n"],
  ["075-0-35", "let amount: integer? = null\nlet copy = amount\nlet final: integer = copy\nexit\n"],
  ["075-0-36", "function show(value: integer?) {\n say value otherwise hostValue\n}\nshow(null)\nexit\n"],
  ["075-0-37", "function value: integer? { return null }\nlet record = {n: value()}\nsay record.n otherwise hostValue\nexit\n"],
  ["075-0-38", "say toInteger(hostValue, default: hostOther)\nexit\n"],
  ["075-0-39", "function keep(value: integer) { return value }\nsay keep(hostValue)\nexit\n"],
  ["075-0-40", "let total = hostValue + 8\nrepeat hostOther { say total }\nexit\n"],
  ["075-0-41", "let records = [{n: 3}]\nlet chosen = records.get(hostOther, default: {n: hostValue})\nsay chosen.n\nexit\n"],
  ["075-0-42", "let records = [[3]]\nlet chosen = records.get(hostOther, default: [hostValue])\nsay chosen.get(0, default: 2)\nexit\n"],
  ["075-0-43", "say [hostValue].get(hostOther, default: 9)\nexit\n"],
  ["075-0-44", "let parsed = fromJson(hostValue, default: {chunks: [[{id: 5}]]})\nsay parsed.chunks.get(0, default: [{id: 4}])[0].id\nexit\n"],
  ["075-0-45", "let parsed = fromJson(hostValue, default: {chunks: [[hostOther]]})\nsay parsed.chunks.get(0, default: [3])[0]\nexit\n"],
  ["075-0-46", "let nested = [[[[3]]]]\nlet copied = nested\nlet sentinel: integer = hostValue\nexit\n", ["hostValue"]],
  ["075-0-47", "let nested = [[[[[[[[3]]]]]]]]\nlet copied = nested\nlet sentinel: integer = hostValue\nexit\n", ["hostValue"]],
  ["075-0-48", "let nested = [[[[[[[[[[[[[[[[3]]]]]]]]]]]]]]]]\nlet copied = nested\nlet sentinel: integer = hostValue\nexit\n", ["hostValue"]],
  ["075-0-49", "let nested = [[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[3]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]\nlet copied = nested\nlet sentinel: integer = hostValue\nexit\n", ["hostValue"]],
  ["075-0-50", "let nested = [[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[3]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]\nlet copied = nested\nlet sentinel: integer = hostValue\nexit\n", ["hostValue"]],
  ["075-0-51", "let nested = [[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[3]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]\nlet copied = nested\nlet sentinel: integer = hostValue\nexit\n", ["hostValue"]],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "ROOT=<checkout> node trace.mjs",
      "R/astra-m4-s8b-r4-evidence/README.md:17"
    ]
  ],
  "sources": 51,
  "sha256": "0e16ff9755d019630b87fa50c254db9399759cc343c7d254f1cc58606cb3eab6"
};
