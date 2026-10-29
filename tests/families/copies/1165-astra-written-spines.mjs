// #1165; builder/review archive: size-dependent shapes source families.
export const sizes = [4, 8];
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
