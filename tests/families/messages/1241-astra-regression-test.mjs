// captured astra regression test inputs; #1241, astra-m4-i1241-review, review/builder evidence
// (R/astra-m4-i1241-review/regression.test.mjs).
export const cases = [
  ["original-1", 'let d = dict{found: [1]}\nsay d["absent"] + 2\nexit\n'],
  ["original-2", 'let d = dict{found: 2}\nlet delay: duration = d["absent"]\nsay delay\nexit\n'],
  ["original-3", 'let d = dict{found: [1]}\nsay d["found"] + 2\nexit\n'],
  ["original-4", 'let d = dict{found: 2}\nlet delay: duration = d["found"]\nsay delay\nexit\n'],
  ['archived paste/d["absent"] + [2]', 'let d = dict{found: [1]}\nsay d["absent"] + [2]\nexit\n'],
  [
    'archived paste/d["absent"].add(2)',
    'let d = dict{found: [1]}\nd["absent"].add(2)\nsay d["absent"]\nexit\n',
  ],
  ['archived paste/d["found"] + [2]', 'let d = dict{found: [1]}\nsay d["found"] + [2]\nexit\n'],
  [
    'archived paste/d["found"].add(2)',
    'let d = dict{found: [1]}\nd["found"].add(2)\nsay d["found"]\nexit\n',
  ],
];

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node head/tools/test-output-filter.mjs regression.test.mjs",
      "R/astra-m4-i1241-review/regression-group.sh:11",
    ],
  ],
  sources: 8,
  sha256: "51f44818bf165ced7057b8df0a9fd4cf396e89bbff9a1481f0b5d124fb575f80",
};
