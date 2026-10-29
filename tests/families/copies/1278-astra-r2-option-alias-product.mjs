// #1278; Astra review; shared generation code from one original module.
export const sizes = [3, 6];
const outputs = (() => {
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
  const nameOf = (a) => `${a.depth}-${a.where}-${a.wrap}-${a.sources}-${a.between}-${a.options}`;
  const BASE = {
    depth: 1,
    where: "top",
    wrap: "none",
    sources: "one",
    between: "none",
    options: "bound",
  };
  const GROWTH = [];
  for (const depth of AXES.depth)
    for (const wrap of AXES.wrap) GROWTH.push({ ...BASE, depth, wrap });
  for (const [axis, values] of Object.entries(AXES))
    if (axis !== "depth" && axis !== "wrap")
      for (const v of values)
        if (v !== BASE[axis])
          GROWTH.push({ ...BASE, [axis]: v }, { ...BASE, wrap: "pair", [axis]: v });
  const shapes0 = (() => {
    return {
      "0-top-none-one-none-bound": (n) => program(n, GROWTH[0]),
      "0-top-list-one-none-bound": (n) => program(n, GROWTH[1]),
      "0-top-object-one-none-bound": (n) => program(n, GROWTH[2]),
      "0-top-selects-one-none-bound": (n) => program(n, GROWTH[3]),
      "0-top-text-one-none-bound": (n) => program(n, GROWTH[4]),
      "0-top-nested-one-none-bound": (n) => program(n, GROWTH[5]),
      "0-top-pair-one-none-bound": (n) => program(n, GROWTH[6]),
      "0-top-dict-one-none-bound": (n) => program(n, GROWTH[7]),
      "1-top-none-one-none-bound": (n) => program(n, GROWTH[8]),
      "1-top-list-one-none-bound": (n) => program(n, GROWTH[9]),
      "1-top-object-one-none-bound": (n) => program(n, GROWTH[10]),
      "1-top-selects-one-none-bound": (n) => program(n, GROWTH[11]),
      "1-top-text-one-none-bound": (n) => program(n, GROWTH[12]),
      "1-top-nested-one-none-bound": (n) => program(n, GROWTH[13]),
      "1-top-pair-one-none-bound": (n) => program(n, GROWTH[14]),
      "1-top-dict-one-none-bound": (n) => program(n, GROWTH[15]),
      "2-top-none-one-none-bound": (n) => program(n, GROWTH[16]),
      "2-top-list-one-none-bound": (n) => program(n, GROWTH[17]),
      "2-top-object-one-none-bound": (n) => program(n, GROWTH[18]),
      "2-top-selects-one-none-bound": (n) => program(n, GROWTH[19]),
      "2-top-text-one-none-bound": (n) => program(n, GROWTH[20]),
      "2-top-nested-one-none-bound": (n) => program(n, GROWTH[21]),
      "2-top-pair-one-none-bound": (n) => program(n, GROWTH[22]),
      "2-top-dict-one-none-bound": (n) => program(n, GROWTH[23]),
      "1-loop-none-one-none-bound": (n) => program(n, GROWTH[24]),
      "1-loop-pair-one-none-bound": (n) => program(n, GROWTH[25]),
      "1-top-none-same-none-bound": (n) => program(n, GROWTH[26]),
      "1-top-pair-same-none-bound": (n) => program(n, GROWTH[27]),
      "1-top-none-diff-none-bound": (n) => program(n, GROWTH[28]),
      "1-top-pair-diff-none-bound": (n) => program(n, GROWTH[29]),
      "1-top-none-one-guard-bound": (n) => program(n, GROWTH[30]),
      "1-top-pair-one-guard-bound": (n) => program(n, GROWTH[31]),
      "1-top-none-one-store-bound": (n) => program(n, GROWTH[32]),
      "1-top-pair-one-store-bound": (n) => program(n, GROWTH[33]),
      "1-top-none-one-ingress-bound": (n) => program(n, GROWTH[34]),
      "1-top-pair-one-ingress-bound": (n) => program(n, GROWTH[35]),
      "1-top-none-one-none-inline": (n) => program(n, GROWTH[36]),
      "1-top-pair-one-none-inline": (n) => program(n, GROWTH[37]),
    };
  })();
  const cases1 = (() => {
    return [["R4", R4]];
  })();
  return { shapes0, cases1 };
})();
export const cases = [...outputs.cases1];
export const shapes = Object.fromEntries([
  ...Object.entries(outputs.shapes0).map(([name, make]) => ["shapes0/" + name, make]),
]);
export const checks = ["publication"];
