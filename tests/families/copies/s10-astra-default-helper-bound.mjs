// Astra review: size-dependent source-variants source families.
export const sizes = [4, 8];
const corpus = (() => {
  function source(k) {
    return `let keep: boolean = hostValue\n${Array.from({ length: k }, (_, i) => `let a${i}: integer? = hostValue`).join("\n")}\nlet total: integer? = 0\nif total != null and ${Array.from({ length: k }, (_, i) => `a${i} != null`).join(" and ")} {\nwhile keep {\n total = ${Array.from({ length: k }, (_, i) => `(a${i} otherwise 0)`).join(" + ")}\n ${Array.from({ length: k - 1 }, (_, i) => `a${i} = a${i + 1}`).join("\n ")}\n a${k - 1} = null\n repeat total {}\n}\n}\nexit\n`;
  }
  return { shapes: { source: (n) => source(n) } };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
