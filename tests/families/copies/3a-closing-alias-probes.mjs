// original self-dynamic-split, other-dynamic-split and related inputs; 3a review, round unrecorded
// (R/pr-3a-closing-check-files/own-probe.mjs).
export const cases = (() => {
  const cases = [
    ["self-dynamic-split", 'let xs = hostValue\nxs = toString(xs).split(",")\nexit'],
    ["other-dynamic-split", 'let xs = hostValue\nlet ys = toString(xs).split(",")\nxs = ys\nexit'],
    ["self-null-split", 'let xs = null\nxs = toString(xs).split(",")\nexit'],
    ["other-null-split", 'let xs = null\nlet ys = toString(xs).split(",")\nxs = ys\nexit'],
    ["self-list-set", "let xs = [1]\nxs = xs.toSet()\nexit"],
    ["other-list-set", "let xs = [1]\nlet ys = xs.toSet()\nxs = ys\nexit"],
    ["self-set-list", "let xs = set {1}\nxs = xs.toList()\nexit"],
    ["self-null-list", "let xs = null\nxs = toList(xs)\nexit"],
    ["self-dynamic-list", "let xs = hostValue\nxs = toList(xs)\nexit"],
    ["self-list-split", 'let xs = [1]\nxs = toString(xs).split(",")\nexit'],
    ["self-bound-list-set", "let xs: integer[] = [1]\nxs = xs.toSet()\nexit"],
    ["self-bound-cross", "let xs: integer[] | string set = [1]\nxs = xs.toSet()\nexit"],
    ["self-form-return", 'let xs = [1]\nxs = askForm("Q", fields: {q: {options: xs}})\nexit'],
    ["self-ignored-input", 'let xs = [1]\nxs = toString("a,b", xs).split(",")\nexit'],
    ["self-split-ref", 'let xs = [1]\nxs = toString(xs).split(",")\nexit'],
    ["self-bound-number", "let xs: integer[] = [1]\nxs = xs + [2.5]\nexit"],
  ];
  return cases.map(([name, source]) => [name, source]);
})();
export const checks = ["publication"];

for (const index of [8, 7, 6]) cases.splice(index, 1);

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node own-probe.mjs (no command recorded: its run without arguments)",
      "R/pr-3a-closing-check-files/own-probe.mjs",
    ],
  ],
  sources: 15,
  sha256: "8b07d9bf9e6005b2dd3ea602d4ddf1bb705b0ec80c456632cb3be36548c48ba2",
  dropped: [
    [
      "0e3c0d41cf283ca87821d5618c18406b0bc91056271d01dfb261a0ea19f5e407",
      "The self-store probe intends a solved collection result, not rejection of the historical set literal or global toList spelling. (undefined)",
    ],
    [
      "22e35c2080e3af439f01c14e18844ac7e7ea86e53f6726a9b31c48ffa4c2f733",
      "The self-store probe intends a solved collection result, not rejection of the historical set literal or global toList spelling. (undefined)",
    ],
    [
      "5494ce198db89ba42316bb51eb4135f3e21907d94e5a19f6551c04ac23af99a8",
      "The self-store probe intends a solved collection result, not rejection of the historical set literal or global toList spelling. (undefined)",
    ],
  ],
};
