// number/direct, number/list and related fixed cases; #1106, Astra review, round unrecorded
// (R/astra-m4-i1106-review-files/probe.mjs).
export const cases = (() => {
  const cases = [];
  const add = (name, source) => cases.push({ name, source: source + "\nexit\n" });
  const leaves = [
    ["number", "askChoice 7, 11", "integer", "0"],
    ["host-values", "askChoice hostValue.alpha, hostValue.beta", "integer", "0"],
    [
      "objects",
      'askChoice {text: hostValue.caption, value: hostValue.alpha}, {text: "fixed", value: 11}',
      "integer",
      "0",
    ],
    ["text-only", 'askChoice {text: hostValue.caption}, {text: "fixed"}', "string", '"backup"'],
    ["text", 'askChoice "first", "second"', "string", '"backup"'],
  ];
  const wrappers = [
    ["direct", (x, z) => `askChoice ${z}, (${x})`],
    ["list", (x, z) => `askChoice [(${x}), ${z}]`],
    ["set", (x, z) => `askChoice set[(${x}), ${z}]`],
    ["fallback", (x, z) => `askChoice null otherwise (${x}), ${z}`],
    ["left", (x, z) => `askChoice ${z}, ((${x}) otherwise ${z})`],
    ["get", (x, z) => `askChoice [(${x})].get(0, default: ${z}), ${z}`],
    ["get-default", (x, z) => `askChoice [].get(0, default: (${x})), ${z}`],
    ["load", (x, z) => `askChoice load("nested", default: (${x})), ${z}`],
    ["parse", (x, z) => `askChoice fromJson("null", default: (${x})), ${z}`],
    ["copy", (x, z) => `askChoice [(${x}), ${z}].take(2)`],
    ["set-copy", (x, z) => `askChoice [(${x}), ${z}].toSet()`],
    ["concat", (x, z) => `askChoice [(${x})] + [${z}]`],
    ["index", (x, z) => `askChoice [(${x}), ${z}][0]`],
    ["field", (x, z) => `askChoice {pick: (${x})}.pick, ${z}`],
    ["dict", (x, z) => `askChoice dict{one: (${x}), two: ${z}}.values`],
    ["object-value", (x, z) => `askChoice {text: "outer", value: (${x})}, ${z}`],
  ];
  for (const [ln, leaf, type, other] of leaves)
    for (const [wn, w] of wrappers)
      add(`${ln}/${wn}`, `let out: ${type} = ${w(leaf, other)}\nsay out`);
  for (const written of [false, true])
    for (const variant of [
      "alias",
      "list-alias",
      "object-alias",
      "mutated-alias",
      "copied-projection",
    ]) {
      const start = `let seed${written ? ": integer" : ""} = 5\n`;
      const xs = {
        alias:
          "let first = askChoice seed, hostValue.alpha\nlet alias = first\nlet out: integer = askChoice alias, 1",
        "list-alias":
          "let entries = [(askChoice seed, hostValue.alpha)]\nlet alias = entries\nlet out: integer = askChoice alias, 1",
        "object-alias":
          'let item = {text: "shown", value: (askChoice seed, hostValue.alpha)}\nlet alias = item\nlet out: integer = askChoice alias, 1',
        "mutated-alias":
          "let first = askChoice seed, hostValue.alpha\nlet alias = first\nfirst = hostValue.beta\nlet out: integer = askChoice alias, 1",
        "copied-projection":
          "let rec = {chosen: (askChoice seed, hostValue.alpha)}\nlet alias = rec.chosen\nlet out: integer = askChoice alias, 1",
      };
      add(`copy/${written}/${variant}`, start + xs[variant] + "\nsay out");
    }
  for (const value of [
    "1",
    "seed",
    "alias",
    "holder[0]",
    'load("n", default: 1)',
    "hostValue.alpha",
  ])
    for (const container of ["list", "set"]) {
      const literal = container === "list" ? `[(${value}), 2.5]` : `set[(${value}), 2.5]`;
      add(
        `guard/${container}/${value}`,
        `let seed: integer = 1\nlet alias = seed\nlet holder: integer[] = [1]\nlet options = ${literal}\nlet out = askChoice options\nsay out`,
      );
    }
  add(
    "writer/each",
    "let left: integer = 1\nlet right: integer = 2\nleft = hostValue.alpha\nright = hostValue.beta\nlet outer: integer = askChoice 3, (askChoice left, right)\nsay outer",
  );
  add(
    "calls/default",
    "function pick(n: integer = 6): integer {\n return askChoice n, hostValue.alpha\n}\nlet out: integer = askChoice pick(), pick(8)\nsay out",
  );
  add(
    "element/written-copy",
    'let seed: integer | string = 1\nlet box: (integer | string)[] = [(askChoice seed), "fallback"]\nlet out: integer | string = askChoice box\nsay out',
  );
  add(
    "ordered/two-hosts",
    "let out: integer = askChoice {text: hostValue.caption, value: (askChoice hostValue.alpha, hostValue.beta)}, 1\nsay out",
  );
  add(
    "invalid/text",
    'let chosen: integer = (askChoice [(askChoice {text: "inner", value: {text: hostValue.label, value: {text: hostValue.field}}})]).text',
  );
  add(
    "invalid/length",
    'let chosen: integer = (askChoice [(askChoice {text: "inner", value: {text: hostValue.label}})]).length',
  );
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node probe.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-i1106-review-files/probe.mjs",
    ],
  ],
  sources: 108,
  sha256: "cdc6b68a9e75097a1518d887a302b2026e5cd346c8baf07350b14e08ad2c5528",
};
