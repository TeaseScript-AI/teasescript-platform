// #1417; builder/review archive: size-dependent shapes source families.
export const sizes = [4, 8];
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
  return {
    shapes: {
      "join-run-ending-in-another-type": (n) => shapes["join-run-ending-in-another-type"](n),
      "join-prefixes-each-in-an-object": (n) => shapes["join-prefixes-each-in-an-object"](n),
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
