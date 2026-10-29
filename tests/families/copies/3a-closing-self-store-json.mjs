// self-null-json-split, other-null-json-split and related fixed cases; 3a review, round unrecorded
// (R/pr-3a-closing-check-files/self-store-json-probe.mjs).
export const cases = (() => {
  const cases = [
    { name: "self-null-json-split", source: 'let xs = null\nxs = toJson(xs).split(",")\nexit' },
    {
      name: "other-null-json-split",
      source: 'let xs = null\nlet ys = toJson(xs).split(",")\nxs = ys\nexit',
    },
    {
      name: "self-dynamic-json-split",
      source: 'let xs = hostValue\nxs = toJson(xs).split(",")\nexit',
    },
    {
      name: "other-dynamic-json-split",
      source: 'let xs = hostValue\nlet ys = toJson(xs).split(",")\nxs = ys\nexit',
    },
  ];
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node self-store-json-probe.mjs (no command recorded: its run without arguments)",
      "R/pr-3a-closing-check-files/self-store-json-probe.mjs",
    ],
  ],
  sources: 4,
  sha256: "ec99be92055d3f6b0523c463a538ecc804ad898a3ebccf96f769050decea7cc0",
};
