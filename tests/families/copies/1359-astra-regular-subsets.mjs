// Astra review: size-dependent shapes source families.
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
