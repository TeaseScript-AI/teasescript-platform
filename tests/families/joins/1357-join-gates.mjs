const corpus = (() => {
  const many = (k, f, sep) => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const shapes = {
    "join-run-ending-in-another-type": (k) =>
      [
        "let xs: (integer | string)[] = [0]",
        `let s = xs + ${many(k, (i) => `[${i + 1}]`, " + ")} + ["x"]`,
        "say s.length",
        "exit",
      ].join("\n"),
    "join-prefixes-each-in-an-object": (k) => {
      let joined = "xs";
      for (let i = 0; i < k; i += 1) joined = `({n: ${joined} + [${i}]}).n`;
      return [
        "let xs: (integer | string)[] = [0]",
        `let s = ${joined} + ["x"]`,
        "say s.length",
        "exit",
      ].join("\n");
    },
  };
  return { shapes: shapes };
})();
export const sizes = [2, 3, 4, 5, 8, 9, 64, 128];
export const shapes = corpus.shapes;

export const checks = ["publication"];
