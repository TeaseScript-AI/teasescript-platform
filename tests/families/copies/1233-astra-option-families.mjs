// #1233, Astra review (R/astra-m4-i1233-review-evidence/cases.mjs): the option families, as review.mjs's independent and
// growth jobs compiled them, and the four residual variants residuals.mjs built from them at 64, 128 and 256.

export const wrappers = {
  direct: (x) => [x, ""],
  list: (x) => [`[${x}]`, ".first"],
  object: (x) => [`{inside:${x}}`, ".inside"],
  selected: (x) => [`{value:${x},text:null}`, ".value"],
  text: (x) => [`{text:${x}}`, ".text"],
  pair: (x) => [`[{value:${x},text:null},{value:${x},text:"two"}]`, ".first.value"],
  dict: (x) => [`dict {a:${x},b:${x}}`, ".values.first"],
};
const many = (k, fn, sep = "\n") => Array.from({ length: k }, (_, i) => fn(i)).join(sep);
export function family(
  k,
  { depth = 0, wrap = "direct", variant = "plain", inline = false, loop = false } = {},
) {
  const obj = (value) => `{${many(k, (i) => `f${i}:${value}`, ",")}}`;
  const lines = [`let source=${variant === "host-bound" ? "hostValue" : obj("1")}`];
  if (variant.startsWith("two"))
    lines.push(`let other=${obj(variant === "two-different" ? '"s"' : "2")}`);
  if (loop) lines.push("repeat 2 {", "source.f0=3");
  const alias = (i) =>
    depth === 0
      ? variant.startsWith("two") && i % 2
        ? "other"
        : variant === "host-direct"
          ? "hostValue"
          : "source"
      : `a${depth - 1}_${i}`;
  for (let d = 0; d < depth; d++)
    lines.push(
      many(
        k,
        (i) =>
          `let a${d}_${i}=${d === 0 ? (variant.startsWith("two") && i % 2 ? "other" : variant === "host-direct" ? "hostValue" : "source") : `a${d - 1}_${i}`}`,
      ),
    );
  if (variant === "store-leaf" && depth) lines.push(`${alias(0)}.f0="s"`);
  if (variant === "store-whole" && depth) lines.push(`${alias(0)}={f0:"s"}`);
  if (variant === "guard") lines.push(`if ${alias(0)}.f0 is integer {`);
  const options = `[${many(k, (i) => `{text:"${i}",value:${wrappers[wrap](alias(i))[0]}}`, ",")}]`;
  if (!inline) lines.push(`let options=${options}`);
  if (variant === "store-option" && !inline) lines.push('options[0].value={f0:"changed"}');
  lines.push(`let picked=askChoice ${inline ? options : "options"}`);
  const suffix = wrappers[wrap]("source")[1];
  lines.push(many(k, (i) => `repeat picked${suffix}.f${i} {}`));
  if (variant === "guard") lines.push("}");
  if (loop) lines.push("}");
  lines.push("exit");
  return lines.join("\n");
}
export function independent() {
  const out = [];
  for (const depth of [0, 1, 3])
    for (const wrap of Object.keys(wrappers))
      for (const variant of [
        "plain",
        "two-same",
        "two-different",
        "host-bound",
        "host-direct",
        "store-leaf",
        "store-whole",
        "guard",
        "store-option",
      ])
        for (const inline of [false, true]) {
          if ((variant === "store-leaf" || variant === "store-whole") && !depth) continue;
          if (variant === "store-option" && inline) continue;
          const spec = { depth, wrap, variant, inline, loop: out.length % 5 === 0 };
          out.push({ name: JSON.stringify(spec), source: family(out.length % 2 ? 3 : 7, spec) });
        }
  const atoms = [
    "1",
    '"a"',
    "null",
    "[]",
    "set []",
    "dict {}",
    "{}",
    "{x:1}",
    '{x:"s"}',
    "{x:null}",
    "{value:1,text:null}",
    '{text:"s"}',
    '{value:null,text:"s"}',
    "{value:[{text:1},{value:null}]}",
  ];
  for (let i = 0; i < atoms.length; i++)
    for (let j = 0; j < atoms.length; j++) {
      out.push({
        name: `nested-selection-${i}-${j}`,
        source: `let options=[{value:{choices:[${atoms[i]},${atoms[j]}]},text:"a"},{value:{choices:[${atoms[j]},${atoms[i]}]},text:"b"}]\nlet outer=askChoice options\nlet p=askChoice outer.choices\nlet n:integer?=p\nsay p.x\nsay p.missing\nsay n\nexit`,
      });
    }
  for (const literal of ["{f:1}", "{f:null}", "{f:hostValue}", "hostValue", "{}"])
    for (const between of ["", "a.f=2", 'a.f="s"', 'source.f="s"', 'a={f:"s"}', "a=b", "b=a"])
      for (const post of ["", 'options[1].value={f:"s"}', 'options[0].value.f="s"']) {
        out.push({
          name: `between-${out.length}`,
          source: `let source=${literal}\nlet a=source\nlet b=a\n${between}\nlet options=[{text:"a",value:a},{text:"b",value:b},{text:"c",value:source}]\n${post}\nlet p=askChoice options\nlet n:integer?=p.f\nsay p.missing\nsay n\nexit`,
        });
      }
  for (const condition of [
    "source.f is integer",
    "source is object",
    "a.f is integer",
    "a is object",
  ])
    for (const expr of ["a", "[a]", "{value:a}", "[{value:a},{text:a}]"]) {
      out.push({
        name: `guard-flow-${condition}-${expr}`,
        source: `let source=hostValue\nlet a=source\nlet options=[]\noptions.add({value:${expr},text:"before"})\nif ${condition} { options.add({value:${expr},text:"inside"}) }\noptions.add({value:${expr},text:"after"})\nlet p=askChoice options\nsay p.f\nsay p.first.value.f\nsay p.missing\nexit`,
      });
    }
  out.push({
    name: "r4-boundary",
    source:
      'let options=[{text:"a",value:{choices:[{value:1,text:"x"},{text:null}]}},{text:"b",value:{choices:[{value:1,text:null},{text:"x"}]}}]\nlet outer=askChoice options\nlet p=askChoice outer.choices\nlet n:integer?=p\nsay n\nexit',
  });
  out.push({
    name: "alias-cycle",
    source:
      "let a={}\nlet b=a\na=b\nlet options=[{value:a},{value:b}]\nlet p=askChoice options\nsay p.missing\nexit",
  });
  return out.map((c) => ({ ...c, files: [{ path: "main.tease", source: c.source }] }));
}
export const growthSpecs = [
  {},
  { depth: 1 },
  { depth: 3 },
  { depth: 3, loop: true },
  { depth: 3, inline: true },
  { depth: 3, variant: "guard" },
  { depth: 3, variant: "store-leaf" },
  { depth: 3, variant: "store-whole" },
  { depth: 3, variant: "two-same" },
  ...Object.keys(wrappers)
    .filter((x) => x !== "direct")
    .map((wrap) => ({ depth: 1, wrap })),
  { depth: 3, wrap: "pair", loop: true },
  { depth: 3, wrap: "pair", inline: true },
  { depth: 3, wrap: "pair", variant: "two-same" },
  { depth: 1, variant: "two-different", excluded: "#1291" },
  { depth: 1, variant: "host-bound", excluded: "#1291" },
];

