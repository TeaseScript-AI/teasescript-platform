// #1375 Astra review r2.
export const cases = (() => {
  const cases = [
    {
      name: "r1-witness",
      source: "let tree = [{q: [{q: 1}]}]\nlet copy = tree[0].q[0].q\nsay copy\nexit\n",
      allowance: 25,
    },
    ...[1, 2, 3].map((depth) => {
      const route = "box" + ".branch".repeat(depth - 1) + ".n";
      const literal = (n) => "{branch: ".repeat(depth - 1) + `{n: ${n}}` + "}".repeat(depth - 1);
      return {
        name: `restarted-stop-depth-${depth}`,
        binding: "box",
        source:
          [
            `let box = ${literal(1)}`,
            ...Array.from({ length: 12 }, (_, i) => `${route} = ${i + 2} + ${i + 3}`),
            `box = ${literal(4)}`,
            `repeat ${route} {}`,
            'say "DONE"',
            "exit",
          ].join("\n") + "\n",
      };
    }),
  ];
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication", "stops"];
