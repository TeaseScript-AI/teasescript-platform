// #1210's review (Astra): its own work programs, a host value's branch held in a list of k members in seven forms (bare,
// a record, a nested list, the last element, a mixed record, the host value itself, a deep path) and read at f fields,
// at the quick (k, f) pairs and the scaling ones (R/astra-m4-i1210-review-evidence/work.mjs). The VALUE_CLASS_SITES
// families it also ran are the repository's exported families, not copied.
const forms = {
  bare: ["hostValue.branch", "bag[1]"],
  record: ["{payload: hostValue.branch}", "bag[1].payload"],
  nested: ["{payload: [hostValue.branch]}", "bag[1].payload[0]"],
  last: ["{payload: hostValue.branch}", "bag.payload"],
  mixed: ["{payload: hostValue.branch, constant: 3}", "bag[1].payload"],
  direct: ["{payload: hostValue}", "bag[1].payload"],
  deep: ["{payload: hostValue.a.b.c.d.e.f}", "bag[1].payload"],
};
function source(name, k, f) {
  const [member, read] = forms[name];
  const expr = `[${Array(k).fill(member).join(", ")}]${name === "last" ? ".last" : ""}`;
  return `let bag = ${expr}\n${Array.from({ length: f }, (_, j) => `let result${j}: integer = ${read}.field${f - j - 1}`).join("\n")}\nexit\n`;
}
const QUICK = [
  [4, 4],
  [8, 8],
];
const SCALE = [
  [32, 32],
  [64, 64],
  [128, 128],
  [16, 64],
  [64, 16],
  [32, 128],
  [128, 32],
];
export const cases = [...QUICK, ...SCALE].flatMap(([k, f]) =>
  Object.keys(forms).map((name) => [`own-${name}/${k}/${f}`, source(name, k, f)]),
);

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "node work.mjs \"$PWD\" head quick # also base",
      "R/astra-m4-i1210-review-evidence/astra-m4-i1210-review.md:80"
    ],
    [
      "node work.mjs \"$PWD\" head scale # also base",
      "R/astra-m4-i1210-review-evidence/astra-m4-i1210-review.md:81"
    ]
  ],
  "sources": 63,
  "sha256": "02cddf738e298fcecc9f8d975730b5f8233bc4edd33feae2f7f44c2088a1a014"
};
