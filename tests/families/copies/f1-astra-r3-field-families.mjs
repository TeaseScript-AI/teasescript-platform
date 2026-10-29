// complete field families, independent 64/128 store/read matrix, and original instrument sizes; Astra review, r3
// (R/astra-m4-f1-review-r3-evidence/cases.mjs).
const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const fields = (n, f) => rows(n, (i) => `f${i}:${f(i)}`).join(",");
const source = (...xs) => xs.flat(Infinity).join("\n") + "\n";
const wrap = (d, v) => (d === 0 ? v : `{a:${wrap(d - 1, v)}}`);
const tail = (d) => ".a".repeat(d);
function layered(n, kind = "point", depth = 2) {
  const leaf = kind === "copy" ? "{leaf:t,slot:w}" : "{leaf:t,slot:1}";
  const value = {
    point: "2",
    read: "plain.f0",
    opaque: "hostValue",
    call: "make()",
    copy: "w",
    reject: '"wrong"',
  }[kind];
  return source(
    "let t:integer=1",
    "let w={q:t,r:1}",
    "function make { return 2 }",
    `let plain={${fields(n, () => "3")}}`,
    `let root={${fields(n, (i) => wrap(depth, leaf))},extra:{${fields(n, () => "1")}}}`,
    "let a=root",
    "let b=a",
    rows(n, (i) =>
      i % 2 === 0 ? `a.f${i}${tail(depth)}.${kind === "reject" ? "leaf" : "slot"}=${value}` : [],
    ),
    rows(n, (i) => `b.extra.f${i}=4`),
    rows(n, (i) => `let read${i}=b.f${i}${tail(i % 3 === 0 ? 0 : depth)}`),
    "exit",
  );
}
const workShapes = {
  "r3-layered-points": (n) => layered(n),
  "r3-layered-reads": (n) => layered(n, "read", 1),
  "r3-layered-host": (n) => layered(n, "opaque", 3),
  "r3-layered-calls": (n) => layered(n, "call", 2),
  "r3-layered-copies": (n) => layered(n, "copy", 2),
  "r3-retaken": (n) => layered(n, "reject", 1),
  "r3-sibling-depths": (n) =>
    source(
      "let t:integer=1",
      `let root={${fields(n, () => "{a:{leaf:t,slot:1},b:{leaf:t,slot:1}}")}}`,
      "let a=root",
      "let b=a",
      rows(n, (i) => `a.f${i}.a.slot=2`),
      rows(n, (i) => (i % 2 ? `b.f${i}.b.slot=3` : [])),
      rows(n, (i) => `let r${i}=b.f${i}.${i % 2 ? "a" : "b"}`),
      "exit",
    ),
  "r3-fed-cycle": (n) =>
    source(
      "let t:integer=1",
      `let root={${fields(n, () => "{a:{leaf:t,slot:1},other:1}")}}`,
      "let a=root",
      "let b=a",
      "a=b",
      rows(n, (i) => `b.f${i}.a.slot=2`),
      rows(n, (i) => `let r${i}=a.f${i}.a`),
      "exit",
    ),
  "r3-fed-retaken": (n) =>
    source(
      "let t:integer=1",
      `let root={${fields(n, () => "{a:{leaf:t,slot:1},other:1}")}}`,
      "let a=root",
      "let b=a",
      "a=b",
      rows(n, (i) => `b.f${i}.a.leaf="wrong"`),
      rows(n, (i) => `let r${i}=a.f${i}.a`),
      "exit",
    ),
  "r3-root-copies": (n) =>
    source(
      "let t:integer=1",
      rows(n, (i) => `let root${i}={f${i}:{leaf:t,slot:1}}`),
      "let a=root0",
      rows(n - 1, (i) => `a=root${i + 1}`),
      rows(n, (i) => `let r${i}=a.f${i}`),
      "exit",
    ),
  "r3-landing-copies": (n) =>
    source(
      "let t:integer=1",
      `let root={${fields(n, () => "{a:{leaf:t,slot:1},other:1}")}}`,
      `let a={${fields(n, () => "{a:{leaf:1,slot:1},other:1}")}}`,
      rows(n, (i) => `a.f${i}=root.f${i}`),
      rows(n, (i) => `a.f${i}.a.slot=2`),
      rows(n, (i) => `let r${i}=a.f${i}.a`),
      "exit",
    ),
  "r3-unfed-cycle": (n) =>
    source(
      "let t:integer=1",
      "let a=null",
      "let b=a",
      "a=b",
      rows(n, (i) => `a.f${i}={a:{leaf:t,slot:1}}`),
      rows(n, (i) => `let r${i}=b.f${i}.a`),
      "exit",
    ),
};
function axes(stores, reads) {
  return source(
    "let t:integer=1",
    `let root={${fields(128, () => "{a:{leaf:t,slot:1}}")},extra:{${fields(128, () => "1")}}}`,
    "let a=root",
    "let b=a",
    rows(128, (i) => `a.f${i}.a.slot=2`),
    rows(stores, (i) => `b.extra.f${i}=3`),
    rows(reads, (i) => `let r${i}=b.f${i}.a`),
    "exit",
  );
}
function semanticCases() {
  const out = Object.entries(workShapes).flatMap(([name, f]) =>
    [3, 6].map((n) => ({ name: `${name}-${n}`, files: [{ path: "main.tease", source: f(n) }] })),
  );
  for (const d of [0, 1, 4, 8])
    for (const kind of ["point", "read", "opaque", "call", "copy", "reject"])
      out.push({
        name: `depth-${d}-${kind}`,
        files: [{ path: "main.tease", source: layered(4, kind, d) }],
      });
  for (const reverse of [false, true])
    for (const guarded of [false, true])
      for (const collection of ["list", "set", "dict"]) {
        const names = reverse ? ["plain", "b", "root"] : ["root", "b", "plain"];
        const literal =
          collection === "dict"
            ? `dict{x:${names[0]},y:${names[1]},z:${names[2]}}`
            : `${collection === "set" ? "set" : ""}[${names}]`;
        out.push({
          name: `meeting-${reverse}-${guarded}-${collection}`,
          files: [
            {
              path: "main.tease",
              source: source(
                'let t:string="ok"',
                "let root={q:{leaf:t,slot:1}}",
                "let a=root",
                "let b=a",
                "b.q.slot=2",
                "let plain={q:{leaf:3,slot:2}}",
                guarded ? `let xs=[]\nif hostValue == 1 { xs=${literal} }` : `let xs=${literal}`,
                "exit",
              ),
            },
          ],
        });
      }
  out.push({
    name: "three-file",
    files: [
      { path: "z.tease", source: 'let t:string="z"\nlet r={p:t}\nlet a=[{p:1},r]\nexit\n' },
      { path: "main.tease", source: 'let t:string="m"\nlet r={p:t}\nlet a=[r,{p:1}]\nexit\n' },
      { path: "a.tease", source: 'let t:integer=2\nlet r={p:t}\nlet a=[r,{p:"a"}]\nexit\n' },
    ],
  });
  return out;
}

