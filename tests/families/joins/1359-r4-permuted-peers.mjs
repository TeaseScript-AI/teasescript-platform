// #1359 r4: permuted peers and aliases (desktop:~/work/evidence/1417/a0abf39f0/tools/r4-own-shapes.mjs).

const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
const choice = (k, host = "hostValue", wrap = (x) => x) =>
  `askChoice ${many(k, (i) => `{text: "${i}", value: ${wrap(`${host}.f${i}`)}}`, ", ")}`;
const prefix = (k, wrap = (x) => x) =>
  `let left = ${choice(k, "hostValue", wrap)}\nlet mid = ${choice(k, "hostValue", wrap)}\nlet right = ${choice(k, "hostValue", wrap)}\n`;
const sites = (k, form, tail = "") =>
  many(k, (i) => `let xs${i} = [${form(i)}]\nlet n${i}: integer = xs${i}[hostValue.i]${tail}`) +
  "\nexit";
export const shapes = {
  permutedPeers: (k) =>
    prefix(k) +
    sites(
      k,
      (i) =>
        ["left, mid, right", "right, left", "mid, right, left", "left, left, right", "right, mid"][
          i % 5
        ],
    ),
  aliases: (k) =>
    prefix(k) + "let a = left\nlet b = right\n" + sites(k, (i) => (i % 2 ? "a, right" : "left, b")),
  objectChoicePeers: (k) =>
    prefix(k, (x) => `{n: ${x}}`) +
    sites(k, (i) => (i % 2 ? "right, left" : "left, mid, right"), ".n"),
  nestedChoicePeers: (k) =>
    prefix(k, (x) => `[${x}]`) +
    sites(k, (i) => (i % 2 ? "right, left" : "left, mid, right"), "[hostValue.j]"),
  parseChoicePeers: (k) =>
    prefix(k, (x) => `fromJson("{}", default: ${x})`) + sites(k, () => "left, right"),
  loadChoicePeers: (k) =>
    prefix(k, (x) => `load("x", default: ${x})`) + sites(k, () => "left, mid, right"),
  choiceSites: (k) =>
    prefix(k) +
    many(
      k,
      (i) =>
        `let v${i} = askChoice {text: "a", value: left}, {text: "b", value: right}\nlet n${i}: integer = v${i}`,
    ) +
    "\nexit",
  addedSites: (k) =>
    prefix(k) +
    many(
      k,
      (i) =>
        `let xs${i} = [left]\nxs${i}.add(right)\nxs${i}.add(mid)\nlet n${i}: integer = xs${i}[hostValue.i]`,
    ) +
    "\nexit",
  narrowedSites: (k) =>
    prefix(k) +
    many(
      k,
      (i) =>
        `if left is integer {\nlet xs${i} = [left, right]\nlet n${i}: integer = xs${i}[hostValue.i]\n}`,
    ) +
    "\nexit",
  alternatingGlobals: (k) =>
    `let left = ${choice(k)}\nlet right = ${choice(k, "otherHost")}\n` +
    sites(k, () => "left, right"),
};
// (its own cases, which no recorded run compiled, stay unexported)
const cases = [];
for (const [name, make] of Object.entries(shapes))
  for (const k of [3, 7])
    cases.push({ name: `${name}@${k}`, files: [{ path: "main.tease", source: make(k) }] });
const sources = [
  "{n: hostValue.a, q: 0}",
  "{n: hostValue.b, q: 0}",
  'load("a", default: {n: hostValue.a, q: 0})',
  'fromJson("{}", default: {n: hostValue.b, q: 0})',
  '(load("a", default: hostValue) otherwise {n: 0, q: 0})',
];
for (const padding of [0, 12])
  for (const middle of sources) {
    const source = [
      padding ? `let pad = [${many(padding, (i) => `{p${i}: hostValue}`, ", ")}]\nsay pad[0]` : "",
      `let a = ${sources[0]}`,
      `let b = ${middle}`,
      `let c = ${sources[1]}`,
      "let xs = [a, b, c]\nlet ys = [c, b, a]",
      "if hostValue.a is integer { let n: integer = xs[hostValue.i].n }",
      "let n: integer = ys[hostValue.i].n",
      "exit",
    ].join("\n");
    cases.push({
      name: `conflict-${padding}-${sources.indexOf(middle)}`,
      files: [{ path: "main.tease", source }],
    });
  }
for (const body of [
  "xs.add(hostValue.b)",
  "if hostValue.flag { xs = [otherHost.c] } else { xs.add(hostValue.b) }",
])
  cases.push({
    name: `growing-${cases.length}`,
    files: [
      {
        path: "main.tease",
        source: `let xs = [hostValue.a]\nrepeat 3 {\n${body}\nlet ys = [xs, xs]\nlet n: integer = ys[hostValue.i][hostValue.j]\n}\nexit`,
      },
    ],
  });

export const sizes = [1, 2, 3, 5, 8, 9, 64, 128]; // the recorded consumers' sizes
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "otherHost"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node growth.mjs <tree> desktop:~/work/evidence/1417/a0abf39f0/tools/r4-own-shapes.mjs all 64 src,rev,srcOff,revOff literalUnits,mergeItems,checks,invSteps",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:20",
    ],
    [
      "node answers.mjs <tree> <out> shapes desktop:~/work/evidence/1417/a0abf39f0/tools/r4-own-shapes.mjs 1,3,8",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:26",
    ],
    [
      "node oracle-run.mjs <base> <head> <out> desktop:~/work/evidence/1417/a0abf39f0/tools/r4-own-shapes.mjs",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:34",
    ],
  ],
  sources: 80,
  sha256: "dbf6d0836225823fa0651af7d21ec5e30f75e72e6b73851401b8aeacb1824838",
};
