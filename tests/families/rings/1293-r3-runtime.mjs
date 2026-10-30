// #1293's review r3: the two runtime cases it wrote itself, an exact relay that fits and a relay whose late copies are
// unreachable (desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/runtime.mjs over its runtime-cases.json). The 41 other
// cases prepare-runtime.py copied there are review r2's sources and results, not copied.
export const cases = [
  [
    "exact-relay-fitting",
    'let good = {n: 1}\nlet bad = {n: 2}\nlet a = {inner: {inner: bad}}\nlet b = {inner: {inner: good}}\nlet c = b\nc = a\nsay "after invalid copy"\nb = c\na = b\nexit\n',
  ],
  [
    "relay-late-copies-unreachable",
    'let good = {n: 1}\nlet bad = {n: "x"}\nlet a = {inner: {inner: bad}}\nlet b = {inner: {inner: good}}\nlet c = b\nc = a\nsay "after invalid copy"\nif false {b = c}\nif false {a = b}\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node runtime.mjs $root runtime-cases.json results/runtime.jsonl",
      "desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/submit-runtime.sh:3",
    ],
  ],
  sources: 2,
  sha256: "9ba0412f064888e0be7dc0b86b71b2f85e8326a7a07e7fbb513741bfaeb9f97e",
};
