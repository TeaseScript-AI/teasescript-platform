// #1165 / S8; Astra review: size-dependent shapes source families.
export const sizes = [4, 8];
const corpus = (() => {
  const shapes = {
    repeated: (n) => "let b = 1\n" + "b = 2\n".repeat(n) + "b = hostValue\n",
    fields: (n) =>
      "let b = {f0: 1}\n" +
      Array.from({ length: n }, (_, i) => `b = {f${i}: ${i}}\n`).join("") +
      "b = hostValue\n",
    fieldStores: (n) =>
      "let b = {f0: 1}\n" +
      Array.from({ length: n }, (_, i) => `b.f${i} = ${i}\n`).join("") +
      "b = hostValue\n",
    deep: (n) => `let b = ${"[".repeat(n)}1${"]".repeat(n)}\nb = hostValue\n`,
  };
  return {
    shapes: {
      repeated: (n) => shapes["repeated"](n),
      fields: (n) => shapes["fields"](n),
      fieldStores: (n) => shapes["fieldStores"](n),
      deep: (n) => shapes["deep"](n),
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication", "stops"];
