// the 3a delta check 3 (Sol): n empty records each given its own property, and a list of n records with distinct
// properties read at its first, at n = 100, 250, 500 and 1,000 (R/pr-3a-delta-check-3-sol-files/grouped-measure.mjs);
// grouped-single-read.mjs read the same programs at 250 to 1,000 from the files the measure wrote. Analysed without
// globals.
function source(n) {
  const lines = Array.from({ length: n }, (_, i) => `let d${i} = {}\nd${i}.p${i} = 1`);
  const values = Array.from({ length: n }, (_, i) => `{p${i}: 0}`).join(", ");
  return `${lines.join("\n")}\nlet xs = [${values}]\nlet r = xs.first\nexit`;
}
export const shapes = { grouped: source };

export const sizes = [100, 250, 500, 1000];

// the globals the recorded runs passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "sx-heavy \"$N\" grouped-measure.mjs \"$D\" 100",
      "R/pr-3a-delta-check-3-sol-files/report-draft.md:169"
    ],
    [
      "sx-heavy \"$N\" grouped-measure.mjs \"$D\" 250",
      "R/pr-3a-delta-check-3-sol-files/report-draft.md:169"
    ],
    [
      "sx-heavy \"$N\" grouped-measure.mjs \"$D\" 500",
      "R/pr-3a-delta-check-3-sol-files/report-draft.md:169"
    ],
    [
      "sx-heavy \"$N\" grouped-measure.mjs \"$D\" 1000",
      "R/pr-3a-delta-check-3-sol-files/report-draft.md:169"
    ],
    [
      "sx-heavy \"$N\" grouped-single-read.mjs \"$D\" 250",
      "R/pr-3a-delta-check-3-sol-files/report-draft.md:171"
    ],
    [
      "sx-heavy \"$N\" grouped-single-read.mjs \"$D\" 500",
      "R/pr-3a-delta-check-3-sol-files/report-draft.md:171"
    ],
    [
      "sx-heavy \"$N\" grouped-single-read.mjs \"$D\" 1000",
      "R/pr-3a-delta-check-3-sol-files/report-draft.md:171"
    ]
  ],
  "sources": 4,
  "sha256": "868cd0f12d2531f34ea35213fb44c65aa9e2ed31458f7ee81f89c6ce64557671"
};