// probe.mjs's work runs: the quick one at 4 and 8, the scale ones at 64 to 512
export const sizes = [4, 8, 64, 128, 256, 512];
export const shapes = workShapes;
export const cases = [
  ...semanticCases().map(({ name, files }) => [name, files]),
  ...[64, 128].flatMap((stores) =>
    [64, 128].map((reads) => [`axes/${stores}/${reads}`, axes(stores, reads)]),
  ),
  // instrument.mjs --extra=layered --sizes=8,16,32
  ...[16, 32].map((k) => [`r3-layered-copies@${k}`, workShapes["r3-layered-copies"](k)]),
];
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node probe.mjs --mode=quick; --mode=answers; --mode=work --sizes=4,8; --mode=work --sizes=64,128,256,512 --part=0..2 --parts=3; --shape=r3-root-copies and r3-layered-copies at their sizes",
      "R/astra-m4-f1-review-r3-evidence/reproduce.sh:15-40",
    ],
    [
      "node charge-series.mjs --mode=axes; node instrument.mjs --extra=layered --sizes=8,16,32",
      "R/astra-m4-f1-review-r3-evidence/reproduce.sh:32, 39",
    ],
  ],
  sources: 137,
  sha256: "5d1339d2f6617ce6726cf4cef305e3af3a6397e3bc8d8e8b16c38bda606968cf",
};
