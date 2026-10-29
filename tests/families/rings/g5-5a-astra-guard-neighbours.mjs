// marks-2-0-duplicate-before, marks-2-0-duplicate-after and related fixed cases; #1394 G5 5a Astra review / builder
// corpus (R/astra-m4-g5-5a-review-evidence/guard-neighbours.mjs).
export const cases = (() => {
  const cases = [];
  for (const k of [2, 3, 4, 5])
    for (const from of [0, k - 1])
      for (const shape of ["duplicate", "chord", "shared-layer"])
        for (const position of ["before", "after"]) {
          const lines = [
            "let seed = {p: hostValue, q: {r: hostValue}}",
            "let a0 = seed",
            ...Array.from({ length: k - 1 }, (_, i) => `let a${i + 1} = a${i}`),
          ];
          if (shape === "duplicate") lines.push(`a${k - 1} = a${k - 2}`);
          if (shape === "chord") for (let i = 0; i < k; i++) lines.push(`a${i} = a${(i + 2) % k}`);
          if (shape === "shared-layer")
            lines.push(
              `let joined = a0`,
              `joined = a${k - 1}`,
              "joined.q.r = hostValue",
              "a0 = joined",
            );
          const probe = [
            `let outside = a${from}`,
            `if a${from}.p is integer {`,
            `a${1 - from + k === k ? 0 : 1} = a${from}`,
          ];
          const guarded = [
            `if a${from}.p is integer {`,
            `let outside = a${from}`,
            "repeat outside.p {}",
            "let nested = {copy: outside}",
            "repeat nested.copy.p {}",
            "}",
          ];
          const g2 = [
            `if a${from}.q.r is integer {`,
            `let projected = a${from}.q`,
            "repeat projected.r {}",
            "}",
          ];
          if (position === "before") lines.push(...guarded, ...g2);
          lines.push(`a0 = a${k - 1}`);
          if (position === "after") lines.push(...guarded, ...g2);
          lines.push("exit");
          cases.push({
            name: `marks-${k}-${from}-${shape}-${position}`,
            source: lines.join("\n") + "\n",
          });
        }
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node guard-neighbours.mjs guard-cases.json", "R/astra-m4-g5-5a-review-evidence/README.md:21"],
    [
      "PUBLICATION_TEXT=1 node builder-tools/pub.mjs <build>/dist guard-cases.json guards-<tree>.jsonl",
      "R/astra-m4-g5-5a-review-evidence/README.md:22",
    ],
  ],
  sources: 48,
  sha256: "cb87ae6cb47a571233c1eab7adcc5cd13cf311dff23f3ea25d972802435406e0",
};
