// captured let value: integer? = hostValue if value != null { let local = value repeat local {} }; #1165 / S8, Astra
// review, round unrecorded (R/astra-m4-s8c-review-evidence/worker/shared-index.mjs).
export const cases = [
  [
    "original-1",
    "let value: integer? = hostValue\nif value != null { let local = value\nrepeat local {} }\nexit",
  ],
  [
    "original-2",
    "let value: integer[]? = hostValue\nif value != null { let local = {rows: value}\nsay local.rows.first }\nexit",
  ],
  [
    "original-3",
    "function use(v: integer?) { if v != null { let local = v\nrepeat local {} } }\nuse(3)\nuse(null)\nexit",
  ],
];

export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "| `node geometry.mjs`; `node shared-index.mjs` | allowance and both shared builds |",
      "R/astra-m4-s8c-review-evidence/README.md:18",
    ],
    [
      "/home/peter/opt/node-24.18/bin/node shared-index.mjs",
      "R/astra-m4-s8c-review-evidence/worker/last-checks.sh:4",
    ],
  ],
  sources: 3,
  sha256: "edc88e00f272e30b27d09a06422c518b0b2b6567afa66e9b3d7aef6ccd695299",
};
