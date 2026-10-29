// 3a review: size-dependent listDecl source families.
export const sizes = [4, 8];
const corpus = (() => {
  const listDecl = (count) =>
    Array.from({ length: count }, (_, i) => `let a${i}: integer[] | number[] = [1]`).join("\n");
  return { shapes: { listDecl: (n) => listDecl(n) } };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