// the smoke run at 4, the growth job at 64, 128 and 256
const growth = growthSpecs.flatMap((spec) =>
  [4, 64, 128, 256].map((k) => [`${JSON.stringify(spec)}@${k}`, family(k, spec)]),
);
// residuals.mjs:13-17
const residuals = [
  "whole-write",
  "missing-properties",
  "option-write",
  "option-property-write",
].flatMap((variant) =>
  [64, 128, 256].map((k) => {
    let source = family(k, {
      depth: 3,
      variant: variant.startsWith("option") ? "plain" : "store-whole",
    });
    if (variant === "missing-properties") source = source.replace('a2_0={f0:"s"}', "a2_0={f0:1}");
    if (variant === "option-write")
      source = source.replace(
        "let picked=askChoice options",
        "options[0].value=source\nlet picked=askChoice options",
      );
    if (variant === "option-property-write")
      source = source.replace(
        "let picked=askChoice options",
        "options[0].value.f0=2\nlet picked=askChoice options",
      );
    return [`residual-${variant}@${k}`, source];
  }),
);
export const cases = [
  ...independent().map(({ name, files }) => [name, files]),
  ...growth,
  ...residuals,
];
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ['node review.mjs "$1"', "R/astra-m4-i1233-review-evidence/run.sh:7"],
    [
      "for job in independent growth fixture-0 fixture-1 fixture-2 fixture-3; do",
      "R/astra-m4-i1233-review-evidence/submit.sh:6",
    ],
    [
      'SX_HEAVY_MEM=2G SX_HEAVY_SWAP=0 sx-queue add --name "astra-i1233-$job" --priority 1 --dir /tmp/agent-work/o4-3a-lead-astra-i1233 -- timeout 180m bash /tmp/agent-work/o4-3a-lead-astra-i1233/run.sh "$job"',
      "R/astra-m4-i1233-review-evidence/submit.sh:7",
    ],
  ],
  sources: 737,
  sha256: "6db3b6ed3fa9ad58e82cff53610783bdbfc2e39d6019ebed7b7d35260a7754c1",
};
