// #1240's review (Astra): the four message checks its parity test writes itself (R/astra-m4-i1240-review/
// sol54-parity.test.mjs). The 52 sources it reads from Sol's #1240 work are Sol's, not copied.
export const cases = [
  ["own-sibling-54", "let xs = [1]\nxs.join = 2\nexit\n"],
  ["own-sibling-55", "let a = 90 deg\na.degrees = 2\nexit\n"],
  ["own-sibling-56", "let a = {n: 1}\nsay a[\"missing\"]\nexit\n"],
  ["own-sibling-57", "let xs = [1]\nsay xs + \"x\"\nexit\n"],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "node wt/tools/test-output-filter.mjs '--test-name-pattern=each member, conversion and list fix' sol54-parity.test.mjs",
      "R/astra-m4-i1240-review/parity-job.sh:6"
    ]
  ],
  "sources": 4,
  "sha256": "738dc056a8b5542ef412f01bbab2cb7467ff9c47b2111f9f26a3cb370b756072"
};
