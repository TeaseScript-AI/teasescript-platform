// original r2:duration, r2:member and related inputs; #1241, Astra review, r3 (R/astra-m4-i1241-review-r3/review.mjs).
const corpus = (() => {
  const cases = [];
  const add = (name, setup, expr, line = "say @", expect) => {
    const [left, right] = line.split("@");
    const prefix = setup + "\n" + left;
    cases.push({
      name,
      source: prefix + expr + right + "\nexit\n",
      start: prefix.length,
      end: prefix.length + expr.length,
      expect,
    });
  };
  for (const [name, setup, access, expect] of [
    ["r2", 'let boxes = [{n: 2, text: "alpha", items: [1]}, null]\nlet box = boxes[1]', "box", 0],
    [
      "chain2",
      'let choices = [{inner: {n: 2, text: "alpha", items: [1]}}, null]\nlet box = choices[1]',
      "box.inner",
      0,
    ],
    [
      "chain3",
      'let choices = [{inner: {nested: {n: 2, text: "alpha", items: [1]}}}, null]\nlet box = choices[1]',
      "box.inner.nested",
      0,
    ],
    [
      "inner-null",
      'let choices = [{n: 2, text: "alpha", items: [1]}, null]\nlet box = {inner: choices[1]}',
      "box.inner",
      0,
    ],
    [
      "selection-null",
      'let choices = [{n: 2, text: "alpha", items: [1]}, null]',
      "choices.random",
      0,
    ],
    [
      "selection-empty",
      'let choices = [{n: 2, text: "alpha", items: [1]}]\nchoices.clear()',
      "choices.first",
      0,
    ],
    [
      "present3",
      'let box = {inner: {nested: {n: 2, text: "alpha", items: [1]}}}',
      "box.inner.nested",
      "some",
    ],
    [
      "mutated",
      'let box = {inner: {n: 2, text: "alpha", items: [1]}}\nfunction change() { box.inner = null }\nchange()',
      "box.inner",
      0,
    ],
  ]) {
    add(
      name + ":duration",
      setup,
      access + ".n",
      "let converted: duration = @\nsay converted",
      expect,
    );
    add(name + ":member", setup, access + ".text.size", "say @", expect);
    add(name + ":list", setup, access + ".items + 2", "say @", expect);
    add(
      name + ":interpolation",
      setup,
      '"${' + access + '.n}"',
      "let converted: date = @",
      expect === "some" ? undefined : expect,
    );
  }
  for (const member of ["n", "text.size", "items + 2"])
    add(
      "guard:" + member,
      'let choices = [{n: 2, text: "alpha", items: [1]}, null]\nlet box = choices[0]\nif box != null {',
      "box." + member,
      member === "n" ? "let converted: duration = @\nsay converted\n}" : "say @\n}",
    );
  for (const [name, setup, subject] of [
    ["nested-warning", 'let box = {inner: {values: ["alpha", null]}}', "box.inner.values[1]"],
    ["dict-warning", 'let box = {inner: dict{ok: "alpha", missing: null}}', 'box.inner["missing"]'],
    [
      "ellipsis-warning",
      'let box = {inner: dict{"...": "alpha", missing: null}}',
      'box.inner["..."]',
    ],
  ])
    add(name, setup, subject + ".length", "say @", "some");
  const nullable = "let ns = [2, null]\nlet n = ns[1]";
  for (const [name, expr] of [
    ["binary", "n + 1"],
    ["unary", "-n"],
    ["literal-binary", "({inner: n + 1}).inner"],
    ["interpolated-binary", '"${n + 1}".length'],
    ["nested-binary", "(n + 1) * 2"],
  ])
    add("nullable-operand:" + name, nullable, expr, "let converted: duration = @\nsay converted");
  return { cases: cases.map(({ name, source }) => [name, source]) };
})();
const all = corpus.cases;

for (const index of [31, 30, 29, 28]) all.splice(index, 1);

