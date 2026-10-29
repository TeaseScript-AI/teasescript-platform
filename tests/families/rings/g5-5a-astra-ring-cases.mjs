// single-2, fed-2 and related fixed cases; #1394 G5 5a Astra review / builder corpus
// (R/astra-m4-g5-5a-review-evidence/generate.mjs).
export const cases = (() => {
  const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const cases = [];
  function add(name, lines, extra = {}) {
    cases.push({ name, source: [...lines, "exit"].join("\n") + "\n", ...extra });
  }
  for (const k of [2, 3, 4, 5]) {
    const pre = ["let good = {p: 1, q: {r: 2}}", "let other = {p: 2, q: {r: 3}}"];
    const decl = ["let a0 = good", ...rows(k - 1, (i) => `let a${i + 1} = a${i}`)];
    const close = `a0 = a${k - 1}`;
    const reads = rows(k, (i) => `let read${i} = a${i}.p`);
    const end = [`let outside = a${k - 1}`, ...reads];
    add(`single-${k}`, [...pre, ...decl, close, ...end]);
    add(`fed-${k}`, [...pre, ...decl, close, ...rows(k, (i) => `a${i} = other`), ...end]);
    add(`chord-${k}`, [
      ...pre,
      ...decl,
      close,
      ...rows(k, (i) => `a${i} = a${(i + 2) % k}`),
      ...end,
    ]);
    add(`layers-${k}`, [...pre, ...decl, ...rows(k, (i) => `a${i}.q.r = ${i + 3}`), close, ...end]);
    add(`guard-${k}`, [
      ...pre,
      ...decl,
      close,
      ...rows(k, (i) => `if a${i}.p is integer { a${(i + 1) % k} = a${i} }`),
      ...end,
    ]);
    add(`reference-${k}`, [
      "speaker voice { p: 1 }",
      ...pre,
      ...decl,
      close,
      `a${k - 1} = voice`,
      ...end,
    ]);
    add(`branch-${k}`, [...pre, ...decl, `if hostValue { ${close} } else { a0 = other }`, ...end]);
    add(`loop-${k}`, [...pre, ...decl, `repeat 2 { ${close}\na${k - 1}.p = 3 }`, ...end]);
    add(`project-entry-${k}`, [
      ...pre,
      ...decl,
      close,
      `let projected = a${k - 1}.q`,
      "let answer = projected.r",
      ...end,
    ]);
    add(`project-cycle-${k}`, [...pre, ...decl, close, `a0 = a${k - 1}.q`, ...end], {
      projectionCycle: true,
    });
    add(`layer-entry-${k}`, [
      ...pre,
      ...decl,
      ...rows(k, (i) => `a${i}.q.r = ${i + 3}`),
      close,
      `let projected = a${k - 1}.q`,
      "let answer = projected.r",
      ...end,
    ]);
    add(`duplicate-${k}`, [...pre, ...decl, `a${k - 1} = a${k - 2}`, close, "a0 = other", ...end], {
      case5: true,
    });
    add(
      `nullable-duplicate-${k}`,
      [
        'let good = {p: "text", q: {r: 2}}',
        "let other: object? = {p: 1}",
        ...decl,
        `a${k - 1} = a${k - 2}`,
        close,
        "a0 = other",
        ...end,
      ],
      { case5: true },
    );
    add(
      `empty-parameter-${k}`,
      [
        "function f(unused) {",
        "let good = {p: 1, q: {r: 2}}",
        "let a0 = unused",
        ...rows(k - 1, (i) => `let a${i + 1} = a${i}`),
        close,
        `a${k - 1} = good`,
        ...end,
        "}",
      ],
      { case5: true },
    );
    add(
      `default-${k}`,
      [
        "let seed = {p: 1, q: {r: 2}}",
        "function f(start, x = start) {",
        "let a0 = x",
        ...rows(k - 1, (i) => `let a${i + 1} = a${i}`),
        close,
        `start = a${k - 1}`,
        ...end,
        "}",
        "f(seed)",
      ],
      { identityCycle: true },
    );
  }
  add("overlapping-rings", [
    "let good = {p: 1, q: {r: 2}}",
    "let a0 = good",
    "let a1 = a0",
    "let a2 = a1",
    "a0 = a2",
    "let a3 = a1",
    "let a4 = a3",
    "a1 = a4",
    "a2.q.r = 7",
    "a4.p = 3",
    "let outside = a4",
    "let answer = outside.q.r",
  ]);
  add("two-independent-rings", [
    "let good = {p: 1}",
    "let a0 = good",
    "let a1 = a0",
    "a0 = a1",
    "let a2 = {p: 3}",
    "let a3 = a2",
    "a2 = a3",
    "let a4 = a1",
    "a4 = a3",
    "let outside = a4",
    "let result = outside.p",
  ]);
  add("reference-guard", [
    "speaker voice { p: 1 }",
    "let a0 = voice",
    "let a1 = a0",
    "let a2 = a1",
    "a0 = a2",
    "if a1 is object { a2 = a1 }",
    "let outside = a2",
    "let result = outside.p",
  ]);
  add(
    "shared-stop-local-layer",
    [
      "let good = {p: 1, q: {r: 2}}",
      "let a0 = good",
      "let a1 = a0",
      "let a2 = a1",
      "a0 = a2",
      "let a3 = a1",
      "a3 = a2",
      "a3.q.r = 8",
      "a0 = a3",
      "let outside = a3",
      "let result = outside.q.r",
    ],
    { case5: true },
  );
  add(
    "host-ops-guard",
    [
      "let seed = [hostValue + 2, hostValue, hostValue + hostValue]",
      "let a0 = seed",
      "let a1 = a0",
      "let a2 = a1",
      "let a3 = a2",
      "if a2 != null { a3 = a2 }",
      "a0 = a3",
      "a1 = [3]",
      "let outside = a3",
      "let result = outside[0]",
    ],
    { case5: true },
  );
  add("written-nullable-layers", [
    "let typed: integer? = null",
    "let good = {p: typed, q: {r: 2}}",
    "let a0 = good",
    "let a1 = a0",
    "let a2 = a1",
    "a1.q.r = 3",
    "a0 = a2",
    "a2.p = 4",
    "let outside = a2",
    "let result = outside.p",
  ]);
  add(
    "projection-only-cycle",
    ["let seed = {p: {q: 1}}", "let a0 = seed", "let a1 = a0.p", "a0 = a1", "let outside = a1"],
    { projectionCycle: true },
  );
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node generate.mjs own-cases.json", "R/astra-m4-g5-5a-review-evidence/README.md:19"],
    [
      "node independent.mjs <build> own-cases.json own-<tree>-<mode>.jsonl <mode>",
      "R/astra-m4-g5-5a-review-evidence/README.md:20",
    ],
  ],
  sources: 67,
  sha256: "4c21e95978e0094ab59d36771634c5de8583e250598fa289c592747046e583b5",
};
