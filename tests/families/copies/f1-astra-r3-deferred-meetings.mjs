// Astra review: size-dependent meeting source families.
export const sizes = [4, 8];
const corpus = (() => {
  const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const fields = (n, f, p = "f") =>
    rows(n, (i) => `${p}${i}:${typeof f === "function" ? f(i) : f}`).join(",");
  const tease = (...xs) => xs.flat(Infinity).join("\n") + "\nexit\n";
  function meeting(n, literals = 2) {
    return tease(
      "let t:integer=1",
      `let plain={${fields(n, "{left:1,right:1}")}}`,
      rows(n, (i) => `let w${i}={q:t}`),
      rows(
        literals,
        (j) =>
          `let p${j}={${fields(n, (i) => `w${i}`, "y")},${fields(n, (i) => `plain.f${i}`, "x")}}`,
      ),
    );
  }
  return { shapes: { meeting: (n) => meeting(n) } };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
