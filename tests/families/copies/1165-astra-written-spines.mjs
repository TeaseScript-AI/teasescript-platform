// original list, object and related inputs; #1165 S8 part 3, r7 retained Astra review scripts
// (desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/astra/astra-b2.mjs).
export const sizes = [64, 128, 256];
const corpus = (() => {
  const nest = (n, open, close, leaf) => open.repeat(n) + leaf + close.repeat(n);
  const shapes = {
    list: (n) => `let layers = ${nest(n, "[", "]", "7")}\nsay "DONE"`,
    object: (n) => `let layers = ${nest(n, "{branch: ", "}", "7")}\nsay "DONE"`,
    typedParse: (n) =>
      `let layers = fromJson(hostValue, default: ${nest(n, "{branch: ", "}", "7")})\nsay layers${".branch".repeat(n)}`,
    typedLoad: (n) =>
      `let layers = load("state", default: ${nest(n, "{branch: ", "}", "7")})\nsay layers${".branch".repeat(n)}`,
    typedCopyLeaf: (n) =>
      `let leaf: integer = 7\nlet layers = ${nest(n, "[", "]", "leaf")}\nsay "DONE"`,
    mixedSpine: (n) => {
      let v = "7";
      for (let i = 0; i < n; i++) v = i % 2 ? `{branch: ${v}, side: 2}` : `[${v}]`;
      return `let layers = ${v}\nsay "DONE"`;
    },
    siblingCopies: (n) =>
      `let leaf: integer = 7\nlet layers = ${nest(n, "{side: leaf, branch: ", "}", "leaf")}\nsay "DONE"`,
  };
  return {
    shapes: {
      list: (n) => shapes["list"](n),
      object: (n) => shapes["object"](n),
      typedParse: (n) => shapes["typedParse"](n),
      typedLoad: (n) => shapes["typedLoad"](n),
      typedCopyLeaf: (n) => shapes["typedCopyLeaf"](n),
      mixedSpine: (n) => shapes["mixedSpine"](n),
      siblingCopies: (n) => shapes["siblingCopies"](n),
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication", "stops"];

for (const [name, make] of Object.entries(shapes)) shapes[name] = (n) => "" + make(n) + "\nexit\n";

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node $g/astra/astra-b2.mjs $t",
      "D/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/jobs/astra.sh:9",
    ],
  ],
  sources: 21,
  sha256: "5afc434a042e1d40830ced948dc133e8933ec557ac1b95a41854a65f5873242d",
};
