// #1310; builder/review archive.
export const cases = (() => {
  const cases = [];
  const add = (name, source, group, pair) =>
    cases.push({ name, source: source + "\nexit\n", group, pair });
  const forms = [
    ["binding", "let u: list = [1]\n", "u", ""],
    ["property", "let original: list = [1]\nlet box = {xs: original}\n", "box.xs", ""],
    ["index", "let rows: list[] = [[1]]\n", "rows[0]", ""],
    ["dict", "let rows: list dict = dict{item: [1]}\n", 'rows["item"]', ""],
    ["parameter", "function check(u: list) {\n", "u", "\n}\ncheck([1])"],
    ["optional", "let u: list? = [1]\n", "u", ""],
    ["optional-guard", "let u: list? = [1]\nif u is list {\n", "u", "\n}"],
    ["empty-deep", "let u: list[][] = []\n", "u", "", 3],
    ["full-deep", "let u: list[][] = [[[1]]]\n", "u", "", 3],
    ["null-binding", "let u: null[] = [null]\n", "u", ""],
    ["null-optional", "let u: null[]? = [null]\n", "u", ""],
    ["null-property", "let original: null[] = [null]\nlet box = {xs: original}\n", "box.xs", ""],
    ["null-parameter", "function check(u: null[]) {\n", "u", "\n}\ncheck([null])"],
    ["null-deep", "let u: null[][][] = [[[null]]]\n", "u", "", 3],
  ];
  for (const [name, start, operand, end, depth = 1] of forms) {
    const wrap = (x) => "[".repeat(depth) + x + "]".repeat(depth);
    for (const written of [false, true]) {
      const intro = written
        ? `let a: ${"integer" + "[]".repeat(depth)} = ${wrap("2")}\n`
        : `let a = ${wrap("2")}\n`;
      for (const side of ["left", "right"]) {
        const inner = side === "left" ? `${operand} + a` : `a + ${operand}`;
        const pair = `${name}-${written ? "written" : "inferred"}-${side}`;
        add(
          pair + "-inline",
          `${start}${intro}let result = (${inner}) + ${wrap('"tail"')}${end}`,
          name.startsWith("null") ? "null" : "open",
          pair,
        );
        add(
          pair + "-kept",
          `${start}${intro}let held = ${inner}\nlet result = held + ${wrap('"tail"')}${end}`,
          name.startsWith("null") ? "null" : "open",
          pair,
        );
      }
    }
  }
  for (const [name, start, operand, end, depth = 1] of forms.filter((f) =>
    f[0].startsWith("null"),
  )) {
    const wrap = (x) => "[".repeat(depth) + x + "]".repeat(depth);
    for (const side of ["left", "right"]) {
      const join = side === "left" ? `${operand} + ${wrap("1")}` : `${wrap("1")} + ${operand}`;
      add(name + "-fit-" + side, `${start}let held = ${join}\nsay held.length${end}`, "null-fit");
      add(
        name + "-later-store-" + side,
        `${start}let held = ${join}\nheld.add(${depth === 1 ? '"bad"' : "[".repeat(depth - 1) + '"bad"' + "]".repeat(depth - 1)})${end}`,
        "null-later",
      );
    }
  }
  for (const type of [
    "null[]",
    "integer[]",
    "integer?[]",
    "(integer | string)[]",
    "list",
    "list?",
    "list[]",
    "null[][]",
    "integer[][]",
    "integer?[][]",
  ]) {
    const deep = type.endsWith("[][]") || type === "list[]";
    const start = type.startsWith("null") ? (deep ? "[[null]]" : "[null]") : deep ? "[[1]]" : "[1]";
    for (const rhs of [
      deep ? "[[2]]" : "[2]",
      deep ? '[["bad"]]' : '["bad"]',
      deep ? "[[null]]" : "[null]",
    ])
      for (const [label, assign] of [
        ["compound", `d += ${rhs}`],
        ["self", `d = d + ${rhs}`],
        ["self-right", `d = ${rhs} + d`],
        ["nested-self", `d = (d + ${rhs}) + []`],
        ["nested-compound", `d += ([] + ${rhs})`],
        ["landing", `let target: ${type} = d + ${rhs}`],
      ])
        add(
          `destination-${type}-${label}-${rhs}`,
          `let d: ${type} = ${start}\n${assign}\nsay d.length`,
          "destination",
        );
  }
  for (const kind of ["integer[]", "(integer | string)[]", "list", "null[]"])
    for (const side of ["left", "right"]) {
      const start = `let typed: ${kind} = ${kind === "null[]" ? "[null]" : "[1]"}\nlet open: list = [2]\n`;
      const join = side === "left" ? "typed + open" : "open + typed";
      for (const [label, post] of [
        ["add", 'held.add("tail")'],
        ["store", 'held = ["tail"]'],
        ["index-store", 'held[0] = "tail"'],
        ["copy", 'let copy = held\ncopy.add("tail")'],
        ["nested-store", 'let box = {xs: held}\nbox.xs = ["tail"]'],
        ["read", "let picked = held[0]\nsay picked"],
        ["narrow", "if held[0] is string {\nsay held[0].length\n}"],
        ["host-store", "held.add(hostValue)"],
        ["literal", 'let rows = [held, ["tail"]]\nsay rows.length'],
      ])
        add(`later-${kind}-${side}-${label}`, `${start}let held = ${join}\n${post}`, "later");
      for (const [label, body] of [
        ["literal", `let rows = [(${join}), ["tail"]]\nsay rows.length`],
        ["argument", `function use(x: list) { say x.length }\nuse((${join}) + ["tail"])`],
        ["strict-argument", `function use(x: integer[]) { say x.length }\nuse(${join})`],
      ])
        add(`context-${kind}-${side}-${label}`, start + body, "context");
    }
  for (const side of ["left", "right"]) {
    const intro = "let u: list = [1]\nlet typed: integer[] = [2]\n";
    const join = side === "left" ? "u + typed" : "typed + u";
    for (const [label, body] of [
      ["long-inline", `let result = (((${join}) + [3]) + [4]) + ["tail"]`],
      ["long-kept", `let a = ${join}\nlet b = a + [3]\nlet c = b + [4]\nlet result = c + ["tail"]`],
      [
        "object",
        `let a = [{open: u, strict: 1}] + [{open: ["tail"], strict: 2}]\nlet result = a + [{open: [true], strict: "bad"}]`,
      ],
      [
        "deep-object",
        `let a = [[{inner: {xs: (${join})}}]] + [[{inner: {xs: ["tail"]}}]]\nsay a.length`,
      ],
    ])
      add("chain-" + side + "-" + label, intro + body, "chain");
  }
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];
