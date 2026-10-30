// S6c's review (Astra): a choice whose value is a list of 30,000 cells, `1 + 0` or the host value, read as its first
// integer (R/astra-m4-s6c-review-evidence/property.mjs, the original and host kinds at 30,000).
const source = (cell, k) =>
  `let choice = {text: "A", value: [${Array.from({ length: k }, () => cell).join(",")}]}\nlet picked: integer = (askChoice choice).first\nexit`;
export const cases = [
  ["original/30000", source("1 + 0", 30000)],
  ["host/30000", source("hostValue", 30000)],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "node property.mjs mutants/spread-property original 30000",
      "R/astra-m4-s6c-review-evidence/property-original.jsonl:1"
    ],
    [
      "node property.mjs wt host 30000",
      "R/astra-m4-s6c-review-evidence/property-host-clean.jsonl:1"
    ]
  ],
  "sources": 2,
  "sha256": "d001a714b023be2f4eaad8cf82e50e1511bc2f927f09af3de27e16e860c1d667"
};
