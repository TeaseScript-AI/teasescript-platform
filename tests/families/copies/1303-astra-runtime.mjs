// typed-first, nullable-first and related fixed cases; #1303, Astra review, round unrecorded
// (R/astra-m4-i1303-review-evidence/runtime.mjs).
export const cases = (() => {
  const list = (items) => ({ kind: "list", items });
  const cases = [];
  for (const selection of ["first", "last", "random"])
    for (const [name, carrier, bad, good] of [
      ["typed", "let xs: integer[] = hostValue", list([]), list([7])],
      ["nullable", "let xs: integer?[] = hostValue", list([]), list([null])],
      ["copy", "let source: integer[] = hostValue\nlet xs = source", list([]), list([7])],
      [
        "nested",
        "let rows: integer[][] = hostValue\nlet xs = rows[0]",
        list([list([])]),
        list([list([7])]),
      ],
      ["stored", "let xs: integer[] = [1]\nxs = hostValue", list([]), list([7])],
      ["untyped", "let xs = hostValue", list([]), list([7])],
    ])
      cases.push({
        id: `${name}-${selection}`,
        source: `${carrier}\nsay "BEFORE"\nlet out = xs.${selection}\nsay "AFTER"\nexit\n`,
        inputs: [bad, good],
        expected: selection === "random" ? "TSR019" : "TSR018",
        access: `xs.${selection}`,
      });
  cases.push({
    id: "nested-empty-outer",
    source:
      'let rows: integer[][] = hostValue\nsay "BEFORE"\nlet xs = rows[0]\nlet out = xs.first\nsay "AFTER"\nexit\n',
    inputs: [list([]), list([list([7])])],
    expected: "TSR025",
    access: "0]",
  });
  cases.push({
    id: "guarded",
    source:
      'let xs = hostValue\nif xs is integer[] {\nsay "BEFORE"\nlet out = xs.first\nsay "AFTER"\n}\nexit\n',
    inputs: [list([]), list([7])],
    expected: "TSR018",
    access: "xs.first",
  });
  cases.push({
    id: "interpolation",
    source: 'let xs: string[] = hostValue\nsay "BEFORE"\nsay "${xs}"\nsay "AFTER"\nexit\n',
    inputs: [list([]), list(["yes"])],
    expected: "TSV042",
    access: "xs}",
  });
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "/home/peter/opt/node-24.18/bin/node /tmp/agent-work/o4-3a-lead-astra-i1303/runtime.mjs",
      "R/astra-m4-i1303-review-evidence/manifest.json:12",
    ],
  ],
  sources: 21,
  sha256: "0d1c1aa9fd85213fc25d5285b59a2c21ff0d3b3cc8f3608ee28245aa5e089cbc",
};