for (const input of [
  [
    "original/1/archived paste/box.inner.nested.items + [2]",
    'let box = {inner: {nested: {n: 2, text: "alpha", items: [1]}}}\nsay box.inner.nested.items + [2]\nexit\n',
  ],
  [
    "original/2/archived paste/box.inner.nested.items.add(2)",
    'let box = {inner: {nested: {n: 2, text: "alpha", items: [1]}}}\nbox.inner.nested.items.add(2)\nsay box.inner.nested.items\nexit\n',
  ],
  [
    "original/3/archived paste/box.inner.nested.n s",
    'let box = {inner: {nested: {n: 2, text: "alpha", items: [1]}}}\nlet converted: duration = box.inner.nested.n s\nsay converted\nexit\n',
  ],
  [
    'original/4/archived paste/(box.inner["..."] otherwise "")',
    'let box = {inner: dict{"...": "alpha", missing: null}}\nsay (box.inner["..."] otherwise "").length\nexit\n',
  ],
  [
    "original/5/archived paste/box.inner.nested.text.length",
    'let box = {inner: {nested: {n: 2, text: "alpha", items: [1]}}}\nsay box.inner.nested.text.length\nexit\n',
  ],
  [
    'original/6/archived paste/(box.inner.values[1] otherwise "")',
    'let box = {inner: {values: ["alpha", null]}}\nsay (box.inner.values[1] otherwise "").length\nexit\n',
  ],
  [
    'original/7/archived paste/(box.inner["missing"] otherwise "")',
    'let box = {inner: dict{ok: "alpha", missing: null}}\nsay (box.inner["missing"] otherwise "").length\nexit\n',
  ],
  [
    'original/8/archived paste/"${n + 1}".length s',
    'let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = "${n + 1}".length s\nsay converted\nexit\n',
    [],
  ],
  [
    "original/9/archived paste/(n otherwise 0)",
    'let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = "${(n otherwise 0) + 1}".length\nsay converted\nexit\n',
    [],
  ],
  [
    "original/10/archived paste/({inner: n + 1}).inner s",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = ({inner: n + 1}).inner s\nsay converted\nexit\n",
    [],
  ],
  [
    "original/11/archived paste/(n otherwise 0)",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = ({inner: (n otherwise 0) + 1}).inner\nsay converted\nexit\n",
    [],
  ],
  [
    "original/12/archived paste/(-n) s",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = (-n) s\nsay converted\nexit\n",
    [],
  ],
  [
    "original/13/archived paste/(n otherwise 0)",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = -(n otherwise 0)\nsay converted\nexit\n",
    [],
  ],
  [
    "original/14/archived paste/((n + 1) * 2) s",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = ((n + 1) * 2) s\nsay converted\nexit\n",
    [],
  ],
  [
    "original/15/archived paste/(n otherwise 0)",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = ((n otherwise 0) + 1) * 2\nsay converted\nexit\n",
    [],
  ],
  [
    "original/16/archived paste/(n otherwise 0)",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = (n otherwise 0) + 1\nsay converted\nexit\n",
    [],
  ],
  [
    "original/17/archived paste/(n + 1) s",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = (n + 1) s\nsay converted\nexit\n",
    [],
  ],
  ["original/18/spot.jsonl/text size at say", 'let t = "hello"\nsay t.size\nexit\n'],
  ["original/19/spot.jsonl/paste/t.length", 'let t = "hello"\nsay t.length\nexit\n'],
  [
    "original/20/spot.jsonl/text size at declaration",
    'let t = "hello"\nlet v = t.size\nsay v\nexit\n',
  ],
  ["original/21/spot.jsonl/paste/t.length", 'let t = "hello"\nlet v = t.length\nsay v\nexit\n'],
  [
    "original/22/spot.jsonl/text size at string declaration",
    'let t = "hello"\nlet v: string = t.size\nexit\n',
  ],
  [
    "original/23/spot.jsonl/text size at integer declaration",
    'let t = "hello"\nlet v: integer = t.size\nexit\n',
  ],
  ["original/24/spot.jsonl/paste/t.length", 'let t = "hello"\nlet v: integer = t.length\nexit\n'],
  [
    "original/25/spot.jsonl/dict missing key at logic",
    "let d = dict{k: 1}\nsay d.missing and true\nexit\n",
  ],
  [
    "original/26/spot.jsonl/element + d[5] at untyped sum argument",
    "let d = [[1]]\nfunction count(p) {\n  return p + 1\n}\nsay count(2 + d[5])\nexit\n",
  ],
  [
    "original/27/spot.jsonl/null property's text size at string declaration",
    'let boxes = [{n: 2, text: "hello", items: [1]}, null]\nlet outer = {inner: boxes[1]}\nlet v: string = outer.inner.text.size\nexit\n',
  ],
  [
    "original/28/spot.jsonl/nested join of integer at condition",
    'let box = {items: [1]}\nif box.items.join {\n  say "yes"\n}\nexit\n',
  ],
  [
    "original/29/spot.jsonl/join of duration at fallback",
    "let items = [1 s]\nlet n: integer? = null\nsay n otherwise items.join\nexit\n",
  ],
  [
    "original/30/spot.jsonl/join of set at boolean declaration",
    "let items = [set[1]]\nlet v: boolean = items.join\nexit\n",
  ],
  [
    "original/31/spot.jsonl/number + list of text at receiver",
    'let xs = ["a"]\nsay (1.5 + xs).length\nexit\n',
  ],
  [
    "original/32/spot.jsonl/number + list of integer at untyped returned argument",
    "let xs = [1]\nfunction id(p) {\n  return p\n}\nlet w: string = id(1.5 + xs)\nsay w\nexit\n",
  ],
  [
    "original/33/spot.jsonl/list of number + object at integer[] declaration",
    'let xs = [1.5]\nlet v: integer[] = xs + {n: "x"}\nexit\n',
  ],
  [
    "original/34/spot.jsonl/list of boolean + object at wait",
    'let xs = [true]\nwait xs + {n: "x"}\nexit\n',
  ],
  [
    "original/35/spot.jsonl/list of duration + object at property divisor",
    'let xs = [1 s]\nsay 1 / ({n: xs + {n: "x"}}).n\nexit\n',
  ],
  [
    "original/36/spot.jsonl/object + list of object at product",
    'let xs = [{n: 1}]\nsay 2 * ({n: "x"} + xs)\nexit\n',
  ],
  [
    "original/37/spot.jsonl/object + list of list at object store",
    'let xs = [[1]]\nlet o = {n: "x"}\no = {n: "x"} + xs\nexit\n',
  ],
  [
    "original/38/spot.jsonl/object + list of set at ask prompt",
    'let xs = [set[1]]\nlet asked = askInteger("${{n: "x"} + xs + 1}")\nexit\n',
  ],
  [
    'original/39/spot.jsonl/d["absent"] into string argument',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nfunction use(p: string) {\n  say p\n}\nuse(d["absent"])\nexit\n',
  ],
  [
    "original/40/spot.jsonl/ns[5] into string argument",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nfunction use(p: string) {\n  say p\n}\nuse(ns[5])\nexit\n',
  ],
])
  all.push(input);

