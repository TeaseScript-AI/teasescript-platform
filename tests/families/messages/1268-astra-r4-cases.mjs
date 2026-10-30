// original declaration-call, declaration-call-later and related inputs; #1268, Astra review, r4
// (R/astra-m4-i1268-review-r4-evidence/cases.mjs).
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
    ["call", "let a = [7, null]\nfunction choose { return a[1] }", "choose()"],
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
  add("typed-date-literal", 'let date: date = "2026-05-12"\nsay date');
  add("typed-date-invalid", 'let date: date = "not a date"\nsay date');
  add("key-number", 'let k = 7\nlet a = dict{"7":8}\nsay a[k]');
  add("condition-list", "let a = [7]\nif a {say 1}");
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];

for (const index of [82, 81, 34, 33, 32, 31, 30, 29]) generated.splice(index, 1);

// The pasted programs its public check compiled, as its results record them (R/astra-m4-i1268-review-r4-evidence/cases.mjs).
const captured = [
  [
    "case-results.json/0/orders/0/rows/0/forms/0/fixed",
    'function begin { return 8 }\nlet score: integer | string = begin()\nscore = "eight"\nsay score\nexit\n',
  ],
  [
    "case-results.json/1/orders/0/rows/0/forms/0/fixed",
    'function begin { return 8 }\nlet score: integer | string = begin()\nrepeat score { say "a" }\nscore = "eight"\nexit\n',
  ],
  [
    "case-results.json/3/orders/0/rows/0/forms/0/fixed",
    'let items = [8]\nlet score: integer | string = items[0]\nscore = "eight"\nsay score\nexit\n',
  ],
  [
    "case-results.json/4/orders/0/rows/0/forms/0/fixed",
    'let items = [8]\nlet score: integer | string = items[0]\nrepeat score { say "a" }\nscore = "eight"\nexit\n',
  ],
  [
    "case-results.json/6/orders/0/rows/0/forms/0/fixed",
    'let book = dict{a:8}\nlet score: integer | string = book["a"]\nscore = "eight"\nsay score\nexit\n',
  ],
  [
    "case-results.json/7/orders/0/rows/0/forms/0/fixed",
    'let book = dict{a:8}\nlet score: integer | string = book["a"]\nrepeat score { say "a" }\nscore = "eight"\nexit\n',
  ],
  [
    "case-results.json/9/orders/0/rows/0/forms/0/fixed",
    'function begin { return 8 }\nfunction tally(n: integer | string = begin()) { n = "eight"\nsay n }\ntally()\nexit\n',
  ],
  [
    "case-results.json/10/orders/0/rows/0/forms/0/fixed",
    'let a = [8]\nfunction tally(n: integer | string = a[0]) { n = "eight"\nsay n }\ntally()\nexit\n',
  ],
  [
    "case-results.json/11/orders/0/rows/0/forms/0/fixed",
    'function begin { return 8 }\nglobal total: integer | string = begin(), default: 8\ntotal = "eight"\nsay total\nexit\n',
  ],
  [
    "case-results.json/12/orders/0/rows/0/forms/0/fixed",
    'let total: integer | string = 8\ntotal = "eight"\nexit\n',
  ],
  [
    "case-results.json/13/orders/0/rows/0/forms/0/fixed",
    "function typed(p: integer | string) { say 1 }\nexit\n",
  ],
  [
    "case-results.json/14/orders/0/rows/0/forms/0/fixed",
    "function typed(p: (integer | string)[]) { say 1 }\nexit\n",
  ],
  [
    "case-results.json/15/orders/0/rows/0/forms/0/fixed",
    "function typed(p: (integer | string) set) { say 1 }\nexit\n",
  ],
  [
    "case-results.json/16/orders/0/rows/0/forms/0/fixed",
    "function typed(p: (integer | string) dict) { say 1 }\nexit\n",
  ],
  [
    "case-results.json/17/orders/0/rows/0/forms/0/fixed",
    "let a = [7, null]\nlet n = a[1]\nif n != null { say 2 * n }\nexit\n",
  ],
  [
    "case-results.json/17/orders/0/rows/0/forms/1/fixed",
    "let a = [7, null]\nlet n = a[1]\nsay 2 * (n otherwise 0)\nexit\n",
  ],
  [
    "case-results.json/18/orders/0/rows/0/forms/0/fixed",
    'let a = [7, null]\nlet n = a[1]\nif n != null { repeat n { say "r" } }\nexit\n',
  ],
  [
    "case-results.json/18/orders/0/rows/0/forms/1/fixed",
    'let a = [7, null]\nlet n = a[1]\nrepeat n otherwise 0 { say "r" }\nexit\n',
  ],
  [
    "case-results.json/19/orders/0/rows/0/forms/0/fixed",
    'let a = [7, null]\nlet n = a[1]\nif n != null { if n <= 7 { say "yes" } }\nexit\n',
  ],
  [
    "case-results.json/19/orders/0/rows/0/forms/1/fixed",
    'let a = [7, null]\nlet n = a[1]\nif (n otherwise 0) <= 7 { say "yes" }\nexit\n',
  ],
  [
    "case-results.json/20/orders/0/rows/0/forms/0/fixed",
    "let a = [7, null]\nlet n = a[1]\nif false and (n otherwise 0) > 1 { say 0 }\nexit\n",
  ],
  [
    "case-results.json/21/orders/0/rows/0/forms/0/fixed",
    "let a = [7, null]\nlet n = a[1]\nlet answer = (n otherwise 0) + 2\nexit\n",
  ],
  [
    "case-results.json/22/orders/0/rows/0/forms/0/fixed",
    "let a = [7, null]\nlet n = a[1]\nif n != null { say 20 / (n + 1) }\nexit\n",
  ],
  [
    "case-results.json/23/orders/0/rows/0/forms/0/fixed",
    "let a = [7, null]\nlet value = a[1]\nif value != null { say 2 * value }\nexit\n",
  ],
  [
    "case-results.json/23/orders/0/rows/0/forms/1/fixed",
    "let a = [7, null]\nsay 2 * (a[1] otherwise 0)\nexit\n",
  ],
  [
    "case-results.json/24/orders/0/rows/0/forms/0/fixed",
    'let a = [7, null]\nlet value = a[1]\nif value != null { repeat value { say "r" } }\nexit\n',
  ],
  [
    "case-results.json/24/orders/0/rows/0/forms/1/fixed",
    'let a = [7, null]\nrepeat a[1] otherwise 0 { say "r" }\nexit\n',
  ],
  [
    "case-results.json/25/orders/0/rows/0/forms/0/fixed",
    'let a = [7, null]\nlet value = a[1]\nif value != null { if value <= 7 { say "yes" } }\nexit\n',
  ],
  [
    "case-results.json/25/orders/0/rows/0/forms/1/fixed",
    'let a = [7, null]\nif (a[1] otherwise 0) <= 7 { say "yes" }\nexit\n',
  ],
  [
    "case-results.json/26/orders/0/rows/0/forms/0/fixed",
    "let a = [7, null]\nif false and (a[1] otherwise 0) > 1 { say 0 }\nexit\n",
  ],
  [
    "case-results.json/27/orders/0/rows/0/forms/0/fixed",
    "let a = [7, null]\nlet answer = (a[1] otherwise 0) + 2\nexit\n",
  ],
  [
    "case-results.json/28/orders/0/rows/0/forms/0/fixed",
    "let a = [7, null]\nlet value = a[1]\nif value != null { say 20 / (value + 1) }\nexit\n",
  ],
  [
    "case-results.json/35/orders/0/rows/0/forms/0/fixed",
    "let a = [7, null]\nlet b = [8, null]\nlet n = a[1]\nlet m = b[1]\nsay (n otherwise 0) + m\nexit\n",
  ],
  [
    "case-results.json/35/orders/0/rows/1/forms/0/fixed",
    "let a = [7, null]\nlet b = [8, null]\nlet n = a[1]\nlet m = b[1]\nsay n + (m otherwise 0)\nexit\n",
  ],
  [
    "case-results.json/36/orders/0/rows/0/forms/0/fixed",
    'let a: (integer | string | null)[] = [4, "s", null]\nlet n = a[2]\nif n is integer { say n * 3 }\nexit\n',
  ],
  [
    "case-results.json/37/orders/0/rows/0/forms/0/fixed",
    "let a = [7, null]\nfunction mutate { a[1] = null\nreturn 1 }\nsay mutate() + (a[1] otherwise 0)\nexit\n",
  ],
  [
    "case-results.json/42/orders/0/rows/0/forms/0/fixed",
    'let t = "Alpha"\nsay t.uppercase()\nexit\n',
  ],
  [
    "case-results.json/45/orders/0/rows/0/forms/0/fixed",
    'let t = "Alpha"\nsay "x: ${t.uppercase()}"\nexit\n',
  ],
  ["case-results.json/46/orders/0/rows/0/forms/0/fixed", 'let t = "Alpha"\nsay t.length\nexit\n'],
  [
    "case-results.json/47/orders/0/rows/0/forms/0/fixed",
    'let t = "Alpha"\nsay 4 / t.length\nexit\n',
  ],
  [
    "case-results.json/48/orders/0/rows/1/forms/0/fixed",
    'let t = "Alpha"\nlet answer: integer = t.length\nexit\n',
  ],
  [
    "case-results.json/49/orders/0/rows/0/forms/0/fixed",
    'let t = "Alpha"\nsay "x: ${t.length}"\nexit\n',
  ],
  [
    "case-results.json/50/orders/0/rows/0/forms/0/fixed",
    "let n = 104\nsay toString(n).length\nexit\n",
  ],
  [
    "case-results.json/51/orders/0/rows/0/forms/0/fixed",
    "let n = 104\nsay 4 / toString(n).length\nexit\n",
  ],
  [
    "case-results.json/52/orders/0/rows/0/forms/0/fixed",
    "let n = 104\nlet answer: integer = toString(n).length\nexit\n",
  ],
  [
    "case-results.json/53/orders/0/rows/0/forms/0/fixed",
    'let n = 104\nsay "x: ${toString(n).length}"\nexit\n',
  ],
  [
    "case-results.json/54/orders/0/rows/0/forms/0/fixed",
    "let delay = 2 s\nsay delay / 1 second\nexit\n",
  ],
  [
    "case-results.json/55/orders/0/rows/0/forms/0/fixed",
    "let delay = 2 s\nsay 4 / (delay / 1 second)\nexit\n",
  ],
  [
    "case-results.json/57/orders/0/rows/0/forms/0/fixed",
    'let delay = 2 s\nsay "x: ${delay / 1 second}"\nexit\n',
  ],
  [
    "case-results.json/60/orders/0/rows/0/forms/0/fixed",
    'let total = 7\nsay "Total " + "${total}"\nexit\n',
  ],
  [
    "case-results.json/63/orders/0/rows/0/forms/0/fixed",
    'let d = toDate("2026-05-12")\nsay d + 3 calendar days\nexit\n',
  ],
  [
    "case-results.json/67/orders/0/rows/0/forms/0/fixed",
    'let t = toAbsoluteDateTime("2026-05-12T12:00:00Z")\nsay (t.toDateTime() + 2 calendar days).toAbsoluteDateTime()\nexit\n',
  ],
  [
    "case-results.json/70/orders/0/rows/0/forms/0/fixed",
    'let ts: (datetime | absoluteDateTime)[] = [toDateTime("2026-05-12T12:00:00"),toAbsoluteDateTime("2026-05-12T12:00:00Z")]\nlet t = ts[1]\nif t is absoluteDateTime { say t + 1 s }\nexit\n',
  ],
  [
    "case-results.json/71/orders/0/rows/0/forms/0/fixed",
    'let things = set[2,3]\nsay "Result: ${things.toList().join()}"\nexit\n',
  ],
  [
    "case-results.json/73/orders/0/rows/0/forms/0/fixed",
    'let things = dict{a:2,b:3}\nsay "Result: ${things.values.join()}"\nexit\n',
  ],
  [
    "case-results.json/75/orders/0/rows/0/forms/0/fixed",
    'let things = {a:2}\nsay "Result: ${things.a}"\nexit\n',
  ],
  [
    "case-results.json/76/orders/0/rows/0/forms/0/fixed",
    "let numbers = [1,2]\nnumbers.add(3)\nsay numbers\nexit\n",
  ],
  [
    "case-results.json/76/orders/0/rows/0/forms/1/fixed",
    "let numbers = [1,2]\nsay numbers + [3]\nexit\n",
  ],
  [
    "case-results.json/79/orders/0/rows/0/forms/0/fixed",
    'let caption: string = "${8 * 3}"\nsay caption\nexit\n',
  ],
  [
    "case-results.json/83/orders/0/rows/0/forms/0/fixed",
    'let k = 7\nlet a = dict{"7":8}\nsay a["${k}"]\nexit\n',
  ],
  [
    "case-results.json/84/orders/0/rows/0/forms/0/fixed",
    "let a = [7]\nif a.length > 0 {say 1}\nexit\n",
  ],
  [
    "case-results.json/78/orders/0/rows/0/forms/0/fixed",
    "player.copyFrom(playerProfile)\nsay player.lastName\nexit\n",
  ],
];
export const cases = [...generated, ...captured];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "/home/peter/opt/node-24.18/bin/node cases.mjs",
      "R/astra-m4-i1268-review-r4-evidence/COMMANDS.txt:11",
    ],
  ],
  sources: 147,
  sha256: "a90b6a0849bc6dd4875164f6b43bfa35eee0f35ff2fea774138481479a124910",
  dropped: [
    [
      "d8e93eb3dccd63b86a57df26ebd867239c7f5e2a69fc5a0f511f700af056ada3",
      "The case tests guarded nullable calls, but choose is now a reserved legacy ask spelling; its name/parse failure is not the intended test. (R/astra-m4-i1268-review-r4-evidence/cases.mjs:17,R/astra-m4-i1268-review-r4-evidence/case-results.json:1)",
    ],
    [
      "6f5b5c82f41d526f1b4d842603e3f575eb2196b41fa951ede9a624d1ddf0d78e",
      "The case tests guarded nullable calls, but choose is now a reserved legacy ask spelling; its name/parse failure is not the intended test. (R/astra-m4-i1268-review-r4-evidence/cases.mjs:17,R/astra-m4-i1268-review-r4-evidence/case-results.json:1)",
    ],
    [
      "786862be99d1eebc5dea360a256018d855d796ccb77d29652c7f2c09e9731572",
      "The case tests guarded nullable calls, but choose is now a reserved legacy ask spelling; its name/parse failure is not the intended test. (R/astra-m4-i1268-review-r4-evidence/cases.mjs:17,R/astra-m4-i1268-review-r4-evidence/case-results.json:1)",
    ],
    [
      "41d37991a2aed0d2851b0b9b789b4fdd54281c9341ab80f6f60a64d9e5e2c256",
      "The case tests guarded nullable calls, but choose is now a reserved legacy ask spelling; its name/parse failure is not the intended test. (R/astra-m4-i1268-review-r4-evidence/cases.mjs:17,R/astra-m4-i1268-review-r4-evidence/case-results.json:1)",
    ],
    [
      "cda5cdf0f6c39c7ce8dd4843fc7000c6af420faeb88be14056210c02dcdfc9bc",
      "The case tests guarded nullable calls, but choose is now a reserved legacy ask spelling; its name/parse failure is not the intended test. (R/astra-m4-i1268-review-r4-evidence/cases.mjs:17,R/astra-m4-i1268-review-r4-evidence/case-results.json:1)",
    ],
    [
      "dac228b133472043fa95569eadbad2cc60a08fadaa9aa36fdee8083bb4b6257b",
      "The case tests guarded nullable calls, but choose is now a reserved legacy ask spelling; its name/parse failure is not the intended test. (R/astra-m4-i1268-review-r4-evidence/cases.mjs:17,R/astra-m4-i1268-review-r4-evidence/case-results.json:1)",
    ],
    [
      "a32af55524c29292d4ef14ab8eb23b4c9934eaa6345cc23f5d911e95a0c9c13d",
      "The case tests date conversion, but the variable date conflicts with a protected name; that declaration failure is not the intended test. (R/astra-m4-i1268-review-r4-evidence/cases.mjs:41,R/astra-m4-i1268-review-r4-evidence/case-results.json:1)",
    ],
    [
      "c85acd3da0c19609a090aac1f1875dd17de4118b5102229e7a57a248d61a11b4",
      "The case tests date conversion, but the variable date conflicts with a protected name; that declaration failure is not the intended test. (R/astra-m4-i1268-review-r4-evidence/cases.mjs:41,R/astra-m4-i1268-review-r4-evidence/case-results.json:1)",
    ],
  ],
};
