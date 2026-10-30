// #1278, Astra review (R/astra-m4-i1278-review-evidence/cases.mjs): its independent controls, and its six growth shapes
// at 8 (the quick run) and 64, 128 and 256 (the growth run).

const many = (k, f, by = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(by);
const record = (name, source) => ({
  name,
  files: [{ path: "main.tease", source: source + "\nexit" }],
});
export const growthNames = [
  "sparse-overlap-deep",
  "sparse-late-stores",
  "sparse-open-gaps",
  "sparse-text-value",
  "shared-deep-leaves",
  "shared-own-wrappers",
];
export function growth(k, shape) {
  const lines = ["let n = 1"];
  let value = (i) => `p${i}`,
    read = (i) => `picked.f${i}`;
  if (shape === "sparse-overlap-deep") {
    lines.push(many(k, (i) => `let p${i} = {f${i}: {leaf: n}, f${(i + 1) % k}: {leaf: 2.5}}`));
    read = (i) => `picked.f${i}.leaf`;
  } else if (shape === "sparse-late-stores") {
    lines.push(
      many(k, (i) => `let p${i} = {anchor: n}`),
      many(k, (i) => `p${i}.f${i} = n`),
    );
  } else if (shape === "sparse-open-gaps") {
    lines.push(
      "let ingressA = hostValue",
      "let ingressB = hostValue",
      many(k, (i) => `let p${i} = {f${i}: n}`),
    );
  } else if (shape === "sparse-text-value") {
    lines.push(many(k, (i) => `let p${i} = {f${i}: n}`));
  } else {
    lines.push(
      `let a = {${many(k, (i) => `f${i}: {leaf: 1}`, ", ")}}`,
      `let b = {${many(k, (i) => `f${i}: {leaf: ${i % 3 ? "1" : "2.5"}}`, ", ")}}`,
    );
    value = (i) => (i % 2 ? "a" : "b");
    read = (i) => `picked.f${i}.leaf`;
    if (shape === "shared-own-wrappers") {
      value = (i) => `{box: ${i % 2 ? "a" : "b"}, own: {tag: ${i}}}`;
      read = (i) => `picked.box.f${i}.leaf`;
    }
  }
  const options = Array.from({ length: k }, (_, i) =>
    shape === "sparse-text-value" && i % 2
      ? `{text: ${value(i)}}`
      : `{text: "${i}", value: ${value(i)}}`,
  );
  if (shape === "sparse-open-gaps") {
    options.splice(Math.floor(k / 3), 0, '{text:"A",value:ingressA}');
    options.splice(Math.floor((2 * k) / 3), 0, '{text:"B",value:ingressB}');
  }
  lines.push(
    `let options = [${options.join(", ")}]`,
    "let picked = askChoice options",
    many(k, (i) => `repeat ${read(i)} {}`),
  );
  return record(shape + "@" + k, lines.join("\n"));
}
export function independent() {
  const out = [];
  for (const k of [7, 8, 9, 17])
    for (const order of ["forward", "reverse"])
      for (const variant of ["gaps", "later", "guarded", "leaf"]) {
        const lines = ["let n = 1", "let openA = hostValue", "let openB = hostValue"];
        lines.push(
          many(
            k,
            (i) =>
              `let p${i} = {f${i}: ${variant === "leaf" ? `{leaf: ${i % 3 ? "n" : "2.5"}}` : "n"}}`,
          ),
        );
        if (variant === "later") lines.push(`p0.f${k - 1} = 2.5`, `p${k - 1}.f0 = 2`);
        if (variant === "guarded") lines.push("if p0 != null {");
        const opts = Array.from({ length: k }, (_, i) => `{text:"${i}",value:p${i}}`);
        if (variant === "gaps") {
          opts.splice(1, 0, '{text:"A",value:openA}');
          opts.splice(k - 1, 0, '{text:"B",value:openB}');
        }
        if (order === "reverse") opts.reverse();
        lines.push(`let options = [${opts.join(",")}]`, "let picked = askChoice options");
        lines.push(
          many(k, (i) => `repeat picked.f${i}${variant === "leaf" ? ".leaf" : ""} {}`),
          "repeat picked.missing {}",
          "repeat picked.missing {}",
          "say picked.missing.first",
          "say picked.missing.length",
          "say picked.missing.values.first",
        );
        if (variant === "guarded") lines.push("}");
        out.push(record(`runs-${k}-${order}-${variant}`, lines.join("\n")));
      }
  for (const value of ["1", "2.5", '"bad"', "null", "hostValue"])
    for (const mutation of ["none", "before", "after", "option", "branch", "call", "loop"]) {
      const lines = ["global p = {f: 1}", "global q = {f: 1, extra: 2.5}"];
      if (mutation === "before") lines.push(`q.f = ${value}`);
      lines.push(
        'let options = [{text:"a",value:p},{text:"b",value:q},{text:"c",value:p},{text:"d",value:q},{text:"e",value:p},{text:"f",value:q},{text:"g",value:p},{text:"h",value:q},{text:"i",value:p}]',
      );
      if (mutation === "option") lines.push(`options[0].value.extra = ${value}`);
      if (mutation === "branch") lines.push(`if hostValue is integer { p.extra = ${value} }`);
      if (mutation === "call") lines.push(`function touch { p.extra = ${value} }`, "touch()");
      if (mutation === "loop") lines.push("repeat 2 {");
      lines.push(
        "let picked = askChoice options",
        "repeat picked.f {}",
        "repeat picked.extra {}",
        "repeat picked.missing {}",
        "if picked.missing != null { repeat picked.missing {} }",
      );
      if (mutation === "after" || mutation === "loop") lines.push(`p.extra = ${value}`);
      if (mutation === "loop") lines.push("}");
      out.push(record(`store-${mutation}-${value}`, lines.join("\n")));
    }
  for (const wrapper of ["inline", "list", "dict", "nestedChoice"])
    for (const guard of ["none", "missing", "present", "foreign"])
      for (const order of ["forward", "reverse"]) {
        const lines = ["let n = 1", "let hostA = hostValue", "let hostB = hostValue"];
        const wrap = (expr) =>
          wrapper === "inline"
            ? `{own: {f: ${expr}}}`
            : wrapper === "list"
              ? `[{own: ${expr}}]`
              : wrapper === "dict"
                ? `dict {key: {own: ${expr}}}`
                : `{choices: [{text:"inner",value:${expr}},{text:"missing"}]}`;
        const path =
          wrapper === "inline"
            ? ".own.f"
            : wrapper === "list"
              ? ".first.own"
              : wrapper === "dict"
                ? ".values.first.own"
                : "";
        const opts = Array.from(
          { length: 10 },
          (_, i) =>
            `{text:"${i}",value:${wrap(i === 3 ? "hostA" : i === 8 ? "hostB" : i % 2 ? "n" : "2.5")}}`,
        );
        if (order === "reverse") opts.reverse();
        lines.push(`let options = [${opts.join(",")}]`, "let picked = askChoice options");
        if (guard === "missing") lines.push("if picked.missing != null {");
        if (guard === "present") lines.push(`if picked${path} is integer {`);
        if (guard === "foreign") lines.push("if hostA is integer {");
        if (wrapper === "nestedChoice")
          lines.push("let inner = askChoice picked.choices", "repeat inner {}");
        else lines.push(`repeat picked${path} {}`);
        lines.push("say picked.missing", "repeat picked.missing {}");
        if (guard !== "none") lines.push("}");
        out.push(record(`writers-${wrapper}-${guard}-${order}`, lines.join("\n")));
      }
  for (const before of ["1", "2.5", "hostValue"])
    for (const after of ["1", "2.5", "hostValue"]) {
      out.push(
        record(
          `snapshots-${before}-${after}`,
          `let p = {f:${before}}\nlet before = {text:"a",value:p}\np = {f:${after}}\nlet after = {text:"b",value:p}\nlet options = [before, after, before, after, before, after, before, after, before]\nlet picked=askChoice options\nrepeat picked.f {}\nrepeat picked.missing {}`,
        ),
      );
    }
  out.push(
    record(
      "original-missing-writer",
      'let payload={f:1}\nlet options=[{text:"a",value:payload},{text:"b",value:payload}]\nlet picked=askChoice options\nsay picked.missing',
    ),
  );
  for (const name of growthNames) out.push(growth(4, name));
  return out;
}

export const cases = independent().map(({ name, files }) => [name, files]);
export const shapes = Object.fromEntries(
  growthNames.map((name) => [name, (k) => growth(k, name).files]),
);
export const sizes = [8, 64, 128, 256];
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "SX_HEAVY_MEM=3G SX_HEAVY_SWAP=0 node review.mjs quick",
      "R/astra-m4-i1278-review-evidence/quick.sh:3",
    ],
    [
      'node /tmp/agent-work/o4-3a-lead-astra-i1278/review.mjs "$job"',
      "R/astra-m4-i1278-review-evidence/enqueue.sh:5",
    ],
    [
      'node /tmp/agent-work/o4-3a-lead-astra-i1278/review.mjs growth "$mode"',
      "R/astra-m4-i1278-review-evidence/enqueue.sh:8",
    ],
  ],
  sources: 135,
  sha256: "7422cd00f686046568041c0304c8b6f521fedc5408aeaf8d1f0db5eb844281fc",
};
