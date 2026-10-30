// S10 U4a, Opus builder (R/opus-m4-s10-u4a/mkcases.mjs): the collection-test cases, each body as the harness compiled it.
export const cases = (() => {
  const pre = [
    'let choice = askBoolean "change?"',
    "let xs: integer?[] = [1]",
    "if choice { xs = [null] }",
  ];
  const L = (...lines) => lines.join("\n");
  const cases = [];
  const sel = ["xs[0]", "xs.first", "xs.last", "xs.random"];
  for (const r of sel)
    cases.push([
      `collection test: ${r}`,
      L(...pre, `if xs is integer[] { let sink: integer = ${r} }`),
    ]);
  for (const r of sel)
    cases.push([
      `root non-null test: ${r}`,
      L(
        'let choice = askBoolean "change?"',
        "let xs: integer?[]? = [1]",
        "if choice { xs = [null] }",
        "if choice { xs = null }",
        `if xs != null { let sink: integer = ${r} }`,
      ),
    ]);
  cases.push([
    "root then collection test: xs.first",
    L(
      'let choice = askBoolean "change?"',
      "let xs: integer?[]? = [1]",
      "if choice { xs = [null] }",
      "if choice { xs = null }",
      "if xs != null { if xs is integer[] { let sink: integer = xs.first } }",
    ),
  ]);
  for (const r of sel) cases.push([`no test: ${r}`, L(...pre, `let sink: integer = ${r}`)]);
  const between = {
    "add null": "xs.add(null)",
    reverse: "xs.reverse()",
    "call storing xs": "spoil()",
    "element store null": "xs[0] = null",
    "whole store [2]": "xs = [2]",
    "whole store [null]": "xs = [null]",
  };
  for (const [what, stmt] of Object.entries(between))
    for (const r of ["xs[0]", "xs.first", "xs.random"])
      cases.push([
        `${what} between: ${r}`,
        L(
          ...pre,
          "function spoil { xs = [null] }",
          `if xs is integer[] { ${stmt}\nlet sink: integer = ${r} }`,
        ),
      ]);
  for (const r of ["xs[0]", "xs.first", "xs.last", "xs.random"]) {
    cases.push([
      `may be empty: ${r}`,
      L(
        'let choice = askBoolean "change?"',
        "let xs: integer?[] = []",
        "if choice { xs = [null] }",
        `if xs is integer[] { let sink: integer = ${r} }`,
      ),
    ]);
    cases.push([
      `loaded: ${r}`,
      L(
        'let xs: integer?[] = load("xs", default: [1])',
        `if xs is integer[] { let sink: integer = ${r} }`,
      ),
    ]);
  }
  const rows = [
    'let choice = askBoolean "change?"',
    "let rows: integer?[][] = [[1]]",
    "if choice { rows = [[null]] }",
    "let row = 0",
  ];
  for (const r of [
    "rows[0][0]",
    "rows[0].first",
    "rows[row].last",
    "rows[row + 1].first",
    "rows[row + 1].random",
    "rows.first[0]",
    "rows.first.last",
    "rows.random.first",
  ])
    cases.push([
      `root test of rows: ${r}`,
      L(...rows, `if rows is integer[][] { let sink: integer = ${r} }`),
    ]);
  for (const r of [
    "rows[0][0]",
    "rows[0].first",
    "rows[0].random",
    "rows[1].first",
    "rows[row].first",
    "rows.first.first",
  ])
    cases.push([
      `test of rows[0]: ${r}`,
      L(...rows, `if rows[0] is integer[] { let sink: integer = ${r} }`),
    ]);
  for (const [t, r] of [
    ["xs.first", "xs.first"],
    ["xs.first", "xs.last"],
    ["xs.first", "xs[0]"],
    ["xs[0]", "xs.first"],
    ["xs.last", "xs.last"],
    ["xs.random", "xs.random"],
  ])
    cases.push([
      `test of ${t} != null: ${r}`,
      L(...pre, `if ${t} != null { let sink: integer = ${r} }`),
    ]);
  for (const p of ["first", "last", "random"]) {
    cases.push([
      `own property ${p}, own test`,
      L(
        'let choice = askBoolean "change?"',
        `let box = {${p}: 1}`,
        `if choice { box.${p} = null }`,
        `if box.${p} != null { let sink: integer = box.${p} }`,
      ),
    ]);
    cases.push([
      `own property ${p}, no test`,
      L(
        'let choice = askBoolean "change?"',
        `let box = {${p}: 1}`,
        `if choice { box.${p} = null }`,
        `let sink: integer = box.${p}`,
      ),
    ]);
  }
  cases.push([
    "parameter list or object: v.first under a collection test",
    L(
      "function pick(v) {",
      'if v is integer[] { let sink: integer = v.first\nsay "${sink}" }',
      "}",
      "pick([1])",
      'pick({first: "a"})',
    ),
  ]);
  cases.push([
    "parameter list or object: v.first under v.first != null",
    L(
      "function pick(v) {",
      'if v.first != null { let sink: integer = v.first\nsay "${sink}" }',
      "}",
      "pick([1, null])",
      "pick({first: null})",
    ),
  ]);
  cases.push([
    "property path: o.list.first",
    L(
      'let choice = askBoolean "change?"',
      "let o = {list: [1]}",
      "if choice { o.list = [null] }",
      "if o.list is integer[] { let sink: integer = o.list.first }",
    ),
  ]);
  cases.push([
    "set: s.first",
    L(
      'let choice = askBoolean "change?"',
      "let s: integer? set = set [1]",
      "if choice { s = set [null] }",
      "if s is integer set { let sink: integer = s.first }",
    ),
  ]);
  cases.push([
    "copy of the selection",
    L(...pre, "if xs is integer[] { let copy = xs.first\nlet sink: integer = copy }"),
  ]);
  cases.push([
    "operation on the selection",
    L(...pre, "if xs is integer[] { let sink: integer = xs.first + 1 }"),
  ]);
  cases.push([
    "selection in a literal",
    L(...pre, "if xs is integer[] { let both: integer[] = [xs.first, xs.last, xs[0]] }"),
  ]);
  cases.push([
    "selections inside and outside the test in one literal",
    L(
      ...pre,
      "let outside = [xs.first]",
      "if xs is integer[] { let inside: integer[] = [xs.first] }",
    ),
  ]);
  cases.push([
    "negative collection test: xs.first",
    L(...pre, "if xs is not integer[] { let sink: integer = xs.first }"),
  ]);
  cases.push([
    "else of a collection test: xs.first",
    L(...pre, 'if xs is integer[] { say "ok" } else { let sink: integer = xs.first }'),
  ]);
  cases.push([
    "leaving branch: xs.first after",
    L(...pre, "if xs is not integer[] { exit }", "let sink: integer = xs.first"),
  ]);
  cases.push([
    "loop preserving element store: xs.first",
    L(...pre, "if xs is integer[] { repeat 2 { xs[0] = 2\nlet sink: integer = xs.first } }"),
  ]);
  cases.push([
    "and operand: xs.first",
    L(...pre, "let ok = xs is integer[] and [xs.first + 1].length > 0"),
  ]);
  // compiled through harness.mjs:23's files(), which ends each body with an exit
  return cases.map(([name, source]) => [name, source + "\nexit\n"]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node evidence/mkcases.mjs", "R/opus-m4-s10-u4a/REPRODUCE.md:5"],
    [
      "node evidence/probe.mjs ROOT evidence/cases.json OUT.json",
      "R/opus-m4-s10-u4a/REPRODUCE.md:5",
    ],
  ],
  sources: 78,
  sha256: "5d5dcccc3807f3b4e26fbfc4d71a4d306d6a683d487d52c5540411c5d8fadaa0",
};
