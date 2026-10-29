// #1268, Astra r4, builder generators (R/astra-m4-i1268-review-r4-evidence/builder/generators/paste-1273.mjs): the
// family run's cases (nullable and present subjects in every use, the others and the errors), and the fixed programs
// both its runs compiled after pasting each offered form. The rows its fixture run read from the repository's type-core
// fixture (tests/fixtures/type-core/cells.jsonl) are not copied; the programs it pasted from them are.
const lines = (...parts) => parts.filter((part) => part !== "").join("\n") + "\nexit\n";
// subjects that may be null (a variable, a list element, a property, a call, a dict value) and their non-null controls
const NULLABLE = [
  ["variable", "let ns = [1, null]\nlet n = ns[1]", "n"],
  ["element", "let ns = [1, null]", "ns[1]"],
  ["property", "let ns = [1, null]\nlet box = {n: ns[1]}", "box.n"],
  ["call", "let ns = [1, null]\nfunction f { return ns[1] }", "f()"],
  ["dict value", "let d = dict{a: 1, b: null}", 'd["b"]'],
];
const PRESENT = [
  ["variable", "let n = 1", "n"],
  ["element", "let ns = [1, 2]", "ns[1]"],
  ["property", "let box = {n: 2}", "box.n"],
];
// uses of an integer subject `S` (an operand, a store, a condition, a count, an interpolation, an argument, a divisor,
// a return, inside a block, a timer, a loop's condition, a declaration's start value, a short-circuit's right side)
const USES = [
  ["say", (s) => `say ${s} + 1`],
  ["let", (s) => `let m = ${s} + 1\nsay m`],
  ["store", (s) => `let m = 0\nm = ${s} + 1\nsay m`],
  ["if", (s) => `if ${s} < 1 { say "low" } else { say "high" }`],
  ["repeat", (s) => `repeat ${s} { say "x" }`],
  ["interpolation", (s) => `say "\${${s} + 1}"`],
  ["argument", (s) => `function show(v: integer) { say v }\nshow(${s})`],
  ["divisor", (s) => `say 10 / ${s}`],
  ["product", (s) => `say ${s} * 2`],
  ["negation", (s) => `say -${s}`],
  ["block", (s) => `if true {\n  say ${s} + 1\n}`],
  ["one-line block", (s) => `if true { say ${s} + 1 }`],
  ["return", (s) => `function g { return ${s} + 1 }\nsay g()`],
  ["while", (s) => `let k = 0\nwhile k < ${s} { k = k + 1 }\nsay k`],
  ["or", (s) => `if false or ${s} > 0 { say 1 }`],
  ["timer", (s) => `let t = timer async 1 s { say ${s} + 1 }`],
  ["list literal", (s) => `say [${s} + 1][0]`],
  ["two reads", (s) => `say ${s} + ${s}`],
  ["comparison", (s) => `say ${s} == 1`],
];
// text, list and union subjects with their uses
const OTHERS = [
  ["text receiver", 'let ts = ["ab", null]\nlet t = ts[1]', (s) => `say ${s}.length`, "t"],
  ["text receiver element", 'let ts = ["ab", null]', (s) => `say ${s}.length + 1`, "ts[1]"],
  ["text join", 'let ts = ["ab", null]\nlet t = ts[1]', (s) => `say "x" + ${s}`, "t"],
  ["boolean condition", "let bs = [true, null]\nlet b = bs[1]", (s) => `if ${s} { say 1 }`, "b"],
  ["list iterable", "let ls = [[1], null]\nlet l = ls[1]", (s) => `for x in ${s} { say x }`, "l"],
  ["list add", "let ls = [[1], null]\nlet l = ls[1]", (s) => `${s}.add(2)\nsay ${s}`, "l"],
  [
    "union operand",
    'let us: (integer | string)[] = [1, "a"]\nlet u = us[0]',
    (s) => `say ${s} + 1`,
    "u",
  ],
  ["union element", 'let us: (integer | string)[] = [1, "a"]', (s) => `say ${s} + 1`, "us[0]"],
  [
    "union and null",
    'let us: (integer | string | null)[] = [1, "a", null]\nlet u = us[0]',
    (s) => `say ${s} + 1`,
    "u",
  ],
  [
    "union in declaration",
    'let us: (integer | string)[] = [1, "a"]',
    (s) => `let m = ${s} + 1\nsay m`,
    "us[0]",
  ],
  ["selection", "let groups: integer[][] = [[], [21]]", (s) => `say ${s}.last`, "groups[1]"],
  [
    "selection random",
    "let groups: integer[][] = [[], [21]]",
    (s) => `say ${s}.last`,
    "groups.random",
  ],
  [
    "selection variable",
    "let groups: integer[][] = [[], [21]]\nlet g = groups[1]",
    (s) => `say ${s}.first`,
    "g",
  ],
  ["external", "let v = hostValue", (s) => `say ${s} + 1`, "v"],
];
// errors whose fixes #1268 rewrote: declarations (a let, a global, a parameter, written or not, each start value),
// written types, conditions, keys, shown values, joins, date and time operations, member conversions
const ERRORS = [
  ...["1", "make()", "[1][0]", 'd["a"]', "n + 1", "-1", "(1)"].map((start) => [
    `declaration ${start}`,
    `function make { return 1 }\nlet d = dict{a: 1}\nlet n = 1\nlet mood = ${start}\nmood = "happy"\nsay mood`,
  ]),
  ["written declaration", 'let x: integer = "a"\nsay x'],
  ["written null", "let x: integer = null\nsay x"],
  ["global", 'global g = 1\ng = "x"\nsay g'],
  ["global default", 'global g = 1, default: 2\ng = "x"\nsay g'],
  ["parameter", 'function use(n: integer) { say n }\nuse("x")'],
  ["parameter default", 'function use(n: integer = 1) { say n }\nuse("x")'],
  ["parameter untyped default", 'function use(n = 1) {\n  n = "a"\n  say n\n}\nuse()'],
  ["element store", 'let xs = [1]\nxs[0] = "a"\nsay xs'],
  ["set literal", 'let xs: integer set = set["a"]\nsay xs'],
  ["dict store", 'let d = dict{a: 1}\nd["b"] = "x"\nsay d["b"]'],
  ["property store", 'let box = {items: [1]}\nbox.items[0] = "a"\nsay box'],
  ["result", 'function f(c) {\n  if c { return 1 }\n  return "a"\n}\nsay f(true)'],
  ["mixed literal", 'let a = [1, "x"]\nsay a.length'],
  ["mixed global", 'global a = [1, "x"]\nsay a.length'],
  ["written type", "let h: integer | string[] = 1\nsay h"],
  ["fallback default", 'let r: integer = load("count", default: "a")\nsay r'],
  ["fallback otherwise", 'let y: integer? = null\nlet x: integer = y otherwise "a"\nsay x'],
  ["condition integer", "let c = 1\nif c { say 1 }"],
  ["condition text", 'let s = "a"\nif s { say 1 }'],
  ["condition list", "let xs = [1]\nif xs { say 1 }"],
  ["not integer", "let c = 1\nif not c { say 1 }"],
  ["and integer", "let c = 1\nif c and true { say 1 }"],
  ["condition element", "let cs = [1]\nif cs[0] { say 1 }"],
  ["key", 'let d = dict{"1": 2}\nlet k = 1\nsay d[k]'],
  ["key element", 'let d = dict{"1": 2}\nlet ks = [1]\nsay d[ks[0]]'],
  ["shown object", 'let box = {n: 1, t: "a"}\nsay "${box}"'],
  ["shown set", 'let s = set[1, 2]\nsay "${s}"'],
  ["shown set of objects", 'let s = set[{n: 1}]\nsay "${s}"'],
  ["shown dict", 'let d = dict{a: 1}\nsay "${d}"'],
  ["shown dict of lists", 'let d = dict{a: [1]}\nsay "${d}"'],
  ["shown sum of sets", 'let a = set[1]\nlet b = set[2]\nsay "${a + b}"'],
  ["shown element of list", 'let xs = [[1]]\nsay "${xs}"'],
  ["join variable", 'let n = 3\nsay "You have " + n + " points"'],
  ["join right", 'let n = 3\nsay n + " points"'],
  ["join property", 'let box = {n: 2}\nsay "n is " + box.n'],
  ["join element", 'let xs = [5]\nsay "First: " + xs[0]'],
  ["join call", 'function two { return 2 }\nsay "Two: " + two()'],
  ["join sum", 'say 1 + 2 + " points"'],
  ["join in condition", 'let n = 1\nif "x" + n { say 1 }'],
  ["join declared", 'let n = 1\nlet s: integer = "x" + n\nsay s'],
  ["join parameter", 'function f(n) {\n  say "You have " + n + " points"\n}\nf(1)\nf(2)'],
  [
    "absolute plus calendar",
    'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nlet u = t + 1 s\nsay u + 1 calendar day',
  ],
  ["date plus duration", 'let day = toDate("2026-10-23")\nsay day + 1 day'],
  ["date plus days", 'let day = toDate("2026-10-23")\nsay day + 2 d'],
  ["date call plus duration", 'say toDate("2026-10-23") + 1 day'],
  ["datetime plus duration", 'let t = toDateTime("2026-01-01T00:00:00")\nsay t + 1 s'],
  [
    "datetime plus duration in condition",
    'let t = toDateTime("2026-01-01T00:00:00")\nif t + 1 s { say 1 }',
  ],
  [
    "date compare",
    'let day = toDate("2026-10-23")\nlet d = toDateTime("2026-10-23T12:00:00")\nsay day < d',
  ],
  [
    "datetime minus datetime",
    'let a = toDateTime("2026-10-23T12:00:00")\nlet b = toDateTime("2026-10-22T12:00:00")\nsay a - b',
  ],
  ["time plus", 'let t = toTime("12:00")\nsay t + 1 s'],
  ["integer length", "let n = 12\nsay n.length"],
  ["integer length in condition", "let n = 12\nif n.length { say 1 }"],
  ["integer length declared", "let n = 12\nlet l: string = n.length\nsay l"],
  ["random length", "let ns = [12, 13]\nsay ns.random.length"],
  ["integer replace", 'let n = 12\nsay n.replace("1", "a")'],
  ["duration seconds", "let d = 2 s\nsay d.seconds"],
  ["duration seconds divisor", "let d = 2 s\nsay 4 / d.seconds"],
  ["duration seconds count", "let d = 2 s\nrepeat d.seconds { say 1 }"],
  ["duration seconds sum", "let d = 1 s+2 s\nsay d.seconds + 1"],
  ["absolute year", 'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nsay t.year'],
  [
    "absolute year element",
    'let ts = [toAbsoluteDateTime("2026-01-01T00:00:00Z")]\nsay ts[0].year',
  ],
  ["calendar seconds", "let d = 1 calendar day\nsay d.seconds"],
  ["set get", "let s = set[1]\nsay s.get(0)"],
  ["set removeAt", "let s = set[1]\ns.removeAt(0)\nsay s"],
  ["list property", "let xs = [1]\nsay xs.size"],
  ["dict property", "let d = dict{a: 1}\nsay d.collar"],
  ["dict method", "let d = dict{a: 1}\nsay d.keys()"],
  ["store as text", "let caption: string = 1\nsay caption"],
  ["store sum as text", "let n = 1\nlet caption: string = n + 1\nsay caption"],
  ["store element as text", "let xs = [1]\nlet caption: string = xs[0]\nsay caption"],
  ["unit", "let pause: duration = 3\nsay pause"],
  ["unit element", "let xs = [3]\nlet pause: duration = xs[0]\nsay pause"],
  ["speaker method", 'speaker sage = "Sage"\nsage.title()'],
  ["player property", "say player.firstName"],
  ["speaker property", 'speaker sage = "Sage"\nsay sage.mood'],
];
const familyCases = () => {
  const cases = [];
  for (const [kind, setup, subject] of NULLABLE)
    for (const [use, line] of USES)
      cases.push({ name: `null ${kind} in ${use}`, source: lines(setup, line(subject)) });
  for (const [kind, setup, subject] of PRESENT)
    for (const [use, line] of USES)
      cases.push({ name: `present ${kind} in ${use}`, source: lines(setup, line(subject)) });
  for (const [name, setup, line, subject] of OTHERS)
    cases.push({ name, source: lines(setup, line(subject)) });
  for (const [name, body] of ERRORS) cases.push({ name, source: lines(body) });
  return cases;
};
// the two speaker cases declare `speaker sage = "Sage"`, which `main` does not parse; they meant the member advice
const unparsed = new Set(["speaker method", "speaker property"]);
const generated = familyCases()
  .filter(({ name }) => !unparsed.has(name))
  .map(({ name, source }) => [name, source]);
export const checks = ["publication"];

