// #1359; builder/review archive.
export const sizes = [4, 8];
export const shapes = (() => {
  const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const choice = (k) =>
    `askChoice ${many(k, (i) => `{text: "${i}", value: hostValue.f${i}}`, ", ")}`;
  const lists = (k, values, read = "xs[i][hostValue.i]", type = ": integer") =>
    many(
      k,
      (i) => `let xs${i} = [${values}]\nlet n${i}${type} = ${read.replaceAll("[i]", String(i))}`,
    );
  const pair = (k) => [`let left = ${choice(k)}`, `let right = ${choice(k)}`];
  const shapes = {
    peersBesideHostList: (k) =>
      [...pair(k), lists(k, "left, [hostValue.j], right"), "exit"].join("\n"),
    peersBesideNumberList: (k) => [...pair(k), lists(k, "left, [1], right"), "exit"].join("\n"),
    onePeerBesideHostList: (k) => [...pair(k), lists(k, "left, [hostValue.j]"), "exit"].join("\n"),
    hostListBesideNumber: (k) => [lists(k, "[hostValue.j], 1"), "exit"].join("\n"),
    hostListAlone: (k) => [lists(k, "[hostValue.j]", "xs[i][0][0]"), "exit"].join("\n"),
    hostReadBesideHostList: (k) => [lists(k, "hostValue.a, [hostValue.j]"), "exit"].join("\n"),
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
