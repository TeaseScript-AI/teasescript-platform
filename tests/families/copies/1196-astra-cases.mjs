// #1196, Astra review (R/astra-m4-i1196-review-evidence/review-cases.mjs): its cases, and scaleCase's families as
// review-runner.mjs:57-60 selected them, each with its own globals (an input per member): the quick mode at (3, 3), the
// scale mode at (64, 64) and (128, 128), and the axes mode at (8, 24) and (24, 8).
const parse = (input, fallback = "seed", files = "false") =>
  `fromJson(${input}${fallback === null ? "" : `, default: ${fallback}`}, files: ${files})`;
const own = [];
const add = (name, lines, globals = ["hostValue", "otherHost", "thirdHost"]) =>
  own.push({
    name,
    globals,
    files: [{ path: "main.tease", source: [...lines, "exit", ""].join("\n") }],
  });
add("nested-list-leaves", [
  "let box = [{a: [hostValue]}, {a: [hostValue]}, {a: [hostValue]}]",
  "let n: integer = box[0].a[0]",
]);
add("nested-record-leaves", [
  "let box = [{a: {b: hostValue}}, {a: {b: hostValue}}, {a: {b: hostValue}}]",
  "let n: integer = box.last.a.b",
]);
add("several-globals-leaves", [
  "let box = [{a: hostValue}, {a: otherHost}, {a: hostValue}, {a: thirdHost}]",
  "let n: integer = box[0].a",
]);
add("root-versus-projection", [
  "let box = [[hostValue.text], [hostValue], [hostValue.text], [otherHost.text]]",
  "let n: integer = box.first[0]",
]);
add("otherwise-nested", [
  "let box = [{a: hostValue otherwise null}, {a: hostValue otherwise null}, {a: otherHost otherwise null}]",
  "let n: integer = box[0].a",
]);
add("choice-nested", [
  'let chosen = askChoice {text: "x", value: {a: [hostValue]}}, {text: "y", value: {a: [hostValue]}}, {text: "z", value: {a: [otherHost]}}',
  "let n: integer = chosen.a[0]",
]);
add("call-arguments", [
  "function echo(x) { return x }",
  "let box = [echo({a: hostValue}), echo({a: hostValue}), echo({a: otherHost})]",
  "let n: integer = box[0].a",
]);
add("typed-call-arguments", [
  "function sumValues(x: integer, y: integer) { return x + y }",
  "let n = sumValues(hostValue, hostValue)",
  "let m = sumValues(otherHost, hostValue)",
]);
add("guarded-root", [
  "let raw = hostValue",
  "if hostValue is string {",
  " let box = [[hostValue], [hostValue], [raw], [otherHost]]",
  " let n: integer = box[0][0]",
  "}",
  "let outside: integer = hostValue",
]);
add("guarded-descendant", [
  "let before = {a: hostValue}",
  "if hostValue.text is string {",
  " let box = [{a: hostValue}, {a: hostValue}, before]",
  " let n: integer = box[0].a.text",
  "}",
  "let after: integer = hostValue.text",
]);
add("guarded-siblings", [
  "if hostValue.left is integer {",
  " let a = [hostValue, hostValue]",
  " let n: integer = a[0].left",
  "}",
  "if hostValue.right is string {",
  " let b = [hostValue, hostValue]",
  " let m: integer = b[0].left",
  "}",
]);
add("written-list-landings", [
  `let a: number[][] = [${parse("hostValue", "[1]")}, ${parse("hostValue", "[1]")}]`,
  `let b: integer[][] = [${parse("hostValue", "[1]")}, ${parse("otherHost", "[1]")}]`,
  "let n: integer = a[0][0]",
  "repeat b[0][0] {}",
]);
add("null-open-fields", [
  "let seed = {count: 2, child: {open: null}, list: []}",
  `let box = [${parse("hostValue")}, ${parse("hostValue")}, ${parse("otherHost")}]`,
  "repeat box[0].count {}",
  "let n: integer = box[0].child.open",
  "let m: integer = box[0].list[0]",
]);
add("host-open-default", [
  "let seed = {count: 2, child: {open: otherHost}}",
  `let box = [${parse("hostValue")}, ${parse("hostValue")}, ${parse("thirdHost")}]`,
  "let n: integer = box[0].child.open",
]);
for (const files of ["true", "false", "hostValue"])
  add(`files-${files}`, [
    "let seed = {count: 2}",
    `let box = [${parse("hostValue", "seed", files)}, ${parse("hostValue", "seed", "false")}, ${parse("otherHost", "seed", "true")}]`,
    "repeat box[0].count {}",
  ]);
