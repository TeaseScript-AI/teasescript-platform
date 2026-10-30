// F1, Astra r2 (R/astra-m4-f1-review-r2-evidence/cases.mjs): its cases and its work shapes at probe.mjs's work runs' sizes
// (work-quick at 4 and 8, work-0 at 64 and 128).

const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const fields = (n, v, p = "f") =>
  rows(n, (i) => `${p}${i}:${typeof v === "function" ? v(i) : v}`).join(",");
const permutations = (xs) =>
  xs.length === 0
    ? [[]]
    : xs.flatMap((x, i) => permutations(xs.filter((_, j) => i !== j)).map((t) => [x, ...t]));
function caseList() {
  const out = [];
  const add = (name, body) =>
    out.push({ name, files: [{ path: "main.tease", source: body + "\nexit\n" }] });
  for (const reverse of [false, true])
    add(
      `r1-${reverse ? "reverse" : "original"}`,
      `let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[${reverse ? "root,other" : "other,root"}]`,
    );
  const shapes = [
    [
      "mixed-fields",
      'let t:string="oak"\nlet n:integer=7\nlet a={p:t,q:1}\nlet b={p:3,q:n}\nlet c={p:"elm",unique:false}',
      ["a", "b", "c"],
    ],
    [
      "nested-middle",
      'let t:string="oak"\nlet a={box:{p:t,q:1}}\nlet b={box:{p:3,q:2}}\nlet c={box:{p:"elm",only:true}}',
      ["a", "b", "c"],
    ],
    [
      "copy-chain-locals",
      'let t:string="oak"\nlet root={p:t,q:1}\nlet c0=root\nlet c1=c0\nc1.q=2\nlet c2=c1\nc2.only=true\nlet a={p:3,q:2}\nlet b={p:"elm"}',
      ["c2", "a", "b"],
    ],
    [
      "rejected-middle-store",
      'let t:string="oak"\nlet root={p:t,q:1}\nlet a=root\na.p=9\nlet b={p:3}\nlet c={p:"elm"}',
      ["a", "b", "c"],
    ],
    [
      "union",
      'let t:integer|string="oak"\nlet a={p:t,q:1}\nlet b={p:3}\nlet c={p:true,only:null}',
      ["a", "b", "c"],
    ],
    [
      "nullable",
      'let t:string?="oak"\nlet a={p:t}\nlet b={p:null,q:1}\nlet c={p:4}',
      ["a", "b", "c"],
    ],
    [
      "missing-field",
      'let t:string="oak"\nlet a={only:t}\nlet b={elsewhere:1}\nlet c={elsewhere:2}',
      ["a", "b", "c"],
    ],
    [
      "same-identity-locals",
      'let t:string="oak"\nlet root={p:t,q:null}\nlet a=root\na.q=2\nlet b=root\nb.q="elm"\nlet c=root',
      ["a", "b", "c"],
    ],
    [
      "projected",
      'let t:string="oak"\nlet root={box:{p:t},q:0}\nlet cp=root\nlet cp2=cp\ncp2.q=1\nlet a=cp2.box\nlet b={p:3}\nlet c={p:"elm"}',
      ["a", "b", "c"],
    ],
    [
      "two-written",
      'let t:string="oak"\nlet n:integer=7\nlet a={p:t}\nlet b={p:n}\nlet c={p:"elm",single:1}',
      ["a", "b", "c"],
    ],
    [
      "plain-after-landing",
      'let t:string="oak"\nlet root={p:t}\nlet a={p:1}\nlet b={p:"elm"}\nlet c={q:1}\nlet xs=[root]',
      ["a", "b", "c"],
    ],
    [
      "guarded-copy",
      'let t:string="oak"\nlet root={p:t,q:1}\nlet cp=root\nif hostValue == 1 { cp.q=2 }\nlet a=cp\nlet b={p:3}\nlet c={p:"elm"}',
      ["a", "b", "c"],
    ],
  ];
  for (const [name, preamble, els] of shapes) {
    for (const perm of permutations(els)) {
      const body = `${preamble}\n${name === "plain-after-landing" ? "xs=" : "let xs="}[${perm.join(",")}]\nlet read=xs[0]`;
      add(`${name}-${perm.join("-")}`, body);
    }
    add(
      `${name}-guarded`,
      `${preamble}\n${name === "plain-after-landing" ? "" : "let xs=[]"}\nif hostValue == 1 { xs=[${els.join(",")}] }\nlet read=xs[0]`,
    );
    add(`${name}-nested`, `${preamble}\nlet nested=[[${els.join(",")}]]\nlet read=nested[0][0]`);
  }
  for (const value of ["hostValue", "maker()", "root.box", "root.box otherwise {p:3}"])
    for (const rev of [false, true]) {
      add(
        `opaque-${value}-${rev}`,
        `let t:string="oak"\nlet root={box:{p:t},q:1}\nfunction maker { return {p:2} }\nlet other=${value}\nlet xs=[${rev ? "other,root.box" : "root.box,other"}]\nlet r=xs[0].p`,
      );
    }
  for (const form of ["set", "dict"])
    for (const rev of [false, true]) {
      const a = rev ? "other" : "root",
        b = rev ? "root" : "other";
      add(
        `${form}-${rev}`,
        `let t:string="oak"\nlet root={p:t}\nlet other={p:2}\nlet xs=${form === "set" ? `set[${a},${b}]` : `dict{one:${a},two:${b}}`}`,
      );
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
const workShapes = {
  "forest-disjoint-deep": (n) =>
    [
      "let t:integer=1",
      `let root={${fields(n, () => "{inner:{value:t}}", "f")},${fields(n, () => "{inner:{value:1}}", "g")}}`,
      "let a=root",
      "let b=a",
      ...rows(n, (i) => `b.g${i}.inner.value=2`),
      ...rows(n, (i) => `let r${i}=b.f${i}.inner.value`),
      "exit",
    ].join("\n"),
  "forest-overlap-prefix": (n) =>
    [
      "let t:integer=1",
      `let root={${fields(n, () => "{left:t,right:1}")}}`,
      "let a=root",
      "let b=a",
      ...rows(n, (i) => `b.f${i}.right=2`),
      ...rows(n, (i) => `let r${i}=b.f${i}.left`),
      "exit",
    ].join("\n"),
  "forest-overlap-ancestor": (n) =>
    [
      "let t:integer=1",
      `let root={${fields(n, () => "{left:t,right:1}")}}`,
      "let a=root",
      "let b=a",
      ...rows(n, (i) => `b.f${i}.right=2`),
      ...rows(n, (i) => `let r${i}=b.f${i}`),
      "exit",
    ].join("\n"),
  "forest-alternating-levels": (n) =>
    [
      "let t:integer=1",
      `let root={${fields(n, () => "{left:t,right:1}")}}`,
      "let a=root",
      ...rows(n, (i) => `a.f${i}.right=2`),
      "let b=a",
      ...rows(n, (i) => `b.f${i}.left=3`),
      ...rows(n, (i) => `let r${i}=b.f${i}.left`),
      "exit",
    ].join("\n"),
  "shared-literals-projected": (n) =>
    [
      "let t:integer=1",
      `let root={box:{${fields(n, "t")}}}`,
      `let other={box:{${fields(n, "1", "g")}}}`,
      ...rows(n, (i) => `let a${i}=[root.box,other.box]`),
      "exit",
    ].join("\n"),
  "shared-locals-under-wrap": (n) =>
    [
      "let t:integer=1",
      "let root={p:t}",
      "let c0=root",
      ...rows(n, (i) => `let c${i + 1}=c${i}\nc${i + 1}.g${i}=1`),
      ...rows(n, (i) => `let a${i}=[{v:c${n}},{v:{p:2}}]`),
      "exit",
    ].join("\n"),
};

export const sizes = [4, 8, 64, 128];
export const shapes = workShapes;
const generated = [
  ...Array.from(caseList()).map(({ name, files }) => [name, files]),
  // overlap-256-512.jsonl's added selection
  ...[256, 512].map((k) => [
    `forest-overlap-ancestor@${k}`,
    workShapes["forest-overlap-ancestor"](k),
  ]),
];
export const checks = ["publication"];

// Its auxiliary drivers' inputs, each analysed with the default globals (coreRequest's hostValue): trace.mjs's
// forest-overlap-ancestor at 8 to 64, and order.mjs's selection of the cases (every seventh, three-file and r1-).
const traced = [8, 16, 32, 64].map((k) => [
  `trace/forest-overlap-ancestor@${k}`,
  workShapes["forest-overlap-ancestor"](k),
  ["hostValue"],
]);
const ordered = Array.from(caseList())
  .filter(({ name }, i) => i % 7 === 0 || name === "three-file" || name.startsWith("r1-"))
  .map(({ name, files }) => [`order/${name}`, files, ["hostValue"]]);
export const cases = [...generated, ...traced, ...ordered];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node probe.mjs --mode=answers; --mode=work at 4 and 8 (work-quick), at 64 and 128 (work-0) and the overlap at 256 and 512; trace.mjs, validate.mjs and order.mjs",
      "R/astra-m4-f1-review-r2-evidence/ (each run's results)",
    ],
  ],
  sources: 159,
  sha256: "cc98d4493f5478c7ad073b6438402f85be29f5dcbf9232d6cbcb08f96331900d",
};
