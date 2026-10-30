// the 3a closing check's schedule counts: k stores to one binding at 500 to 4,000, and a wide list literal and a list
// fed back into itself at 25 to 200 (R/pr-3a-closing-check-files/schedule-counts.mjs, analysed without globals).
const families = {
  stores: [500, 1000, 2000, 4000],
  "literal-wide": [25, 50, 100, 200],
  feedback: [25, 50, 100, 200],
};
const source = (family, n) =>
  family === "stores"
    ? "let x=1\n" + Array.from({ length: n }, (_, i) => `x=${i + 2}`).join("\n") + "\nexit"
    : family === "literal-wide"
      ? "let xs=[" + Array(n).fill("1").join(",") + "]\nexit"
      : "let xs=[1]\n" + Array(n).fill("xs=xs+[]").join("\n") + "\nexit";
export const cases = Object.entries(families).flatMap(([family, sizes]) =>
  sizes.map((n) => [`${family}/${n}`, source(family, n)]),
);

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node schedule-counts.mjs", "null"]],
  sources: 12,
  sha256: "3b52922c73df2706256b634ad5d73387b918dc517950f726be106d24b6370991",
};
