// complete depth/location/wrapper/source/event/option product at 3/10 fields; #1278, Astra review, r2
// (R/astra-m4-i1278-review-r2-evidence/builder-evidence/generators/fam1233.mjs).
const many = (n, f, by = "\n") => Array.from({ length: n }, (_, i) => f(i)).join(by);
const WRAPS = {
  none: [(x) => x, ""],
  list: [(x) => `[${x}]`, ".first"],
  object: [(x) => `{v: ${x}}`, ".v"],
  selects: [(x) => `{value: ${x}}`, ".value"],
  text: [(x) => `{text: "t", v: ${x}}`, ".v"],
  nested: [(x) => `[{value: ${x}}]`, ".first.value"],
  pair: [(x) => `[{value: ${x}}, {value: ${x}}]`, ".first.value"],
  dict: [(x) => `dict {k: ${x}}`, ".values.first"],
};
function program(k, a) {
  const { depth, where, wrap, sources, between, options } = a;
  const [w, read] = WRAPS[wrap];
  const lines = [];
  lines.push(
    between === "ingress"
      ? "let payload = hostValue"
      : `let payload = {${many(k, (i) => `f${i}: 1`, ", ")}}`,
  );
  if (sources !== "one")
    lines.push(
      `let second = {${many(k, (i) => `f${i}: ${sources === "same" || i % 2 ? "1" : "2.5"}`, ", ")}}`,
    );
  if (where === "loop") lines.push('let flag = askBoolean "flag"', "while flag {");
  const source = (i) => (sources !== "one" && i % 2 ? "second" : "payload");
  if (depth >= 2) lines.push(many(k, (i) => `let q${i} = ${source(i)}`));
  if (depth >= 1) lines.push(many(k, (i) => `let p${i} = ${depth >= 2 ? `q${i}` : source(i)}`));
  const held = (i) => (depth >= 1 ? `p${i}` : source(i));
  if (between === "store") lines.push(`${held(0)}.f0 = 2.5`);
  if (between === "guard") lines.push(`if ${held(0)}.f0 != null {`);
  const list = `[${many(k, (i) => `{text: "${i}", value: ${w(held(i))}}`, ", ")}]`;
  lines.push(
    options === "inline"
      ? `let picked = askChoice ${list}`
      : `let options = ${list}\nlet picked = askChoice options`,
  );
  lines.push(many(k, (i) => `repeat picked${read}.f${i} {}`));
  if (between === "guard") lines.push("}");
  if (where === "loop") lines.push("payload.f0 = 2.5", "}");
  lines.push("exit");
  return lines.join("\n");
}
// r4's witness: equal merged properties, different selections (semantics only)
const R4 = [
  'let options = [{text: "a", value: {choices: [{value: 1, text: "x"}, {text: null}]}}, {text: "b", value: {choices: [{value: 1, text: null}, {text: "x"}]}}]',
  "let outer = askChoice options",
  "let picked = askChoice outer.choices",
  "let n: integer? = picked",
  "say n",
  "exit",
].join("\n");

const AXES = {
  depth: [0, 1, 2],
  where: ["top", "loop"],
  wrap: Object.keys(WRAPS),
  sources: ["one", "same", "diff"],
  between: ["none", "guard", "store", "ingress"],
  options: ["bound", "inline"],
};
function* product() {
  for (const depth of AXES.depth)
    for (const where of AXES.where)
      for (const wrap of AXES.wrap)
        for (const sources of AXES.sources)
          for (const between of AXES.between)
            for (const options of AXES.options)
              yield { depth, where, wrap, sources, between, options };
}
const nameOf = (a) => `${a.depth}-${a.where}-${a.wrap}-${a.sources}-${a.between}-${a.options}`;

export const sizes = [3, 10];
export const shapes = Object.fromEntries(
  Array.from(product(), (a) => [nameOf(a), (n) => program(n, a)]),
);
export const cases = [["r4-witness", R4]];

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node bin/fam1233.mjs sem base3/dist $tree/dist out/$label/fam1233-$i.jsonl $i 2",
      "R/astra-m4-i1278-review-r2-evidence/builder-evidence/generators/queue-sem3.sh:11",
    ],
  ],
  sources: 2305,
  sha256: "bebf62df0687faf26ee9f4a2f74f729992fdd04cb7f88dac2802b98afb706b01",
};
