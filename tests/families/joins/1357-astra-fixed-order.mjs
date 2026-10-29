// #1357; Astra review: size-dependent shapes source families.
export const sizes = [16, 32];
const corpus = (() => {
  const many = (n, f, sep = "\n") => Array.from({ length: n }, (_, i) => f(i)).join(sep);
  const forms = {
    roles: (n) => `${"max(".repeat(n)}hostValue.n${many(n, (i) => `, ${i})`, "")}`,
    leaves: (n) => `askChoice ${many(n, (i) => `{text:"${i}", value:hostValue.p${i}}`, ", ")}`,
  };
  const shapes = Object.fromEntries(
    Object.entries(forms).map(([name, expr]) => [
      name,
      (n) => {
        const peers = Math.max(2, Math.floor(n / 8));
        return [
          many(peers, (i) => `let p${i} = ${expr(n)}`),
          many(
            n,
            (i) =>
              `let xs${i} = [${many(peers, (j) => `p${j}`, ", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
          ),
          "exit",
        ].join("\n");
      },
    ]),
  );
  return { shapes: { roles: (n) => shapes["roles"](n), leaves: (n) => shapes["leaves"](n) } };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
