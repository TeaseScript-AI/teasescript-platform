// #1165 / S8; Astra review: size-dependent source-variants source families.
export const sizes = [24, 48];
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
    shapes: {
      callable: (n) => source(n, undefined, "callable"),
      recursive: (n) => source(n, undefined, "recursive"),
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication", "stops"];