// The fixed programs its family run (pasted/) and its fixture run (fixture-pasted/) compiled after pasting each offered
// form, as their results record them; the five that equal a fixture row are named after it.
const captured = [
  ["pasted/1", "let ns = [1, null]\nlet n = ns[1]\nif n != null { say n + 1 }\nexit\n"],
  ["pasted/2", "let ns = [1, null]\nlet n = ns[1]\nsay (n otherwise 0) + 1\nexit\n"],
  ["pasted/4", "let ns = [1, null]\nlet n = ns[1]\nlet m = (n otherwise 0) + 1\nsay m\nexit\n"],
  [
    "pasted/6",
    "let ns = [1, null]\nlet n = ns[1]\nlet m = 0\nif n != null { m = n + 1 }\nsay m\nexit\n",
  ],
  [
    "pasted/7",
    "let ns = [1, null]\nlet n = ns[1]\nlet m = 0\nm = (n otherwise 0) + 1\nsay m\nexit\n",
  ],
  [
    "pasted/9",
    'let ns = [1, null]\nlet n = ns[1]\nif n != null { if n < 1 { say "low" } else { say "high" } }\nexit\n',
  ],
  [
    "pasted/10",
    'let ns = [1, null]\nlet n = ns[1]\nif (n otherwise 0) < 1 { say "low" } else { say "high" }\nexit\n',
  ],
  ["pasted/12", 'let ns = [1, null]\nlet n = ns[1]\nif n != null { repeat n { say "x" } }\nexit\n'],
  ["pasted/13", 'let ns = [1, null]\nlet n = ns[1]\nrepeat n otherwise 0 { say "x" }\nexit\n'],
  ["pasted/15", 'let ns = [1, null]\nlet n = ns[1]\nif n != null { say "${n + 1}" }\nexit\n'],
  ["pasted/16", 'let ns = [1, null]\nlet n = ns[1]\nsay "${(n otherwise 0) + 1}"\nexit\n'],
  [
    "pasted/18",
    "let ns = [1, null]\nlet n = ns[1]\nfunction show(v: integer) { say v }\nif n != null { show(n) }\nexit\n",
  ],
  [
    "pasted/19",
    "let ns = [1, null]\nlet n = ns[1]\nfunction show(v: integer) { say v }\nshow(n otherwise 0)\nexit\n",
  ],
  ["pasted/21", "let ns = [1, null]\nlet n = ns[1]\nif n != null { say 10 / n }\nexit\n"],
  ["pasted/23", "let ns = [1, null]\nlet n = ns[1]\nif n != null { say n * 2 }\nexit\n"],
  ["pasted/24", "let ns = [1, null]\nlet n = ns[1]\nsay (n otherwise 0) * 2\nexit\n"],
  ["pasted/26", "let ns = [1, null]\nlet n = ns[1]\nif n != null { say -n }\nexit\n"],
  ["pasted/27", "let ns = [1, null]\nlet n = ns[1]\nsay -(n otherwise 0)\nexit\n"],
  [
    "pasted/29",
    "let ns = [1, null]\nlet n = ns[1]\nif true {\n  if n != null { say n + 1 }\n}\nexit\n",
  ],
  [
    "pasted/30",
    "let ns = [1, null]\nlet n = ns[1]\nif true {\n  say (n otherwise 0) + 1\n}\nexit\n",
  ],
  [
    "pasted/32",
    "let ns = [1, null]\nlet n = ns[1]\nif true { if n != null { say n + 1 } }\nexit\n",
  ],
  ["pasted/33", "let ns = [1, null]\nlet n = ns[1]\nif true { say (n otherwise 0) + 1 }\nexit\n"],
  [
    "pasted/35",
    "let ns = [1, null]\nlet n = ns[1]\nfunction g { return (n otherwise 0) + 1 }\nsay g()\nexit\n",
  ],
  [
    "pasted/37",
    "let ns = [1, null]\nlet n = ns[1]\nlet k = 0\nwhile k < (n otherwise 0) { k = k + 1 }\nsay k\nexit\n",
  ],
  [
    "pasted/39",
    "let ns = [1, null]\nlet n = ns[1]\nif false or (n otherwise 0) > 0 { say 1 }\nexit\n",
  ],
  [
    "pasted/41",
    "let ns = [1, null]\nlet n = ns[1]\nlet t = timer async 1 s { if n != null { say n + 1 } }\nexit\n",
  ],
  [
    "pasted/42",
    "let ns = [1, null]\nlet n = ns[1]\nlet t = timer async 1 s { say (n otherwise 0) + 1 }\nexit\n",
  ],
  ["pasted/44", "let ns = [1, null]\nlet n = ns[1]\nif n != null { say [n + 1][0] }\nexit\n"],
  ["pasted/45", "let ns = [1, null]\nlet n = ns[1]\nsay [(n otherwise 0) + 1][0]\nexit\n"],
  ["pasted/47", "let ns = [1, null]\nlet n = ns[1]\nsay (n otherwise 0) + n\nexit\n"],
  ["pasted/48", "let ns = [1, null]\nlet n = ns[1]\nsay n + (n otherwise 0)\nexit\n"],
  [
    "pasted/51",
    "let ns = [1, null]\nlet value = ns[1]\nif value != null { say value + 1 }\nexit\n",
  ],
  ["pasted/52", "let ns = [1, null]\nsay (ns[1] otherwise 0) + 1\nexit\n"],
  ["pasted/54", "let ns = [1, null]\nlet m = (ns[1] otherwise 0) + 1\nsay m\nexit\n"],
  [
    "pasted/56",
    "let ns = [1, null]\nlet m = 0\nlet value = ns[1]\nif value != null { m = value + 1 }\nsay m\nexit\n",
  ],
  ["pasted/57", "let ns = [1, null]\nlet m = 0\nm = (ns[1] otherwise 0) + 1\nsay m\nexit\n"],
  [
    "pasted/59",
    'let ns = [1, null]\nlet value = ns[1]\nif value != null { if value < 1 { say "low" } else { say "high" } }\nexit\n',
  ],
  [
    "pasted/60",
    'let ns = [1, null]\nif (ns[1] otherwise 0) < 1 { say "low" } else { say "high" }\nexit\n',
  ],
  [
    "pasted/62",
    'let ns = [1, null]\nlet value = ns[1]\nif value != null { repeat value { say "x" } }\nexit\n',
  ],
  ["pasted/63", 'let ns = [1, null]\nrepeat ns[1] otherwise 0 { say "x" }\nexit\n'],
  [
    "pasted/65",
    'let ns = [1, null]\nlet value = ns[1]\nif value != null { say "${value + 1}" }\nexit\n',
  ],
  ["pasted/66", 'let ns = [1, null]\nsay "${(ns[1] otherwise 0) + 1}"\nexit\n'],
  [
    "pasted/68",
    "let ns = [1, null]\nfunction show(v: integer) { say v }\nlet value = ns[1]\nif value != null { show(value) }\nexit\n",
  ],
  [
    "pasted/69",
    "let ns = [1, null]\nfunction show(v: integer) { say v }\nshow(ns[1] otherwise 0)\nexit\n",
  ],
  [
    "pasted/71",
    "let ns = [1, null]\nlet value = ns[1]\nif value != null { say 10 / value }\nexit\n",
  ],
  [
    "pasted/73",
    "let ns = [1, null]\nlet value = ns[1]\nif value != null { say value * 2 }\nexit\n",
  ],
  ["pasted/74", "let ns = [1, null]\nsay (ns[1] otherwise 0) * 2\nexit\n"],
  ["pasted/76", "let ns = [1, null]\nlet value = ns[1]\nif value != null { say -value }\nexit\n"],
  ["pasted/77", "let ns = [1, null]\nsay -(ns[1] otherwise 0)\nexit\n"],
  [
    "pasted/79",
    "let ns = [1, null]\nif true {\n  let value = ns[1]\nif value != null { say value + 1 }\n}\nexit\n",
  ],
  ["pasted/80", "let ns = [1, null]\nif true {\n  say (ns[1] otherwise 0) + 1\n}\nexit\n"],
  [
    "pasted/82",
    "let ns = [1, null]\nif true { let value = ns[1]\nif value != null { say value + 1 } }\nexit\n",
  ],
  ["pasted/83", "let ns = [1, null]\nif true { say (ns[1] otherwise 0) + 1 }\nexit\n"],
  [
    "pasted/85",
    "let ns = [1, null]\nfunction g { return (ns[1] otherwise 0) + 1 }\nsay g()\nexit\n",
  ],
  [
    "pasted/87",
    "let ns = [1, null]\nlet k = 0\nwhile k < (ns[1] otherwise 0) { k = k + 1 }\nsay k\nexit\n",
  ],
  ["pasted/89", "let ns = [1, null]\nif false or (ns[1] otherwise 0) > 0 { say 1 }\nexit\n"],
  [
    "pasted/91",
    "let ns = [1, null]\nlet t = timer async 1 s { let value = ns[1]\nif value != null { say value + 1 } }\nexit\n",
  ],
  [
    "pasted/92",
    "let ns = [1, null]\nlet t = timer async 1 s { say (ns[1] otherwise 0) + 1 }\nexit\n",
  ],
  [
    "pasted/94",
    "let ns = [1, null]\nlet value = ns[1]\nif value != null { say [value + 1][0] }\nexit\n",
  ],
  ["pasted/95", "let ns = [1, null]\nsay [(ns[1] otherwise 0) + 1][0]\nexit\n"],
  ["pasted/97", "let ns = [1, null]\nsay (ns[1] otherwise 0) + ns[1]\nexit\n"],
  ["pasted/98", "let ns = [1, null]\nsay ns[1] + (ns[1] otherwise 0)\nexit\n"],
  [
    "pasted/101",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nlet value = box.n\nif value != null { say value + 1 }\nexit\n",
  ],
  ["pasted/102", "let ns = [1, null]\nlet box = {n: ns[1]}\nsay (box.n otherwise 0) + 1\nexit\n"],
  [
    "pasted/104",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nlet m = (box.n otherwise 0) + 1\nsay m\nexit\n",
  ],
  [
    "pasted/106",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nlet m = 0\nlet value = box.n\nif value != null { m = value + 1 }\nsay m\nexit\n",
  ],
  [
    "pasted/107",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nlet m = 0\nm = (box.n otherwise 0) + 1\nsay m\nexit\n",
  ],
  [
    "pasted/109",
    'let ns = [1, null]\nlet box = {n: ns[1]}\nlet value = box.n\nif value != null { if value < 1 { say "low" } else { say "high" } }\nexit\n',
  ],
  [
    "pasted/110",
    'let ns = [1, null]\nlet box = {n: ns[1]}\nif (box.n otherwise 0) < 1 { say "low" } else { say "high" }\nexit\n',
  ],
  [
    "pasted/112",
    'let ns = [1, null]\nlet box = {n: ns[1]}\nlet value = box.n\nif value != null { repeat value { say "x" } }\nexit\n',
  ],
  [
    "pasted/113",
    'let ns = [1, null]\nlet box = {n: ns[1]}\nrepeat box.n otherwise 0 { say "x" }\nexit\n',
  ],
  [
    "pasted/115",
    'let ns = [1, null]\nlet box = {n: ns[1]}\nlet value = box.n\nif value != null { say "${value + 1}" }\nexit\n',
  ],
  [
    "pasted/116",
    'let ns = [1, null]\nlet box = {n: ns[1]}\nsay "${(box.n otherwise 0) + 1}"\nexit\n',
  ],
  [
    "pasted/118",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nfunction show(v: integer) { say v }\nlet value = box.n\nif value != null { show(value) }\nexit\n",
  ],
  [
    "pasted/119",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nfunction show(v: integer) { say v }\nshow(box.n otherwise 0)\nexit\n",
  ],
  [
    "pasted/121",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nlet value = box.n\nif value != null { say 10 / value }\nexit\n",
  ],
  [
    "pasted/123",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nlet value = box.n\nif value != null { say value * 2 }\nexit\n",
  ],
  ["pasted/124", "let ns = [1, null]\nlet box = {n: ns[1]}\nsay (box.n otherwise 0) * 2\nexit\n"],
  [
    "pasted/126",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nlet value = box.n\nif value != null { say -value }\nexit\n",
  ],
  ["pasted/127", "let ns = [1, null]\nlet box = {n: ns[1]}\nsay -(box.n otherwise 0)\nexit\n"],
  [
    "pasted/129",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nif true {\n  let value = box.n\nif value != null { say value + 1 }\n}\nexit\n",
  ],
  [
    "pasted/130",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nif true {\n  say (box.n otherwise 0) + 1\n}\nexit\n",
  ],
  [
    "pasted/132",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nif true { let value = box.n\nif value != null { say value + 1 } }\nexit\n",
  ],
  [
    "pasted/133",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nif true { say (box.n otherwise 0) + 1 }\nexit\n",
  ],
  [
    "pasted/135",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nfunction g { return (box.n otherwise 0) + 1 }\nsay g()\nexit\n",
  ],
  [
    "pasted/137",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nlet k = 0\nwhile k < (box.n otherwise 0) { k = k + 1 }\nsay k\nexit\n",
  ],
  [
    "pasted/139",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nif false or (box.n otherwise 0) > 0 { say 1 }\nexit\n",
  ],
  [
    "pasted/141",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nlet t = timer async 1 s { let value = box.n\nif value != null { say value + 1 } }\nexit\n",
  ],
  [
    "pasted/142",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nlet t = timer async 1 s { say (box.n otherwise 0) + 1 }\nexit\n",
  ],
  [
    "pasted/144",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nlet value = box.n\nif value != null { say [value + 1][0] }\nexit\n",
  ],
  [
    "pasted/145",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nsay [(box.n otherwise 0) + 1][0]\nexit\n",
  ],
  [
    "pasted/147",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nsay (box.n otherwise 0) + box.n\nexit\n",
  ],
  [
    "pasted/148",
    "let ns = [1, null]\nlet box = {n: ns[1]}\nsay box.n + (box.n otherwise 0)\nexit\n",
  ],
  [
    "pasted/151",
    "let ns = [1, null]\nfunction f { return ns[1] }\nlet value = f()\nif value != null { say value + 1 }\nexit\n",
  ],
  [
    "pasted/152",
    "let ns = [1, null]\nfunction f { return ns[1] }\nsay (f() otherwise 0) + 1\nexit\n",
  ],
  [
    "pasted/154",
    "let ns = [1, null]\nfunction f { return ns[1] }\nlet m = (f() otherwise 0) + 1\nsay m\nexit\n",
  ],
  [
    "pasted/156",
    "let ns = [1, null]\nfunction f { return ns[1] }\nlet m = 0\nlet value = f()\nif value != null { m = value + 1 }\nsay m\nexit\n",
  ],
  [
    "pasted/157",
    "let ns = [1, null]\nfunction f { return ns[1] }\nlet m = 0\nm = (f() otherwise 0) + 1\nsay m\nexit\n",
  ],
  [
    "pasted/159",
    'let ns = [1, null]\nfunction f { return ns[1] }\nlet value = f()\nif value != null { if value < 1 { say "low" } else { say "high" } }\nexit\n',
  ],
  [
    "pasted/160",
    'let ns = [1, null]\nfunction f { return ns[1] }\nif (f() otherwise 0) < 1 { say "low" } else { say "high" }\nexit\n',
  ],
  [
    "pasted/162",
    'let ns = [1, null]\nfunction f { return ns[1] }\nlet value = f()\nif value != null { repeat value { say "x" } }\nexit\n',
  ],
  [
    "pasted/163",
    'let ns = [1, null]\nfunction f { return ns[1] }\nrepeat f() otherwise 0 { say "x" }\nexit\n',
  ],
  [
    "pasted/165",
    'let ns = [1, null]\nfunction f { return ns[1] }\nlet value = f()\nif value != null { say "${value + 1}" }\nexit\n',
  ],
  [
    "pasted/166",
    'let ns = [1, null]\nfunction f { return ns[1] }\nsay "${(f() otherwise 0) + 1}"\nexit\n',
  ],
  [
    "pasted/168",
    "let ns = [1, null]\nfunction f { return ns[1] }\nfunction show(v: integer) { say v }\nshow(f() otherwise 0)\nexit\n",
  ],
  [
    "pasted/171",
    "let ns = [1, null]\nfunction f { return ns[1] }\nlet value = f()\nif value != null { say value * 2 }\nexit\n",
  ],
  [
    "pasted/172",
    "let ns = [1, null]\nfunction f { return ns[1] }\nsay (f() otherwise 0) * 2\nexit\n",
  ],
  [
    "pasted/174",
    "let ns = [1, null]\nfunction f { return ns[1] }\nlet value = f()\nif value != null { say -value }\nexit\n",
  ],
  ["pasted/175", "let ns = [1, null]\nfunction f { return ns[1] }\nsay -(f() otherwise 0)\nexit\n"],
  [
    "pasted/177",
    "let ns = [1, null]\nfunction f { return ns[1] }\nif true {\n  let value = f()\nif value != null { say value + 1 }\n}\nexit\n",
  ],
  [
    "pasted/178",
    "let ns = [1, null]\nfunction f { return ns[1] }\nif true {\n  say (f() otherwise 0) + 1\n}\nexit\n",
  ],
  [
    "pasted/180",
    "let ns = [1, null]\nfunction f { return ns[1] }\nif true { let value = f()\nif value != null { say value + 1 } }\nexit\n",
  ],
  [
    "pasted/181",
    "let ns = [1, null]\nfunction f { return ns[1] }\nif true { say (f() otherwise 0) + 1 }\nexit\n",
  ],
  [
    "pasted/183",
    "let ns = [1, null]\nfunction f { return ns[1] }\nfunction g { return (f() otherwise 0) + 1 }\nsay g()\nexit\n",
  ],
  [
    "pasted/185",
    "let ns = [1, null]\nfunction f { return ns[1] }\nlet k = 0\nwhile k < (f() otherwise 0) { k = k + 1 }\nsay k\nexit\n",
  ],
  [
    "pasted/187",
    "let ns = [1, null]\nfunction f { return ns[1] }\nif false or (f() otherwise 0) > 0 { say 1 }\nexit\n",
  ],
  [
    "pasted/189",
    "let ns = [1, null]\nfunction f { return ns[1] }\nlet t = timer async 1 s { let value = f()\nif value != null { say value + 1 } }\nexit\n",
  ],
  [
    "pasted/190",
    "let ns = [1, null]\nfunction f { return ns[1] }\nlet t = timer async 1 s { say (f() otherwise 0) + 1 }\nexit\n",
  ],
  [
    "pasted/192",
    "let ns = [1, null]\nfunction f { return ns[1] }\nlet value = f()\nif value != null { say [value + 1][0] }\nexit\n",
  ],
  [
    "pasted/193",
    "let ns = [1, null]\nfunction f { return ns[1] }\nsay [(f() otherwise 0) + 1][0]\nexit\n",
  ],
  [
    "pasted/195",
    "let ns = [1, null]\nfunction f { return ns[1] }\nsay (f() otherwise 0) + f()\nexit\n",
  ],
  [
    "pasted/196",
    "let ns = [1, null]\nfunction f { return ns[1] }\nsay f() + (f() otherwise 0)\nexit\n",
  ],
  [
    "pasted/199",
    'let d = dict{a: 1, b: null}\nlet value = d["b"]\nif value != null { say value + 1 }\nexit\n',
  ],
  ["pasted/200", 'let d = dict{a: 1, b: null}\nsay (d["b"] otherwise 0) + 1\nexit\n'],
  ["pasted/202", 'let d = dict{a: 1, b: null}\nlet m = (d["b"] otherwise 0) + 1\nsay m\nexit\n'],
  [
    "pasted/204",
    'let d = dict{a: 1, b: null}\nlet m = 0\nlet value = d["b"]\nif value != null { m = value + 1 }\nsay m\nexit\n',
  ],
  [
    "pasted/205",
    'let d = dict{a: 1, b: null}\nlet m = 0\nm = (d["b"] otherwise 0) + 1\nsay m\nexit\n',
  ],
  [
    "pasted/207",
    'let d = dict{a: 1, b: null}\nlet value = d["b"]\nif value != null { if value < 1 { say "low" } else { say "high" } }\nexit\n',
  ],
  [
    "pasted/208",
    'let d = dict{a: 1, b: null}\nif (d["b"] otherwise 0) < 1 { say "low" } else { say "high" }\nexit\n',
  ],
  [
    "pasted/210",
    'let d = dict{a: 1, b: null}\nlet value = d["b"]\nif value != null { repeat value { say "x" } }\nexit\n',
  ],
  ["pasted/211", 'let d = dict{a: 1, b: null}\nrepeat d["b"] otherwise 0 { say "x" }\nexit\n'],
  [
    "pasted/213",
    'let d = dict{a: 1, b: null}\nlet value = d["b"]\nif value != null { say "${value + 1}" }\nexit\n',
  ],
  ["pasted/214", 'let d = dict{a: 1, b: null}\nsay "${(d["b"] otherwise 0) + 1}"\nexit\n'],
  [
    "pasted/216",
    'let d = dict{a: 1, b: null}\nfunction show(v: integer) { say v }\nlet value = d["b"]\nif value != null { show(value) }\nexit\n',
  ],
  [
    "pasted/217",
    'let d = dict{a: 1, b: null}\nfunction show(v: integer) { say v }\nshow(d["b"] otherwise 0)\nexit\n',
  ],
  [
    "pasted/219",
    'let d = dict{a: 1, b: null}\nlet value = d["b"]\nif value != null { say 10 / value }\nexit\n',
  ],
  [
    "pasted/221",
    'let d = dict{a: 1, b: null}\nlet value = d["b"]\nif value != null { say value * 2 }\nexit\n',
  ],
  ["pasted/222", 'let d = dict{a: 1, b: null}\nsay (d["b"] otherwise 0) * 2\nexit\n'],
  [
    "pasted/224",
    'let d = dict{a: 1, b: null}\nlet value = d["b"]\nif value != null { say -value }\nexit\n',
  ],
  ["pasted/225", 'let d = dict{a: 1, b: null}\nsay -(d["b"] otherwise 0)\nexit\n'],
  [
    "pasted/227",
    'let d = dict{a: 1, b: null}\nif true {\n  let value = d["b"]\nif value != null { say value + 1 }\n}\nexit\n',
  ],
  [
    "pasted/228",
    'let d = dict{a: 1, b: null}\nif true {\n  say (d["b"] otherwise 0) + 1\n}\nexit\n',
  ],
  [
    "pasted/230",
    'let d = dict{a: 1, b: null}\nif true { let value = d["b"]\nif value != null { say value + 1 } }\nexit\n',
  ],
  ["pasted/231", 'let d = dict{a: 1, b: null}\nif true { say (d["b"] otherwise 0) + 1 }\nexit\n'],
  [
    "pasted/233",
    'let d = dict{a: 1, b: null}\nfunction g { return (d["b"] otherwise 0) + 1 }\nsay g()\nexit\n',
  ],
  [
    "pasted/235",
    'let d = dict{a: 1, b: null}\nlet k = 0\nwhile k < (d["b"] otherwise 0) { k = k + 1 }\nsay k\nexit\n',
  ],
  [
    "pasted/237",
    'let d = dict{a: 1, b: null}\nif false or (d["b"] otherwise 0) > 0 { say 1 }\nexit\n',
  ],
  [
    "pasted/239",
    'let d = dict{a: 1, b: null}\nlet t = timer async 1 s { let value = d["b"]\nif value != null { say value + 1 } }\nexit\n',
  ],
  [
    "pasted/240",
    'let d = dict{a: 1, b: null}\nlet t = timer async 1 s { say (d["b"] otherwise 0) + 1 }\nexit\n',
  ],
  [
    "pasted/242",
    'let d = dict{a: 1, b: null}\nlet value = d["b"]\nif value != null { say [value + 1][0] }\nexit\n',
  ],
  ["pasted/243", 'let d = dict{a: 1, b: null}\nsay [(d["b"] otherwise 0) + 1][0]\nexit\n'],
  ["pasted/245", 'let d = dict{a: 1, b: null}\nsay (d["b"] otherwise 0) + d["b"]\nexit\n'],
  ["pasted/246", 'let d = dict{a: 1, b: null}\nsay d["b"] + (d["b"] otherwise 0)\nexit\n'],
  ["pasted/306", 'let ts = ["ab", null]\nlet t = ts[1]\nif t != null { say t.length }\nexit\n'],
  ["pasted/307", 'let ts = ["ab", null]\nlet t = ts[1]\nsay (t otherwise "").length\nexit\n'],
  [
    "pasted/309",
    'let ts = ["ab", null]\nlet value = ts[1]\nif value != null { say value.length + 1 }\nexit\n',
  ],
  ["pasted/310", 'let ts = ["ab", null]\nsay (ts[1] otherwise "").length + 1\nexit\n'],
  ["pasted/312", 'let ts = ["ab", null]\nlet t = ts[1]\nif t != null { say "x" + t }\nexit\n'],
  ["pasted/313", 'let ts = ["ab", null]\nlet t = ts[1]\nsay "x" + (t otherwise "")\nexit\n'],
  ["pasted/315", "let bs = [true, null]\nlet b = bs[1]\nif b != null { if b { say 1 } }\nexit\n"],
  ["pasted/316", "let bs = [true, null]\nlet b = bs[1]\nif b otherwise false { say 1 }\nexit\n"],
  [
    "pasted/318",
    "let ls = [[1], null]\nlet l = ls[1]\nif l != null { for x in l { say x } }\nexit\n",
  ],
  ["pasted/320", "let ls = [[1], null]\nlet l = ls[1]\nif l != null { l.add(2) }\nsay l\nexit\n"],
  [
    "pasted/322",
    'let us: (integer | string)[] = [1, "a"]\nlet u = us[0]\nif u is integer { say u + 1 }\nexit\n',
  ],
  [
    "pasted/324",
    'let us: (integer | string)[] = [1, "a"]\nlet value = us[0]\nif value is integer { say value + 1 }\nexit\n',
  ],
  [
    "pasted/326",
    'let us: (integer | string | null)[] = [1, "a", null]\nlet u = us[0]\nif u is integer { say u + 1 }\nexit\n',
  ],
  [
    "pasted/329",
    "let groups: integer[][] = [[], [21]]\nif groups[1].length > 0 { say groups[1].last }\nexit\n",
  ],
  [
    "pasted/331",
    "let groups: integer[][] = [[], [21]]\nlet value = groups.random\nif value.length > 0 { say value.last }\nexit\n",
  ],
  [
    "pasted/333",
    "let groups: integer[][] = [[], [21]]\nlet g = groups[1]\nif g.length > 0 { say g.first }\nexit\n",
  ],
  ["pasted/335", "let v = hostValue\nif v is number { say v + 1 }\nexit\n"],
  [
    "pasted/337",
    'function make { return 1 }\nlet d = dict{a: 1}\nlet n = 1\nlet mood: integer | string = 1\nmood = "happy"\nsay mood\nexit\n',
  ],
  [
    "pasted/339",
    'function make { return 1 }\nlet d = dict{a: 1}\nlet n = 1\nlet mood: integer | string = make()\nmood = "happy"\nsay mood\nexit\n',
  ],
  [
    "pasted/341",
    'function make { return 1 }\nlet d = dict{a: 1}\nlet n = 1\nlet mood: integer | string = [1][0]\nmood = "happy"\nsay mood\nexit\n',
  ],
  [
    "pasted/343",
    'function make { return 1 }\nlet d = dict{a: 1}\nlet n = 1\nlet mood: integer | string = d["a"]\nmood = "happy"\nsay mood\nexit\n',
  ],
  [
    "pasted/345",
    'function make { return 1 }\nlet d = dict{a: 1}\nlet n = 1\nlet mood: integer | string = n + 1\nmood = "happy"\nsay mood\nexit\n',
  ],
  [
    "pasted/347",
    'function make { return 1 }\nlet d = dict{a: 1}\nlet n = 1\nlet mood: integer | string = -1\nmood = "happy"\nsay mood\nexit\n',
  ],
  [
    "pasted/349",
    'function make { return 1 }\nlet d = dict{a: 1}\nlet n = 1\nlet mood: integer | string = (1)\nmood = "happy"\nsay mood\nexit\n',
  ],
  ["pasted/351", 'let x: integer | string = "a"\nsay x\nexit\n'],
  ["pasted/353", "let x: integer? = null\nsay x\nexit\n"],
  ["pasted/355", 'global g: integer | string = 1\ng = "x"\nsay g\nexit\n'],
  ["pasted/357", 'global g: integer | string = 1, default: 2\ng = "x"\nsay g\nexit\n'],
  ["pasted/359", 'function use(n: integer | string) { say n }\nuse("x")\nexit\n'],
  ["pasted/361", 'function use(n: integer | string = 1) { say n }\nuse("x")\nexit\n'],
  ["pasted/363", 'function use(n: integer | string = 1) {\n  n = "a"\n  say n\n}\nuse()\nexit\n'],
  ["pasted/365", 'let xs: (integer | string)[] = [1]\nxs[0] = "a"\nsay xs\nexit\n'],
  ["pasted/367", 'let xs: (integer | string) set = set["a"]\nsay xs\nexit\n'],
  ["pasted/369", 'let d: (integer | string) dict = dict{a: 1}\nd["b"] = "x"\nsay d["b"]\nexit\n'],
  [
    "pasted/371",
    'let box = {items: [1]}\nbox.items[0] = "a"\nsay box\nexit\nfunction fixType(p: (integer | string)[]) {\n  say p\n}\n',
  ],
  [
    "pasted/373",
    'function f(c) {\n  if c { return 1 }\n  return "a"\n}\nsay f(true)\nexit\nfunction fixType(p: integer | string) {\n  say p\n}\n',
  ],
  ["pasted/375", 'let a: (integer | string)[] = [1, "x"]\nsay a.length\nexit\n'],
  ["pasted/377", 'global a: (integer | string)[] = [1, "x"]\nsay a.length\nexit\n'],
  [
    "pasted/379",
    "let h: integer | string[] = 1\nsay h\nexit\nfunction fixType(p: (integer | string)[]) {\n  say p\n}\n",
  ],
  ["pasted/381", 'let r: integer | string = load("count", default: "a")\nsay r\nexit\n'],
  [
    "pasted/383",
    'let y: integer? = null\nlet x: integer | string = y otherwise "a"\nsay x\nexit\n',
  ],
  ["pasted/385", "let c = 1\nif c > 0 { say 1 }\nexit\n"],
  ["pasted/387", 'let s = "a"\nif s != "" { say 1 }\nexit\n'],
  ["pasted/389", "let xs = [1]\nif xs.length > 0 { say 1 }\nexit\n"],
  ["pasted/391", "let c = 1\nif not (c > 0) { say 1 }\nexit\n"],
  ["pasted/393", "let c = 1\nif (c > 0) and true { say 1 }\nexit\n"],
  ["pasted/396", 'let d = dict{"1": 2}\nlet k = 1\nsay d["${k}"]\nexit\n'],
  ["pasted/399", 'let box = {n: 1, t: "a"}\nsay "${box.n}"\nexit\n'],
  ["pasted/401", 'let s = set[1, 2]\nsay "${s.toList().join()}"\nexit\n'],
  ["pasted/404", 'let d = dict{a: 1}\nsay "${d.values.join()}"\nexit\n'],
  ["pasted/409", 'let n = 3\nsay "You have " + "${n}" + " points"\nexit\n'],
  ["pasted/411", 'let n = 3\nsay "${n}" + " points"\nexit\n'],
  ["pasted/413", 'let box = {n: 2}\nsay "n is " + "${box.n}"\nexit\n'],
  ["pasted/417", 'say "${1 + 2}" + " points"\nexit\n'],
  ["pasted/421", 'function f(n) {\n  say "You have " + "${n}" + " points"\n}\nf(1)\nf(2)\nexit\n'],
  [
    "pasted/423",
    'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nlet u = t + 1 s\nsay (u.toDateTime() + 1 calendar day).toAbsoluteDateTime()\nexit\n',
  ],
  ["pasted/425", 'let day = toDate("2026-10-23")\nsay day + 1 calendar day\nexit\n'],
  ["pasted/427", 'let day = toDate("2026-10-23")\nsay day + 2 calendar days\nexit\n'],
  [
    "pasted/430",
    'let t = toDateTime("2026-01-01T00:00:00")\nsay (t.toAbsoluteDateTime() + 1 s).toDateTime()\nexit\n',
  ],
  [
    "pasted/433",
    'let day = toDate("2026-10-23")\nlet d = toDateTime("2026-10-23T12:00:00")\nsay day < toDate(d)\nexit\n',
  ],
  ["pasted/437", "let n = 12\nsay toString(n).length\nexit\n"],
  ["pasted/441", "let ns = [12, 13]\nsay toString(ns.random).length\nexit\n"],
  ["pasted/444", "let d = 2 s\nsay d / 1 second\nexit\n"],
  ["pasted/446", "let d = 2 s\nsay 4 / (d / 1 second)\nexit\n"],
  ["pasted/449", "let d = 1 s+2 s\nsay (d / 1 second) + 1\nexit\n"],
  [
    "pasted/451",
    'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nsay t.toDateTime().year\nexit\n',
  ],
  ["pasted/460", 'let caption: string = "${1}"\nsay caption\nexit\n'],
  ["pasted/462", 'let n = 1\nlet caption: string = "${n + 1}"\nsay caption\nexit\n'],
  ["pasted/465", "let pause: duration = 3 s\nsay pause\nexit\n"],
  ["pasted/469", "player.copyFrom(playerProfile)\nsay player.firstName\nexit\n"],
  ["fixture-pasted/482", "let xs = []\nxs.addAll([1])\nif xs.length > 0 { say xs.first }\nexit\n"],
  ["fixture-pasted/484", "let xs = [1]\nxs.clear()\nif xs.length > 0 { say xs.first }\nexit\n"],
  ["fixture-pasted/487", "let xs = [1]\nxs.removeAt(0)\nif xs.length > 0 { say xs.first }\nexit\n"],
  [
    "fixture-pasted/489",
    "let xs = [1]\nxs.removeFirst()\nif xs.length > 0 { say xs.first }\nexit\n",
  ],
  [
    "fixture-pasted/491",
    "let xs = [1]\nxs.removeLast()\nif xs.length > 0 { say xs.first }\nexit\n",
  ],
  ["fixture-pasted/501", 'let a = ["s"]\nlet b: (string | integer)[] = a\nb.add(1)\nexit\n'],
  [
    "fixture-pasted/503",
    'let a = ["s"]\nlet b: (string | integer) set = a.toSet()\nb.add(1)\nexit\n',
  ],
  [
    "fixture-pasted/505",
    'let a = set["s"]\nlet b: (string | integer)[] = a.toList()\nb.add(1)\nexit\n',
  ],
  [
    "fixture-pasted/507",
    'let a = ["s"]\nlet b: (string | integer)[] = a.take(1)\nb.add(1)\nexit\n',
  ],
  [
    "fixture-pasted/509",
    'let a = ["s"]\nlet b: (string | integer)[] = a.takeLast(1)\nb.add(1)\nexit\n',
  ],
  ["fixture-pasted/511", 'let a = ["s"]\nlet b: (string | integer)[] = [] + a\nb.add(1)\nexit\n'],
  [
    "fixture-pasted/514",
    'let a = {length: "bad", first: 1.5}\nlet n: integer | string = a.length\nrepeat a.first {}\nexit\n',
  ],
  [
    "fixture-pasted/515",
    'let a = {length: "bad", first: 1.5}\nlet n: integer = a.length\nlet value = a.first\nif value is integer { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/527",
    "let groups =  [[]]\ngroups[0].add(1)\nif groups[0].length > 0 { say groups[0].first }\nexit\n",
  ],
  [
    "fixture-pasted/529",
    "let groups =  [[1]]\ngroups[0].clear()\nif groups[0].length > 0 { say groups[0].first }\nexit\n",
  ],
  [
    "fixture-pasted/531",
    "let groups =  [[1]]\ngroups[0].removeFirst()\nif groups[0].length > 0 { say groups[0].first }\nexit\n",
  ],
  [
    "fixture-pasted/618",
    "let xs = [null, 1]\nlet n = xs.get(0, default: 1)\nif n != null { repeat n {} }\nexit\n",
  ],
  [
    "fixture-pasted/619",
    "let xs = [null, 1]\nlet n = xs.get(0, default: 1)\nrepeat n otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/627",
    "player.n = 1\nlet value = player.n\nif value is integer { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/629",
    "let other = player\nother.n = 1\nlet value = other.n\nif value is integer { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/631",
    "let state = {person: player}\nstate.person.n = 1\nlet value = state.person.n\nif value is integer { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/633",
    "let people = [player]\nlet value = people.random.n\nif value is integer { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/635",
    "function who { return player }\nlet value = who().n\nif value is integer { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/637",
    "function use(who = player) { let value = who.n\nif value is integer { repeat value {} } }\nuse()\nexit\n",
  ],
  [
    "fixture-pasted/641",
    'function f { if askBoolean("Value?") { return 1 } }\nlet value = f()\nif value != null { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/642",
    'function f { if askBoolean("Value?") { return 1 } }\nrepeat f() otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/650",
    'function f { return 1\n return "x" }\nsay f()\nexit\nfunction fixType(p: integer | string) {\n  say p\n}\n',
  ],
  ["fixture-pasted/661", 'let x = {a: 1}\nsay "Value ${x.a}"\nexit\n'],
  ["fixture-pasted/670", 'let n: integer | string = 1\nn = "bad"\nrepeat n {}\nexit\n'],
  [
    "fixture-pasted/691",
    'let x = "s"\nif askBoolean("Clear?") { x = null }\nif x != null { say x.length }\nexit\n',
  ],
  [
    "fixture-pasted/692",
    'let x = "s"\nif askBoolean("Clear?") { x = null }\nsay (x otherwise "").length\nexit\n',
  ],
  ["fixture-pasted/694", "let x = 1\nsay toString(x).length\nexit\n"],
  ["fixture-pasted/698", "let xs = []\nif xs.length > 0 { say xs.last }\nexit\n"],
  ["fixture-pasted/700", "let xs = []\nif xs.length > 0 { say xs.random }\nexit\n"],
  ["fixture-pasted/702", "let xs = []\nif xs.length > 0 { say xs.removeFirst() }\nexit\n"],
  ["fixture-pasted/704", "let xs = []\nif xs.length > 0 { say xs.removeLast() }\nexit\n"],
  [
    "fixture-pasted/706",
    'let xs = ["Ada"]\nxs.clear()\nif xs.length > 0 { say "Hello ${xs}" }\nexit\n',
  ],
  ["fixture-pasted/715", 'let x = dict{a: 1}\nsay "Value ${x.values.join()}"\nexit\n'],
  ["fixture-pasted/723", 'let key = 1\nlet d = dict{["${key}"]: 2}\nsay d\nexit\n'],
  ["fixture-pasted/732", 'let x: integer | string | null = null\nx = 1\nx = "bad"\nexit\n'],
  ["fixture-pasted/738", 'let a: integer | string = 1\na = "bad"\nlet b = a\nrepeat b {}\nexit\n'],
  [
    "fixture-pasted/740",
    'let live = []\nshowPermanentButton "key" { live.add("s") }\nlet saved: (integer | string)[] = live\nsaved.add(1)\nexit\n',
  ],
  [
    "fixture-pasted/742",
    'let source = ["s"]\nlet copy: integer | string = source.removeAt(0)\ncopy = 2\nexit\n',
  ],
  [
    "fixture-pasted/745",
    'let d: (integer | string) dict = dict{}\nd["a"] = 1\nd["b"] = "x"\nexit\n',
  ],
  [
    "fixture-pasted/776",
    'let rugzak = []\nshowPermanentButton "key" { rugzak.add("sleutel") }\nwait 5 s\nlet kopie: (integer | string)[] = rugzak\nkopie.add(3)\nexit\n',
  ],
  [
    "fixture-pasted/787",
    "let xs = []\nfunction replacement { xs = []\n return 1 }\nxs.add(replacement())\nif xs.length > 0 { say xs.first }\nexit\n",
  ],
  [
    "fixture-pasted/792",
    "let person = player\nlet value = person.n\nif value is integer { repeat value {} }\nexit\n",
  ],
  ["fixture-pasted/796", "let xs = []\nif xs.length > 0 { say xs.first }\nexit\n"],
  ["fixture-pasted/844", 'let clock = {hour: 12}\nsay "Clock ${clock.hour}"\nexit\n'],
  [
    "fixture-pasted/848",
    'let a = []\na.add("s")\nlet b: (string | integer)[] = a\nb.add(1)\nexit\n',
  ],
  ["fixture-pasted/851", 'let a = 1\nlet b: integer | string = a\nb = "s"\nexit\n'],
  [
    "fixture-pasted/854",
    'let xs = [1]\nif askBoolean("Change?") { xs = [] }\nif xs.length > 0 { say xs.first }\nexit\n',
  ],
  [
    "fixture-pasted/863",
    'let alarm: media | timer = timer async hidden 1 s { say "finished", instant }\nexit\n',
  ],
  [
    "fixture-pasted/876",
    'let names = ["Ada"]\nlet selected: string = names.get(5, default: null) otherwise ""\nsay selected\nexit\n',
  ],
  [
    "fixture-pasted/948",
    "function who { return {person: player} }\nlet record = who()\nlet value = record.person.n\nif value is integer { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/953",
    'let d = dict{a: null}\nlet n = d.get("a", default: 1)\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/954",
    'let d = dict{a: null}\nlet n = d.get("a", default: 1)\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/959",
    'let entries = []\nfunction use(first: (string | integer)[], ignored) { first.add(1) }\nuse(ignored: entries.add("word"), first: entries)\nexit\n',
  ],
  [
    "fixture-pasted/982",
    'let value: string | integer = "s"\nif askBoolean("Change?") { value = 1 }\nif value is string { say value.length }\nexit\n',
  ],
  [
    "fixture-pasted/997",
    'let keyA = "alpha"\nlet keyB = "beta"\nlet raw = 1\nlet value = load(keyA, default: null)\nif value is integer { raw = value }\nif askBoolean("Second ingress?") { raw = load(keyB, default: null) }\nif askBoolean("Opaque source?") { raw = player.firstName }\nrepeat raw {}\nlet arbitrary: integer = raw.unlisted\nrepeat arbitrary {}\nexit\n',
  ],
  [
    "fixture-pasted/998",
    'let keyA = "alpha"\nlet keyB = "beta"\nlet raw = 1\nraw = load(keyA, default: null)\nif askBoolean("Second ingress?") { let value = load(keyB, default: null)\nif value is integer { raw = value } }\nif askBoolean("Opaque source?") { raw = player.firstName }\nrepeat raw {}\nlet arbitrary: integer = raw.unlisted\nrepeat arbitrary {}\nexit\n',
  ],
  [
    "fixture-pasted/999",
    'let keyA = "alpha"\nlet keyB = "beta"\nlet raw = 1\nraw = load(keyA, default: null)\nif askBoolean("Second ingress?") { raw = load(keyB, default: null) }\nif askBoolean("Opaque source?") { let value = player.firstName\nif value is integer { raw = value } }\nrepeat raw {}\nlet arbitrary: integer = raw.unlisted\nrepeat arbitrary {}\nexit\n',
  ],
  [
    "fixture-pasted/1000",
    'player.copyFrom(playerProfile)\nlet keyA = "alpha"\nlet keyB = "beta"\nlet raw = 1\nraw = load(keyA, default: null)\nif askBoolean("Second ingress?") { raw = load(keyB, default: null) }\nif askBoolean("Opaque source?") { raw = player.firstName }\nrepeat raw {}\nlet arbitrary: integer = raw.unlisted\nrepeat arbitrary {}\nexit\n',
  ],
  [
    "fixture-pasted/1001",
    'let keyA = "alpha"\nlet keyB = "beta"\nlet raw = 1\nraw = load(keyA, default: null)\nif askBoolean("Second ingress?") { raw = load(keyB, default: null) }\nif askBoolean("Opaque source?") { raw = player.firstName }\nif raw is integer { repeat raw {} }\nlet arbitrary: integer = raw.unlisted\nrepeat arbitrary {}\nexit\n',
  ],
  [
    "fixture-pasted/1004",
    "let rounds = 2\nlet state = {a: [1], b: [2]}\nrepeat rounds { state.a.clear()\n state.a.add(1)\n state.b.clear()\n state.b.add(2) }\nif state.a.length > 0 { say state.a.first }\nsay state.b.first\nexit\n",
  ],
  [
    "fixture-pasted/1005",
    "let rounds = 2\nlet state = {a: [1], b: [2]}\nrepeat rounds { state.a.clear()\n state.a.add(1)\n state.b.clear()\n state.b.add(2) }\nsay state.a.first\nif state.b.length > 0 { say state.b.first }\nexit\n",
  ],
  [
    "fixture-pasted/1007",
    'let value = "ok"\nif askBoolean("Clear?") { value = null }\nlet copied: string = value otherwise ""\nexit\n',
  ],
  [
    "fixture-pasted/1010",
    'function result: string | integer { if askBoolean("Text?") { return "text" }\n return 1 }\nlet accepted: boolean | string | integer = result()\nexit\n',
  ],
  [
    "fixture-pasted/1020",
    'let loaded = load("count", default: [1])\nif loaded.length > 0 { say loaded.first }\nexit\n',
  ],
  [
    "fixture-pasted/1024",
    'let loaded = fromJson("1.5", default: [1])\nif loaded.length > 0 { say loaded.first }\nexit\n',
  ],
  [
    "fixture-pasted/1028",
    'let flag = hostValue\nif flag is boolean { if flag { say "yes" } }\nexit\n',
  ],
  [
    "fixture-pasted/1032",
    "let x = hostValue\nlet result: string = x / 4\nexit\nfunction fixType(p: string | number | duration | calendarDuration | angle) {\n  say p\n}\n",
  ],
  [
    "fixture-pasted/1036",
    "let out = []\nfor item in [] { out.add(1) }\nif out.length > 0 { repeat out.first {} }\nexit\n",
  ],
  [
    "fixture-pasted/1039",
    "let items = []\nitems.addAll([1])\nlet out = []\nfor item in items { out.add(1) }\nif out.length > 0 { repeat out.first {} }\nexit\n",
  ],
  [
    "fixture-pasted/1042",
    'let out = []\nfor item in [1] { if askBoolean("Add?") { out.add(1) } }\nif out.length > 0 { repeat out.first {} }\nexit\n',
  ],
  [
    "fixture-pasted/1047",
    "let out = []\nfor item in [1] { out.add(1)\n exit }\nif out.length > 0 { repeat out.first {} }\nexit\n",
  ],
  [
    "fixture-pasted/1049",
    "function visit {\n let out = []\n for item in [1] { out.add(1)\n  return }\n if out.length > 0 { repeat out.first {} }\n}\nvisit()\nexit\n",
  ],
  [
    "fixture-pasted/1051",
    "let out = []\nfor item in [1] { out.add(1)\n goto done }\nlabel done\nif out.length > 0 { repeat out.first {} }\nexit\n",
  ],
  [
    "fixture-pasted/1054",
    "let out = []\nfunction reset { out = []\n return 1 }\nfor item in [1] { out.add(reset()) }\nif out.length > 0 { repeat out.first {} }\nexit\n",
  ],
  [
    "fixture-pasted/1056",
    "let out = []\nfor item in [1] { out.addAll([1]) }\nif out.length > 0 { repeat out.first {} }\nexit\n",
  ],
  [
    "fixture-pasted/1069",
    'showPermanentButton "Read" {\n let out = []\n out.add(1)\n if out.length > 0 { say out.first }\n}\nexit\n',
  ],
  ["fixture-pasted/1074", "let n = null\nif n != null { if n != null { repeat n {} } }\nexit\n"],
  ["fixture-pasted/1075", "let n = null\nif n != null { repeat n otherwise 0 {} }\nexit\n"],
  ["fixture-pasted/1077", "let n = null\nif n == null { if n != null { repeat n {} } }\nexit\n"],
  ["fixture-pasted/1078", "let n = null\nif n == null { repeat n otherwise 0 {} }\nexit\n"],
  [
    "fixture-pasted/1080",
    "let n = null\nif n == null {} else { if n != null { repeat n {} } }\nexit\n",
  ],
  ["fixture-pasted/1081", "let n = null\nif n == null {} else { repeat n otherwise 0 {} }\nexit\n"],
  [
    "fixture-pasted/1097",
    [
      { path: "main.tease", source: 'call "worker.tease"\nexit\n' },
      {
        path: "worker.tease",
        source:
          "let out = []\nfor item in [1] { out.add(1)\n end\n}\nif out.length > 0 { repeat out.first {} }\nexit\n",
      },
    ],
  ],
  [
    "fixture-pasted/1106",
    'let flagHost = askBoolean "flag"\nlet target = {n: 1}\nif flagHost { if hostValue is object { target = hostValue } }\ntarget.other = 2\nexit\n',
  ],
  [
    "fixture-pasted/1111",
    "let a = {last: 1.5}\nlet value = a.last\nif value is integer { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/1116",
    "let out = []\nfor item in [1] { out.add(1)\n out.clear() }\nif out.length > 0 { say out.first }\nexit\n",
  ],
  [
    "fixture-pasted/1119",
    "let out = []\nfor item in [1] { out.add(1)\n out = [] }\nif out.length > 0 { say out.first }\nexit\n",
  ],
  [
    "fixture-pasted/1122",
    "let out = []\nfor item in [1] { out.add(1)\n out.removeFirst() }\nif out.length > 0 { say out.first }\nexit\n",
  ],
  ["fixture-pasted/1126", "let n = null\nlet whole: integer? = n\nexit\n"],
  ["fixture-pasted/1130", "let x = null\nif x != null { if x != null { say x.length } }\nexit\n"],
  [
    "fixture-pasted/1137",
    'let rugzak = []\nshowPermanentButton "Pak sleutel" { rugzak.add("sleutel") }\nwait 5 s\nlet kopie: (integer | string)[] = rugzak\nkopie.add(3)\nexit\n',
  ],
  [
    "fixture-pasted/1139",
    'let hasKey = askBoolean "Do you have the key?"\nlet backpack = []\nif hasKey {\n    backpack.add("key")\n}\nif not hasKey {\n    let copy: (integer | string)[] = backpack\n    copy.add(3)\n}\nexit\n',
  ],
  [
    "fixture-pasted/1141",
    "let values = []\nfunction replace {\n    values = []\n    return 1\n}\nvalues.add(replace())\nif values.length > 0 { say values.first }\nexit\n",
  ],
  [
    "fixture-pasted/1143",
    "let state = { items: [] }\nfunction reset {\n    state = { items: [] }\n    return 1\n}\nstate.items.add(reset())\nif state.items.length > 0 { say state.items.first }\nexit\n",
  ],
  [
    "fixture-pasted/1145",
    "let state = { items: [] }\nfunction reset {\n    state = { items: [] }\n    return [1]\n}\nstate.items.addAll(reset())\nif state.items.length > 0 { say state.items.first }\nexit\n",
  ],
  [
    "fixture-pasted/1158",
    'let values = [null, 1]\nlet selected = values.get(0, default: 1)\nif selected != null { repeat selected { say "round" } }\nexit\n',
  ],
  [
    "fixture-pasted/1159",
    'let values = [null, 1]\nlet selected = values.get(0, default: 1)\nrepeat selected otherwise 0 { say "round" }\nexit\n',
  ],
  ["fixture-pasted/1163", 'let state = { hp: 1 }\nsay "Value: ${state.hp}"\nexit\n'],
  [
    "fixture-pasted/1165",
    'player.n = 1\nlet other = player\nother.n = 1.5\nlet value = player.n\nif value is integer { repeat value { say "x" } }\nexit\n',
  ],
  [
    "fixture-pasted/1167",
    'player.n = 1\nlet other = player\nother.n = 1.5\nlet value = other.n\nif value is integer { repeat value { say "x" } }\nexit\n',
  ],
  [
    "fixture-pasted/1169",
    'player.n = 1\nlet other = player\nother.n = 1\nplayer.n = 1.5\nlet value = other.n\nif value is integer { repeat value { say "x" } }\nexit\n',
  ],
  [
    "fixture-pasted/1171",
    'player.n = 1\nlet state = {person: player}\nstate.person.n = 1\nplayer.n = 1.5\nlet value = state.person.n\nif value is integer { repeat value { say "x" } }\nexit\n',
  ],
  [
    "fixture-pasted/1173",
    'player.n = 1\nlet other = player\nother.n = 1.5\nplayer.n = 1\nlet value = other.n\nif value is integer { repeat value { say "x" } }\nexit\n',
  ],
  [
    "fixture-pasted/1175",
    'player.rounds = 0\nfunction who { return player }\nlet alias = who()\nalias.rounds = 1\nplayer.rounds = 1.5\nlet value = alias.rounds\nif value is integer { repeat value { say "round" } }\nexit\n',
  ],
  [
    "fixture-pasted/1177",
    'player.rounds = 0\nfunction use(who = player) {\n    who.rounds = 1\n    player.rounds = 1.5\n    let value = who.rounds\nif value is integer { repeat value { say "round" } }\n}\nuse()\nexit\n',
  ],
  [
    "fixture-pasted/1179",
    'player.rounds = 0\nfunction wrapped { return { person: player } }\nlet wrapper = wrapped()\nlet alias = wrapper.person\nalias.rounds = 1\nplayer.rounds = 1.5\nlet value = alias.rounds\nif value is integer { repeat value { say "round" } }\nexit\n',
  ],
  [
    "fixture-pasted/1181",
    'let v0: integer | string = 0\nv0 = "x"\nlet v1 = v0\nv1 = "x"\nlet v2 = v1\nv2 = "x"\nlet v3 = v2\nv3 = "x"\nlet v4 = v3\nv4 = "x"\nlet v5 = v4\nv5 = "x"\nlet v6 = v5\nv6 = "x"\nlet v7 = v6\nv7 = "x"\nlet v8 = v7\nv8 = "x"\nlet v9 = v8\nv9 = "x"\nlet v10 = v9\nv10 = "x"\nlet v11 = v10\nv11 = "x"\nlet final: integer = v11\nsay final\nexit\n',
  ],
  [
    "fixture-pasted/1182",
    'let v0 = 0\nv0 = "x"\nlet v1: integer | string = v0\nv1 = "x"\nlet v2 = v1\nv2 = "x"\nlet v3 = v2\nv3 = "x"\nlet v4 = v3\nv4 = "x"\nlet v5 = v4\nv5 = "x"\nlet v6 = v5\nv6 = "x"\nlet v7 = v6\nv7 = "x"\nlet v8 = v7\nv8 = "x"\nlet v9 = v8\nv9 = "x"\nlet v10 = v9\nv10 = "x"\nlet v11 = v10\nv11 = "x"\nlet final: integer = v11\nsay final\nexit\n',
  ],
  [
    "fixture-pasted/1183",
    'let v0 = 0\nv0 = "x"\nlet v1 = v0\nv1 = "x"\nlet v2: integer | string = v1\nv2 = "x"\nlet v3 = v2\nv3 = "x"\nlet v4 = v3\nv4 = "x"\nlet v5 = v4\nv5 = "x"\nlet v6 = v5\nv6 = "x"\nlet v7 = v6\nv7 = "x"\nlet v8 = v7\nv8 = "x"\nlet v9 = v8\nv9 = "x"\nlet v10 = v9\nv10 = "x"\nlet v11 = v10\nv11 = "x"\nlet final: integer = v11\nsay final\nexit\n',
  ],
  [
    "fixture-pasted/1184",
    'let v0 = 0\nv0 = "x"\nlet v1 = v0\nv1 = "x"\nlet v2 = v1\nv2 = "x"\nlet v3: integer | string = v2\nv3 = "x"\nlet v4 = v3\nv4 = "x"\nlet v5 = v4\nv5 = "x"\nlet v6 = v5\nv6 = "x"\nlet v7 = v6\nv7 = "x"\nlet v8 = v7\nv8 = "x"\nlet v9 = v8\nv9 = "x"\nlet v10 = v9\nv10 = "x"\nlet v11 = v10\nv11 = "x"\nlet final: integer = v11\nsay final\nexit\n',
  ],
  [
    "fixture-pasted/1185",
    'let v0 = 0\nv0 = "x"\nlet v1 = v0\nv1 = "x"\nlet v2 = v1\nv2 = "x"\nlet v3 = v2\nv3 = "x"\nlet v4: integer | string = v3\nv4 = "x"\nlet v5 = v4\nv5 = "x"\nlet v6 = v5\nv6 = "x"\nlet v7 = v6\nv7 = "x"\nlet v8 = v7\nv8 = "x"\nlet v9 = v8\nv9 = "x"\nlet v10 = v9\nv10 = "x"\nlet v11 = v10\nv11 = "x"\nlet final: integer = v11\nsay final\nexit\n',
  ],
  [
    "fixture-pasted/1186",
    'let v0 = 0\nv0 = "x"\nlet v1 = v0\nv1 = "x"\nlet v2 = v1\nv2 = "x"\nlet v3 = v2\nv3 = "x"\nlet v4 = v3\nv4 = "x"\nlet v5: integer | string = v4\nv5 = "x"\nlet v6 = v5\nv6 = "x"\nlet v7 = v6\nv7 = "x"\nlet v8 = v7\nv8 = "x"\nlet v9 = v8\nv9 = "x"\nlet v10 = v9\nv10 = "x"\nlet v11 = v10\nv11 = "x"\nlet final: integer = v11\nsay final\nexit\n',
  ],
  [
    "fixture-pasted/1187",
    'let v0 = 0\nv0 = "x"\nlet v1 = v0\nv1 = "x"\nlet v2 = v1\nv2 = "x"\nlet v3 = v2\nv3 = "x"\nlet v4 = v3\nv4 = "x"\nlet v5 = v4\nv5 = "x"\nlet v6: integer | string = v5\nv6 = "x"\nlet v7 = v6\nv7 = "x"\nlet v8 = v7\nv8 = "x"\nlet v9 = v8\nv9 = "x"\nlet v10 = v9\nv10 = "x"\nlet v11 = v10\nv11 = "x"\nlet final: integer = v11\nsay final\nexit\n',
  ],
  [
    "fixture-pasted/1188",
    'let v0 = 0\nv0 = "x"\nlet v1 = v0\nv1 = "x"\nlet v2 = v1\nv2 = "x"\nlet v3 = v2\nv3 = "x"\nlet v4 = v3\nv4 = "x"\nlet v5 = v4\nv5 = "x"\nlet v6 = v5\nv6 = "x"\nlet v7: integer | string = v6\nv7 = "x"\nlet v8 = v7\nv8 = "x"\nlet v9 = v8\nv9 = "x"\nlet v10 = v9\nv10 = "x"\nlet v11 = v10\nv11 = "x"\nlet final: integer = v11\nsay final\nexit\n',
  ],
  [
    "fixture-pasted/1189",
    'let v0 = 0\nv0 = "x"\nlet v1 = v0\nv1 = "x"\nlet v2 = v1\nv2 = "x"\nlet v3 = v2\nv3 = "x"\nlet v4 = v3\nv4 = "x"\nlet v5 = v4\nv5 = "x"\nlet v6 = v5\nv6 = "x"\nlet v7 = v6\nv7 = "x"\nlet v8: integer | string = v7\nv8 = "x"\nlet v9 = v8\nv9 = "x"\nlet v10 = v9\nv10 = "x"\nlet v11 = v10\nv11 = "x"\nlet final: integer = v11\nsay final\nexit\n',
  ],
  [
    "fixture-pasted/1190",
    'let v0 = 0\nv0 = "x"\nlet v1 = v0\nv1 = "x"\nlet v2 = v1\nv2 = "x"\nlet v3 = v2\nv3 = "x"\nlet v4 = v3\nv4 = "x"\nlet v5 = v4\nv5 = "x"\nlet v6 = v5\nv6 = "x"\nlet v7 = v6\nv7 = "x"\nlet v8 = v7\nv8 = "x"\nlet v9: integer | string = v8\nv9 = "x"\nlet v10 = v9\nv10 = "x"\nlet v11 = v10\nv11 = "x"\nlet final: integer = v11\nsay final\nexit\n',
  ],
  [
    "fixture-pasted/1191",
    'let v0 = 0\nv0 = "x"\nlet v1 = v0\nv1 = "x"\nlet v2 = v1\nv2 = "x"\nlet v3 = v2\nv3 = "x"\nlet v4 = v3\nv4 = "x"\nlet v5 = v4\nv5 = "x"\nlet v6 = v5\nv6 = "x"\nlet v7 = v6\nv7 = "x"\nlet v8 = v7\nv8 = "x"\nlet v9 = v8\nv9 = "x"\nlet v10: integer | string = v9\nv10 = "x"\nlet v11 = v10\nv11 = "x"\nlet final: integer = v11\nsay final\nexit\n',
  ],
  [
    "fixture-pasted/1192",
    'let v0 = 0\nv0 = "x"\nlet v1 = v0\nv1 = "x"\nlet v2 = v1\nv2 = "x"\nlet v3 = v2\nv3 = "x"\nlet v4 = v3\nv4 = "x"\nlet v5 = v4\nv5 = "x"\nlet v6 = v5\nv6 = "x"\nlet v7 = v6\nv7 = "x"\nlet v8 = v7\nv8 = "x"\nlet v9 = v8\nv9 = "x"\nlet v10 = v9\nv10 = "x"\nlet v11: integer | string = v10\nv11 = "x"\nlet final: integer = v11\nsay final\nexit\n',
  ],
  [
    "fixture-pasted/1196",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string = false\nif flagHost { value = "word" }\nif value is boolean { if value {} }\nexit\n',
  ],
  [
    "fixture-pasted/1198",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string | null = null\nif flagHost { value = "word" }\nif value is boolean { if value {} }\nexit\n',
  ],
  [
    "fixture-pasted/1200",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string = false\nif flagHost { value = "word" }\nif value is boolean { say not value }\nexit\n',
  ],
  [
    "fixture-pasted/1202",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string | null = null\nif flagHost { value = "word" }\nif value is boolean { say not value }\nexit\n',
  ],
  [
    "fixture-pasted/1208",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string = false\nif flagHost { value = "word" }\nlet d = dict{a: 1}\nif value is string { say d[value] }\nexit\n',
  ],
  [
    "fixture-pasted/1210",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string | null = null\nif flagHost { value = "word" }\nlet d = dict{a: 1}\nif value is string { say d[value] }\nexit\n',
  ],
  [
    "fixture-pasted/1212",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string = false\nif flagHost { value = "word" }\nlet d = dict{a: 1}\nif value is string { say d.get(value, default: 0) }\nexit\n',
  ],
  [
    "fixture-pasted/1214",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string | null = null\nif flagHost { value = "word" }\nlet d = dict{a: 1}\nif value is string { say d.get(value, default: 0) }\nexit\n',
  ],
  [
    "fixture-pasted/1216",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string = false\nif flagHost { value = "word" }\nlet d = dict{a: 1}\nif value is string { say d.remove(value) }\nexit\n',
  ],
  [
    "fixture-pasted/1218",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string | null = null\nif flagHost { value = "word" }\nlet d = dict{a: 1}\nif value is string { say d.remove(value) }\nexit\n',
  ],
  [
    "fixture-pasted/1220",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string = false\nif flagHost { value = "word" }\nlet d = dict{a: 1}\nif value is string { d[value] = 2 }\nexit\n',
  ],
  [
    "fixture-pasted/1222",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string | null = null\nif flagHost { value = "word" }\nlet d = dict{a: 1}\nif value is string { d[value] = 2 }\nexit\n',
  ],
  [
    "fixture-pasted/1227",
    "let numbers = [1]\nif hostValue is integer { numbers.add(hostValue) }\nexit\n",
  ],
  [
    "fixture-pasted/1230",
    'let numbers = [1]\nlet value = load("list", default: [])\nif value is integer { numbers.addAll(value) }\nexit\n',
  ],
  [
    "fixture-pasted/1237",
    'let flagHost = askBoolean "flag"\nlet v = {n: 1}\nif flagHost { if hostValue is object { v = hostValue } }\nv.n = 2\nexit\n',
  ],
  [
    "fixture-pasted/1261",
    "let n = null\nlet other = null\nif n != null { if n != null { repeat n {} } }\nexit\n",
  ],
  [
    "fixture-pasted/1262",
    "let n = null\nlet other = null\nif n != null { repeat n otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/1265",
    "let n = null\nlet other = null\nif n == null { if n != null { repeat n {} } }\nexit\n",
  ],
  [
    "fixture-pasted/1266",
    "let n = null\nlet other = null\nif n == null { repeat n otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/1312",
    "let n = 2.0\nlet other = 2.0\nif n is integer {\nlet whole: integer | boolean = n < 3\n}\nexit\n",
  ],
  [
    "fixture-pasted/1314",
    "let n = 2.0\nlet other = 2.0\nif other is integer {\nlet whole: integer | boolean = n < 3\n}\nexit\n",
  ],
  [
    "fixture-pasted/1335",
    "let xs = []\nlet other = []\nif xs != null { if xs.length > 0 { say xs.first } }\nexit\n",
  ],
  [
    "fixture-pasted/1337",
    "let xs = []\nlet other = []\nif other != null { if xs.length > 0 { say xs.first } }\nexit\n",
  ],
  [
    "fixture-pasted/1340",
    "let n = 2.0\nlet other = 2.0\nif n is integer {\nlet saved = n\nif saved > 0 {}\n}\nexit\n",
  ],
  [
    "fixture-pasted/1342",
    "let n = 2.0\nlet other = 2.0\nif other is integer {\nlet saved = n\nif saved > 0 {}\n}\nexit\n",
  ],
  [
    "fixture-pasted/1348",
    'let n = 2.0\nlet other = 2.0\nif n is integer {\nlet whole: integer = n\nlet caption: string = "${1}"\n}\nexit\n',
  ],
  [
    "fixture-pasted/1350",
    'let n = 2.0\nlet other = 2.0\nif other is integer {\nlet whole: integer = n\nlet caption: string = "${1}"\n}\nexit\n',
  ],
  [
    "fixture-pasted/1395",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string = true\nif flagHost { value = "bad" }\nif value is boolean { if value {} }\nexit\n',
  ],
  [
    "fixture-pasted/1397",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string | null = null\nif flagHost { value = "bad" }\nif value is boolean { if value {} }\nexit\n',
  ],
  [
    "fixture-pasted/1399",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string = true\nif flagHost { value = "bad" }\nif value is boolean { say not value }\nexit\n',
  ],
  [
    "fixture-pasted/1401",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string | null = null\nif flagHost { value = "bad" }\nif value is boolean { say not value }\nexit\n',
  ],
  [
    "fixture-pasted/1403",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string = true\nif flagHost { value = "bad" }\nif value is boolean { say value and true }\nexit\n',
  ],
  [
    "fixture-pasted/1405",
    'let flagHost = askBoolean "flag"\nlet value: boolean | string | null = null\nif flagHost { value = "bad" }\nif value is boolean { say value and true }\nexit\n',
  ],
  [
    "fixture-pasted/1407",
    'let flagHost = askBoolean "flag"\nlet d = dict{"ok": 1}\nlet value: string | integer = "ok"\nif flagHost { value = 4 }\nif value is string { say d[value] }\nexit\n',
  ],
  [
    "fixture-pasted/1409",
    'let flagHost = askBoolean "flag"\nlet d = dict{"ok": 1}\nlet value: string | integer | null = null\nif flagHost { value = 4 }\nif value is string { say d[value] }\nexit\n',
  ],
  [
    "fixture-pasted/1411",
    'let flagHost = askBoolean "flag"\nlet value: integer | string = 1\nif flagHost { value = "bad" }\nif value is integer { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/1413",
    'let flagHost = askBoolean "flag"\nlet value: integer | string | null = null\nif flagHost { value = "bad" }\nif value is integer { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/1415",
    'let flagHost = askBoolean "flag"\nlet value: integer | string = 1\nif flagHost { value = "bad" }\nif value is integer { say value + 1 }\nexit\n',
  ],
  [
    "fixture-pasted/1417",
    'let flagHost = askBoolean "flag"\nlet value: integer | string | null = null\nif flagHost { value = "bad" }\nif value is integer { say value + 1 }\nexit\n',
  ],
  [
    "fixture-pasted/1430",
    "let data = {amount: hostValue}\nlet value = data.amount\nif value is integer { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/1432",
    "function packet { return {amount: hostValue} }\nlet data = packet()\nlet value = data.amount\nif value is integer { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/1434",
    "function use(data) { let value = data.amount\nif value is integer { repeat value {} } }\nuse({amount: hostValue})\nexit\n",
  ],
  [
    "fixture-pasted/1436",
    "function packet { return {amount: hostValue} }\nfunction use(data) { let value = data.amount\nif value is integer { repeat value {} } }\nuse(packet())\nexit\n",
  ],
  [
    "fixture-pasted/1438",
    "let numbers: integer[] = []\nif hostValue is integer { numbers.add(hostValue) }\nrepeat numbers.first {}\nexit\n",
  ],
  [
    "fixture-pasted/1440",
    "let records = [{amount: 1}]\nif hostValue is integer { records.add({amount: hostValue}) }\nrepeat records.last.amount {}\nexit\n",
  ],
  [
    "fixture-pasted/1441",
    "let records = [{amount: 1}]\nrecords.add({amount: hostValue})\nlet value = records.last.amount\nif value is integer { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/1443",
    "function use(n: integer) { repeat n {} }\nif hostValue is integer { use(hostValue) }\nexit\n",
  ],
  [
    "fixture-pasted/1447",
    "let a=hostValue\nlet b=hostValue\nlet bag=[a,b]\nlet value = bag.first\nif value is integer { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/1449",
    'let flagHost = askBoolean "flag"\nlet v=player.count\nif flagHost { v=hostValue }\nif v is integer { repeat v {} }\nexit\n',
  ],
  [
    "fixture-pasted/1454",
    "let shelf={items:[]}\nfunction change{shelf={items:[]}\nreturn 1}\nshelf.items.add(change())\nif shelf.items.length > 0 { repeat shelf.items.first {} }\nexit\n",
  ],
  ["fixture-pasted/1469", "let box: integer?[] = [1]\nbox=[null]\nrepeat box.first {}\nexit\n"],
  [
    "fixture-pasted/1473",
    "let xs=[1]\nxs.clear()\nif xs.length > 0 { repeat xs.first {} }\nexit\n",
  ],
  [
    "fixture-pasted/1475",
    "let xs=[1]\nxs.removeLast()\nif xs.length > 0 { repeat xs.first {} }\nexit\n",
  ],
  [
    "fixture-pasted/1506",
    'let flagHost = askBoolean "flag"\nlet value:integer|string|null=null\nif flagHost {value=4}\nif value is string { say value.length }\nexit\n',
  ],
  [
    "fixture-pasted/1511",
    'let flagHost = askBoolean "flag"\nlet value:object|integer={a:1}\nif flagHost {value=4}\nif value is object { value.missing=2 }\nexit\n',
  ],
  [
    "fixture-pasted/1515",
    "function packet {return {first:hostValue,second:hostValue}}\nlet x=packet()\nlet value = x.first\nif value is integer { repeat value {} }\nif x.second {}\nexit\n",
  ],
  [
    "fixture-pasted/1516",
    "function packet {return {first:hostValue,second:hostValue}}\nlet x=packet()\nrepeat x.first {}\nlet value = x.second\nif value is boolean { if value {} }\nexit\n",
  ],
  [
    "fixture-pasted/1519",
    "let out=[]\nfor n in [1,2] {\nbreak\nout.add(3)\n}\nif out.length > 0 { repeat out.first {} }\nexit\n",
  ],
  [
    "fixture-pasted/1521",
    "let out=[]\nfor n in [1,2] {\ngoto finish\nout.add(3)\n}\nlabel finish\nif out.length > 0 { repeat out.first {} }\nexit\n",
  ],
  [
    "fixture-pasted/1523",
    "let out=[]\nfor n in [1,2] {\nout.add(3)\nout.clear()\n}\nif out.length > 0 { repeat out.first {} }\nexit\n",
  ],
  [
    "fixture-pasted/1537",
    'let flagHost = askBoolean "flag"\nlet x:object|integer={a:1}\nif flagHost { x=4 }\nif x is object { x.a=2 }\nexit\n',
  ],
  [
    "fixture-pasted/1539",
    'let flagHost = askBoolean "flag"\nlet x:object|boolean={a:1}\nif flagHost { x=true }\nif x is object { x.a=2 }\nexit\n',
  ],
  [
    "fixture-pasted/1541",
    'let flagHost = askBoolean "flag"\nlet x:object|string={a:1}\nif flagHost { x="hi" }\nif x is object { x.a=2 }\nexit\n',
  ],
  [
    "fixture-pasted/1562",
    "function person {return player}\nlet p=person()\np.n=2\nlet value = p.n\nif value is integer { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/1564",
    "function use(p=player){p.n=2\nlet value = p.n\nif value is integer { repeat value {} }}\nuse()\nexit\n",
  ],
  [
    "fixture-pasted/1571",
    'let flagHost = askBoolean "flag"\nlet a:integer?=null\nlet b:integer?=null\nif flagHost {a=2\nb=3}\nsay (a otherwise 0)+b\nexit\n',
  ],
  [
    "fixture-pasted/1572",
    'let flagHost = askBoolean "flag"\nlet a:integer?=null\nlet b:integer?=null\nif flagHost {a=2\nb=3}\nsay a+(b otherwise 0)\nexit\n',
  ],
  [
    "fixture-pasted/1574",
    "let xs:integer?[]=[null,1]\nlet n:integer=xs.get(0,default:null) otherwise 0\nexit\n",
  ],
  ["fixture-pasted/1576", "let xs:integer?[]=[null,1]\nlet n:integer=xs.first otherwise 0\nexit\n"],
  [
    "fixture-pasted/1579",
    'let value:integer = 1 otherwise "one"\nexit\nfunction fixType(p: number | string) {\n  say p\n}\n',
  ],
  ["fixture-pasted/1581", 'let x={a:1}\nsay "${x.a}"\nexit\n'],
  ["fixture-pasted/1584", 'let xs=["a","b"]\nxs.clear()\nif xs.length > 0 { say "${xs}" }\nexit\n'],
  ["fixture-pasted/1621", "let v = null\nif v != null {\nif v != null { repeat v {} }\n}\nexit\n"],
  ["fixture-pasted/1622", "let v = null\nif v != null {\nrepeat v otherwise 0 {}\n}\nexit\n"],
  ["fixture-pasted/1625", "let v = null\nif v != null {\nif v != null { say v.length }\n}\nexit\n"],
  [
    "fixture-pasted/1628",
    'let v = null\nif v != null {\nif v != null { if v { say "yes" } }\n}\nexit\n',
  ],
  [
    "fixture-pasted/1629",
    'let v = null\nif v != null {\nif v otherwise false { say "yes" }\n}\nexit\n',
  ],
  [
    "fixture-pasted/1645",
    "let v = hostValue\nlet out: integer = not v\nexit\nfunction fixType(p: integer | boolean) {\n  say p\n}\n",
  ],
  [
    "fixture-pasted/1647",
    'let v = hostValue\nlet out: integer = "${v}"\nexit\nfunction fixType(p: integer | string) {\n  say p\n}\n',
  ],
  [
    "fixture-pasted/1657",
    'let flagHost = askBoolean "flag"\nlet v = 1\nif flagHost { if hostValue is integer { v = hostValue } }\nsay v.length\nexit\n',
  ],
  [
    "fixture-pasted/1659",
    'let flagHost = askBoolean "flag"\nlet v = 1\nif flagHost { if hostValue is integer { v = hostValue } }\nv.add(1)\nexit\n',
  ],
  [
    "fixture-pasted/1661",
    'let flagHost = askBoolean "flag"\nlet v = 1\nif flagHost { if hostValue is integer { v = hostValue } }\nsay v.get(0, default: 0)\nexit\n',
  ],
  [
    "fixture-pasted/1663",
    'let flagHost = askBoolean "flag"\nlet v = 1\nif flagHost { if hostValue is integer { v = hostValue } }\nsay v.n\nexit\n',
  ],
  [
    "fixture-pasted/1665",
    'let flagHost = askBoolean "flag"\nlet v = null\nif flagHost { v = [1] }\nif v != null { say v.length }\nexit\n',
  ],
  [
    "fixture-pasted/1667",
    'let flagHost = askBoolean "flag"\nlet v = null\nif flagHost { v = [1] }\nif v != null { v.add(1) }\nexit\n',
  ],
  [
    "fixture-pasted/1669",
    'let flagHost = askBoolean "flag"\nlet v = null\nif flagHost { v = [1] }\nif v != null { say v.get(0, default: 0) }\nexit\n',
  ],
  [
    "fixture-pasted/1687",
    "function pass(p) { return p }\nlet n = null\nif n != null { let out: integer = pass(n) otherwise 0 }\nexit\n",
  ],
  [
    "fixture-pasted/1690",
    "function pass(p) { return {n: p} }\nlet n = null\nif n != null { let out: integer = pass(n).n otherwise 0 }\nexit\n",
  ],
  [
    "fixture-pasted/1693",
    "function pass(p) { return [p] }\nlet n = null\nif n != null { let out: integer = pass(n).first otherwise 0 }\nexit\n",
  ],
  [
    "fixture-pasted/1698",
    "function pass(p) { return p }\nlet n = null\nif n != null { let value = pass(n)\nif value != null { say value.length } }\nexit\n",
  ],
  [
    "fixture-pasted/1708",
    'let flagHost = askBoolean "flag"\nlet d = dict {"a": 1}\nlet v = null\nif flagHost { v = true }\nif v != null { if v { say "true" } }\nexit\n',
  ],
  [
    "fixture-pasted/1709",
    'let flagHost = askBoolean "flag"\nlet d = dict {"a": 1}\nlet v = null\nif flagHost { v = true }\nif v otherwise false { say "true" }\nexit\n',
  ],
  [
    "fixture-pasted/1711",
    'let flagHost = askBoolean "flag"\nlet d = dict {"a": 1}\nlet v = null\nif flagHost { v = true }\nlet out = not (v otherwise false)\nexit\n',
  ],
  [
    "fixture-pasted/1718",
    'let flagHost = askBoolean "flag"\nlet d = dict {"a": 1}\nlet v = null\nif flagHost { v = "x" }\nif v != null { say d[v] }\nexit\n',
  ],
  [
    "fixture-pasted/1719",
    'let flagHost = askBoolean "flag"\nlet d = dict {"a": 1}\nlet v = null\nif flagHost { v = "x" }\nsay d[v otherwise ""]\nexit\n',
  ],
  [
    "fixture-pasted/1721",
    'let flagHost = askBoolean "flag"\nlet d = dict {"a": 1}\nlet v = null\nif flagHost { v = "x" }\nif v != null { say d.get(v, default: 0) }\nexit\n',
  ],
  [
    "fixture-pasted/1722",
    'let flagHost = askBoolean "flag"\nlet d = dict {"a": 1}\nlet v = null\nif flagHost { v = "x" }\nsay d.get(v otherwise "", default: 0)\nexit\n',
  ],
  [
    "fixture-pasted/1724",
    'let flagHost = askBoolean "flag"\nlet d = dict {"a": 1}\nlet v = null\nif flagHost { v = "x" }\nif v != null { say d.remove(v) }\nexit\n',
  ],
  [
    "fixture-pasted/1725",
    'let flagHost = askBoolean "flag"\nlet d = dict {"a": 1}\nlet v = null\nif flagHost { v = "x" }\nsay d.remove(v otherwise "")\nexit\n',
  ],
  [
    "fixture-pasted/1727",
    "let xs = [0]\nif hostValue is integer { xs.add(hostValue) }\nrepeat xs.last {}\nexit\n",
  ],
  [
    "fixture-pasted/1728",
    "let xs = [0]\nxs.add(hostValue)\nlet value = xs.last\nif value is integer { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/1730",
    'let xs = [0]\nlet value = load("list", default: [])\nif value is integer { xs.addAll(value) }\nrepeat xs.last {}\nexit\n',
  ],
  [
    "fixture-pasted/1731",
    'let xs = [0]\nxs.addAll(load("list", default: []))\nlet value = xs.last\nif value is integer { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/1733",
    "let xs = [{n: 0}]\nif hostValue is integer { xs.add({n: hostValue}) }\nrepeat xs.last.n {}\nexit\n",
  ],
  [
    "fixture-pasted/1734",
    "let xs = [{n: 0}]\nxs.add({n: hostValue})\nlet value = xs.last.n\nif value is integer { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/1736",
    "let xs: integer[] = []\nif hostValue is integer { xs.add(hostValue) }\nexit\n",
  ],
  [
    "fixture-pasted/1738",
    "let record = {n: 0}\nif hostValue is integer { record.n = hostValue }\nrepeat record.n {}\nexit\n",
  ],
  [
    "fixture-pasted/1739",
    "let record = {n: 0}\nrecord.n = hostValue\nlet value = record.n\nif value is integer { repeat value {} }\nexit\n",
  ],
  ["fixture-pasted/1742", 'let value = 1\nif value > 0 { say "ok" }\nexit\n'],
  [
    "fixture-pasted/1744",
    'let flagHost = askBoolean "flag"\nlet value = null\nif flagHost { value = true }\nif value != null { if value { say "ok" } }\nexit\n',
  ],
  [
    "fixture-pasted/1745",
    'let flagHost = askBoolean "flag"\nlet value = null\nif flagHost { value = true }\nif value otherwise false { say "ok" }\nexit\n',
  ],
  ["fixture-pasted/1750", "let n = null\nlet out: integer? = n\nexit\n"],
  ["fixture-pasted/1753", "let n = null\nlet out: integer? = 0\nout = n\nexit\n"],
  [
    "fixture-pasted/1784",
    'let origin = { pocket: ["tag"] }\nlet archive = { record: origin }\norigin.pocket.add("later")\narchive.record.pocket.add(3)\nexit\nfunction fixType(p: (string | integer)[]) {\n  say p\n}\n',
  ],
  [
    "fixture-pasted/1803",
    "let origin = { count: 1 }\nlet earlier = origin\nfunction arm {\n    timer async 1 ms { origin.count = null }\n    wait 2 ms\n    return 0\n}\nlet shelf = [{ item: origin, step: arm() }, { item: origin, step: 0 }]\nlet value = shelf.last.item.count\nif value != null { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/1804",
    "let origin = { count: 1 }\nlet earlier = origin\nfunction arm {\n    timer async 1 ms { origin.count = null }\n    wait 2 ms\n    return 0\n}\nlet shelf = [{ item: origin, step: arm() }, { item: origin, step: 0 }]\nrepeat shelf.last.item.count otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/1806",
    "let origin = { count: 1 }\nlet earlier = origin\nfunction arm {\n    timer async 1 ms { origin.count = null }\n    wait 2 ms\n    return 0\n}\nlet shelf = [{ item: earlier, step: arm() }, { item: origin, step: 0 }]\nlet value = shelf.last.item.count\nif value != null { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/1807",
    "let origin = { count: 1 }\nlet earlier = origin\nfunction arm {\n    timer async 1 ms { origin.count = null }\n    wait 2 ms\n    return 0\n}\nlet shelf = [{ item: earlier, step: arm() }, { item: origin, step: 0 }]\nrepeat shelf.last.item.count otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/1811",
    'let a = []\na.add(1)\nlet b: (integer | string)[] = a\nb.add("x")\nexit\n',
  ],
  [
    "fixture-pasted/1830",
    "let attempts: integer = hostValue\nlet config = { n: hostValue }\nrepeat attempts { let value = config.n\nif value is number { say value + 1 } }\nexit\n",
  ],
  ["fixture-pasted/1848", 'let xs: (integer | string)[] = [1]\nxs.add("bad")\nexit\n'],
  ["fixture-pasted/1850", 'let xs: (integer | string)[] = [1, 2]\nxs.add("bad")\nexit\n'],
  [
    "fixture-pasted/1874",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1875",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1877",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/1879",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n is not null { if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1880",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n is not null { repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1882",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif not (n is null) { if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1883",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif not (n is null) { repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1885",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n == null { say "nil" } else { if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1886",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n == null { say "nil" } else { repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1888",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n is null { say "nil" } else { if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1889",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n is null { say "nil" } else { repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1891",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif not (n != null) { say "nil" } else { if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1892",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif not (n != null) { say "nil" } else { repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1903",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nwhile n != null { if n != null { repeat n {} }\n break }\nexit\n',
  ],
  [
    "fixture-pasted/1904",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nwhile n != null { repeat n otherwise 0 {}\n break }\nexit\n',
  ],
  [
    "fixture-pasted/1906",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nwhile n != null { n = null }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/1907",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nwhile n != null { n = null }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/1909",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null and (n otherwise 0) > 0 { say "ready" }\nexit\n',
  ],
  [
    "fixture-pasted/1911",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n == null or (n otherwise 0) > 0 { say "ready" }\nexit\n',
  ],
  [
    "fixture-pasted/1913",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n == null { exit }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/1914",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n == null { exit }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/1916",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n == null { goto done }\nif n != null { repeat n {} }\nlabel done\nexit\n',
  ],
  [
    "fixture-pasted/1917",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n == null { goto done }\nrepeat n otherwise 0 {}\nlabel done\nexit\n',
  ],
  [
    "fixture-pasted/1920",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nrepeat 2 { if n == null { break }\n if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1921",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nrepeat 2 { if n == null { break }\n repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1923",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nrepeat 2 { if n == null { continue }\n if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1924",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nrepeat 2 { if n == null { continue }\n repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1930",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nswitch n { case null { say "nil" } default { if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/1931",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nswitch n { case null { say "nil" } default { repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1933",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nswitch n { case null { say "nil" } case 1 { if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/1934",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nswitch n { case null { say "nil" } case 1 { repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1936",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nswitch n { case null { if n != null { repeat n {} } } default { say "ok" } }\nexit\n',
  ],
  [
    "fixture-pasted/1937",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nswitch n { case null { repeat n otherwise 0 {} } default { say "ok" } }\nexit\n',
  ],
  [
    "fixture-pasted/1939",
    'let flagHost = askBoolean "flag"\nlet n: integer | null = 1\nif flagHost { n = null }\nswitch n { case null, 1 { if n != null { repeat n {} } } default { say "other" } }\nexit\n',
  ],
  [
    "fixture-pasted/1940",
    'let flagHost = askBoolean "flag"\nlet n: integer | null = 1\nif flagHost { n = null }\nswitch n { case null, 1 { repeat n otherwise 0 {} } default { say "other" } }\nexit\n',
  ],
  [
    "fixture-pasted/1942",
    'let flagHost = askBoolean "flag"\nlet n: integer | null = 1\nif flagHost { n = null }\nswitch n { case 1..3 { if n != null { repeat n {} } } default { say "other" } }\nexit\n',
  ],
  [
    "fixture-pasted/1943",
    'let flagHost = askBoolean "flag"\nlet n: integer | null = 1\nif flagHost { n = null }\nswitch n { case 1..3 { repeat n otherwise 0 {} } default { say "other" } }\nexit\n',
  ],
  [
    "fixture-pasted/1945",
    'let flagHost = askBoolean "flag"\nlet box = {n: 1}\nif flagHost { box.n = null }\nif box.n != null { let value = box.n\nif value != null { repeat value {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1946",
    'let flagHost = askBoolean "flag"\nlet box = {n: 1}\nif flagHost { box.n = null }\nif box.n != null { repeat box.n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1948",
    'let flagHost = askBoolean "flag"\nlet box = {n: 1}\nif flagHost { box.n = null }\nif box.n != null { if flagHost { box.n = null }\n let value = box.n\nif value != null { repeat value {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1949",
    'let flagHost = askBoolean "flag"\nlet box = {n: 1}\nif flagHost { box.n = null }\nif box.n != null { if flagHost { box.n = null }\n repeat box.n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1951",
    "let xs = [1, null]\nif xs[0] != null { let value = xs[0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/1952",
    "let xs = [1, null]\nif xs[0] != null { repeat xs[0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/1954",
    'let flagHost = askBoolean "flag"\nlet xs = [1, null]\nif xs[0] != null { if flagHost { xs[0] = null }\n let value = xs[0]\nif value != null { repeat value {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1955",
    'let flagHost = askBoolean "flag"\nlet xs = [1, null]\nif xs[0] != null { if flagHost { xs[0] = null }\n repeat xs[0] otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1957",
    "let xs = [1, null]\nlet i = 0\nif xs[i] != null { let value = xs[i]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/1958",
    "let xs = [1, null]\nlet i = 0\nif xs[i] != null { repeat xs[i] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/1960",
    'let flagHost = askBoolean "flag"\nlet xs = [1, null]\nlet i = 0\nif xs[i] != null { if flagHost { i = 1 }\n let value = xs[i]\nif value != null { repeat value {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1961",
    'let flagHost = askBoolean "flag"\nlet xs = [1, null]\nlet i = 0\nif xs[i] != null { if flagHost { i = 1 }\n repeat xs[i] otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1963",
    'let d = dict {"a": 1, "b": null}\nif d["a"] != null { let value = d["a"]\nif value != null { repeat value {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1964",
    'let d = dict {"a": 1, "b": null}\nif d["a"] != null { repeat d["a"] otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1966",
    'let flagHost = askBoolean "flag"\nlet d = dict {"a": 1, "b": null}\nif d["a"] != null { if flagHost { d["a"] = null }\n let value = d["a"]\nif value != null { repeat value {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1967",
    'let flagHost = askBoolean "flag"\nlet d = dict {"a": 1, "b": null}\nif d["a"] != null { if flagHost { d["a"] = null }\n repeat d["a"] otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1969",
    'let d = dict {"a": 1, "b": null}\nlet key = "a"\nif d[key] != null { let value = d[key]\nif value != null { repeat value {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1970",
    'let d = dict {"a": 1, "b": null}\nlet key = "a"\nif d[key] != null { repeat d[key] otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1972",
    'let flagHost = askBoolean "flag"\nlet d = dict {"a": 1, "b": null}\nlet key = "a"\nif d[key] != null { if flagHost { key = "b" }\n let value = d[key]\nif value != null { repeat value {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1973",
    'let flagHost = askBoolean "flag"\nlet d = dict {"a": 1, "b": null}\nlet key = "a"\nif d[key] != null { if flagHost { key = "b" }\n repeat d[key] otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1975",
    'let flagHost = askBoolean "flag"\nlet box = {n: 1}\nif flagHost { box.n = null }\nif box.n != null { if flagHost { box = {n: null} }\n let value = box.n\nif value != null { repeat value {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1976",
    'let flagHost = askBoolean "flag"\nlet box = {n: 1}\nif flagHost { box.n = null }\nif box.n != null { if flagHost { box = {n: null} }\n repeat box.n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1978",
    "let xs = [1, null]\nlet i = 0\nif xs[i + 1] != null { let value = xs[i + 1]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/1979",
    "let xs = [1, null]\nlet i = 0\nif xs[i + 1] != null { repeat xs[i + 1] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/1981",
    "let xs = [1, null]\nlet i = 0\nif xs.random != null { let value = xs.random\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/1982",
    "let xs = [1, null]\nlet i = 0\nif xs.random != null { repeat xs.random otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/1984",
    'let flagHost = askBoolean "flag"\nfunction read { if flagHost { return null }\n return 2 }\nif read() != null { let value = read()\nif value != null { repeat value {} } }\nexit\n',
  ],
  [
    "fixture-pasted/1985",
    'let flagHost = askBoolean "flag"\nfunction read { if flagHost { return null }\n return 2 }\nif read() != null { repeat read() otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/1987",
    "if player.rounds != null { let value = player.rounds\nif value is integer { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/1990",
    "let rows = [[1], [null]]\nif rows[0] is integer[] { let value = rows[0][0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/1991",
    "let rows = [[1], [null]]\nif rows[0] is integer[] { repeat rows[0][0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/1993",
    "let xs = []\nif xs is integer[] { if xs.length > 0 { say xs.first } }\nexit\n",
  ],
  [
    "fixture-pasted/1996",
    "let xs = [1, null]\nif xs[0] != null { if xs[1] != null { let value = xs[0]\nif value != null { repeat value {} }\n repeat xs[1] {} } }\nexit\n",
  ],
  [
    "fixture-pasted/1997",
    "let xs = [1, null]\nif xs[0] != null { if xs[1] != null { repeat xs[0] otherwise 0 {}\n repeat xs[1] {} } }\nexit\n",
  ],
  [
    "fixture-pasted/1998",
    "let xs = [1, null]\nif xs[0] != null { if xs[1] != null { repeat xs[0] {}\n let value = xs[1]\nif value != null { repeat value {} } } }\nexit\n",
  ],
  [
    "fixture-pasted/1999",
    "let xs = [1, null]\nif xs[0] != null { if xs[1] != null { repeat xs[0] {}\n repeat xs[1] otherwise 0 {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2001",
    "let xs = [1, null]\nif xs[0] != null { xs.add(2)\n let value = xs[0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2002",
    "let xs = [1, null]\nif xs[0] != null { xs.add(2)\n repeat xs[0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2004",
    "let xs = [1, null]\nif xs[0] != null { xs.addAll([2])\n let value = xs[0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2005",
    "let xs = [1, null]\nif xs[0] != null { xs.addAll([2])\n repeat xs[0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2008",
    "let xs = [1, null]\nif xs[0] != null { xs.removeFirst()\n let value = xs[0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2009",
    "let xs = [1, null]\nif xs[0] != null { xs.removeFirst()\n repeat xs[0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2011",
    "let xs = [1, null]\nif xs[0] != null { xs.removeLast()\n let value = xs[0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2012",
    "let xs = [1, null]\nif xs[0] != null { xs.removeLast()\n repeat xs[0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2014",
    "let xs = [1, null]\nif xs[0] != null { xs.reverse()\n let value = xs[0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2015",
    "let xs = [1, null]\nif xs[0] != null { xs.reverse()\n repeat xs[0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2017",
    "let xs = [1, null]\nif xs[0] != null { xs.sort()\n let value = xs[0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2018",
    "let xs = [1, null]\nif xs[0] != null { xs.sort()\n repeat xs[0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2020",
    "let xs = [1, null]\nif xs[0] != null { xs.shuffle()\n let value = xs[0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2021",
    "let xs = [1, null]\nif xs[0] != null { xs.shuffle()\n repeat xs[0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2023",
    "let xs = [1, null]\nfunction flip { xs.reverse() }\nif xs[0] != null { flip()\n let value = xs[0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2024",
    "let xs = [1, null]\nfunction flip { xs.reverse() }\nif xs[0] != null { flip()\n repeat xs[0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2026",
    "let xs = [1, null]\nfunction flip { xs.reverse() }\nfunction relay { flip() }\nif xs[0] != null { relay()\n let value = xs[0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2027",
    "let xs = [1, null]\nfunction flip { xs.reverse() }\nfunction relay { flip() }\nif xs[0] != null { relay()\n repeat xs[0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2029",
    "let xs = [1, null]\ntimer async 1 s { xs.reverse() }\nif xs[0] != null { let value = xs[0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2030",
    "let xs = [1, null]\ntimer async 1 s { xs.reverse() }\nif xs[0] != null { repeat xs[0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2032",
    "let xs = [1, null]\ntimer async 1 s { xs.reverse() }\nif xs[0] != null { wait 1 s\n let value = xs[0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2033",
    "let xs = [1, null]\ntimer async 1 s { xs.reverse() }\nif xs[0] != null { wait 1 s\n repeat xs[0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2036",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { if flagHost { n = null }\n if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2037",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { if flagHost { n = null }\n repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2039",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { if n != null { repeat n {} }\n n = n + 1 } }\nexit\n',
  ],
  [
    "fixture-pasted/2040",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { repeat n otherwise 0 {}\n n = n + 1 } }\nexit\n',
  ],
  [
    "fixture-pasted/2042",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { if n != null { repeat n {} }\n n = null } }\nexit\n',
  ],
  [
    "fixture-pasted/2043",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { repeat n otherwise 0 {}\n n = null } }\nexit\n',
  ],
  [
    "fixture-pasted/2045",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { if flagHost { n = n + 1\n continue }\n if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2046",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { if flagHost { n = n + 1\n continue }\n repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2048",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { if flagHost { n = null\n continue }\n if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2049",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { if flagHost { n = null\n continue }\n repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2052",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { repeat 2 { n = null }\n if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2053",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { repeat 2 { n = null }\n repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2055",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { if n != null { repeat n {} }\n n = n + 1\n break } }\nexit\n',
  ],
  [
    "fixture-pasted/2056",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { repeat n otherwise 0 {}\n n = n + 1\n break } }\nexit\n',
  ],
  [
    "fixture-pasted/2058",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { if n != null { repeat n {} }\n n = null\n break } }\nexit\n',
  ],
  [
    "fixture-pasted/2059",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { repeat n otherwise 0 {}\n n = null\n break } }\nexit\n',
  ],
  [
    "fixture-pasted/2061",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { n = null\n if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2062",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { n = null\n repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2064",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2065",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2067",
    "let n: number | string = 2\nif n is integer { repeat 2 { repeat n {}\n if n is number { n = n / 2 } } }\nexit\n",
  ],
  [
    "fixture-pasted/2069",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { save null as "n"\n if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2070",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { save null as "n"\n repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2072",
    "let xs = [1, null]\nlet i = 0\nlet item = xs[i + 1]\nif item != null { xs.clear()\n i = 1\n if item != null { repeat item {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2073",
    "let xs = [1, null]\nlet i = 0\nlet item = xs[i + 1]\nif item != null { xs.clear()\n i = 1\n repeat item otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2075",
    "let xs = [1, null]\nlet i = 0\nif xs[i + 1] != null { xs.reverse()\n i = 1\n let value = xs[i + 1]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2076",
    "let xs = [1, null]\nlet i = 0\nif xs[i + 1] != null { xs.reverse()\n i = 1\n repeat xs[i + 1] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2078",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nfunction use { if n != null { repeat n {} } }\nif n != null { use() }\nexit\n',
  ],
  [
    "fixture-pasted/2079",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nfunction use { repeat n otherwise 0 {} }\nif n != null { use() }\nexit\n',
  ],
  [
    "fixture-pasted/2081",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { timer async 1 s { if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2082",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { timer async 1 s { repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2084",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { showPermanentButton "Go" { if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2085",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { showPermanentButton "Go" { repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2087",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { playVideo async "clip.mp4" { if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2088",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { playVideo async "clip.mp4" { repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2091",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n == null { n = 1 }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2092",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n == null { n = 1 }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2094",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif not ((n otherwise 0) > 3) { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2095",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif not (n > 3) { if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2096",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif not (n > 3) { repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2099",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\ntimer async 1 s { n = null }\nif n != null { if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2100",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\ntimer async 1 s { n = null }\nif n != null { repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2102",
    'let n = 1\nif askBoolean "Reset?" {\n    n = null\n    n = 2\n}\nif n != null { say n + 1 }\nexit\n',
  ],
  [
    "fixture-pasted/2103",
    'let n = 1\nif askBoolean "Reset?" {\n    n = null\n    n = 2\n}\nsay (n otherwise 0) + 1\nexit\n',
  ],
  [
    "fixture-pasted/2105",
    "let xs = [7, null]\nif xs[0] != null {\n    xs.reverse()\n    let value = xs[0]\nif value != null { say value + 1 }\n}\nexit\n",
  ],
  [
    "fixture-pasted/2106",
    "let xs = [7, null]\nif xs[0] != null {\n    xs.reverse()\n    say (xs[0] otherwise 0) + 1\n}\nexit\n",
  ],
  [
    "fixture-pasted/2108",
    "let xs = [8, null]\nlet i = 0\nif xs[i] != null {\n    repeat 2 {\n        let value = xs[i]\nif value != null { say value + 1 }\n        i = i + 1\n    }\n}\nexit\n",
  ],
  [
    "fixture-pasted/2109",
    "let xs = [8, null]\nlet i = 0\nif xs[i] != null {\n    repeat 2 {\n        say (xs[i] otherwise 0) + 1\n        i = i + 1\n    }\n}\nexit\n",
  ],
  [
    "fixture-pasted/2113",
    "let xs = [1, null]\nif xs[0] != null {\n    if xs[1] == null {\n        let value = xs[0]\nif value != null { say value + 1 }\n    }\n}\nexit\n",
  ],
  [
    "fixture-pasted/2114",
    "let xs = [1, null]\nif xs[0] != null {\n    if xs[1] == null {\n        say (xs[0] otherwise 0) + 1\n    }\n}\nexit\n",
  ],
  [
    "fixture-pasted/2116",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null {\n    while askBoolean "Again?" {\n        if askBoolean "Increment?" { n = n + 1 }\n        if n != null { say n + 1 }\n    }\n}\nexit\n',
  ],
  [
    "fixture-pasted/2117",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null {\n    while askBoolean "Again?" {\n        if askBoolean "Increment?" { n = n + 1 }\n        say (n otherwise 0) + 1\n    }\n}\nexit\n',
  ],
  [
    "fixture-pasted/2119",
    'let clear = askBoolean "Clear?"\nlet n = 1\nif clear { n = null } else { if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2120",
    'let clear = askBoolean "Clear?"\nlet n = 1\nif clear { n = null } else { repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2122",
    'let n = 1\nif askBoolean "Reset?" { n = null\n n = 1 }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2123",
    'let n = 1\nif askBoolean "Reset?" { n = null\n n = 1 }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2125",
    "let xs = [null, 1]\nif xs[1] != null {\n    xs.reverse()\n    let value = xs[1]\nif value != null { repeat value {} }\n}\nexit\n",
  ],
  [
    "fixture-pasted/2126",
    "let xs = [null, 1]\nif xs[1] != null {\n    xs.reverse()\n    repeat xs[1] otherwise 0 {}\n}\nexit\n",
  ],
  [
    "fixture-pasted/2128",
    "let xs = [1, null]\nlet i = 0\nif xs[i] != null {\n    repeat 2 {\n        let value = xs[i]\nif value != null { repeat value {} }\n        i += 1\n    }\n}\nexit\n",
  ],
  [
    "fixture-pasted/2129",
    "let xs = [1, null]\nlet i = 0\nif xs[i] != null {\n    repeat 2 {\n        repeat xs[i] otherwise 0 {}\n        i += 1\n    }\n}\nexit\n",
  ],
  [
    "fixture-pasted/2131",
    'let v: integer? = load("rounds", default: 1)\nif v != null {\n    repeat 2 {\n        if askBoolean "Advance?" { v += 1 }\n        if v != null { repeat v {} }\n    }\n}\nexit\n',
  ],
  [
    "fixture-pasted/2132",
    'let v: integer? = load("rounds", default: 1)\nif v != null {\n    repeat 2 {\n        if askBoolean "Advance?" { v += 1 }\n        repeat v otherwise 0 {}\n    }\n}\nexit\n',
  ],
  [
    "fixture-pasted/2134",
    'let enabled = askBoolean "Enabled?"\nlet reset = askBoolean "Reset?"\nlet n = 1\nif enabled {\n    if reset { n = null }\n    n = 2\n}\nif n != null { say n + 1 }\nexit\n',
  ],
  [
    "fixture-pasted/2135",
    'let enabled = askBoolean "Enabled?"\nlet reset = askBoolean "Reset?"\nlet n = 1\nif enabled {\n    if reset { n = null }\n    n = 2\n}\nsay (n otherwise 0) + 1\nexit\n',
  ],
  [
    "fixture-pasted/2137",
    "let rows: integer?[][] = [[1], [null]]\nif rows[0] is integer[] {\n    let value = rows[0][0]\nif value != null { repeat value {} }   // checked collection\n    repeat rows[1][0] {}   // different collection; actually null\n}\nexit\n",
  ],
  [
    "fixture-pasted/2138",
    "let rows: integer?[][] = [[1], [null]]\nif rows[0] is integer[] {\n    repeat rows[0][0] otherwise 0 {}   // checked collection\n    repeat rows[1][0] {}   // different collection; actually null\n}\nexit\n",
  ],
  [
    "fixture-pasted/2139",
    "let rows: integer?[][] = [[1], [null]]\nif rows[0] is integer[] {\n    repeat rows[0][0] {}   // checked collection\n    let value = rows[1][0]\nif value != null { repeat value {} }   // different collection; actually null\n}\nexit\n",
  ],
  [
    "fixture-pasted/2140",
    "let rows: integer?[][] = [[1], [null]]\nif rows[0] is integer[] {\n    repeat rows[0][0] {}   // checked collection\n    repeat rows[1][0] otherwise 0 {}   // different collection; actually null\n}\nexit\n",
  ],
  [
    "fixture-pasted/2142",
    "let xs = [null, 1]\nfunction flip { xs.reverse() }\nflip()\nif xs[0] != null {\n    flip()\n    let value = xs[0]\nif value != null { say value + 1 }\n}\nexit\n",
  ],
  [
    "fixture-pasted/2143",
    "let xs = [null, 1]\nfunction flip { xs.reverse() }\nflip()\nif xs[0] != null {\n    flip()\n    say (xs[0] otherwise 0) + 1\n}\nexit\n",
  ],
  [
    "fixture-pasted/2145",
    "let xs = [1, null]\ntimer(duration: 1 s, async: true) { xs.reverse() }\nif xs[0] != null {\n    wait 2 s\n    let value = xs[0]\nif value != null { say value + 1 }\n}\nexit\n",
  ],
  [
    "fixture-pasted/2146",
    "let xs = [1, null]\ntimer(duration: 1 s, async: true) { xs.reverse() }\nif xs[0] != null {\n    wait 2 s\n    say (xs[0] otherwise 0) + 1\n}\nexit\n",
  ],
  [
    "fixture-pasted/2149",
    "let xs = [1]\nif xs != null {\n    repeat 2 {\n        if xs.length > 0 { say xs.first }\n        xs = []\n    }\n}\nexit\n",
  ],
  [
    "fixture-pasted/2151",
    'let clear = askBoolean "Clear?"\nlet repair = askBoolean "Repair?"\nlet n = 1\nif clear {\n    n = null\n    if repair { n = 2 } else { n = 3 }\n}\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2152",
    'let clear = askBoolean "Clear?"\nlet repair = askBoolean "Repair?"\nlet n = 1\nif clear {\n    n = null\n    if repair { n = 2 } else { n = 3 }\n}\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2154",
    'let clear = askBoolean "Clear?"\nlet box = { n: 1 }\nif clear {\n    box.n = null\n    box = { n: 2 }\n}\nlet value = box.n\nif value != null { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/2155",
    'let clear = askBoolean "Clear?"\nlet box = { n: 1 }\nif clear {\n    box.n = null\n    box = { n: 2 }\n}\nrepeat box.n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2157",
    "let xs = [1, null]\nfunction flip { xs.reverse() }\nif xs[0] != null {\n    flip()\n    let value = xs[0]\nif value != null { repeat value {} }\n}\nexit\n",
  ],
  [
    "fixture-pasted/2158",
    "let xs = [1, null]\nfunction flip { xs.reverse() }\nif xs[0] != null {\n    flip()\n    repeat xs[0] otherwise 0 {}\n}\nexit\n",
  ],
  [
    "fixture-pasted/2160",
    "let xs = [1, null]\ntimer(duration: 1 s, async: true) { xs.reverse() }\nif xs[0] != null {\n    wait 2 s\n    let value = xs[0]\nif value != null { repeat value {} }\n}\nexit\n",
  ],
  [
    "fixture-pasted/2161",
    "let xs = [1, null]\ntimer(duration: 1 s, async: true) { xs.reverse() }\nif xs[0] != null {\n    wait 2 s\n    repeat xs[0] otherwise 0 {}\n}\nexit\n",
  ],
  [
    "fixture-pasted/2163",
    "let rows = [[1], [null]]\nif rows[0] is integer[] {\n    let value = rows[1][0]\nif value != null { repeat value {} }\n}\nexit\n",
  ],
  [
    "fixture-pasted/2164",
    "let rows = [[1], [null]]\nif rows[0] is integer[] {\n    repeat rows[1][0] otherwise 0 {}\n}\nexit\n",
  ],
  [
    "fixture-pasted/2166",
    'let clear = askBoolean "Clear?"\nlet use = askBoolean "Use?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nif clear { n = null }\nif use {\n    if pickFlag { n = 2 } else { n = 3 }\n    if n != null { say n + 1 }\n}\nexit\n',
  ],
  [
    "fixture-pasted/2167",
    'let clear = askBoolean "Clear?"\nlet use = askBoolean "Use?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nif clear { n = null }\nif use {\n    if pickFlag { n = 2 } else { n = 3 }\n    say (n otherwise 0) + 1\n}\nexit\n',
  ],
  [
    "fixture-pasted/2170",
    'let clear = askBoolean "Clear?"\nlet enter = askBoolean "Enter?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nif clear { n = null }\nif enter {\n    if pickFlag { n = 2 } else { n = 3 }\n    if n != null { repeat n {} }\n}\nexit\n',
  ],
  [
    "fixture-pasted/2171",
    'let clear = askBoolean "Clear?"\nlet enter = askBoolean "Enter?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nif clear { n = null }\nif enter {\n    if pickFlag { n = 2 } else { n = 3 }\n    repeat n otherwise 0 {}\n}\nexit\n',
  ],
  [
    "fixture-pasted/2173",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2 }\nif clear { n = null }\nrestore()\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2174",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2 }\nif clear { n = null }\nrestore()\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2176",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2 }\nif clear {\n    n = null\n    restore()\n}\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2177",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2 }\nif clear {\n    n = null\n    restore()\n}\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2179",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null }\nif pickFlag {\n    n = 2\n} else {\n    restore()\n}\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2180",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null }\nif pickFlag {\n    n = 2\n} else {\n    restore()\n}\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2182",
    'let clear = askBoolean "Clear?"\nlet fork = askBoolean "Which way?"\nlet n = 1\nfunction restore { n = 2 }\nif clear { n = null }\nif fork { restore() } else { restore() }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2183",
    'let clear = askBoolean "Clear?"\nlet fork = askBoolean "Which way?"\nlet n = 1\nfunction restore { n = 2 }\nif clear { n = null }\nif fork { restore() } else { restore() }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2185",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction ready {\n    n = 2\n    return true\n}\nif clear { n = null }\nif ready() {\n    if n != null { repeat n {} }\n}\nexit\n',
  ],
  [
    "fixture-pasted/2186",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction ready {\n    n = 2\n    return true\n}\nif clear { n = null }\nif ready() {\n    repeat n otherwise 0 {}\n}\nexit\n',
  ],
  [
    "fixture-pasted/2188",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2 }\nif clear { n = null }\nwhile true {\n    restore()\n    break\n}\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2189",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2 }\nif clear { n = null }\nwhile true {\n    restore()\n    break\n}\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2191",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore {\n    n = 2\n    return true\n}\nif clear { n = null }\nif restore() {\n    if n != null { repeat n {} }\n}\nexit\n',
  ],
  [
    "fixture-pasted/2192",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore {\n    n = 2\n    return true\n}\nif clear { n = null }\nif restore() {\n    repeat n otherwise 0 {}\n}\nexit\n',
  ],
  [
    "fixture-pasted/2194",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore {\n    n = 2\n    return 0\n}\nif clear { n = null }\nsay restore() + (n otherwise 0)\nexit\n',
  ],
  [
    "fixture-pasted/2196",
    'let b = askBoolean "Clear?"\n let n = 1\n if b { n = null }\n if not b { if n != null { say n + 1 } }\nexit\n',
  ],
  [
    "fixture-pasted/2197",
    'let b = askBoolean "Clear?"\n let n = 1\n if b { n = null }\n if not b { say (n otherwise 0) + 1 }\nexit\n',
  ],
  [
    "fixture-pasted/2199",
    'let c = askBoolean "Clear?"\n let n = 1\n if c { n = null }\n if not c { if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2200",
    'let c = askBoolean "Clear?"\n let n = 1\n if c { n = null }\n if not c { repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2202",
    "let xs = [1, 2]\n xs[1] = null\n let value = xs[0]\nif value != null { say value + 1 }\nexit\n",
  ],
  ["fixture-pasted/2203", "let xs = [1, 2]\n xs[1] = null\n say (xs[0] otherwise 0) + 1\nexit\n"],
  [
    "fixture-pasted/2205",
    "let xs = [1, 2]\n xs[1] = null\n let i = 0\n if xs[i + 1] != null { let value = xs[i + 1]\nif value != null { say value + 1 } }\nexit\n",
  ],
  [
    "fixture-pasted/2206",
    "let xs = [1, 2]\n xs[1] = null\n let i = 0\n if xs[i + 1] != null { say (xs[i + 1] otherwise 0) + 1 }\nexit\n",
  ],
  [
    "fixture-pasted/2208",
    "let xs = [null, 1]\n let i = 0\n if xs[i + 1] != null { let value = xs[i + 1]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2209",
    "let xs = [null, 1]\n let i = 0\n if xs[i + 1] != null { repeat xs[i + 1] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2211",
    "let xs = [null, 1]\nlet i = 0\nif xs[i + 1] != null { let saved = xs[i + 1]\n if saved != null { repeat saved {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2212",
    "let xs = [null, 1]\nlet i = 0\nif xs[i + 1] != null { let saved = xs[i + 1]\n repeat saved otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2214",
    "let xs = [null, 1]\nlet i = 0\nfunction chosen { if xs[i + 1] != null { return xs[i + 1] }\n return 1 }\nlet value = chosen()\nif value != null { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/2215",
    "let xs = [null, 1]\nlet i = 0\nfunction chosen { if xs[i + 1] != null { return xs[i + 1] }\n return 1 }\nrepeat chosen() otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2226",
    "let xs = [1, null]\nif xs.first != null { xs.reverse()\n let value = xs.first\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2227",
    "let xs = [1, null]\nif xs.first != null { xs.reverse()\n repeat xs.first otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2229",
    "let xs = [null, 1]\nif xs.last != null { xs.reverse()\n let value = xs.last\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2230",
    "let xs = [null, 1]\nif xs.last != null { xs.reverse()\n repeat xs.last otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2232",
    "let groups = [[1, null]]\nif groups[0][0] != null { groups[0].reverse()\n let value = groups[0][0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2233",
    "let groups = [[1, null]]\nif groups[0][0] != null { groups[0].reverse()\n repeat groups[0][0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2235",
    "let xs = [1, null]\nif xs[0] != null { say xs.length\n let value = xs[0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2236",
    "let xs = [1, null]\nif xs[0] != null { say xs.length\n repeat xs[0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2238",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nfunction clear { n = null\n return true }\nif n != null and clear() { if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2239",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nfunction clear { n = null\n return true }\nif n != null and clear() { repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2241",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { n = null\n if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2242",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { n = null\n repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2244",
    'let n = 1\nif askBoolean "Enabled?" { n = null\n if askBoolean "Reset?" { n = 2 } else { n = 3 } }\nif n != null { say n + 1 }\nexit\n',
  ],
  [
    "fixture-pasted/2245",
    'let n = 1\nif askBoolean "Enabled?" { n = null\n if askBoolean "Reset?" { n = 2 } else { n = 3 } }\nsay (n otherwise 0) + 1\nexit\n',
  ],
  [
    "fixture-pasted/2247",
    "let rows = [[1], [null]]\nlet i = 0\nlet j = 0\nif rows[i] is integer[] { let value = rows[i][j]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2248",
    "let rows = [[1], [null]]\nlet i = 0\nlet j = 0\nif rows[i] is integer[] { repeat rows[i][j] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2250",
    "let rows = [[1], [null]]\nlet i = 0\nif rows[i] is integer[] { i = 1\n let value = rows[i][0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2251",
    "let rows = [[1], [null]]\nlet i = 0\nif rows[i] is integer[] { i = 1\n repeat rows[i][0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2253",
    "let rooms = [{items: [1]}, {items: [null]}]\nlet i = 0\nlet j = 1\nif rooms[i].items is integer[] { let value = rooms[j].items[0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2254",
    "let rooms = [{items: [1]}, {items: [null]}]\nlet i = 0\nlet j = 1\nif rooms[i].items is integer[] { repeat rooms[j].items[0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2257",
    "let rows = [[1], [null]]\nif rows is integer?[][] { let value = rows[0][0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2258",
    "let rows = [[1], [null]]\nif rows is integer?[][] { repeat rows[0][0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2260",
    "let xs = [1, null]\nlet i = 0\nif xs[i] != null { repeat 2 { xs[i] = xs[i] + 1\n let value = xs[i]\nif value != null { repeat value {} } } }\nexit\n",
  ],
  [
    "fixture-pasted/2261",
    "let xs = [1, null]\nlet i = 0\nif xs[i] != null { repeat 2 { xs[i] = xs[i] + 1\n repeat xs[i] otherwise 0 {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2263",
    "let xs = [1, null]\nlet i = 0\nif xs[i] != null { repeat 2 { xs[i] += 1\n let value = xs[i]\nif value != null { repeat value {} } } }\nexit\n",
  ],
  [
    "fixture-pasted/2264",
    "let xs = [1, null]\nlet i = 0\nif xs[i] != null { repeat 2 { xs[i] += 1\n repeat xs[i] otherwise 0 {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2266",
    "let xs = [1, null]\nif xs[0] != null { repeat 2 { xs[0] = xs[1]\n let value = xs[0]\nif value != null { repeat value {} } } }\nexit\n",
  ],
  [
    "fixture-pasted/2267",
    "let xs = [1, null]\nif xs[0] != null { repeat 2 { xs[0] = xs[1]\n repeat xs[0] otherwise 0 {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2269",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nfunction next { n = null\n return 1 }\nif n != null { repeat 2 { if n != null { repeat n {} }\n n = next() } }\nexit\n',
  ],
  [
    "fixture-pasted/2270",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nfunction next { n = null\n return 1 }\nif n != null { repeat 2 { repeat n otherwise 0 {}\n n = next() } }\nexit\n',
  ],
  [
    "fixture-pasted/2273",
    'let v = 8 / 4\nif askBoolean "Clear?" { v = null }\nif v != null { repeat 2 { if v != null { say v + 1 }\n v = v / 2 } }\nexit\n',
  ],
  [
    "fixture-pasted/2274",
    'let v = 8 / 4\nif askBoolean "Clear?" { v = null }\nif v != null { repeat 2 { say (v otherwise 0) + 1\n v = v / 2 } }\nexit\n',
  ],
  [
    "fixture-pasted/2276",
    'let box = {n: 1}\nif askBoolean "Clear?" { box.n = null }\nif askBoolean "Enter?" { if askBoolean "Choose?" { box = {n: 2} } else { box.n = 3 }\n let value = box.n\nif value != null { say value + 1 } }\nexit\n',
  ],
  [
    "fixture-pasted/2277",
    'let box = {n: 1}\nif askBoolean "Clear?" { box.n = null }\nif askBoolean "Enter?" { if askBoolean "Choose?" { box = {n: 2} } else { box.n = 3 }\n say (box.n otherwise 0) + 1 }\nexit\n',
  ],
  [
    "fixture-pasted/2279",
    'let box = {n: 1}\nif askBoolean "Outer?" { if askBoolean "Inner?" { box.n = null }\n if askBoolean "Choose?" { box = {n: 2} } else { box.n = 3 } }\nlet value = box.n\nif value != null { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/2280",
    'let box = {n: 1}\nif askBoolean "Outer?" { if askBoolean "Inner?" { box.n = null }\n if askBoolean "Choose?" { box = {n: 2} } else { box.n = 3 } }\nrepeat box.n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2283",
    'let clear = askBoolean "Clear?"\nlet box = {a: 1, b: 1}\n if clear { box = {a: null, b: null}\n box.a = 2 }\n let value = box.a\nif value != null { repeat value {} }\n repeat box.b {}\nexit\n',
  ],
  [
    "fixture-pasted/2284",
    'let clear = askBoolean "Clear?"\nlet box = {a: 1, b: 1}\n if clear { box = {a: null, b: null}\n box.a = 2 }\n repeat box.a otherwise 0 {}\n repeat box.b {}\nexit\n',
  ],
  [
    "fixture-pasted/2285",
    'let clear = askBoolean "Clear?"\nlet box = {a: 1, b: 1}\n if clear { box = {a: null, b: null}\n box.a = 2 }\n repeat box.a {}\n let value = box.b\nif value != null { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/2286",
    'let clear = askBoolean "Clear?"\nlet box = {a: 1, b: 1}\n if clear { box = {a: null, b: null}\n box.a = 2 }\n repeat box.a {}\n repeat box.b otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2290",
    "let xs = [1, null]\nfunction flip { xs.reverse() }\nfunction helper { flip() }\nif xs[0] != null { helper()\n let value = xs[0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2291",
    "let xs = [1, null]\nfunction flip { xs.reverse() }\nfunction helper { flip() }\nif xs[0] != null { helper()\n repeat xs[0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2293",
    "let groups = [[1, null]]\nfunction flip { groups[0].reverse() }\nfunction helper { flip() }\ntimer(duration: 1 s, async: true) { helper() }\nif groups[0][0] != null { let value = groups[0][0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2294",
    "let groups = [[1, null]]\nfunction flip { groups[0].reverse() }\nfunction helper { flip() }\ntimer(duration: 1 s, async: true) { helper() }\nif groups[0][0] != null { repeat groups[0][0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2296",
    'let groups = [[1, null]]\nfunction flip { groups[0].reverse() }\nfunction helper { flip() }\ntimer(duration: 1 s, async: true) { helper() }\nif groups[0][0] != null { say "Continue"\n let value = groups[0][0]\nif value != null { repeat value {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2297",
    'let groups = [[1, null]]\nfunction flip { groups[0].reverse() }\nfunction helper { flip() }\ntimer(duration: 1 s, async: true) { helper() }\nif groups[0][0] != null { say "Continue"\n repeat groups[0][0] otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2299",
    "let groups = [[1, null]]\nfunction flip { groups[0].reverse() }\nfunction helper { flip() }\ntimer(duration: 1 s, async: true) { helper() }\nif groups[0][0] != null { wait 2 s\n let value = groups[0][0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2300",
    "let groups = [[1, null]]\nfunction flip { groups[0].reverse() }\nfunction helper { flip() }\ntimer(duration: 1 s, async: true) { helper() }\nif groups[0][0] != null { wait 2 s\n repeat groups[0][0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2302",
    'let groups = [[1, null]]\nfunction flip { groups[0].reverse() }\nfunction helper { flip() }\ntimer(duration: 1 s, async: true) { helper() }\nif groups[0][0] != null { let answered = askBoolean "Continue?"\n let value = groups[0][0]\nif value != null { repeat value {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2303",
    'let groups = [[1, null]]\nfunction flip { groups[0].reverse() }\nfunction helper { flip() }\ntimer(duration: 1 s, async: true) { helper() }\nif groups[0][0] != null { let answered = askBoolean "Continue?"\n repeat groups[0][0] otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2305",
    'let groups = [[1, null]]\nfunction flip { groups[0].reverse() }\nfunction helper { flip() }\ntimer(duration: 1 s, async: true) { helper() }\nif groups[0][0] != null { save 1 as "note"\n let value = groups[0][0]\nif value != null { repeat value {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2306",
    'let groups = [[1, null]]\nfunction flip { groups[0].reverse() }\nfunction helper { flip() }\ntimer(duration: 1 s, async: true) { helper() }\nif groups[0][0] != null { save 1 as "note"\n repeat groups[0][0] otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2308",
    "let groups = [[1, null]]\nfunction flip { groups[0].reverse() }\nfunction helper { flip() }\ntimer(duration: 1 s, async: true) { helper() }\nif groups[0][0] != null { timer(duration: 2 s, async: true) {}\n let value = groups[0][0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2309",
    "let groups = [[1, null]]\nfunction flip { groups[0].reverse() }\nfunction helper { flip() }\ntimer(duration: 1 s, async: true) { helper() }\nif groups[0][0] != null { timer(duration: 2 s, async: true) {}\n repeat groups[0][0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2311",
    "let box = {n: 1}\nif box != null { repeat 2 { let value = box.n\nif value != null { say value + 1 }\n box = {n: null} } }\nexit\n",
  ],
  [
    "fixture-pasted/2312",
    "let box = {n: 1}\nif box != null { repeat 2 { say (box.n otherwise 0) + 1\n box = {n: null} } }\nexit\n",
  ],
  [
    "fixture-pasted/2315",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { repeat 2 { if n != null { repeat n {} }\n n = n + 1 } }\nexit\n',
  ],
  [
    "fixture-pasted/2316",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { repeat 2 { repeat n otherwise 0 {}\n n = n + 1 } }\nexit\n',
  ],
  [
    "fixture-pasted/2318",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { repeat 2 { if askBoolean "Advance?" { n = n + 1\n continue }\n if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2319",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { repeat 2 { if askBoolean "Advance?" { n = n + 1\n continue }\n repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2323",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { repeat 2 { n = null\n if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2324",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { repeat 2 { n = null\n repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2326",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { repeat 2 { if n != null { repeat n {} }\n n = null } }\nexit\n',
  ],
  [
    "fixture-pasted/2327",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { repeat 2 { repeat n otherwise 0 {}\n n = null } }\nexit\n',
  ],
  [
    "fixture-pasted/2329",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { repeat 2 { if askBoolean "Advance?" { n = null\n continue }\n if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2330",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { repeat 2 { if askBoolean "Advance?" { n = null\n continue }\n repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2332",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { repeat 2 { repeat 2 { if n != null { repeat n {} }\n n = null } } }\nexit\n',
  ],
  [
    "fixture-pasted/2333",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { repeat 2 { repeat 2 { repeat n otherwise 0 {}\n n = null } } }\nexit\n',
  ],
  [
    "fixture-pasted/2335",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { repeat 2 { if askBoolean "Leave?" { n = null\n break }\n if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2336",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { repeat 2 { if askBoolean "Leave?" { n = null\n break }\n repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2338",
    "let xs = [1, null]\nlet i0 = 0\nif xs[i0] != null { repeat 2 { xs[i0] = 1\n let value = xs[i0]\nif value != null { repeat value {} } } }\nexit\n",
  ],
  [
    "fixture-pasted/2339",
    "let xs = [1, null]\nlet i0 = 0\nif xs[i0] != null { repeat 2 { xs[i0] = 1\n repeat xs[i0] otherwise 0 {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2341",
    "let xs = [1, 1, null]\nlet i0 = 0\n let i1 = 1\nif xs[i0] != null { if xs[i1] != null { repeat 2 { xs[i0] = 1\n xs[i1] = 1\n let value = xs[i0]\nif value != null { repeat value {} }\n repeat xs[i1] {} } } }\nexit\n",
  ],
  [
    "fixture-pasted/2342",
    "let xs = [1, 1, null]\nlet i0 = 0\n let i1 = 1\nif xs[i0] != null { if xs[i1] != null { repeat 2 { xs[i0] = 1\n xs[i1] = 1\n repeat xs[i0] otherwise 0 {}\n repeat xs[i1] {} } } }\nexit\n",
  ],
  [
    "fixture-pasted/2343",
    "let xs = [1, 1, null]\nlet i0 = 0\n let i1 = 1\nif xs[i0] != null { if xs[i1] != null { repeat 2 { xs[i0] = 1\n xs[i1] = 1\n repeat xs[i0] {}\n let value = xs[i1]\nif value != null { repeat value {} } } } }\nexit\n",
  ],
  [
    "fixture-pasted/2344",
    "let xs = [1, 1, null]\nlet i0 = 0\n let i1 = 1\nif xs[i0] != null { if xs[i1] != null { repeat 2 { xs[i0] = 1\n xs[i1] = 1\n repeat xs[i0] {}\n repeat xs[i1] otherwise 0 {} } } }\nexit\n",
  ],
  [
    "fixture-pasted/2347",
    'let n = 1\nif askBoolean "Again?" { n = null\n if n == null { n = 2 } }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2348",
    'let n = 1\nif askBoolean "Again?" { n = null\n if n == null { n = 2 } }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2350",
    'let box = {n: 1}\nfunction restore { box = {n: 2} }\nif askBoolean "Outer?" { if askBoolean "Inner?" { box.n = null\n restore() } }\nlet value = box.n\nif value != null { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/2351",
    'let box = {n: 1}\nfunction restore { box = {n: 2} }\nif askBoolean "Outer?" { if askBoolean "Inner?" { box.n = null\n restore() } }\nrepeat box.n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2353",
    'let box = {n: 1}\nfunction restore { box = {n: 2} }\nif askBoolean "Clear?" { box.n = null }\nrestore()\nlet value = box.n\nif value != null { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/2354",
    'let box = {n: 1}\nfunction restore { box = {n: 2} }\nif askBoolean "Clear?" { box.n = null }\nrestore()\nrepeat box.n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2356",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2357",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2359",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null\n if pickFlag { n = 2 } else { restore() } }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2360",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null\n if pickFlag { n = 2 } else { restore() } }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2362",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null }\nif pickFlag { n = 2 } else { restore() }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2363",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null }\nif pickFlag { n = 2 } else { restore() }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2365",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null }\nif askBoolean "Enter?" { if pickFlag { n = 2 } else { restore() }\n if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2366",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null }\nif askBoolean "Enter?" { if pickFlag { n = 2 } else { restore() }\n repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2368",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null\n if pickFlag { restore() } else { restore() } }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2369",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null\n if pickFlag { restore() } else { restore() } }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2371",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null }\nif pickFlag { restore() } else { restore() }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2372",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null }\nif pickFlag { restore() } else { restore() }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2374",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null }\nif askBoolean "Enter?" { if pickFlag { restore() } else { restore() }\n if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2375",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null }\nif askBoolean "Enter?" { if pickFlag { restore() } else { restore() }\n repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2377",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null\n if pickFlag { n = 2 } else { n = 3 } }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2378",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null\n if pickFlag { n = 2 } else { n = 3 } }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2380",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null }\nif pickFlag { n = 2 } else { n = 3 }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2381",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null }\nif pickFlag { n = 2 } else { n = 3 }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2383",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null }\nif askBoolean "Enter?" { if pickFlag { n = 2 } else { n = 3 }\n if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2384",
    'let clear = askBoolean "Clear?"\nlet pickFlag = askBoolean "Choose?"\nlet n = 1\nfunction restore { n = 3 }\nif clear { n = null }\nif askBoolean "Enter?" { if pickFlag { n = 2 } else { n = 3 }\n repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2386",
    'let box = {n: 1}\nfunction restore { box = {n: 3} }\nif askBoolean "Clear?" { box.n = null }\nif askBoolean "Choose?" { box = {n: 2} } else { restore() }\nlet value = box.n\nif value != null { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/2387",
    'let box = {n: 1}\nfunction restore { box = {n: 3} }\nif askBoolean "Clear?" { box.n = null }\nif askBoolean "Choose?" { box = {n: 2} } else { restore() }\nrepeat box.n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2389",
    'let clear = askBoolean "Clear?"\nlet fork = askBoolean "Which way?"\nlet n = 1\nfunction restore { n = 2 }\nif clear { n = null }\n if fork { restore() }\n if n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2390",
    'let clear = askBoolean "Clear?"\nlet fork = askBoolean "Which way?"\nlet n = 1\nfunction restore { n = 2 }\nif clear { n = null }\n if fork { restore() }\n repeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2392",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { say "Present" }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2393",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { say "Present" }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2395",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n == null { n = 1 }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2396",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n == null { n = 1 }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2404",
    'let x = 3\nif askBoolean "Clear?" { x = null }\nswitch x { case null {}\ncase 3 { if x != null { repeat x {} } }\ndefault { repeat x {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2405",
    'let x = 3\nif askBoolean "Clear?" { x = null }\nswitch x { case null {}\ncase 3 { repeat x otherwise 0 {} }\ndefault { repeat x {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2406",
    'let x = 3\nif askBoolean "Clear?" { x = null }\nswitch x { case null {}\ncase 3 { repeat x {} }\ndefault { if x != null { repeat x {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2407",
    'let x = 3\nif askBoolean "Clear?" { x = null }\nswitch x { case null {}\ncase 3 { repeat x {} }\ndefault { repeat x otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2409",
    "let shelves = [[[1]], [[null]]]\nlet i = 0\n let j = 0\nif shelves[i][j] is integer[] { let value = shelves[i][j][0]\nif value != null { repeat value {} }\n repeat shelves[1][0][0] {} }\nexit\n",
  ],
  [
    "fixture-pasted/2410",
    "let shelves = [[[1]], [[null]]]\nlet i = 0\n let j = 0\nif shelves[i][j] is integer[] { repeat shelves[i][j][0] otherwise 0 {}\n repeat shelves[1][0][0] {} }\nexit\n",
  ],
  [
    "fixture-pasted/2411",
    "let shelves = [[[1]], [[null]]]\nlet i = 0\n let j = 0\nif shelves[i][j] is integer[] { repeat shelves[i][j][0] {}\n let value = shelves[1][0][0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2412",
    "let shelves = [[[1]], [[null]]]\nlet i = 0\n let j = 0\nif shelves[i][j] is integer[] { repeat shelves[i][j][0] {}\n repeat shelves[1][0][0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2414",
    "let grid = [[[1], [2]], [[null]]]\nlet i = 0\n let j = 0\n let q = 0\nif grid[i] is integer[][] { let value = grid[i][j][q]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2415",
    "let grid = [[[1], [2]], [[null]]]\nlet i = 0\n let j = 0\n let q = 0\nif grid[i] is integer[][] { repeat grid[i][j][q] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2417",
    "let grid = [[[1], [2]], [[null]]]\nlet i = 0\n let j = 0\n let q = 0\nif grid[i] is integer[][] { j = 1\n let value = grid[i][j][q]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2418",
    "let grid = [[[1], [2]], [[null]]]\nlet i = 0\n let j = 0\n let q = 0\nif grid[i] is integer[][] { j = 1\n repeat grid[i][j][q] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2420",
    "let shelves = [[[1]], [[null]]]\nif shelves is integer[][][] { let value = shelves[0][0][0]\nif value != null { repeat value {} }\n repeat shelves[1][0][0] {} }\nexit\n",
  ],
  [
    "fixture-pasted/2421",
    "let shelves = [[[1]], [[null]]]\nif shelves is integer[][][] { repeat shelves[0][0][0] otherwise 0 {}\n repeat shelves[1][0][0] {} }\nexit\n",
  ],
  [
    "fixture-pasted/2422",
    "let shelves = [[[1]], [[null]]]\nif shelves is integer[][][] { repeat shelves[0][0][0] {}\n let value = shelves[1][0][0]\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2423",
    "let shelves = [[[1]], [[null]]]\nif shelves is integer[][][] { repeat shelves[0][0][0] {}\n repeat shelves[1][0][0] otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2425",
    'let n = 1\nfunction ready { n = 2\n return true }\nfunction restoreCount { n = 2\n return 1 }\nif askBoolean "Clear?" { n = null }\nready()\nif askBoolean "Enter?" { if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2426",
    'let n = 1\nfunction ready { n = 2\n return true }\nfunction restoreCount { n = 2\n return 1 }\nif askBoolean "Clear?" { n = null }\nready()\nif askBoolean "Enter?" { repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2428",
    'let n = 1\nfunction ready { n = 2\n return true }\nfunction restoreCount { n = 2\n return 1 }\nif askBoolean "Clear?" { n = null }\nswitch ready() { case true { if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2429",
    'let n = 1\nfunction ready { n = 2\n return true }\nfunction restoreCount { n = 2\n return 1 }\nif askBoolean "Clear?" { n = null }\nswitch ready() { case true { repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2431",
    'let n = 1\nfunction ready { n = 2\n return true }\nfunction restoreCount { n = 2\n return 1 }\nif askBoolean "Clear?" { n = null }\nrepeat restoreCount() { if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2432",
    'let n = 1\nfunction ready { n = 2\n return true }\nfunction restoreCount { n = 2\n return 1 }\nif askBoolean "Clear?" { n = null }\nrepeat restoreCount() { repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2434",
    'let n = 1\nfunction ready { n = 2\n return true }\nfunction restoreCount { n = 2\n return 1 }\nif askBoolean "Clear?" { n = null }\nwhile ready() { if n != null { repeat n {} }\n break }\nexit\n',
  ],
  [
    "fixture-pasted/2435",
    'let n = 1\nfunction ready { n = 2\n return true }\nfunction restoreCount { n = 2\n return 1 }\nif askBoolean "Clear?" { n = null }\nwhile ready() { repeat n otherwise 0 {}\n break }\nexit\n',
  ],
  [
    "fixture-pasted/2437",
    'let n = 1\nfunction ready { n = 2\n return true }\nfunction restoreCount { n = 2\n return 1 }\nif askBoolean "Clear?" { n = null }\nif askBoolean "Enter?" { if ready() { if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2438",
    'let n = 1\nfunction ready { n = 2\n return true }\nfunction restoreCount { n = 2\n return 1 }\nif askBoolean "Clear?" { n = null }\nif askBoolean "Enter?" { if ready() { repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2440",
    'let n = 1\nfunction restoreCount { n = 2\n return 1 }\nif askBoolean "Clear?" { n = null }\nlet total = restoreCount() + (n otherwise 0)\nexit\n',
  ],
  [
    "fixture-pasted/2442",
    'let n = 1\nfunction restoreCount { n = 2\n return 1 }\nif askBoolean "Clear?" { n = null }\nlet total = (n otherwise 0) + restoreCount()\nexit\n',
  ],
  [
    "fixture-pasted/2444",
    'let box = {n: 1}\nfunction ready { box = {n: 2}\n return true }\nif askBoolean "Clear?" { box.n = null }\nif ready() { let value = box.n\nif value != null { repeat value {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2445",
    'let box = {n: 1}\nfunction ready { box = {n: 2}\n return true }\nif askBoolean "Clear?" { box.n = null }\nif ready() { repeat box.n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2447",
    'let n = 1\nfunction restore { n = 2\n return 0 }\nfunction use(a: integer, b: integer) {}\nif askBoolean "Clear?" { n = null }\nuse(restore(), n otherwise 0)\nexit\n',
  ],
  [
    "fixture-pasted/2449",
    'let n = 1\nfunction restore { n = 2\n return 0 }\nfunction use(a: integer, b: integer) {}\nif askBoolean "Clear?" { n = null }\nif n != null { use(n, restore()) }\nexit\n',
  ],
  [
    "fixture-pasted/2450",
    'let n = 1\nfunction restore { n = 2\n return 0 }\nfunction use(a: integer, b: integer) {}\nif askBoolean "Clear?" { n = null }\nuse(n otherwise 0, restore())\nexit\n',
  ],
  [
    "fixture-pasted/2452",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nrepeat 1 { restore()\n break }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2453",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nrepeat 1 { restore()\n break }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2455",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nrepeat 0 { restore()\n break }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2456",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nrepeat 0 { restore()\n break }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2458",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nlet times = askInteger "Times?"\nrepeat times { restore()\n break }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2459",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nlet times = askInteger "Times?"\nrepeat times { restore()\n break }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2461",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nwhile askBoolean "Again?" { restore()\n break }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2462",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nwhile askBoolean "Again?" { restore()\n break }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2464",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nif true { restore() }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2465",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nif true { restore() }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2467",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nwhile true { break }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2468",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nwhile true { break }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2470",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null\n while true { restore()\n break } }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2471",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null\n while true { restore()\n break } }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2473",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nif askBoolean "Enter?" { while true { restore()\n break }\n if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2474",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nif askBoolean "Enter?" { while true { restore()\n break }\n repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2476",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nif askBoolean "Choose?" { exit } else { restore() }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2477",
    'let n = 1\nfunction restore { n = 2 }\nif askBoolean "Clear?" { n = null }\nif askBoolean "Choose?" { exit } else { restore() }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2479",
    'let n = 1\nwhile askBoolean "Again?" { if n != null { repeat n {} }\n n = null }\nexit\n',
  ],
  [
    "fixture-pasted/2480",
    'let n = 1\nwhile askBoolean "Again?" { repeat n otherwise 0 {}\n n = null }\nexit\n',
  ],
  [
    "fixture-pasted/2482",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif askBoolean "Jump?" { goto again }\nlabel again\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2483",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif askBoolean "Jump?" { goto again }\nlabel again\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2485",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nlabel again\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2486",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nlabel again\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2488",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nfunction unused { n = 2 }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2489",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nfunction unused { n = 2 }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2491",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nfunction use { if n != null { repeat n {} } }\nif n != null { use() }\nexit\n',
  ],
  [
    "fixture-pasted/2492",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nfunction use { repeat n otherwise 0 {} }\nif n != null { use() }\nexit\n',
  ],
  [
    "fixture-pasted/2494",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { timer(duration: 1 s, async: true) { if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2495",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n != null { timer(duration: 1 s, async: true) { repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2497",
    "let items = [1, null]\nlet i = 0\nlet item = items[i + 1]\nif item != null { items.reverse()\n i = 1\n if item != null { repeat item {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2498",
    "let items = [1, null]\nlet i = 0\nlet item = items[i + 1]\nif item != null { items.reverse()\n i = 1\n repeat item otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2501",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nwhile n == null { n = 1 }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2502",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nwhile n == null { n = 1 }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2504",
    "let xs = [1, null]\nif xs.random != null { let value = xs.random\nif value != null { repeat value {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2505",
    "let xs = [1, null]\nif xs.random != null { repeat xs.random otherwise 0 {} }\nexit\n",
  ],
  [
    "fixture-pasted/2507",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nswitch n { case null, 1 { if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2508",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nswitch n { case null, 1 { repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2510",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nswitch n { case 1..3 { if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2511",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nswitch n { case 1..3 { repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2513",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nswitch n { case is integer { if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2514",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nswitch n { case is integer { repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2516",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nswitch n { case is not null { if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2517",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nswitch n { case is not null { repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2520",
    "let raw = hostValue\nif raw is integer { if raw is integer { repeat raw {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2522",
    "let raw = hostValue\nif raw is not integer { if raw is integer { repeat raw {} } }\nexit\n",
  ],
  [
    "fixture-pasted/2525",
    "let xs: integer[] = []\nif xs is integer[] { if xs.length > 0 { say xs.first } }\nexit\n",
  ],
  [
    "fixture-pasted/2528",
    'let n: integer | string = 1\nif askBoolean "Text?" { n = "two" }\nif n is integer { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2531",
    'let hasKey = askBoolean "Do you have the key?"\nlet backpack = []\nif hasKey { backpack.add("key") }\nif not hasKey { let copy: (integer | string)[] = backpack\n copy.add(3) }\nexit\n',
  ],
  [
    "fixture-pasted/2533",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n == null { exit }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2534",
    'let n = 1\nif askBoolean "Clear?" { n = null }\nif n == null { exit }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2536",
    'let pickFlag = askBoolean "Choose?"\nfunction use(n = null) { if pickFlag { n = 4 }\n if n != null { repeat n {} } }\nuse()\nexit\n',
  ],
  [
    "fixture-pasted/2537",
    'let pickFlag = askBoolean "Choose?"\nfunction use(n = null) { if pickFlag { n = 4 }\n repeat n otherwise 0 {} }\nuse()\nexit\n',
  ],
  [
    "fixture-pasted/2542",
    "function use(n = null) { if n != null { repeat n {} } }\nuse()\nuse(2)\nexit\n",
  ],
  [
    "fixture-pasted/2543",
    "function use(n = null) { repeat n otherwise 0 {} }\nuse()\nuse(2)\nexit\n",
  ],
  [
    "fixture-pasted/2545",
    "function rounds { let enabled = true\n if enabled { return 3 } }\nlet count = rounds()\nif count != null { repeat count {} }\nexit\n",
  ],
  [
    "fixture-pasted/2546",
    "function rounds { let enabled = true\n if enabled { return 3 } }\nlet count = rounds()\nrepeat count otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2549",
    'function rounds(enabled: boolean) { if enabled { return 3 } }\nlet count = rounds(askBoolean "Enabled?")\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2550",
    'function rounds(enabled: boolean) { if enabled { return 3 } }\nlet count = rounds(askBoolean "Enabled?")\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2555",
    'function chooseCount(flag: boolean) { if flag { return }\n return 2 }\nlet count = chooseCount(askBoolean "Void?")\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2556",
    'function chooseCount(flag: boolean) { if flag { return }\n return 2 }\nlet count = chooseCount(askBoolean "Void?")\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2558",
    "function chooseCount(flag) { if flag { return }\n return 2 }\nlet count: integer? = chooseCount(false)\nif count != null { repeat count {} }\nexit\n",
  ],
  [
    "fixture-pasted/2559",
    "function chooseCount(flag) { if flag { return }\n return 2 }\nlet count: integer? = chooseCount(false)\nrepeat count otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2561",
    'function use(n = null) { if askBoolean "Again?" { use(2) }\n if n != null { repeat n {} } }\nuse()\nexit\n',
  ],
  [
    "fixture-pasted/2562",
    'function use(n = null) { if askBoolean "Again?" { use(2) }\n repeat n otherwise 0 {} }\nuse()\nexit\n',
  ],
  [
    "fixture-pasted/2564",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null\n source = 2 }\nif source != null { repeat source {} }\nexit\n',
  ],
  [
    "fixture-pasted/2565",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null\n source = 2 }\nrepeat source otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2567",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nlet saved = source\nif saved != null { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2568",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nlet saved = source\nrepeat saved otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2571",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nfunction restore { source = 2 }\nrestore()\nlet saved = source\nif saved != null { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2572",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nfunction restore { source = 2 }\nrestore()\nlet saved = source\nrepeat saved otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2574",
    'let change = askBoolean "Change?"\nlet source: integer | string = 1\nif change { source = "text"\n source = 2 }\nlet saved = source\nif saved is integer { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2576",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null\n source = 2 }\nlet box = { count: source }\nlet value = box.count\nif value != null { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/2577",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null\n source = 2 }\nlet box = { count: source }\nrepeat box.count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2579",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null\n source = 2 }\nlet saved = source\nlet twice = saved\nif twice != null { repeat twice {} }\nexit\n',
  ],
  [
    "fixture-pasted/2580",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null\n source = 2 }\nlet saved = source\nlet twice = saved\nrepeat twice otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2582",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nlet saved = source\nlet twice = saved\nif twice != null { repeat twice {} }\nexit\n',
  ],
  [
    "fixture-pasted/2583",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nlet saved = source\nlet twice = saved\nrepeat twice otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2586",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nlet saved = source\nsource = 2\nif saved != null { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2587",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nlet saved = source\nsource = 2\nrepeat saved otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2589",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nfunction restore { source = 2 }\nlet saved = source\nrestore()\nif saved != null { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2590",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nfunction restore { source = 2 }\nlet saved = source\nrestore()\nrepeat saved otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2592",
    'let change = askBoolean "Change?"\nlet box = { count: 1 }\nif change { box.count = null\n box.count = 2 }\nlet saved = box.count\nlet twice = saved\nif twice != null { repeat twice {} }\nexit\n',
  ],
  [
    "fixture-pasted/2593",
    'let change = askBoolean "Change?"\nlet box = { count: 1 }\nif change { box.count = null\n box.count = 2 }\nlet saved = box.count\nlet twice = saved\nrepeat twice otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2595",
    'let change = askBoolean "Change?"\nlet box = { count: 1 }\nif change { box.count = null }\nlet saved = box.count\nlet twice = saved\nif twice != null { repeat twice {} }\nexit\n',
  ],
  [
    "fixture-pasted/2596",
    'let change = askBoolean "Change?"\nlet box = { count: 1 }\nif change { box.count = null }\nlet saved = box.count\nlet twice = saved\nrepeat twice otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2600",
    'let box = { count: 1 }\nif askBoolean "Clear?" { box = { count: null }\n box.count = 2 }\nlet value = box.count\nif value != null { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/2601",
    'let box = { count: 1 }\nif askBoolean "Clear?" { box = { count: null }\n box.count = 2 }\nrepeat box.count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2603",
    "let values = [1, null]\nlet saved = values[0]\nif saved != null { repeat saved {} }\nexit\n",
  ],
  [
    "fixture-pasted/2604",
    "let values = [1, null]\nlet saved = values[0]\nrepeat saved otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2606",
    'let values = dict { a: 1, b: null }\nlet saved = values["a"]\nif saved != null { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2607",
    'let values = dict { a: 1, b: null }\nlet saved = values["a"]\nrepeat saved otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2609",
    'let source = 1\nif askBoolean "Clear?" { source = null }\nlet box = { n: source }\nlet value = box.n\nif value != null { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/2610",
    'let source = 1\nif askBoolean "Clear?" { source = null }\nlet box = { n: source }\nrepeat box.n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2612",
    'let source = { n: 1 }\nif askBoolean "Clear?" { source.n = null }\nlet copy = source\nlet value = copy.n\nif value != null { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/2613",
    'let source = { n: 1 }\nif askBoolean "Clear?" { source.n = null }\nlet copy = source\nrepeat copy.n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2615",
    "let source = [1, null]\nlet copy = source\nlet value = copy[0]\nif value != null { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/2616",
    "let source = [1, null]\nlet copy = source\nrepeat copy[0] otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2618",
    'let source = 1\nif askBoolean "Clear?" { source = null }\nfunction use(n) { if n != null { repeat n {} } }\nuse(source)\nexit\n',
  ],
  [
    "fixture-pasted/2619",
    'let source = 1\nif askBoolean "Clear?" { source = null }\nfunction use(n) { repeat n otherwise 0 {} }\nuse(source)\nexit\n',
  ],
  [
    "fixture-pasted/2621",
    'function value { if askBoolean "Clear?" { return null }\n return 1 }\nlet saved = value()\nif saved != null { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2622",
    'function value { if askBoolean "Clear?" { return null }\n return 1 }\nlet saved = value()\nrepeat saved otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2624",
    'let source = 1\nif askBoolean "Clear?" { source = null }\nfunction reset { source = null }\nif source != null { reset()\n let saved: integer? = source\n if saved != null { repeat saved {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2625",
    'let source = 1\nif askBoolean "Clear?" { source = null }\nfunction reset { source = null }\nif source != null { reset()\n let saved: integer? = source\n repeat saved otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2627",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\ngoto resume\nlabel resume\nlet saved = source\nif saved != null { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2628",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\ngoto resume\nlabel resume\nlet saved = source\nrepeat saved otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2630",
    'let source = 1\nwhile askBoolean "Again?" { let saved = source\n if saved != null { repeat saved {} }\n source = null }\nexit\n',
  ],
  [
    "fixture-pasted/2631",
    'let source = 1\nwhile askBoolean "Again?" { let saved = source\n repeat saved otherwise 0 {}\n source = null }\nexit\n',
  ],
  [
    "fixture-pasted/2633",
    'let box = { n: 1 }\nif askBoolean "Clear?" { box.n = null }\nlet saved = box.n\nfunction restore { box.n = 2 }\nrestore()\nif saved != null { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2634",
    'let box = { n: 1 }\nif askBoolean "Clear?" { box.n = null }\nlet saved = box.n\nfunction restore { box.n = 2 }\nrestore()\nrepeat saved otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2636",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif restore() {}\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2637",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif restore() {}\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2639",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif askBoolean "Enter?" { if restore() { if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2640",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif askBoolean "Enter?" { if restore() { repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2642",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nswitch restore() { case true { if n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/2643",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nswitch restore() { case true { repeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2645",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return 1 }\nif clear { n = null }\nrepeat restore() { if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2646",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return 1 }\nif clear { n = null }\nrepeat restore() { repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2648",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nwhile restore() { if n != null { repeat n {} }\n break }\nexit\n',
  ],
  [
    "fixture-pasted/2649",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nwhile restore() { repeat n otherwise 0 {}\n break }\nexit\n',
  ],
  [
    "fixture-pasted/2651",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return [1] }\nif clear { n = null }\nfor item in restore() { if n != null { repeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/2652",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return [1] }\nif clear { n = null }\nfor item in restore() { repeat n otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/2654",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nwhile true { restore()\n break }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2655",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nwhile true { restore()\n break }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2657",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nrepeat 1 { restore() }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2658",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nrepeat 1 { restore() }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2660",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif true { restore() }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2661",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif true { restore() }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2663",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif false { restore() }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2664",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif false { restore() }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2666",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nwhile askBoolean "Restore?" { restore()\n break }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2667",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nwhile askBoolean "Restore?" { restore()\n break }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2669",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nlet times = askInteger "Times?"\nrepeat times { restore() }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2670",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nlet times = askInteger "Times?"\nrepeat times { restore() }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2672",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif askBoolean "Fork?" { restore() }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2673",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif askBoolean "Fork?" { restore() }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2675",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif askBoolean "Fork?" { restore() } else { restore() }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2676",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif askBoolean "Fork?" { restore() } else { restore() }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2678",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif askBoolean "Choose?" { n = 2 } else { restore() }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2679",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif askBoolean "Choose?" { n = 2 } else { restore() }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2682",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif askBoolean "Choose?" { if n == null { exit } } else { restore() }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2683",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return true }\nif clear { n = null }\nif askBoolean "Choose?" { if n == null { exit } } else { restore() }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2685",
    'let clear = askBoolean "Clear?"\nlet n = 1\nif clear { n = null }\nif n == null { n = 2 }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2686",
    'let clear = askBoolean "Clear?"\nlet n = 1\nif clear { n = null }\nif n == null { n = 2 }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2688",
    'let clear = askBoolean "Clear?"\nlet n = 1\nif clear { n = null }\nif n == null { exit }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2689",
    'let clear = askBoolean "Clear?"\nlet n = 1\nif clear { n = null }\nif n == null { exit }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2691",
    'let clear = askBoolean "Clear?"\nlet n = 1\nif clear { n = null }\nif n != null {}\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2692",
    'let clear = askBoolean "Clear?"\nlet n = 1\nif clear { n = null }\nif n != null {}\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2694",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return 1 }\nif clear { n = null }\nsay restore() + (n otherwise 0)\nexit\n',
  ],
  [
    "fixture-pasted/2696",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return 1 }\nif clear { n = null }\nif n != null { say n + restore() }\nexit\n',
  ],
  [
    "fixture-pasted/2697",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return 1 }\nif clear { n = null }\nsay (n otherwise 0) + restore()\nexit\n',
  ],
  [
    "fixture-pasted/2699",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return 1 }\nfunction sink(first: integer, count: integer) {}\nif clear { n = null }\nsink(restore(), n otherwise 0)\nexit\n',
  ],
  [
    "fixture-pasted/2701",
    'let clear = askBoolean "Clear?"\nlet n = 1\nfunction restore { n = 2\n return [1] }\nif clear { n = null }\nsay restore().take(n otherwise 0)\nexit\n',
  ],
  [
    "fixture-pasted/2720",
    'let result = fromBase64("Mg==", default: null)\nlet checked: string = result otherwise ""\nexit\n',
  ],
  [
    "fixture-pasted/2722",
    'let text = askText "Input?"\nlet result = fromBase64(text, default: null)\nlet checked: string = result otherwise ""\nexit\n',
  ],
  [
    "fixture-pasted/2724",
    'let result = fileFromBase64("Mg==", default: null)\nlet checked: string = result otherwise ""\nexit\n',
  ],
  [
    "fixture-pasted/2726",
    'let text = askText "Input?"\nlet result = fileFromBase64(text, default: null)\nlet checked: string = result otherwise ""\nexit\n',
  ],
  [
    "fixture-pasted/2728",
    'let locked = encryptText("2", password: "p", publicKey: false, timeLock: false)\nlet result = decryptText(locked, password: "p", default: null)\nlet checked: string = result otherwise ""\nexit\n',
  ],
  [
    "fixture-pasted/2730",
    'let locked = encryptText("2", password: "p", publicKey: false, timeLock: false)\nlet result = decryptText(locked, password: "wrong", default: null)\nlet checked: string = result otherwise ""\nexit\n',
  ],
  [
    "fixture-pasted/2732",
    'let locked = encryptFile(fileFromBase64("Mg==", default: ""), password: "p", publicKey: false, timeLock: false)\nlet result = decryptFile(locked, password: "p", default: null)\nlet checked: string = result otherwise ""\nexit\n',
  ],
  [
    "fixture-pasted/2734",
    'let locked = encryptFile(fileFromBase64("Mg==", default: ""), password: "p", publicKey: false, timeLock: false)\nlet result = decryptFile(locked, password: "wrong", default: null)\nlet checked: string = result otherwise ""\nexit\n',
  ],
  [
    "fixture-pasted/2736",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null\n source = 2 }\nlet saved = source otherwise null\nif saved != null { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2737",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null\n source = 2 }\nlet saved = source otherwise null\nrepeat saved otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2739",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nlet saved = source otherwise null\nif saved != null { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2740",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nlet saved = source otherwise null\nrepeat saved otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2742",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null\n source = 2 }\nlet saved: integer | string = source otherwise "unused"\nif saved is integer { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2744",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nlet saved: integer | string = source otherwise "unused"\nif saved is integer { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2747",
    "let saved = 1 otherwise null\nif saved != null { repeat saved {} }\nexit\n",
  ],
  ["fixture-pasted/2748", "let saved = 1 otherwise null\nrepeat saved otherwise 0 {}\nexit\n"],
  [
    "fixture-pasted/2750",
    "let saved = (1 otherwise null) otherwise null\nif saved != null { repeat saved {} }\nexit\n",
  ],
  [
    "fixture-pasted/2751",
    "let saved = (1 otherwise null) otherwise null\nrepeat saved otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2753",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nlet saved = (source otherwise 2) otherwise null\nif saved != null { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2754",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nlet saved = (source otherwise 2) otherwise null\nrepeat saved otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2756",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nlet saved = source otherwise (null otherwise null)\nif saved != null { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2757",
    'let change = askBoolean "Change?"\nlet source = 1\nif change { source = null }\nlet saved = source otherwise (null otherwise null)\nrepeat saved otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2759",
    'let clear = askBoolean "Clear?"\nlet a = 1\nif clear { a = null\n a = 2 }\nlet b = a otherwise null\nlet c = b otherwise null\nif c != null { repeat c {} }\nexit\n',
  ],
  [
    "fixture-pasted/2760",
    'let clear = askBoolean "Clear?"\nlet a = 1\nif clear { a = null\n a = 2 }\nlet b = a otherwise null\nlet c = b otherwise null\nrepeat c otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2762",
    'let clear = askBoolean "Clear?"\nlet a = 1\nif clear { a = null }\nlet b = a otherwise null\nlet c = b otherwise null\nif c != null { repeat c {} }\nexit\n',
  ],
  [
    "fixture-pasted/2763",
    'let clear = askBoolean "Clear?"\nlet a = 1\nif clear { a = null }\nlet b = a otherwise null\nlet c = b otherwise null\nrepeat c otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2765",
    'let clear = askBoolean "Clear?"\nlet a = 1\nif clear { a = null }\nlet b = a otherwise 4\nlet c = b otherwise null\nif c != null { repeat c {} }\nexit\n',
  ],
  [
    "fixture-pasted/2766",
    'let clear = askBoolean "Clear?"\nlet a = 1\nif clear { a = null }\nlet b = a otherwise 4\nlet c = b otherwise null\nrepeat c otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2768",
    'let change = askBoolean "Change?"\nlet source = 1\nif change {\n    source = null\n    source = 2\n}\nlet saved = source\nif saved != null { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2769",
    'let change = askBoolean "Change?"\nlet source = 1\nif change {\n    source = null\n    source = 2\n}\nlet saved = source\nrepeat saved otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2771",
    "let values = [3]\nlet count = values.get(0, default: null)\nif count != null { repeat count {} }\nexit\n",
  ],
  [
    "fixture-pasted/2772",
    "let values = [3]\nlet count = values.get(0, default: null)\nrepeat count otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2774",
    'let change = askBoolean "Change?"\nlet n = 1\nif change { n = 1 otherwise null }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2775",
    'let change = askBoolean "Change?"\nlet n = 1\nif change { n = 1 otherwise null }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2777",
    'let change = askBoolean "Change?"\nlet n: integer | string = 1\nif change { n = 1 otherwise "unused" }\nif n is integer { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2779",
    'let count: integer? = fromJson("3", default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2780",
    'let count: integer? = fromJson("3", default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2782",
    'let count: integer | string = fromJson("3", default: "none")\nif count is integer { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2784",
    'let count: integer? = fromJson("2", default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2785",
    'let count: integer? = fromJson("2", default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2787",
    'let count: integer | string = fromJson("2", default: "unused")\nif count is integer { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2789",
    "let count: integer? = fromJson(toJson(4), default: null)\nif count != null { repeat count {} }\nexit\n",
  ],
  [
    "fixture-pasted/2790",
    "let count: integer? = fromJson(toJson(4), default: null)\nrepeat count otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2792",
    'let count: integer | string = fromJson(toJson(4), default: "none")\nif count is integer { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2794",
    "function rounds(enabled: boolean) {\n    if enabled {\n        return 3\n    }\n}\nlet count = rounds(true)\nif count != null { repeat count {} }\nexit\n",
  ],
  [
    "fixture-pasted/2795",
    "function rounds(enabled: boolean) {\n    if enabled {\n        return 3\n    }\n}\nlet count = rounds(true)\nrepeat count otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2797",
    "function chooseCount(flag) {\n    if flag { return }\n    return 2\n}\nchooseCount(true)\nlet count: integer? = chooseCount(false)\nif count != null { repeat count {} }\nexit\n",
  ],
  [
    "fixture-pasted/2798",
    "function chooseCount(flag) {\n    if flag { return }\n    return 2\n}\nchooseCount(true)\nlet count: integer? = chooseCount(false)\nrepeat count otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2800",
    'save 4 as "rounds"\nlet count: integer? = load("rounds", default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2801",
    'save 4 as "rounds"\nlet count: integer? = load("rounds", default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2803",
    'save 2 as "r9.count"\nlet count: integer? = load("r9.count", default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2804",
    'save 2 as "r9.count"\nlet count: integer? = load("r9.count", default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2806",
    'let text = "2"\nlet count: integer? = fromJson(text, default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2807",
    'let text = "2"\nlet count: integer? = fromJson(text, default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2809",
    "let text = toJson(2)\nlet count: integer? = fromJson(text, default: null)\nif count != null { repeat count {} }\nexit\n",
  ],
  [
    "fixture-pasted/2810",
    "let text = toJson(2)\nlet count: integer? = fromJson(text, default: null)\nrepeat count otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2812",
    "let parsed: integer? = fromJson(toJson(7), default: null)\nlet saved = parsed otherwise null\nif saved != null { repeat saved {} }\nexit\n",
  ],
  [
    "fixture-pasted/2813",
    "let parsed: integer? = fromJson(toJson(7), default: null)\nlet saved = parsed otherwise null\nrepeat saved otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2815",
    'let box = { n: 1 }\nif askBoolean "Clear?" { box.n = null }\nlet kept = box.n\nbox.n = 2\nif kept != null { repeat kept {} }\nexit\n',
  ],
  [
    "fixture-pasted/2816",
    'let box = { n: 1 }\nif askBoolean "Clear?" { box.n = null }\nlet kept = box.n\nbox.n = 2\nrepeat kept otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2818",
    'let count: integer? = fromJson("4", default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2819",
    'let count: integer? = fromJson("4", default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2821",
    'let payload = "4"\nlet count: integer? = fromJson(payload, default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2822",
    'let payload = "4"\nlet count: integer? = fromJson(payload, default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2824",
    'let count: integer? = fromJson("4" + "", default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2825",
    'let count: integer? = fromJson("4" + "", default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2827",
    'function payload { return "4" }\nlet count: integer? = fromJson(payload(), default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2828",
    'function payload { return "4" }\nlet count: integer? = fromJson(payload(), default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2830",
    'let payload = askText "Count?"\nif payload != "4" { payload = "4" }\nlet count: integer? = fromJson(payload, default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2831",
    'let payload = askText "Count?"\nif payload != "4" { payload = "4" }\nlet count: integer? = fromJson(payload, default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2833",
    'let payload = askText "Count?"\nlet count: integer? = fromJson(payload, default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2834",
    'let payload = askText "Count?"\nlet count: integer? = fromJson(payload, default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2836",
    'let count: integer? = fromJson("{", default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2837",
    'let count: integer? = fromJson("{", default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2839",
    'let text = "3"\nlet count: integer? = fromJson(text, default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2840",
    'let text = "3"\nlet count: integer? = fromJson(text, default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2842",
    'let text = "2"\nlet payload = text\nlet count: integer? = fromJson(payload, default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2843",
    'let text = "2"\nlet payload = text\nlet count: integer? = fromJson(payload, default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2845",
    "let count: integer? = fromJson(toJson(2), default: null)\nif count != null { repeat count {} }\nexit\n",
  ],
  [
    "fixture-pasted/2846",
    "let count: integer? = fromJson(toJson(2), default: null)\nrepeat count otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2848",
    'let n = askInteger "Count?"\nlet count: integer? = fromJson(toJson(n), default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2849",
    'let n = askInteger "Count?"\nlet count: integer? = fromJson(toJson(n), default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2851",
    'let text = "2"\nlet count: integer | string = fromJson(text, default: "unused")\nif count is integer { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2853",
    'let count: integer | string = fromJson(toJson(4), default: "unused")\nif count is integer { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2855",
    'let text = askText "Count?"\nlet count: integer | string = fromJson(text, default: "unused")\nif count is integer { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2857",
    "let parsed: integer? = fromJson(toJson(7), default: null)\nlet saved = parsed otherwise null\nlet copied = saved\nif copied != null { repeat copied {} }\nexit\n",
  ],
  [
    "fixture-pasted/2858",
    "let parsed: integer? = fromJson(toJson(7), default: null)\nlet saved = parsed otherwise null\nlet copied = saved\nrepeat copied otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2860",
    'let parsed: integer? = fromJson(toJson(7), default: null)\nlet saved: integer | string = parsed otherwise "unused"\nif saved is integer { repeat saved {} }\nexit\n',
  ],
  [
    "fixture-pasted/2868",
    "let values = [3]\nlet count = values.get(1, default: null)\nif count != null { repeat count {} }\nexit\n",
  ],
  [
    "fixture-pasted/2869",
    "let values = [3]\nlet count = values.get(1, default: null)\nrepeat count otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2871",
    'let values = [3]\nlet count: integer | string = values.get(0, default: "none")\nif count is integer { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2873",
    'let values = dict { a: 3 }\nlet count = values.get("a", default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2874",
    'let values = dict { a: 3 }\nlet count = values.get("a", default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2876",
    'let values = dict { a: 3 }\nlet count = values.get("b", default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2877",
    'let values = dict { a: 3 }\nlet count = values.get("b", default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2879",
    "let box = { count: 1 }\nlet values = [3]\nbox.count = values.get(0, default: null)\nlet value = box.count\nif value != null { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/2880",
    "let box = { count: 1 }\nlet values = [3]\nbox.count = values.get(0, default: null)\nrepeat box.count otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2882",
    "let values = [3]\nlet count = values.get(0, default: null)\nlet saved = count\nlet twice = saved\nif twice != null { repeat twice {} }\nexit\n",
  ],
  [
    "fixture-pasted/2883",
    "let values = [3]\nlet count = values.get(0, default: null)\nlet saved = count\nlet twice = saved\nrepeat twice otherwise 0 {}\nexit\n",
  ],
  [
    "fixture-pasted/2885",
    'let clear = askBoolean "Clear?"\nlet n = 4\nif clear { n = null }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2886",
    'let clear = askBoolean "Clear?"\nlet n = 4\nif clear { n = null }\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2888",
    'let clear = askBoolean "Clear?"\nlet box = { n: 4 }\nif clear { box.n = null }\nlet value = box.n\nif value != null { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/2889",
    'let clear = askBoolean "Clear?"\nlet box = { n: 4 }\nif clear { box.n = null }\nrepeat box.n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2893",
    'let pickFlag = askBoolean "Choose?"\nlet n: integer | string = "none"\nif pickFlag { n = 4 }\nif n is integer { repeat n {} }\nexit\n',
  ],
  ["fixture-pasted/2896", "let count = hostValue\nif count is integer { repeat count {} }\nexit\n"],
  [
    "fixture-pasted/2898",
    'let count: integer? = load("rounds", default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2899",
    'let count: integer? = load("rounds", default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2901",
    'let key = "rounds"\nlet count: integer? = load(key, default: null)\nif count is integer { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2903",
    'let pickFlag = askBoolean "Save?"\nif pickFlag { save 4 as "rounds" } else { save 4 as "rounds" }\nlet count: integer? = load("rounds", default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2904",
    'let pickFlag = askBoolean "Save?"\nif pickFlag { save 4 as "rounds" } else { save 4 as "rounds" }\nlet count: integer? = load("rounds", default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2906",
    'save 4 as "rounds"\nsave 4 as "rounds"\nlet count: integer? = load("rounds", default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2907",
    'save 4 as "rounds"\nsave 4 as "rounds"\nlet count: integer? = load("rounds", default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2909",
    'delete "rounds"\nlet count: integer? = load("rounds", default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2910",
    'delete "rounds"\nlet count: integer? = load("rounds", default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2912",
    'let earlier: integer? = load("rounds", default: null)\nif earlier == null { exit }\nlet count: integer? = load("rounds", default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2913",
    'let earlier: integer? = load("rounds", default: null)\nif earlier == null { exit }\nlet count: integer? = load("rounds", default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2915",
    'if debugMode { exit }\nlet count: integer? = load("rounds", default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/2916",
    'if debugMode { exit }\nlet count: integer? = load("rounds", default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2941",
    "let value = [hostValue, 11][0]\nif value is integer { repeat value {} }\nvalue = 11\nexit\n",
  ],
  [
    "fixture-pasted/2943",
    'let amber = dict{seed: hostValue}\nlet value = amber.get("seed", default: 11)\nif value is integer { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/2946",
    "let amber = [hostValue]\nlet value = amber.get(0, default: 11)\nif value is integer { repeat value {} }\nexit\n",
  ],
  [
    "fixture-pasted/2949",
    'let amount = 17\namount = 2.5\nlet value = fromJson("2.5", default: null)\nif value is number { amount = value }\nsay amount\nexit\n',
  ],
  [
    "fixture-pasted/2952",
    'let state = {amount: 17}\nstate.amount = 2.5\nlet value = fromJson("2.5", default: null)\nif value is number { state.amount = value }\nsay state.amount\nexit\n',
  ],
  [
    "fixture-pasted/2954",
    'let state = {amount: 2.5}\nstate.amount = 17\nlet value = fromJson("2.5", default: null)\nif value is number { state.amount = value }\nsay state.amount\nexit\n',
  ],
  [
    "fixture-pasted/2956",
    'let values = [17]\nvalues.add(2.5)\nlet value = fromJson("2.5", default: null)\nif value is number { values.add(value) }\nsay values.get(0, default: null)\nexit\n',
  ],
  [
    "fixture-pasted/2958",
    'let values = [2.5]\nvalues.add(17)\nlet value = fromJson("2.5", default: null)\nif value is number { values.add(value) }\nsay values.get(0, default: null)\nexit\n',
  ],
  [
    "fixture-pasted/2960",
    "function task(amount: integer? = hostValue) { if amount is integer { repeat amount {} } }\ntask()\nexit\n",
  ],
  [
    "fixture-pasted/2962",
    "let amount: integer? = hostValue\nif amount is integer { repeat amount {} }\nexit\n",
  ],
  [
    "fixture-pasted/2964",
    'let textHost = askText "text"\nfunction task(amount: integer? = fromJson(textHost, default: null)) { if amount != null { repeat amount {} } }\ntask()\nexit\n',
  ],
  [
    "fixture-pasted/2965",
    'let textHost = askText "text"\nfunction task(amount: integer? = fromJson(textHost, default: null)) { repeat amount otherwise 0 {} }\ntask()\nexit\n',
  ],
  [
    "fixture-pasted/2967",
    'let textHost = askText "text"\nlet amount: integer? = fromJson(textHost, default: null)\nif amount != null { repeat amount {} }\nexit\n',
  ],
  [
    "fixture-pasted/2968",
    'let textHost = askText "text"\nlet amount: integer? = fromJson(textHost, default: null)\nrepeat amount otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/2980",
    "let n = 1\nfunction clear { n = null\n return true }\nif n != null and true { if n != null { repeat n {} } }\nsay clear()\nexit\n",
  ],
  [
    "fixture-pasted/2981",
    "let n = 1\nfunction clear { n = null\n return true }\nif n != null and true { repeat n otherwise 0 {} }\nsay clear()\nexit\n",
  ],
  [
    "fixture-pasted/2983",
    "let n = 1\nfunction clear { n = null\n return true }\nif n != null and clear() { if n != null { repeat n {} } }\nsay clear()\nexit\n",
  ],
  [
    "fixture-pasted/2984",
    "let n = 1\nfunction clear { n = null\n return true }\nif n != null and clear() { repeat n otherwise 0 {} }\nsay clear()\nexit\n",
  ],
  [
    "fixture-pasted/2987",
    'let flagHost = askBoolean "flag"\nlet v = 1\nif flagHost { v = null }\nif v != null {\n while askBoolean "More?" {\n  let w = v\n  v = w otherwise null\n  if v != null { repeat v {} }\n }\n}\nexit\n',
  ],
  [
    "fixture-pasted/2988",
    'let flagHost = askBoolean "flag"\nlet v = 1\nif flagHost { v = null }\nif v != null {\n while askBoolean "More?" {\n  let w = v\n  v = w otherwise null\n  repeat v otherwise 0 {}\n }\n}\nexit\n',
  ],
  [
    "fixture-pasted/2994",
    'let n: integer | string = load("n", default: "bad")\nif n is integer { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/2996",
    'let n: integer | string = fromJson("1", default: "bad")\nif n is integer { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/3006",
    'let flagHost = askBoolean "flag"\nlet n = 1\nfunction restore { n = 2\n return 1 }\nif flagHost { n = null }\nif flagHost and restore() == 1 {}\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/3007",
    'let flagHost = askBoolean "flag"\nlet n = 1\nfunction restore { n = 2\n return 1 }\nif flagHost { n = null }\nif flagHost and restore() == 1 {}\nrepeat n otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/3009",
    'let flagHost = askBoolean "flag"\nlet n = 1\nfunction restore { n = 2\n return 1 }\nif flagHost { n = null }\nif restore() == 1 {}\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/3010",
    'let flagHost = askBoolean "flag"\nlet n = 1\nfunction restore { n = 2\n return 1 }\nif flagHost { n = null }\nif restore() == 1 {}\nrepeat n otherwise 0 {}\nexit\n',
  ],
  ["fixture-pasted/3012", 'let xs: (integer | string)[] = ["wrong", 8]\nexit\n'],
  ["fixture-pasted/3014", 'let xs: (integer | string)[] = ["wrong"]\nexit\n'],
  [
    "fixture-pasted/3016",
    'let flagHost = askBoolean "flag"\nlet n = 3\nif flagHost { n = null }\nlet y = n\nif n != null { if y != null { repeat 2 { if n != null { repeat n {} }\nn = y\ny = n }\nrepeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/3017",
    'let flagHost = askBoolean "flag"\nlet n = 3\nif flagHost { n = null }\nlet y = n\nif n != null { if y != null { repeat 2 { repeat n otherwise 0 {}\nn = y\ny = n }\nrepeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/3019",
    'let flagHost = askBoolean "flag"\nlet n = 3\nif flagHost { n = null }\nlet y = n\nif n != null { if y != null { repeat 2 { if n != null { repeat n {} }\nn = y\ny = null }\nrepeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/3020",
    'let flagHost = askBoolean "flag"\nlet n = 3\nif flagHost { n = null }\nlet y = n\nif n != null { if y != null { repeat 2 { repeat n otherwise 0 {}\nn = y\ny = null }\nrepeat n {} } }\nexit\n',
  ],
  [
    "fixture-pasted/3021",
    'let flagHost = askBoolean "flag"\nlet n = 3\nif flagHost { n = null }\nlet y = n\nif n != null { if y != null { repeat 2 { repeat n {}\nn = y\ny = null }\nif n != null { repeat n {} } } }\nexit\n',
  ],
  [
    "fixture-pasted/3022",
    'let flagHost = askBoolean "flag"\nlet n = 3\nif flagHost { n = null }\nlet y = n\nif n != null { if y != null { repeat 2 { repeat n {}\nn = y\ny = null }\nrepeat n otherwise 0 {} } }\nexit\n',
  ],
  [
    "fixture-pasted/3024",
    "let count = 6\ncount += 1\nif hostValue is integer { count = hostValue }\nrepeat count {}\nexit\n",
  ],
  [
    "fixture-pasted/3025",
    "let count = 6\ncount += 1\ncount = hostValue\nif count is integer { repeat count {} }\nexit\n",
  ],
  [
    "fixture-pasted/3041",
    "let n = 6\nn += 0.5\nif hostValue is number { n = hostValue }\nsay n\nexit\n",
  ],
  [
    "fixture-pasted/3043",
    "let n = 6\nn -= 0.5\nif hostValue is number { n = hostValue }\nsay n\nexit\n",
  ],
  [
    "fixture-pasted/3045",
    "let n = 6\nn = n / 2\nif hostValue is number { n = hostValue }\nsay n\nexit\n",
  ],
  [
    "fixture-pasted/3047",
    "let n = 6\nn = n + 0.5\nif hostValue is number { n = hostValue }\nsay n\nexit\n",
  ],
  [
    "fixture-pasted/3049",
    "let box = { n: 6 }\nbox.n += 0.5\nif hostValue is number { box.n = hostValue }\nsay box.n\nexit\n",
  ],
  [
    "fixture-pasted/3051",
    "let n = 6\nn = 1.25\nif hostValue is number { n = hostValue }\nsay n\nexit\n",
  ],
  ["fixture-pasted/3053", 'let r = "abc".reverse()\nlet n: integer | string = r\nexit\n'],
  ["fixture-pasted/3057", 'let r = "abc".reverse()\nlet result: string? = r\nexit\n'],
  ["fixture-pasted/3060", 'let w: integer | date = askDate "x"\nexit\n'],
  ["fixture-pasted/3063", 'let w: integer | string = askPassword "x"\nexit\n'],
  ["fixture-pasted/3068", 'let w: integer | time = askTime "x"\nexit\n'],
  ["fixture-pasted/3071", 'let w: integer | datetime = askDateTime "x"\nexit\n'],
  [
    "fixture-pasted/3083",
    "let picked = askChoice [hostValue, 1]\nif picked is integer { repeat picked {} }\nexit\n",
  ],
  [
    "fixture-pasted/3090",
    'let value = askChoice [{text:"A", value:1}, {text:"B"}]\nif value is integer { repeat value {} }\nexit\n',
  ],
  ["fixture-pasted/3095", 'let s: integer | string = askChoice [{text:"A"}]\nexit\n'],
  [
    "fixture-pasted/3100",
    'let x: string = (askDate "When?").year otherwise "ok"\nexit\nfunction fixType(p: number | string) {\n  say p\n}\n',
  ],
  ["fixture-pasted/3102", 'let x: string = "${(askDate "When?").year}"\nexit\n'],
  ["fixture-pasted/3111", "let d = 2 days\nsay d / 1 day\nexit\n"],
  [
    "fixture-pasted/3115",
    'let a = toAbsoluteDateTime("2026-10-04T12:30:00Z")\nsay a.toDateTime().year\nexit\n',
  ],
  [
    "fixture-pasted/3120",
    "let d = dict{a: dict{}, b: dict{v: 1}}\nlet value = d.values.get(0, default: dict{v: 1}).values\nif value.length > 0 { repeat value.first {} }\nexit\n",
  ],
  [
    "fixture-pasted/3122",
    "let d = dict{a: dict{}, b: dict{v: 1}}\nif d.values.length > 0 { repeat d.values.first.values.get(0, default: 0) {} }\nexit\n",
  ],
  [
    "fixture-pasted/3124",
    "let d = dict{a: dict{}, b: dict{v: 1}}\nif d.values.length > 0 { for n in d.values.first.values { repeat n {} } }\nexit\n",
  ],
  [
    "fixture-pasted/3126",
    "let d = dict{a: dict{}, b: dict{v: 1}}\nfor inner in d.values { if inner.values.length > 0 { repeat inner.values.first {} } }\nexit\n",
  ],
  [
    "fixture-pasted/3129",
    "let d = dict{a: dict{}, b: dict{v: 1}}\nlet value = d.values.removeAt(0).values\nif value.length > 0 { repeat value.first {} }\nexit\n",
  ],
  [
    "fixture-pasted/3133",
    "let xs = [[], [1]]\nif xs.first.length > 0 { repeat xs.first.first {} }\nexit\n",
  ],
  ["fixture-pasted/3149", "let t: integer | time = getTime()\nexit\n"],
  [
    "fixture-pasted/3159",
    'function rootResult {\n    if askBoolean("First?") { return 1 }\n    return "x"\n}\nrepeat rootResult() {}\nexit\nfunction fixType(p: integer | string) {\n  say p\n}\n',
  ],
  [
    "fixture-pasted/3166",
    'function defaultPool(xs: (integer | string)[] = [1]) {\n    xs.add("x")\n}\ndefaultPool()\nexit\n',
  ],
  [
    "fixture-pasted/3173",
    'function defaultCount(n: integer | string = 1) {\n    repeat n {}\n}\ndefaultCount("x")\nexit\n',
  ],
  [
    "fixture-pasted/3177",
    'let xs = [1, hostValue]\nif false { let value = xs[0]\nif value is integer { repeat value {} } }\nsay "AFTER"\nexit\n',
  ],
  [
    "fixture-pasted/3213",
    'let values = [3]\nlet index = askInteger "Index?"\nlet count = values.get(index, default: null)\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/3214",
    'let values = [3]\nlet index = askInteger "Index?"\nlet count = values.get(index, default: null)\nif count != null { if count != null { repeat count {} } }\nexit\n',
  ],
  [
    "fixture-pasted/3215",
    'let values = [3]\nlet index = askInteger "Index?"\nlet count = values.get(index, default: null)\nif count != null { repeat count otherwise 0 {} }\nexit\n',
  ],
  [
    "fixture-pasted/3219",
    'let index = askInteger "Index?"\nlet values = [3]\nlet count: integer | string = values.get(index, default: "bad")\nif count is integer { if count is integer { repeat count {} } }\nexit\n',
  ],
  [
    "fixture-pasted/3222",
    'let values = [3]\nlet index = askInteger "Index?"\nlet count = values.get(index, default: null)\nlet amount: integer = count otherwise 0\nrepeat count {}\nexit\n',
  ],
  [
    "fixture-pasted/3223",
    'let values = [3]\nlet index = askInteger "Index?"\nlet count = values.get(index, default: null)\nlet amount: integer = count\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/3224",
    'let values = [3]\nlet index = askInteger "Index?"\nlet count = values.get(index, default: null)\nlet amount: integer = count\nrepeat count otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/3254",
    'let result: integer | string = load("count", default: ["bad"].last)\nsay result\nexit\n',
  ],
  [
    "fixture-pasted/3257",
    'function seed {\n if askBoolean("again") { return seed() }\n return "bad"\n}\nlet result: integer | string = load("count", default: seed())\nsay result\nexit\n',
  ],
  [
    "fixture-pasted/3260",
    'let result: integer | string = fromJson("1", default: ["bad"].last)\nsay result\nexit\n',
  ],
  [
    "fixture-pasted/3263",
    'function seed {\n if askBoolean("again") { return seed() }\n return "bad"\n}\nlet result: integer | string = fromJson("1", default: seed())\nsay result\nexit\n',
  ],
  [
    "fixture-pasted/3265",
    'let result = fromJson("1", default: [null].last)\nif result is integer { repeat result {} }\nexit\n',
  ],
  [
    "fixture-pasted/3267",
    'let result: integer? = fromJson("1", default: [null].last)\nif result != null { repeat result {} }\nexit\n',
  ],
  [
    "fixture-pasted/3268",
    'let result: integer? = fromJson("1", default: [null].last)\nrepeat result otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/3270",
    'function seed {\n if askBoolean("again") { return seed() }\n return null\n}\nlet result = fromJson("1", default: seed())\nif result is integer { repeat result {} }\nexit\n',
  ],
  [
    "fixture-pasted/3272",
    'function seed {\n if askBoolean("again") { return seed() }\n return null\n}\nlet result: integer? = fromJson("1", default: seed())\nif result != null { repeat result {} }\nexit\n',
  ],
  [
    "fixture-pasted/3273",
    'function seed {\n if askBoolean("again") { return seed() }\n return null\n}\nlet result: integer? = fromJson("1", default: seed())\nrepeat result otherwise 0 {}\nexit\n',
  ],
  [
    "fixture-pasted/3275",
    'function sample {\n return fromJson("1", default: sample())\n}\nlet value = sample()\nif value is integer { repeat value {} }\nexit\n',
  ],
  [
    "fixture-pasted/3285",
    "for entry in [hostValue] {\n  if entry is integer { repeat entry {} }\n}\nexit\n",
  ],
  [
    "fixture-pasted/3318",
    'let key = "k"\nlet result = load(key, default: 0)\nsay result\nif result is integer { repeat result {} }\nsay "after"\nexit\n',
  ],
  [
    "fixture-pasted/3320",
    'let key = "k"\nlet result = load(key, default: null)\nsay result\nif result is integer { repeat result {} }\nsay "after"\nexit\n',
  ],
  [
    "fixture-pasted/cp9-cells/3b/forms/not-null/held",
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat n {} }\nexit\n',
  ],
  [
    "fixture-pasted/cp9-cells/r8/written-union/assignment/guarded",
    'let flagHost = askBoolean "flag"\nlet strict: integer = 0\nlet n: integer | string = 1\nif flagHost { n = "bad" }\nif n is integer { strict = n }\nexit\n',
  ],
  [
    "fixture-pasted/cp9-cells/r8/written-union/parameter-binding/guarded",
    'let flagHost = askBoolean "flag"\nfunction use(value: integer) {}\nlet n: integer | string = 1\nif flagHost { n = "bad" }\nif n is integer { use(n) }\nexit\n',
  ],
  [
    "fixture-pasted/cp9-cells/3b/ad1/e1a/tested",
    'let values = [3]\nlet index = askInteger "Index?"\nlet count = values.get(index, default: null)\nif count != null { repeat count {} }\nexit\n',
  ],
  [
    "fixture-pasted/cp9-cells/3b/ad1/e1b/tested",
    'let index = askInteger "Index?"\nlet values = [3]\nlet count: integer | string = values.get(index, default: "bad")\nif count is integer { repeat count {} }\nexit\n',
  ],
];
export const cases = [...generated, ...captured];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node gen/paste-1273.mjs head-2cdb498a4 family desktop:~/work/evidence/1273/2cdb498a4/paste-1273-family.json",
      "R/astra-m4-i1268-review-r4-evidence/builder/COMMANDS:4",
    ],
    [
      "node gen/paste-1273.mjs head-2cdb498a4 fixture desktop:~/work/evidence/1273/2cdb498a4/paste-1273-fixture.json",
      "R/astra-m4-i1268-review-r4-evidence/builder/COMMANDS:5",
    ],
    [
      "/home/peter/opt/node-24.18/bin/node gen/paste-1273.mjs head-$H family $E/paste-1273-family.json",
      "R/astra-m4-i1268-review-r4-evidence/builder/generators/queue-evidence.sh:16",
    ],
    [
      "/home/peter/opt/node-24.18/bin/node gen/paste-1273.mjs head-$H fixture $E/paste-1273-fixture.json",
      "R/astra-m4-i1268-review-r4-evidence/builder/generators/queue-evidence.sh:18",
    ],
  ],
  sources: 1433,
  sha256: "7f19cb3872f49a455371483c97c852d052786e61f7222f52b00dcf155b7f9b00",
  dropped: [
    [
      "feb4e51f6becf4644cc1349d7d876d97b69b97023f1189b31cd65c9401f1bef2",
      'The speaker method/property case uses unsupported speaker sage = "Sage" syntax. The origin intends speaker-member advice, not this parse failure; the original coreRequest skips it as null. (R/astra-m4-i1268-review-r4-evidence/builder/generators/paste-1273.mjs:153,R/astra-m4-i1268-review-r4-evidence/builder/generators/paste-1273.mjs:285)',
    ],
    [
      "4ed6e48b717b24d53686e8cee4d2ac28897fa7bb1318f6b4d88f58a94e6cc2d3",
      'The speaker method/property case uses unsupported speaker sage = "Sage" syntax. The origin intends speaker-member advice, not this parse failure; the original coreRequest skips it as null. (R/astra-m4-i1268-review-r4-evidence/builder/generators/paste-1273.mjs:155,R/astra-m4-i1268-review-r4-evidence/builder/generators/paste-1273.mjs:285)',
    ],
  ],
};
