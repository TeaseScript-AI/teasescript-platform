// #1303; Astra review.
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
