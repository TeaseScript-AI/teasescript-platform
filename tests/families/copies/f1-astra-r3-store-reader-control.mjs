// Astra review: size-dependent source-variants source families.
export const sizes = [4, 8];
const corpus = (() => {
  const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const fields = (n, f) => rows(n, f).join(",");
  const source = (stores, reads) =>
    [
      "let t:integer=1",
      `let root={${fields(128, (i) => `f${i}:{left:t,right:1}`)},${fields(128, (i) => `g${i}:1`)}}`,
      "let a=root",
      ...rows(128, (i) => `a.f${i}.right=2`),
      ...rows(stores, (i) => `a.g${i}=2`),
      ...rows(reads, (i) => `let r${i}=a.f${i}`),
      "exit",
    ].join("\n");
  return { shapes: { source: (n) => source(n, n) } };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
