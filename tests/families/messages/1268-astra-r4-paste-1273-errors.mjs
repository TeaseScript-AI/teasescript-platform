// #1268; Astra review; shared generation code from one original module.
export const sizes = [4, 8];
const outputs = (() => {
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
  const cases0 = (() => {
    return ERRORS.map(([name, source]) => [name, source]);
  })();
  const cases1 = (() => {
    return NULLABLE.map(([name, source]) => [name, source]);
  })();
  const cases2 = (() => {
    return OTHERS.map(([name, source]) => [name, source]);
  })();
  const cases3 = (() => {
    return PRESENT.map(([name, source]) => [name, source]);
  })();
  const shapes4 = (() => {
    return {
      "say/1": (n) => USES[0][1](n),
      "let/1": (n) => USES[1][1](n),
      "store/1": (n) => USES[2][1](n),
      "if/1": (n) => USES[3][1](n),
      "repeat/1": (n) => USES[4][1](n),
      "interpolation/1": (n) => USES[5][1](n),
      "argument/1": (n) => USES[6][1](n),
      "divisor/1": (n) => USES[7][1](n),
      "product/1": (n) => USES[8][1](n),
      "negation/1": (n) => USES[9][1](n),
      "block/1": (n) => USES[10][1](n),
      "one-line block/1": (n) => USES[11][1](n),
      "return/1": (n) => USES[12][1](n),
      "while/1": (n) => USES[13][1](n),
      "or/1": (n) => USES[14][1](n),
      "timer/1": (n) => USES[15][1](n),
      "list literal/1": (n) => USES[16][1](n),
      "two reads/1": (n) => USES[17][1](n),
      "comparison/1": (n) => USES[18][1](n),
    };
  })();
  return { cases0, cases1, cases2, cases3, shapes4 };
})();
export const cases = [...outputs.cases0, ...outputs.cases1, ...outputs.cases2, ...outputs.cases3];
export const shapes = Object.fromEntries([
  ...Object.entries(outputs.shapes4).map(([name, make]) => ["shapes4/" + name, make]),
]);
export const checks = ["publication"];
