// #1405 / #1403, Astra review (R/astra-m4-g3-p3-review-evidence/cases.mjs:45): the growth families review.mjs's growth
// mode ran at n = 40 and 80: wrapper chains (short and long steps), copied and hot properties, and depths of written
// types, literals and carriers.
function growth(name, n) {
  const lines = [];
  const q = Array(n).fill("q").join(".");
  if (name === "wrapper" || name === "long-step-wrapper") {
    const step = name === "wrapper" ? "q" : "anUnusuallyLongPropertyName";
    lines.push("let seed: integer=1", "let root={f:seed}");
    for (let i = 0; i < n; i++) lines.push(`let box${i}={${step}:${i ? "box" + (i - 1) : "root"}}`);
    lines.push(`let out=box${n - 1}.${Array(n).fill(step).join(".")}.f`);
  } else if (name === "copied-properties") {
    lines.push(
      "let seed: integer=1",
      `let source={${Array.from({ length: n }, (_, i) => "p" + i + ":seed").join(",")}}`,
      "let copy=source",
    );
    for (let i = 0; i < n; i++) lines.push(`copy.p${i}=2`);
  } else if (name === "hot-candidates") {
    lines.push(`let source={${Array.from({ length: n }, (_, i) => "p" + i + ":1").join(",")}}`);
    for (let i = 0; i < n; i++) lines.push(`let box${i}=[source,{p${i}:2}]`);
  } else if (name === "typed-depth") {
    lines.push("let source:integer" + "[]".repeat(n) + "=[]", "let copy=source");
  } else if (name === "literal-depth") {
    lines.push("let source=" + "{q:".repeat(n) + "1" + "}".repeat(n), `let out=source.${q}`);
  } else if (name === "carrier-depth") {
    let value = "seed";
    for (let i = 0; i < n; i++) value = `[${value},"other"][0]`;
    lines.push('let seed="origin"', "let out=" + value);
  }
  return lines.join("\n") + "\nexit\n";
}

const names = [
  "wrapper",
  "long-step-wrapper",
  "copied-properties",
  "hot-candidates",
  "typed-depth",
  "literal-depth",
  "carrier-depth",
];
export const shapes = Object.fromEntries(names.map((name) => [name, (n) => growth(name, n)]));
export const sizes = [40, 80];
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node review.mjs growth growth.jsonl", "R/astra-m4-g3-p3-review-evidence/queue.sh:3"],
  ],
  sources: 14,
  sha256: "1d2807133e6d0ef93bd11aaec59e6ff4eb64c75b16f83769518f2f0b43ab7638",
};