// (the pastes of its own.jsonl rows 38 to 42, over the nullable n, the review compiled without globals: their third
// element; it analysed everything else with hostValue)
export const cases = all;
export const globals = ["hostValue"];
export const checks = ["publication", "stops"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node /tmp/agent-work/o4-3a-lead-astra-i1241-r3/evidence/review.mjs",
      "R/astra-m4-i1241-review-r3/COMMANDS:4",
    ],
  ],
  sources: 83,
  sha256: "80c4f51798e2442fb455291279d9ac0d1909d2baba1c2de6e67c1e6c6f823bde",
  dropped: [
    [
      "7ff727cde2c4f7d6dd9d90dd1d83569b9808c018809f1e9bc12c0e388eff9dd3",
      "Accidental unsupported zero-parameter function change() spelling, not a parse-error witness; delta.mjs explicitly corrects these four inputs to function change. (R/astra-m4-i1241-review-r3/review.mjs:43,R/astra-m4-i1241-review-r3/delta.mjs:8,R/astra-m4-i1241-review-r3/corrected.json:1)",
    ],
    [
      "06115f8ad3553a2a3b1c8c0dffeac3f41185386fe45585c0d01f7d4e05c3a1e5",
      "Accidental unsupported zero-parameter function change() spelling, not a parse-error witness; delta.mjs explicitly corrects these four inputs to function change. (R/astra-m4-i1241-review-r3/review.mjs:43,R/astra-m4-i1241-review-r3/delta.mjs:8,R/astra-m4-i1241-review-r3/corrected.json:1)",
    ],
    [
      "ec44325d3d16430573fc634e6db2321d4f666d14eea0efd15c18e36476b9969f",
      "Accidental unsupported zero-parameter function change() spelling, not a parse-error witness; delta.mjs explicitly corrects these four inputs to function change. (R/astra-m4-i1241-review-r3/review.mjs:43,R/astra-m4-i1241-review-r3/delta.mjs:8,R/astra-m4-i1241-review-r3/corrected.json:1)",
    ],
    [
      "0c3aedb93cb74ada963161f5fe62bd3de2bfaf73d7e47bc6dbd95b4321203014",
      "Accidental unsupported zero-parameter function change() spelling, not a parse-error witness; delta.mjs explicitly corrects these four inputs to function change. (R/astra-m4-i1241-review-r3/review.mjs:43,R/astra-m4-i1241-review-r3/delta.mjs:8,R/astra-m4-i1241-review-r3/corrected.json:1)",
    ],
  ],
};
