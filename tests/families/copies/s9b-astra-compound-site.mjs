// S9b's plan review (Astra): the calendar offset and its binary form, as its cases hold them
// (R/astra-m4-s9b-plan-review-evidence/compound-site.mjs); compiled without globals.
export const cases = [
  ["compound-site-j0-input1", "let day = toDate(\"2026-08-11\")\nday += 1 calendar day + 2 h\nexit\n"],
  ["compound-site-j0-input2", "let day = toDate(\"2026-08-11\")\nday = day + (1 calendar day + 2 h)\nexit\n"],
];

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "node compound-site.mjs",
      "R/astra-m4-s9b-plan-review-evidence/compound-sites.json:1"
    ]
  ],
  "sources": 2,
  "sha256": "a2f763f55a1419f6c52ec8a50c55476b52938840de9f943e834e4cb4d93d067a"
};
