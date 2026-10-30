// captured a nullable list element added to a parameter, a copy and a host value, in functions and at the top level;
// #1268, Astra review, r4 (R/astra-m4-i1268-review-r4-evidence/builder/generators/grid-probe.mjs).
export const cases = [
  [
    "original-1",
    "function f(n) {\n  let ms = [1, null]\n  say ms[1] + n\n  return 1\n}\nsay f(hostValue)\nexit\n",
  ],
  [
    "original-2",
    "function f(n) {\n  let ms = [1, null]\n  let m = ms[1]\n  say m + n\n  return 1\n}\nsay f(hostValue)\nexit\n",
  ],
  [
    "original-3",
    "let ms = [1, null]\nlet m = ms[1]\nlet v: integer = hostValue\nsay m + v\nexit\n",
  ],
  [
    "original-4",
    "function f(n) {\n  let ms = [1, null]\n  say ms[1] + 1\n  say n + 1\n  return 1\n}\nsay f(hostValue)\nexit\n",
  ],
  [
    "original-5",
    "let ms = [1, null]\nlet m = ms[1]\nfunction g(n) { return n }\nsay m + g(hostValue)\nexit\n",
  ],
];

export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node grid-probe.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-i1268-review-r4-evidence/builder/generators/grid-probe.mjs",
    ],
  ],
  sources: 5,
  sha256: "ce8c43e7cf4d52d9927caea76a2aa54d318410226de5c87e3703c7316c9e07e5",
};
