// #1165 / S8; Astra review.
export const cases = (() => {
  const shapes = [];
  for (const k of [40, 80])
    for (const t of ["integer?", "(integer | string)"]) {
      const name = `copies-${t === "integer?" ? "nullable" : "union"}-${k}`;
      const source = [
        `let typed: ${t}${"[]".repeat(k)} = []`,
        "let one = typed",
        "let two = typed",
        ...Array.from({ length: k }, (_, i) => `${i % 2 ? "one" : "two"} = typed`),
        'say "DONE"',
        "exit",
      ].join("\n");
      shapes.push([name, source]);
    }
  for (const k of [72, 144]) {
    let a = "typed",
      b = '"ok"';
    for (let i = 0; i < k; i++) {
      a = `{branch: [${a}]}`;
      b = `{branch: [${b}]}`;
    }
    shapes.push([
      `branched-union-${k}`,
      `let typed: integer | string = 1\nlet xs = [${a}, ${b}]\nexit`,
    ]);
  }
  return shapes.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];
