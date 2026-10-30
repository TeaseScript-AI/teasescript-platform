// captured astra regression test inputs; #1268, astra-m4-i1268-review-evidence, review/builder evidence
// (R/astra-m4-i1268-review-evidence/regression.test.mjs).
const regression = [
  ["original-1", 'let mood = 1\nmood = "happy"\nexit'],
  ["original-2", "let ns = [1, null]\nlet n = ns[1]\nsay n + 1\nexit"],
  ["pasted declaration with ellipsis", 'let mood: integer | string = ...\nmood = "happy"\nexit'],
  [
    "pasted guard with ellipsis",
    "let ns = [1, null]\nlet n = ns[1]\nif n != null { ... }\nsay n + 1\nexit",
  ],
];

// the test compiled the two pasted placeholders without globals, and analysed the originals with hostValue
export const cases = regression.map(([name, source]) =>
  name.startsWith("pasted ") ? [name, source, []] : [name, source],
);
export const globals = ["hostValue"];
export const checks = ["publication"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "SX_HEAVY_CLASS=light /home/peter/.local/share/mise/installs/node/24.18.0/bin/node tools/test-output-filter.mjs <test-file>",
      "R/astra-m4-i1268-review.md:67",
    ],
  ],
  sources: 4,
  sha256: "c2e640798cf560300baa2d861f1687914959a77079d96f1f938eec3c0d16279f",
};
