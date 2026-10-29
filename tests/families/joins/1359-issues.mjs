// #1359; builder/review archive.
export const sizes = [4, 8];
export const shapes = (() => {
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
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(shapes)) {
    const sample = make(4);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
export const checks = ["publication"];
