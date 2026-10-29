// #1357, Astra review: the operation family (R/astra-m4-i1357-review-evidence/vps/own-shapes.mjs), as review.mjs compiled it:
// each shape at 4 with the six controls (its mutant and diff runs) and at 64 and 128 (its growth run).

const many = (n, f, sep = "\n") => Array.from({ length: n }, (_, i) => f(i)).join(sep);
const program = (...s) => s.join("\n") + "\nexit\n";
const chain = (n, last) => `[0] + ${many(n, (i) => `[${i + 1}]`, " + ")} + [${last}]`;
const choice = (n, global = "hostValue", wrap = (x) => x) =>
  `askChoice ${many(n, (i) => `{text: "option${i}", value: ${wrap(`${global}.p${i}`)}}`, ", ")}`;
const max = (n) => `${"max(".repeat(n)}hostValue.n${many(n, (i) => `, ${i})`, "")}`;
export const shapes = {};
const endings = {
  string: '"tail"',
  number: "1.5",
  boolean: "true",
  null: "null",
  duration: "1 s",
  angle: "90 deg",
  calendar: "1 calendar month",
  object: "{n:1}",
  list: "[1]",
  dict: "dict{a:1}",
  set: "set[1,2]",
  range: "1..3",
  regex: "/x/",
  date: 'toDate("2026-01-01")',
  time: 'toTime("12:00")',
  datetime: 'toDateTime("2026-01-01T12:00")',
  host: "otherHost",
};
for (const [name, last] of Object.entries(endings))
  shapes[`end-${name}`] = (n) => program(`let s = ${chain(n, last)}`, "say s.length");
for (const type of ["absoluteDateTime", "speaker", "timer", "media", "messageHandle", "script"])
  shapes[`end-${type}`] = (n) =>
    program(`let tail: ${type} = otherHost`, `let s = ${chain(n, "tail")}`, "say s.length");
shapes["nested-object-joins"] = (n) => {
  let e = "[0]";
  for (let i = 0; i < n; i++) e = `({a: [${e} + [${i}]]}).a[0]`;
  return program(`let s = ${e} + [true]`, "say s.length");
};
shapes["forked-bound-prefixes"] = (n) =>
  program(
    "let a0 = [0]",
    "let b0 = [0]",
    many(
      n,
      (i) => `let a${i + 1} = a${i} + [${i}]
let b${i + 1} = b${i} + [${i}]
let z${i} = [a${i + 1}, b${i + 1}]
say z${i}[hostValue.i].length`,
    ),
  );
shapes["wide-role-alias-permutations"] = (n) =>
  program(
    `let a = ${max(n)}`,
    `let b = ${max(n)}`,
    `let c = ${max(n)}`,
    "let d = a",
    many(
      n,
      (i) => `let s${i} = [${["a,b,c", "c,a,b", "b,d,c", "d,b"][i % 4]}]
let n${i}: integer = s${i}[hostValue.i]`,
    ),
  );
shapes["three-leaf-classes-rotating"] = (n) =>
  program(
    `let a = ${choice(n)}`,
    `let b = ${choice(n)}`,
    `let c = ${choice(n, "otherHost")}`,
    `let d = ${choice(n, "otherHost")}`,
    `let e = ${choice(n, "hostValue", (x) => `load("${x}", default: ${x})`)}`,
    `let f = ${choice(n, "hostValue", (x) => `load("${x}", default: ${x})`)}`,
    many(
      n,
      (i) => `let s${i} = [${["a,b,c,d,e,f", "f,e,d,c,b,a", "c,a,e,d,b,f"][i % 3]}]
let n${i}: integer = s${i}[hostValue.i]`,
    ),
  );
shapes["leaf-choices-in-properties"] = (n) =>
  program(
    `let a = ${choice(n)}`,
    `let b = ${choice(n)}`,
    many(
      n,
      (i) => `let s${i} = [{p:a}, {p:b}]
let n${i}: integer = s${i}[hostValue.i].p`,
    ),
  );
shapes["wide-choice-with-literal"] = (n) =>
  program(
    `let a = ${choice(n)}`,
    `let b = ${choice(n)}`,
    many(
      n,
      (i) => `let s${i} = [${i % 2 ? "b, [false], a" : "a, [0], b"}]
let n${i}: integer = s${i}[hostValue.i]`,
    ),
  );
