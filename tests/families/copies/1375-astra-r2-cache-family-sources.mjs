// #1375 Astra review r2.
export const cases = (() => {
  const sources = [];
  for (const depth of [1, 3, 5])
    for (const flip of [false, true]) {
      const steps = Array.from({ length: depth }, (_, i) =>
        (i % 2 === 0) !== flip ? `.twig${i}` : "[0]",
      );
      let literal = "1";
      for (let i = depth - 1; i >= 0; i--)
        literal = steps[i] === "[0]" ? `[${literal}]` : `{twig${i}: ${literal}, quiet: "ok"}`;
      const reads = steps.map((_, i) => "plant" + steps.slice(0, i + 1).join(""));
      sources.push({
        name: `chain-${depth}-${flip}`,
        source: `let plant = ${literal}\nsay ${reads.at(-1)}\nexit\n`,
        reads,
      });
    }
  sources.push(
    {
      name: "selection-descendants",
      source: "let plant = [{branch: [{leaf: 1}]}]\nsay plant.first.branch[0].leaf\nexit\n",
      reads: ["plant.first.branch", "plant.first.branch[0]", "plant.first.branch[0].leaf"],
    },
    {
      name: "operation-descendants",
      source:
        "let seed: integer? = null\nlet plant = {branch: {leaf: [seed]}}\nsay (plant.branch otherwise {leaf: [2]}).leaf[0]\nexit\n",
      reads: [
        "plant.branch",
        "(plant.branch otherwise {leaf: [2]}).leaf",
        "(plant.branch otherwise {leaf: [2]}).leaf[0]",
      ],
    },
    {
      name: "branching-occurrences",
      source:
        'let plant = {left: [{leaf: 1}], right: [{leaf: "x"}]}\nsay plant.left[0].leaf\nsay plant.right[0].leaf\nsay plant.left[0].leaf\nexit\n',
      reads: [
        "plant.left",
        "plant.left[0]",
        "plant.left[0].leaf",
        "plant.right",
        "plant.right[0]",
        "plant.right[0].leaf",
      ],
    },
  );
  return sources.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication", "stops"];