add("defaults-nested-different", [
  "let a = {child: {n: 1}, open: null}",
  "let b = {child: {n: 1.5}, open: null}",
  `let box = [${parse("hostValue", "a")}, ${parse("hostValue", "b")}, ${parse("hostValue", "a")}]`,
  "let n: integer = box[0].child.n",
  "let m: integer = box[0].open",
]);
add("open-and-typed-parses", [
  "let seed = {a: {n: 1}}",
  `let box = [${parse("hostValue", null)}, ${parse("hostValue")}, ${parse("hostValue", null)}, ${parse("hostValue")}]`,
  "let n: integer = box[0].a.n",
]);
add("guarded-parse-options", [
  "let seed = {n: 1}",
  `let before = ${parse("hostValue.text")}`,
  "if hostValue.text is string {",
  ` let box = [${parse("hostValue.text")}, ${parse("hostValue")}, before, ${parse("hostValue.text")}]`,
  " repeat box[0].n {}",
  "}",
]);
add("reassigned-default", [
  "let seed = {a: {n: 1}}",
  `let old = ${parse("hostValue")}`,
  "seed.a.n = 2.5",
  `let box = [old, ${parse("hostValue")}, ${parse("otherHost")}]`,
  "let n: integer = box[0].a.n",
]);
add("call-writes-default", [
  "global seed = {a: {n: 1}}",
  "function change {",
  " seed.a.n = 2.5",
  " return hostValue",
  "}",
  `let box = [${parse("hostValue")}, ${parse("change()")}, ${parse("hostValue")}]`,
  "let n: integer = box[0].a.n",
]);
add("alias-of-parsed", [
  "let seed = {a: {n: 1}, open: null}",
  `let parsed = ${parse("hostValue")}`,
  "let one = parsed",
  "let two = one",
  `let box = [one, two, ${parse("hostValue")}, parsed]`,
  "repeat box[0].a.n {}",
  "let n: integer = box[0].open",
]);
add("nested-parse-carriers", [
  "let seed = {a: {n: 1}, open: null}",
  `let box = [{x: {y: ${parse("hostValue")}}}, {x: {y: ${parse("hostValue")}}}, {x: {y: ${parse("otherHost")}}}]`,
  "repeat box[0].x.y.a.n {}",
  "let n: integer = box[0].x.y.open",
]);
add("load-with-direct-default", [
  'let box = [load("alpha", default: hostValue), load("beta", default: hostValue), load("alpha", default: otherHost)]',
  "let n: integer = box[0].count",
]);
add("computed-key-and-nested-parse", [
  "let seed = {n: 1}",
  `let box = [load(hostValue, default: ${parse("otherHost")}), load(otherHost, default: ${parse("hostValue")})]`,
  "repeat box[0].n {}",
]);
add("adds-and-nested-wrappers", [
  "let box = []",
  "box.add({a: [hostValue]})",
  "box.add({a: [hostValue]})",
  "box.add({a: [otherHost]})",
  "let n: integer = box.last.a[0]",
]);
add("set-and-concatenation", [
  "let a = [{n: hostValue}] + [{n: hostValue}] + [{n: otherHost}]",
  "let b = set[hostValue, hostValue, otherHost]",
  "let n: integer = a[0].n",
  "let m: integer = b.first",
]);
add("separate-file-reads", [
  "let a = {n: hostValue}",
  "let b = {n: hostValue}",
  "let n: integer = a.n",
  "let m: integer = b.n",
]);
own
  .at(-1)
  .files.push({
    path: "other.tease",
    source:
      "let c = [{n: hostValue}, {n: otherHost}, {n: hostValue}]\nlet k: integer = c[0].n\nexit\n",
  });

