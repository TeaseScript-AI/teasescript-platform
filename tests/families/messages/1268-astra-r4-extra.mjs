// guard-call-say, guard-call-repeat and related fixed cases; #1268, Astra review, r4
// (R/astra-m4-i1268-review-r4-evidence/extra.mjs).
const generated = (() => {
  const cases = [];
  const add = (name, source, expect = {}) =>
    cases.push({ name, source: source + "\nexit\n", expect });
  for (const [name, value, setup] of [
    ["call", "begin()", "function begin { return 8 }"],
    ["index", "items[0]", "let items = [8]"],
    ["dict", 'book["a"]', "let book = dict{a:8}"],
  ]) {
    add(`declaration-${name}`, `${setup}\nlet score = ${value}\nscore = "eight"\nsay score`, {
      form: "declaration",
    });
    add(
      `declaration-${name}-later`,
      `${setup}\nlet score = ${value}\nrepeat score { say "a" }\nscore = "eight"`,
      { disclosed: "later-narrow-read" },
    );
    add(`declaration-${name}-nullable`, `${setup}\nlet score = ${value}\nscore = null\nsay score`, {
      form: "declaration",
    });
  }
  add(
    "parameter-call",
    'function begin { return 8 }\nfunction tally(n = begin()) { n = "eight"\nsay n }\ntally()',
    {},
  );
  add(
    "parameter-index",
    'let a = [8]\nfunction tally(n = a[0]) { n = "eight"\nsay n }\ntally()',
    {},
  );
  add(
    "global-call",
    'function begin { return 8 }\nglobal total = begin(), default: 8\ntotal = "eight"\nsay total',
  );
  add("decl-comment", 'let total /* here */ = 8\ntotal = "eight"');
  add("decl-multiline", 'let total = (\n8\n)\ntotal = "eight"');
  add("type-list", "let h: integer | string[] = 1");
  add("type-set", "let h: integer | string set = 1");
  add("type-dict", "let h: integer | string dict = 1");
  for (const [name, setup, s] of [
    ["name", "let a = [7, null]\nlet n = a[1]", "n"],
    ["index", "let a = [7, null]", "a[1]"],
    ["call", "let a = [7, null]\nfunction selectAmount { return a[1] }", "selectAmount()"],
  ]) {
    for (const [site, line] of [
      ["say", `say 2 * ${s}`],
      ["repeat", `repeat ${s} { say "r" }`],
      ["condition", `if ${s} <= 7 { say "yes" }`],
      ["lazy", `if false and ${s} > 1 { say 0 }`],
      ["declaration", `let answer = ${s} + 2`],
      ["divisor", `say 20 / (${s} + 1)`],
    ])
      add(`guard-${name}-${site}`, `${setup}\n${line}`);
  }
  add(
    "guard-two-null",
    "let a = [7, null]\nlet b = [8, null]\nlet n = a[1]\nlet m = b[1]\nsay n + m",
  );
  add(
    "guard-union-null",
    'let a: (integer | string | null)[] = [4, "s", null]\nlet n = a[2]\nsay n * 3',
  );
  add(
    "guard-effect-before",
    "let a = [7, null]\nfunction mutate { a[1] = null\nreturn 1 }\nsay mutate() + a[1]",
  );
  for (const [kind, setup, expr] of [
    ["text", 'let t = "Alpha"', "t.upper"],
    ["method", 'let t = "Alpha"', "t.uppercase"],
    ["length", 'let t = "Alpha"', "t.length()"],
    ["numeric", "let n = 104", "n.length"],
    ["duration", "let delay = 2 s", "delay.seconds"],
  ]) {
    for (const [site, line] of [
      ["say", `say ${expr}`],
      ["op", `say 4 / ${expr}`],
      ["decl", `let answer: integer = ${expr}`],
      ["interp", `say "x: \${${expr}}"`],
    ])
      add(`member-${kind}-${site}`, `${setup}\n${line}`);
  }
  add("dict-members", "let catalog = dict{a:2}\nsay catalog.lengths");
  add("dict-methods", "let catalog = dict{a:2}\nsay catalog.first()");
  for (const [name, setup, s] of [
    ["var", "let total = 7", "total"],
    ["index", "let totals = [7]", "totals[0]"],
    ["call", "function total { return 7 }", "total()"],
  ])
    add(`join-${name}`, `${setup}\nsay "Total " + ${s}`);
  for (const [name, setup, s] of [
    ["var", 'let d = toDate("2026-05-12")', "d"],
    ["call", "", 'toDate("2026-05-12")'],
    ["index", 'let ds = [toDate("2026-05-12")]', "ds[0]"],
  ])
    add(`date-${name}`, `${setup}\nsay ${s} + 3 days`);
  add(
    "datetime-minus",
    'let a = toDateTime("2026-05-12T12:00:00")\nlet b = toDateTime("2026-05-11T12:00:00")\nsay a - b',
  );
  add(
    "date-absolute",
    'let t = toAbsoluteDateTime("2026-05-12T12:00:00Z")\nsay t + 2 calendar days',
  );
  add(
    "date-year-index",
    'let stamps = [toAbsoluteDateTime("2026-05-12T12:00:00Z")]\nlet i = 0\nsay stamps[i].year',
  );
  add(
    "union-temporal",
    'let ts: (date | absoluteDateTime)[] = [toDate("2026-05-12"),toAbsoluteDateTime("2026-05-12T12:00:00Z")]\nlet t = ts[0]\nsay t + 1 calendar day',
  );
  add(
    "union-duration",
    'let ts: (datetime | absoluteDateTime)[] = [toDateTime("2026-05-12T12:00:00"),toAbsoluteDateTime("2026-05-12T12:00:00Z")]\nlet t = ts[1]\nsay t + 1 s',
  );
  for (const [kind, value] of [
    ["set-scalar", "set[2,3]"],
    ["set-object", "set[{a:2}]"],
    ["dict-scalar", "dict{a:2,b:3}"],
    ["dict-list", "dict{a:[2]}"],
    ["object", "{a:2}"],
  ])
    add(`shown-${kind}`, `let things = ${value}\nsay "Result: \${things}"`);
  add("list-inline", "let numbers = [1,2]\nsay numbers + 3");
  add("list-index", "let numbers = [1,2]\nlet more = [3]\nsay numbers + more[0]");
  add("player-copy", "say player.lastName");
  add("typed-scalar", "let caption: string = 8 * 3\nsay caption");
  add("typed-call", "function amount { return 8 }\nlet caption: string = amount()\nsay caption");
  add("typed-date-literal", 'let dayValue: date = "2026-05-12"\nsay dayValue');
  add("typed-date-invalid", 'let dayValue: date = "not a date"\nsay dayValue');
  add("key-number", 'let k = 7\nlet a = dict{"7":8}\nsay a[k]');
  add("condition-list", "let a = [7]\nif a {say 1}");
  cases.splice(
    0,
    cases.length,
    ...cases.filter((c) => c.name.startsWith("guard-call-") || c.name.startsWith("typed-date-")),
  );
  for (const [label, body] of [
    ["call-case", 'let t = " Ab "\nsay t.toUpperCase()'],
    ["call-case-numeric", 'let t = " Ab "\nsay t.toUpperCase() + 1'],
    ["call-case-string", 'let t = " Ab "\nsay "Prefix " + t.toUpperCase()'],
    [
      "call-case-argument",
      'let t = " Ab "\nfunction greet(p: string) { say p }\ngreet(t.toUpperCase())',
    ],
    ["call-case-child", 'let ts = [" Ab "]\nsay ts[0].toUpperCase()'],
    ["call-case-missing", 'let t = dict{a:" Ab "}\nsay t["missing"].toUpperCase()'],
    [
      "call-case-union",
      'let ts: (string | integer)[] = ["x",1]\nlet t = ts[1]\nsay t.toUpperCase()',
    ],
    ["call-case-null", 'let ts = ["x",null]\nlet t = ts[1]\nsay t.toUpperCase()'],
    ["later-failure", 'let n = 4\nn = "four"\nrepeat n {}'],
    ["parameter-later", 'function countTimes(n: integer = 2) { repeat n {} }\ncountTimes("two")'],
    ["same-site-store", 'let t = "text"\nlet answer: string = t.toUpperCase()\nsay answer'],
    ["same-site-op", "let d = 2 s\nlet answer: number = 7 / d.seconds\nsay answer"],
    ["inside-other-error", "let d = 2 s\nlet answer: string = 7 / d.seconds\nsay answer"],
    ["known-zero-own", "let d = 0 s\nsay 7 / d.seconds"],
    ["dict-lists-values", 'let d = dict{a:[1]}\nsay "${d}"'],
    ["dict-empty-values", 'let d: integer dict = dict{}\nsay "${d}"'],
    ["check-same-sentence", "let ns = [2,null]\nlet n = ns[1]\nsay n * 7"],
  ])
    add(label, body);
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];

// The pasted forms its public check compiled, as its results record them (R/astra-m4-i1268-review-r4-evidence/extra.mjs).
const captured = [
  [
    "case-extra-results.json/0/orders/0/rows/0/forms/0/fixed",
    "let a = [7, null]\nfunction selectAmount { return a[1] }\nsay 2 * (selectAmount() otherwise 0)\nexit\n",
  ],
  [
    "case-extra-results.json/1/orders/0/rows/0/forms/0/fixed",
    'let a = [7, null]\nfunction selectAmount { return a[1] }\nlet value = selectAmount()\nif value != null { repeat value { say "r" } }\nexit\n',
  ],
  [
    "case-extra-results.json/1/orders/0/rows/0/forms/1/fixed",
    'let a = [7, null]\nfunction selectAmount { return a[1] }\nrepeat selectAmount() otherwise 0 { say "r" }\nexit\n',
  ],
  [
    "case-extra-results.json/2/orders/0/rows/0/forms/0/fixed",
    'let a = [7, null]\nfunction selectAmount { return a[1] }\nlet value = selectAmount()\nif value != null { if value <= 7 { say "yes" } }\nexit\n',
  ],
  [
    "case-extra-results.json/2/orders/0/rows/0/forms/1/fixed",
    'let a = [7, null]\nfunction selectAmount { return a[1] }\nif (selectAmount() otherwise 0) <= 7 { say "yes" }\nexit\n',
  ],
  [
    "case-extra-results.json/3/orders/0/rows/0/forms/0/fixed",
    "let a = [7, null]\nfunction selectAmount { return a[1] }\nif false and (selectAmount() otherwise 0) > 1 { say 0 }\nexit\n",
  ],
  [
    "case-extra-results.json/4/orders/0/rows/0/forms/0/fixed",
    "let a = [7, null]\nfunction selectAmount { return a[1] }\nlet answer = (selectAmount() otherwise 0) + 2\nexit\n",
  ],
  [
    "case-extra-results.json/6/orders/0/rows/0/forms/0/fixed",
    'let dayValue: date = toDate("2026-05-12")\nsay dayValue\nexit\n',
  ],
  [
    "case-extra-results.json/8/orders/0/rows/0/forms/0/fixed",
    'let t = " Ab "\nsay t.uppercase()\nexit\n',
  ],
  [
    "case-extra-results.json/9/orders/0/rows/1/forms/0/fixed",
    'let t = " Ab "\nlet value = t.toUpperCase()\nif value is number { say value + 1 }\nexit\n',
  ],
  [
    "case-extra-results.json/10/orders/0/rows/0/forms/0/fixed",
    'let t = " Ab "\nsay "Prefix " + t.uppercase()\nexit\n',
  ],
  [
    "case-extra-results.json/11/orders/0/rows/1/forms/0/fixed",
    'let t = " Ab "\nfunction greet(p: string) { say p }\ngreet(t.uppercase())\nexit\n',
  ],
  [
    "case-extra-results.json/16/orders/0/rows/0/forms/0/fixed",
    'let n: integer | string = 4\nn = "four"\nrepeat n {}\nexit\n',
  ],
  [
    "case-extra-results.json/17/orders/0/rows/0/forms/0/fixed",
    'function countTimes(n: integer | string = 2) { repeat n {} }\ncountTimes("two")\nexit\n',
  ],
  [
    "case-extra-results.json/18/orders/0/rows/1/forms/0/fixed",
    'let t = "text"\nlet answer: string = t.uppercase()\nsay answer\nexit\n',
  ],
  [
    "case-extra-results.json/19/orders/0/rows/0/forms/0/fixed",
    "let d = 2 s\nlet answer: number = 7 / (d / 1 second)\nsay answer\nexit\n",
  ],
  [
    "case-extra-results.json/21/orders/0/rows/0/forms/0/fixed",
    "let d = 0 s\nsay 7 / (d / 1 second)\nexit\n",
  ],
  [
    "case-extra-results.json/24/orders/0/rows/0/forms/0/fixed",
    "let ns = [2,null]\nlet n = ns[1]\nif n != null { say n * 7 }\nexit\n",
  ],
  [
    "case-extra-results.json/24/orders/0/rows/0/forms/1/fixed",
    "let ns = [2,null]\nlet n = ns[1]\nsay (n otherwise 0) * 7\nexit\n",
  ],
];
export const cases = [...generated, ...captured];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "/home/peter/opt/node-24.18/bin/node extra.mjs",
      "R/astra-m4-i1268-review-r4-evidence/COMMANDS.txt:25",
    ],
  ],
  sources: 44,
  sha256: "c804d42703029001eebe61cec9212529b5adb0f5a070e0026459dc0f674403da",
};
