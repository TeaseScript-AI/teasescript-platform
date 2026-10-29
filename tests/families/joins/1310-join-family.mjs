// #1310; builder/review archive.
export const cases = (() => {
  const DOMAINS = [
    ["concrete", 1, "let d = [1]\n"],
    ["open", 1, "let d: list = [1]\n"],
    ["null-only", 1, "let d: null[] = [null]\n"],
    ["nullable-written", 1, "let d: integer?[] = [1]\n"],
    ["written-union", 1, "let d: (integer | string)[] = [1]\n"],
    ["two-concrete", 2, "let d = [[1]]\n"],
    ["two-open", 2, "let d: list[] = [[1]]\n"],
    ["two-open-empty", 2, "let d: list[] = []\n"],
    ["two-null-only", 2, "let d: null[][] = [[null]]\n"],
    ["two-written-union", 2, "let d: (integer | string)[][] = [[1]]\n"],
  ];
  const TYPES = {
    open: "list",
    "null-only": "null[]",
    "nullable-written": "integer?[]",
    "written-union": "(integer | string)[]",
    "two-open": "list[]",
    "two-open-empty": "list[]",
    "two-null-only": "null[][]",
    "two-written-union": "(integer | string)[][]",
  };
  const forms = (domain) => {
    const out = [
      ["binding", "", "d"],
      ["copy", "let c = d\n", "c"],
    ];
    if (TYPES[domain] !== undefined)
      out.push(["written-call", `function make: ${TYPES[domain]} {\n  return d\n}\n`, "make()"]);
    out.push(["inferred-call", "function make {\n  return d\n}\n", "make()"]);
    return out;
  };
  const wrap = (depth, element) => "[".repeat(depth) + element + "]".repeat(depth);
  const NEIGHBOURS = { I: "2", S: '"tail"', N: "null" };
  const cases = [];
  for (const [domain, depth, declaration] of DOMAINS)
    for (const [form, extra, d] of forms(domain)) {
      const start = `let w: integer${"[]".repeat(depth)} = ${wrap(depth, "7")}\n${declaration}${extra}`;
      const n = {
        ...Object.fromEntries(Object.entries(NEIGHBOURS).map(([k, v]) => [k, wrap(depth, v)])),
        W: "w",
      };
      for (const [x, X] of Object.entries(n)) {
        cases.push({
          domain,
          form,
          position: "left",
          x,
          inline: `${start}let result = ${d} + ${X}\nsay result.length\nexit\n`,
        });
        cases.push({
          domain,
          form,
          position: "right",
          x,
          inline: `${start}let result = ${X} + ${d}\nsay result.length\nexit\n`,
        });
        // (a later store into a variable holding the join: Codex r9's B1b)
        for (const [e, E] of Object.entries(NEIGHBOURS))
          for (const [position, inner] of [
            ["store-left", `${d} + ${X}`],
            ["store-right", `${X} + ${d}`],
          ])
            cases.push({
              domain,
              form,
              position,
              x,
              e,
              inline: `${start}let held = ${inner}\nheld.add(${wrap(depth - 1, E)})\nsay held.length\nexit\n`,
            });
        for (const [y, Y] of Object.entries(n))
          for (const [position, inner, outer] of [
            ["nested-left-of-left", `${d} + ${X}`, (j) => `${j} + ${Y}`],
            ["nested-right-of-left", `${X} + ${d}`, (j) => `${j} + ${Y}`],
            ["nested-left-of-right", `${d} + ${X}`, (j) => `${Y} + ${j}`],
            ["nested-right-of-right", `${X} + ${d}`, (j) => `${Y} + ${j}`],
          ])
            cases.push({
              domain,
              form,
              position,
              x,
              y,
              inline: `${start}let result = ${outer(`(${inner})`)}\nsay result.length\nexit\n`,
              kept: `${start}let held = ${inner}\nlet result = ${outer("held")}\nsay result.length\nexit\n`,
            });
      }
    }
  cases.push({
    domain: "null-only",
    form: "strict",
    position: "landing",
    inline: "let d: null[] = [null]\nlet result: integer[] = [1] + d\nsay result.length\nexit\n",
  });
  cases.push({
    domain: "null-only",
    form: "strict",
    position: "compound",
    inline: "let d: null[] = [null]\nd += [1]\nsay d.length\nexit\n",
  });
  cases.push({
    domain: "open",
    form: "strict",
    position: "landing",
    inline: 'let d: list = [1]\nlet result: integer[] = d + ["tail"]\nsay result.length\nexit\n',
  });
  for (const [position, inline] of [
    ["assigned-left", "let d: null[] = [null]\nd = d + [1]\nsay d.length\nexit\n"],
    ["assigned-right", "let d: null[] = [null]\nd = [1] + d\nsay d.length\nexit\n"],
    [
      "landing-null",
      "let d: null[] = [null]\nlet result: null[] = d + [1]\nsay result.length\nexit\n",
    ],
    [
      "compound-into-strict",
      "let d: null[] = [null]\nlet xs: integer[] = [1]\nxs += d\nsay xs.length\nexit\n",
    ],
    [
      "compound-nullable",
      "let d: null[] = [null]\nlet xs: integer?[] = [1]\nxs += d\nsay xs.length\nexit\n",
    ],
    ["compound-inferred", "let d: null[] = [null]\nlet xs = [1]\nxs += d\nsay xs.length\nexit\n"],
    ["two-compound", "let d: null[][] = [[null]]\nd += [[1]]\nsay d.length\nexit\n"],
  ])
    cases.push({ domain: "null-only", form: "strict", position, inline });
  for (const [position, inline] of [
    ["compound", 'let d: list = [1]\nd += ["tail"]\nsay d.length\nexit\n'],
    [
      "compound-into-strict",
      "let d: list = [1]\nlet xs: integer[] = [1]\nxs += d\nsay xs.length\nexit\n",
    ],
  ])
    cases.push({ domain: "open", form: "strict", position, inline });
  return cases.flatMap((c, i) =>
    ["inline", "kept"]
      .filter((key) => typeof c[key] === "string")
      .map((key) => [(c.name ?? i) + "/" + key, c[key]]),
  );
})();
export const checks = ["publication"];