function scaleCase(family, f, c) {
  const fields = Array.from({ length: f }, (_, i) => `v${i}:1`).join(",");
  const raw = {
    direct: "hostValue",
    projected: "hostValue.text",
    indexed: "[hostValue][0]",
    named: "raw",
    constant: '"{}"',
  }[family];
  const globals = ["hostValue", ...Array.from({ length: c }, (_, i) => `input${i}`)];
  const lines = family === "named" ? ["let raw = hostValue"] : [];
  lines.push(`let seed = {${fields}}`);
  let member;
  let path = "box[0]";
  if (raw) member = () => parse(raw);
  else if (family === "nested-records") {
    member = () => `{outer: {payload: ${parse("hostValue")}}}`;
    path += " .outer.payload";
  } else if (family === "many-globals") member = (i) => parse(`input${i}`);
  else if (family === "stored-aliases") {
    lines.push(`let parsed = ${parse("hostValue")}`, "let first = parsed");
    for (let i = 0; i < c; i++) lines.push(`let alias${i} = first`);
    member = (i) => `alias${i}`;
  } else if (family === "literal-identity")
    member = () => "({noise: hostValue, outer: {payload: seed}}).outer.payload";
  else if (family === "mixed-index") member = () => "[hostValue][0]";
  else if (family === "mixed-load") member = () => 'load("state", default: hostValue)';
  else if (family === "otherwise") member = () => "hostValue otherwise seed";
  else if (family === "nested-load-parse")
    member = () => `load("state", default: ${parse("hostValue")})`;
  else if (family === "computed-load") member = () => "load(hostValue, default: seed)";
  else throw Error(family);
  lines.push(`let box = [${Array.from({ length: c }, (_, i) => member(i)).join(",")}]`);
  for (let i = f - 1; i >= 0; i--) lines.push(`repeat ${path}.v${i} {}`);
  lines.push("exit", "");
  return {
    name: `${family}-${f}-${c}`,
    globals,
    files: [{ path: "main.tease", source: lines.join("\n") }],
  };
}

const families = [
  "direct",
  "projected",
  "indexed",
  "named",
  "constant",
  "nested-records",
  "many-globals",
  "stored-aliases",
  "literal-identity",
  "mixed-index",
  "mixed-load",
  "otherwise",
  "nested-load-parse",
  "computed-load",
];
const scaled = [
  ...families.map((family) => scaleCase(family, 3, 3)),
  ...families.flatMap((family) =>
    [
      [64, 64],
      [128, 128],
    ].map(([f, c]) => scaleCase(family, f, c)),
  ),
  ...families.slice(0, 5).flatMap((family) =>
    [
      [8, 24],
      [24, 8],
    ].map(([f, c]) => scaleCase(family, f, c)),
  ),
];
export const cases = [...own, ...scaled].map(({ name, files, globals }) => [name, files, globals]);
export const checks = ["publication"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      '{"done":true,"mode":"correctness","shard":"0/1","cases":29,"analyses":232,"mismatches":0}',
      "R/astra-m4-i1196-review-evidence/results/correctness-0.jsonl:237",
    ],
    [
      '{"done":true,"mode":"quick","shard":"0/1","cases":14,"analyses":112,"mismatches":0}',
      "R/astra-m4-i1196-review-evidence/results/quick-0.jsonl:113",
    ],
    [
      '{"done":true,"mode":"axes","shard":"0/1","cases":10,"analyses":80,"mismatches":0}',
      "R/astra-m4-i1196-review-evidence/results/axes-0.jsonl:81",
    ],
    [
      '{"done":true,"mode":"scale","shard":"0/2","cases":14,"analyses":112,"mismatches":0}',
      "R/astra-m4-i1196-review-evidence/results/scale-0.jsonl:113",
    ],
    [
      '{"done":true,"mode":"scale","shard":"1/2","cases":14,"analyses":112,"mismatches":0}',
      "R/astra-m4-i1196-review-evidence/results/scale-1.jsonl:113",
    ],
  ],
  sources: 81,
  sha256: "5ef2db8e40812fb8af4b4860789f913c1c2bd30ba91a33888cf895e993767792",
};
