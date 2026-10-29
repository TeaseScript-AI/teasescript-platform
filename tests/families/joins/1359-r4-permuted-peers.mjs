// #1417; builder/review archive; shared generation code from one original module.
export const sizes = [3, 6];
const outputs = (() => {
  const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const choice = (k, host = "hostValue", wrap = (x) => x) =>
    `askChoice ${many(k, (i) => `{text: "${i}", value: ${wrap(`${host}.f${i}`)}}`, ", ")}`;
  const prefix = (k, wrap = (x) => x) =>
    `let left = ${choice(k, "hostValue", wrap)}\nlet mid = ${choice(k, "hostValue", wrap)}\nlet right = ${choice(k, "hostValue", wrap)}\n`;
  const sites = (k, form, tail = "") =>
    many(k, (i) => `let xs${i} = [${form(i)}]\nlet n${i}: integer = xs${i}[hostValue.i]${tail}`) +
    "\nexit";
  const shapes = {
    permutedPeers: (k) =>
      prefix(k) +
      sites(
        k,
        (i) =>
          [
            "left, mid, right",
            "right, left",
            "mid, right, left",
            "left, left, right",
            "right, mid",
          ][i % 5],
      ),
    aliases: (k) =>
      prefix(k) +
      "let a = left\nlet b = right\n" +
      sites(k, (i) => (i % 2 ? "a, right" : "left, b")),
    objectChoicePeers: (k) =>
      prefix(k, (x) => `{n: ${x}}`) +
      sites(k, (i) => (i % 2 ? "right, left" : "left, mid, right"), ".n"),
    nestedChoicePeers: (k) =>
      prefix(k, (x) => `[${x}]`) +
      sites(k, (i) => (i % 2 ? "right, left" : "left, mid, right"), "[hostValue.j]"),
    parseChoicePeers: (k) =>
      prefix(k, (x) => `fromJson("{}", default: ${x})`) + sites(k, () => "left, right"),
    loadChoicePeers: (k) =>
      prefix(k, (x) => `load("x", default: ${x})`) + sites(k, () => "left, mid, right"),
    choiceSites: (k) =>
      prefix(k) +
      many(
        k,
        (i) =>
          `let v${i} = askChoice {text: "a", value: left}, {text: "b", value: right}\nlet n${i}: integer = v${i}`,
      ) +
      "\nexit",
    addedSites: (k) =>
      prefix(k) +
      many(
        k,
        (i) =>
          `let xs${i} = [left]\nxs${i}.add(right)\nxs${i}.add(mid)\nlet n${i}: integer = xs${i}[hostValue.i]`,
      ) +
      "\nexit",
    narrowedSites: (k) =>
      prefix(k) +
      many(
        k,
        (i) =>
          `if left is integer {\nlet xs${i} = [left, right]\nlet n${i}: integer = xs${i}[hostValue.i]\n}`,
      ) +
      "\nexit",
    alternatingGlobals: (k) =>
      `let left = ${choice(k)}\nlet right = ${choice(k, "otherHost")}\n` +
      sites(k, () => "left, right"),
  };
  const cases = [];
  for (const [name, make] of Object.entries(shapes))
    for (const k of [3, 7])
      cases.push({ name: `${name}@${k}`, files: [{ path: "main.tease", source: make(k) }] });
  const sources = [
    "{n: hostValue.a, q: 0}",
    "{n: hostValue.b, q: 0}",
    'load("a", default: {n: hostValue.a, q: 0})',
    'fromJson("{}", default: {n: hostValue.b, q: 0})',
    '(load("a", default: hostValue) otherwise {n: 0, q: 0})',
  ];
  for (const padding of [0, 12])
    for (const middle of sources) {
      const source = [
        padding
          ? `let pad = [${many(padding, (i) => `{p${i}: hostValue}`, ", ")}]\nsay pad[0]`
          : "",
        `let a = ${sources[0]}`,
        `let b = ${middle}`,
        `let c = ${sources[1]}`,
        "let xs = [a, b, c]\nlet ys = [c, b, a]",
        "if hostValue.a is integer { let n: integer = xs[hostValue.i].n }",
        "let n: integer = ys[hostValue.i].n",
        "exit",
      ].join("\n");
      cases.push({
        name: `conflict-${padding}-${sources.indexOf(middle)}`,
        files: [{ path: "main.tease", source }],
      });
    }
  for (const body of [
    "xs.add(hostValue.b)",
    "if hostValue.flag { xs = [otherHost.c] } else { xs.add(hostValue.b) }",
  ])
    cases.push({
      name: `growing-${cases.length}`,
      files: [
        {
          path: "main.tease",
          source: `let xs = [hostValue.a]\nrepeat 3 {\n${body}\nlet ys = [xs, xs]\nlet n: integer = ys[hostValue.i][hostValue.j]\n}\nexit`,
        },
      ],
    });
  const cases0 = (() => {
    return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.files]);
  })();
  const shapes1 = (() => {
    return {
      permutedPeers: (n) => shapes["permutedPeers"](n),
      aliases: (n) => shapes["aliases"](n),
      objectChoicePeers: (n) => shapes["objectChoicePeers"](n),
      nestedChoicePeers: (n) => shapes["nestedChoicePeers"](n),
      parseChoicePeers: (n) => shapes["parseChoicePeers"](n),
      loadChoicePeers: (n) => shapes["loadChoicePeers"](n),
      choiceSites: (n) => shapes["choiceSites"](n),
      addedSites: (n) => shapes["addedSites"](n),
      narrowedSites: (n) => shapes["narrowedSites"](n),
      alternatingGlobals: (n) => shapes["alternatingGlobals"](n),
    };
  })();
  return { cases0, shapes1 };
})();
export const cases = [...outputs.cases0];
export const shapes = Object.fromEntries([
  ...Object.entries(outputs.shapes1).map(([name, make]) => ["shapes1/" + name, make]),
]);
export const checks = ["publication"];
