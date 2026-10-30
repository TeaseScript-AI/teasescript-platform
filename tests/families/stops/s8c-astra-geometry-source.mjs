// callable/top/recursive forms, 24/96 links, and 0/192 padding functions; #1165 / S8, Astra review, round unrecorded
// (R/astra-m4-s8c-review-evidence/worker/geometry.mjs).
export const sizes = [24, 96];
const corpus = (() => {
  const source = (n, padding, form) =>
    [
      "let source = 1.5",
      ...Array.from({ length: n }, (_, i) => `let link${i} = ${i ? "link" + (i - 1) : "source"}`),
      ...(form === "callable"
        ? [`function inspect { repeat link${n - 1} {}\nrepeat link${n - 1} {} }\ninspect()`]
        : form === "recursive"
          ? [
              `function inspect(n: integer) { if n > 0 { inspect(n - 1) }\nrepeat link${n - 1} {} }\ninspect(2)`,
            ]
          : [`repeat link${n - 1} {}\nrepeat link${n - 1} {}`]),
      `link${n - 1} = 2`,
      ...Array.from(
        { length: padding },
        (_, i) => `function unused${i}(n: integer) { if n > 0 { return n }\nreturn 0 }`,
      ),
      "exit",
    ].join("\n");
  return {
    shapes: Object.fromEntries(
      ["callable", "top", "recursive"].flatMap((form) =>
        [0, 192].map((padding) => [`${form}/padding-${padding}`, (n) => source(n, padding, form)]),
      ),
    ),
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "| `node geometry.mjs`; `node shared-index.mjs` | allowance and both shared builds |",
      "R/astra-m4-s8c-review-evidence/README.md:18",
    ],
  ],
  sources: 12,
  sha256: "1098d26ceee2d4e4dc1483b75a1ff00f092741cbc106c7433708f5a125de0fa2",
};
