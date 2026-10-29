const corpus = (() => {
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
  return { shapes: shapes };
})();
export const sizes = [2, 3, 4, 5, 8, 9, 64, 128];
export const shapes = corpus.shapes;

export const checks = ["publication"];
