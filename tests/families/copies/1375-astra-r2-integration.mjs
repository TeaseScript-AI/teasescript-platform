// r1-witness, restarted-stop-depth-1 and related fixed cases; #1375 Astra review r2
// (R/astra-m4-g3-p1-review-r2-evidence/integration.mjs).
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

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node integration.mjs", "R/astra-m4-g3-p1-review-r2-evidence/run-integration.sh:3"]],
  sources: 4,
  sha256: "0c4c68913dbb4930f08044a6b6fabe0705987a78bcb23cad5a2b1cc1bad4b50e",
};
