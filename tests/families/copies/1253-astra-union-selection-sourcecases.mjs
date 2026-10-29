// captured let parcel: integer dict? = fromJson(hostValue, default: null, files: false) say "complete" exit; #1253,
// Astra review, round unrecorded (R/astra-m4-i1253-review-evidence/union-selection.mjs).
export const cases = [
  [
    "original-1",
    'let parcel: integer dict? = fromJson(hostValue, default: null, files: false)\nsay "complete"\nexit',
  ],
  [
    "original-2",
    'let parcel = fromJson(hostValue, default: dict {"a": 1}, files: false)\nsay "complete"\nexit',
  ],
];

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node union-selection.mjs <tree>",
      "R/astra-m4-i1253-review-evidence/queue-logs/2-20261028122503404113838-astra-i1253-union-selection.log:1",
    ],
  ],
  sources: 2,
  sha256: "280567ecdc98bc80a8d0f55fa680ce34d55f47a3e0cac4ac10c392bf56d5b8d9",
};
