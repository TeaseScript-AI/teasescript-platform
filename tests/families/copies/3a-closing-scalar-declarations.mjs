// 3a review: size-dependent scalarDecl source families.
export const sizes = [4, 8];
const corpus = (() => {
  const scalarDecl = (count) =>
    Array.from({ length: count }, (_, i) => `let a${i}: integer | number = 1`).join("\n");
  return { shapes: { scalarDecl: (n) => scalarDecl(n) } };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