shapes["repeat-add-classes"] = (n) =>
  program(
    "let xs = []",
    many(n, (i) => `xs.add({a: ${i}, b: true})`),
    "say xs[hostValue.i].a",
  );
shapes["long-right-operands"] = (n) =>
  program(
    `let x = ${max(n)}`,
    `let y = ${max(n)}`,
    `let z = ${max(n)}`,
    "let s = x + y + z + x + y + z",
    "say s",
  );
export const controls = [
  [
    "disjoint-leaf-groups",
    program(
      `let a = ${choice(3)}`,
      `let b = ${choice(3)}`,
      `let c = ${choice(3, "otherHost")}`,
      `let d = ${choice(3, "otherHost")}`,
      "let x = [a,b]",
      "let y = [c,d]",
      "let z = [a,b,c,d]",
      "let i: integer = x[hostValue.i]",
      "let j: integer = y[hostValue.i]",
      "let k: integer = z[hostValue.i]",
    ),
  ],
  [
    "different-property-leaves",
    program(
      "let a = {p: hostValue.p, q: otherHost.q}",
      "let b = {p: hostValue.p, q: otherHost.q}",
      "let c = {p: otherHost.p, q: hostValue.q}",
      "let d = {p: otherHost.p, q: hostValue.q}",
      "let x = [a,b,c,d]",
      "let i: integer = x[hostValue.i].p",
      "let j: integer = x[hostValue.i].q",
    ),
  ],
  [
    "cell-and-loop",
    program(
      "let a = hostValue",
      "let b = otherHost",
      "while hostValue.flag {",
      "a = [a,b]",
      "b = [a,otherHost]",
      "}",
      "let x = [a,b]",
      "let n: integer = x[hostValue.i]",
    ),
  ],
  [
    "a2-conflict-padding",
    program(
      "let pad = [hostValue, otherHost]",
      "let a = {p:{n:1}}",
      'let b = {p:{n:"x"}}',
      "let c = {q:hostValue}",
      "let xs = [c,a,b,a,c,b]",
      "let v = xs[hostValue.i]",
      "say v.p.n",
    ),
  ],
  [
    "f18-plus-equivalence",
    program(
      'let a = load("one", default: [hostValue])',
      'let b = load("two", default: [otherHost])',
      "let x = [a,b,a]",
      "let y = [b,a,b]",
      "let s = [0]+[1]+[2]+[true]",
      "say x[hostValue.i][0]",
      "say y[hostValue.i][0]",
      "say s.length",
    ),
  ],
  [
    "guard-between-sites",
    program(
      "let a = hostValue",
      "let b = otherHost",
      "let x = [a,b]",
      "if a is integer {",
      "let y = [a,b]",
      "let n: integer = y[hostValue.i]",
      "}",
      "let z = [a,b]",
      "let m: integer = z[hostValue.i]",
    ),
  ],
];

export const sizes = [4, 64, 128];
export const cases = controls;
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "otherHost"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node review.mjs growth <tree> src", "R/astra-m4-i1357-review-evidence/vps/queue.sh:7"],
    ["node review.mjs growth <tree> rev", "R/astra-m4-i1357-review-evidence/vps/queue.sh:7"],
    ["node review.mjs growth <tree> srcoff", "R/astra-m4-i1357-review-evidence/vps/queue.sh:7"],
    ["node review.mjs growth <tree> revoff", "R/astra-m4-i1357-review-evidence/vps/queue.sh:7"],
    ["node review.mjs mutant <tree> list-key", "R/astra-m4-i1357-review-evidence/vps/queue.sh:10"],
    ["node review.mjs mutant <tree> node-key", "R/astra-m4-i1357-review-evidence/vps/queue.sh:10"],
    [
      "node review.mjs diff <tree> corrected",
      "R/astra-m4-i1357-review-evidence/desktop/diff-corrected.jsonl:1 (its result's header)",
    ],
  ],
  sources: 99,
  sha256: "5a9e8942087c3d603d9bfc09a9d76d63290998b32a35d3f7e0e9a8c241e2b728",
};
