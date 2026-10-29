// #1417; builder/review archive: size-dependent shapes source families.
export const sizes = [2, 3, 5, 9, 16, 32, 64];
const corpus = (() => {
  const many = (n, f, separator = "\n") =>
    Array.from({ length: n }, (_, i) => f(i)).join(separator);
  function tied(k, form = "rotated", spacing = 4) {
    const m = Math.max(4, Math.floor(k / spacing));
    return [
      "let base = 1\nlet early = base\nlet late = base",
      many(
        m,
        (j) =>
          `let p${j} = ${"max(".repeat(k)}early${many(k, (r) => `, ${j !== 0 && r % m === j ? "late" : "early"})`, "")}`,
      ),
      many(k, (i) => {
        let order = Array.from({ length: m }, (_, j) => (form === "fixed" ? j : (i + j) % m));
        if (form === "repeated") order = order.flatMap((j) => [j, j]);
        return `let xs${i} = [${order.map((j) => `p${j}`).join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`;
      }),
      "exit",
    ].join("\n");
  }
  const shapes = {
    "ties-rotated": (k) => tied(k),
    "ties-fixed": (k) => tied(k, "fixed"),
    "ties-repeated": (k) => tied(k, "repeated"),
    "ties-more-peers": (k) => tied(k, "rotated", 2),
  };
  return {
    shapes: {
      "ties-rotated": (n) => shapes["ties-rotated"](n),
      "ties-fixed": (n) => shapes["ties-fixed"](n),
      "ties-repeated": (n) => shapes["ties-repeated"](n),
      "ties-more-peers": (n) => shapes["ties-more-peers"](n),
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
