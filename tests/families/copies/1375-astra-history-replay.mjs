// #1375, Astra r1 (R/astra-m4-g3-p1-review-evidence/history-replay.mjs:6, :15): the history replay's prelude, unrelated
// prefixes beside a nested selection, and its witness, twelve objects in one list read through it.
const pre = Array.from({ length: 12 }, (_, i) => `let r${i} = {n: ${i}}`).join("\n");
export const cases = [
  [
    "prelude",
    "let a = {q: [{inner: {n: 1}}]}\nlet b = {q: [{inner: {n: 2}}]}\nlet c = {elsewhere: {missing: {n: 3}}}\nexit\n",
  ],
  [
    "witness",
    pre +
      "\nlet box = {q: {deep: [" +
      Array.from({ length: 12 }, (_, i) => `r${i}`).join(",") +
      "]}}\nsay box.q.deep[0].n\nexit\n",
  ],
];
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node history-replay.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-g3-p1-review-evidence/history-replay.mjs",
    ],
  ],
  sources: 2,
  sha256: "b1fe4269cc606b890f1b0d89cd89effe1b4be4aadb70629f9ae3504338f6dba3",
};
