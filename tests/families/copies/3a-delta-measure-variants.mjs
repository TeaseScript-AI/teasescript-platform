// the 3a delta check 3 (Sol): n records each declared with one property, given a distinct other one and read back
// (`literal-distinct`), at n = 250, 500, 1,000 and 2,000 (R/pr-3a-delta-check-3-sol-files/measure-variants.mjs).
const lines = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join("\n");
export const shapes = {
  "literal-distinct": (n) =>
    `${lines(n, (i) => `let a${i} = {q${i}: 0}\na${i}.p${i} = 1\nlet r${i} = a${i}.p${i}`)}\nexit`,
};

export const sizes = [250, 500, 1000, 2000];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'sx-heavy "$N" measure-variants.mjs "$D" literal-distinct 250',
      "R/pr-3a-delta-check-3-sol-files/report-draft.md:167",
    ],
    [
      'sx-heavy "$N" measure-variants.mjs "$D" literal-distinct 500',
      "R/pr-3a-delta-check-3-sol-files/report-draft.md:167",
    ],
    [
      'sx-heavy "$N" measure-variants.mjs "$D" literal-distinct 1000',
      "R/pr-3a-delta-check-3-sol-files/report-draft.md:167",
    ],
    [
      'sx-heavy "$N" measure-variants.mjs "$D" literal-distinct 2000',
      "R/pr-3a-delta-check-3-sol-files/report-draft.md:167",
    ],
  ],
  sources: 4,
  sha256: "3511c3a2efca7ca3046bb0d910255d4ef1931eb3430bd7696ef35682913cf488",
};
