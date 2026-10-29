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
export const sizes = [2, 3, 4, 5, 8, 9, 64, 128];
export const shapes = corpus.shapes;

export const checks = ["publication"];
