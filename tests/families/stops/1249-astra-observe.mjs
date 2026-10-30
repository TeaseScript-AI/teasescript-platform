// #1249's review r1 (Astra): the five minimal witnesses it observed, as its minimal.json holds them
// (R/astra-m4-i1249-review-evidence/observe.mjs).
export const cases = [
  ["076-0-1", 'let n: integer = 1\nlet a = {n: n}\nlet b = {n: "text"}\nlet xs = [a, b]\nexit\n'],
  [
    "076-0-2",
    'let n: integer = 1\nlet a = {n: n}\nlet b = {n: "text"}\nlet xs = [a, b]\nsay xs[0].n\nexit\n',
  ],
  [
    "076-0-3",
    'let n: integer = 1\nlet a = {n: n}\nlet b = {n: "text"}\nlet xs = [a, b]\nxs[0].n = 1\nexit\n',
  ],
  [
    "076-0-4",
    'let s: string = "text"\nlet a = {n: 1}\nlet b = {n: s}\nlet copy = a\ncopy = b\nexit\n',
  ],
  [
    "076-0-5",
    'let s: string = "text"\nlet a = {n: 1}\nlet b = {n: s}\nlet copy = a\ncopy = b\nsay copy.n\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ['node observe.mjs "$review_tree"', "R/astra-m4-i1249-review-evidence/REPRODUCE.md:23"],
  ],
  sources: 5,
  sha256: "20ddd9c8580a58b161fbef4cb58d12fb46887ebf9b3f768badbac7ae702946a6",
};
