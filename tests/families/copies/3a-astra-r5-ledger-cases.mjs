// singleton-union/new-kind controls; unsupported quoted-property experiments excluded; 3a review, r5
// (R/pr-3a-review-r5-files/astra/ledger-probe.mjs).
export const cases = (() => {
  const tests = [
    { name: "singleton-union", source: "let x = 1\nexit" },
    { name: "new-kind", source: "let x = 1\nexit" },
  ];
  return tests.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node ledger-probe.mjs (no command recorded: its run without arguments)",
      "R/pr-3a-review-r5-files/astra/ledger-probe.mjs",
    ],
  ],
  sources: 3,
  sha256: "d9cd092692360c0fbefb7ec07aa36936092c603a3685926902726190adf9428d",
  dropped: [
    [
      "fc65b4a38b038e6cff0c6f578ef2b41056aad084ebeb15eebcdc46d8e0e7c244",
      "The ledger probe intends fact normalization for quoted property names, not rejection of quoted object property syntax. (undefined)",
    ],
    [
      "e7abd7580bd53d83d9d3bdceefdeb76c5bea6ff037b23565cee63ccc83225268",
      "The ledger probe intends fact normalization for quoted property names, not rejection of quoted object property syntax. (undefined)",
    ],
  ],
};
