// original getChainInKList, getChainReadOnce and related inputs; #1359, builder/review archive
// (desktop:~/work/evidence/1359/67b1d250b/tools/shapes-issues.mjs).
const corpus = (() => {
  const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const getChain = (k) => `hostValue${many(k, (i) => `.get("a", default: {n: ${i}})`, "")}`;
  const lists = (k, values) =>
    many(k, (i) => `let xs${i} = [${values}]\nlet n${i}: integer = xs${i}[hostValue.i]`);
  const shapes = {
    getChainInKList: (k) =>
      [
        `let root = ${getChain(k)}`,
        `let xs = [${many(k, () => "root", ", ")}]`,
        "let n: integer = xs[hostValue.i].n",
        "exit",
      ].join("\n"),
    getChainReadOnce: (k) =>
      [`let root = ${getChain(k)}`, "let n: integer = root.n", "exit"].join("\n"),
    getChainSaid: (k) => [`say ${getChain(k)}.n`, "exit"].join("\n"),
    choiceBesideHostList: (k) =>
      [
        `let left = askChoice ${many(k, (i) => `{text: "${i}", value: hostValue.f${i}}`, ", ")}`,
        lists(k, "left, [hostValue.j]"),
        "exit",
      ].join("\n"),
    maxBesideHostList: (k) =>
      [
        `let left = max(${many(k, (i) => `hostValue.f${i}`, ", ")})`,
        lists(k, "left, [hostValue.j]"),
        "exit",
      ].join("\n"),
    hostListOfKBesideHostList: (k) =>
      [
        `let left = [${many(k, (i) => `hostValue.f${i}`, ", ")}]`,
        lists(k, "left, [hostValue.j]"),
        "exit",
      ].join("\n"),
  };
  return { shapes: shapes };
})();
export const sizes = [64, 128]; // the recorded consumers' sizes
export const shapes = corpus.shapes;

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "otherHost"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node growth.mjs <tree> desktop:~/work/evidence/1359/67b1d250b/tools/shapes-issues.mjs all 64 src,rev literalUnits,mergeItems,checks,invSteps",
      "R/astra-m4-i1357-review-evidence/INDEX.md:23",
    ],
  ],
  sources: 12,
  sha256: "aa65166bc0704b8210478215434fb386b17fa6a51ba78a02cb41762c8fc9c1aa",
};
