// alias-subsets-regular, alias-subsets-fixed-width; #1359 contract roles design review (Astra), round unrecorded
// (R/astra-m4-contract-roles-design-review-evidence/probes/regular-shapes.mjs).
export const sizes = [64, 128];
const corpus = (() => {
  const many = (n, f, sep = "\n") => Array.from({ length: n }, (_, i) => f(i)).join(sep);
  function scalar(k, m) {
    const width = Math.max(2, m / 2);
    return [
      "let base = 1",
      many(m, (j) => `let x${j} = base`),
      many(
        m,
        (j) =>
          `let p${j} = ${"max(".repeat(k)}x${j}${many(k, (r) => `, x${(j + r + 1) % m})`, "")}`,
      ),
      many(
        k,
        (i) =>
          `let xs${i} = [${many(width, (j) => `p${(i + j) % m}`, ", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
      ),
      "exit",
    ].join("\n");
  }
  const shapes = {
    "alias-subsets-regular": (k) => scalar(k, k / 8),
    "alias-subsets-fixed-width": (k) => scalar(k, 8),
  };
  return {
    shapes: {
      "alias-subsets-regular": (n) => shapes["alias-subsets-regular"](n),
      "alias-subsets-fixed-width": (n) => shapes["alias-subsets-fixed-width"](n),
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "otherHost"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "ROLE_TIE_PROBE=<mode> node --import ./tie-hook.mjs ./growth.mjs <tree> ./regular-shapes.mjs all 64 src,rev,srcOff,revOff",
      "R/astra-m4-contract-roles-design-review-evidence/probes/regular-run.sh:4",
    ],
  ],
  sources: 3,
  sha256: "609da9a3ba769b44735ae08b41b479de52068ed858123e41f12e3406aa8c1cdf",
};
