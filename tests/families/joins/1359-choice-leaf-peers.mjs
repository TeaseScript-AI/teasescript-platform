const corpus = (() => {
  const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const choice = (k) =>
    `askChoice ${many(k, (i) => `{text: "${i}", value: hostValue.f${i}}`, ", ")}`;
  const lists = (k, values, read = "xs[i][hostValue.i]") =>
    many(
      k,
      (i) => `let xs${i} = [${values}]\nlet n${i}: integer = ${read.replaceAll("[i]", String(i))}`,
    );
  const chain = (k) => `${"max(".repeat(k)}hostValue${many(k, (i) => `, ${i})`, "")}`;
  const shapes = {
    choicePeers: (k) =>
      [`let left = ${choice(k)}`, `let right = ${choice(k)}`, lists(k, "left, right"), "exit"].join(
        "\n",
      ),
    choicePeersBesideLiteral: (k) =>
      [
        `let left = ${choice(k)}`,
        `let right = ${choice(k)}`,
        lists(k, `left, [hostValue.j], right`),
        "exit",
      ].join("\n"),
    choicePeersBesideText: (k) =>
      [
        `let left = ${choice(k)}`,
        `let right = ${choice(k)}`,
        lists(k, `left, "x", right`),
        "exit",
      ].join("\n"),
    threeChoicePeers: (k) =>
      [
        `let left = ${choice(k)}`,
        `let mid = ${choice(k)}`,
        `let right = ${choice(k)}`,
        lists(k, "left, mid, right"),
        "exit",
      ].join("\n"),
    literalPeers: (k) => {
      const lit = `[${many(k, (i) => `hostValue.f${i}`, ", ")}]`;
      return [
        `let left = ${lit}`,
        `let right = ${lit}`,
        lists(k, "left, right", "xs[i][hostValue.i][hostValue.j]"),
        "exit",
      ].join("\n");
    },
    choiceBesideLiteralPeer: (k) => {
      // a choice of k host reads and a one-option choice of a literal of k host reads? kept as a literal-valued choice
      const lit = `[${many(k, (i) => `hostValue.f${i}`, ", ")}]`;
      return [
        `let left = askChoice {text: "a", value: ${lit}}, {text: "b", value: ${lit}}`,
        `let right = askChoice {text: "a", value: ${lit}}, {text: "b", value: ${lit}}`,
        lists(k, "left, right", "xs[i][hostValue.i][hostValue.j]"),
        "exit",
      ].join("\n");
    },
    maxPeers: (k) =>
      [`let left = ${chain(k)}`, `let right = ${chain(k)}`, lists(k, "left, right"), "exit"].join(
        "\n",
      ),
  };
  const forms = ["left, right", "left, [0], right", "left, mid, right"];
  const three = (k) => [
    `let left = ${choice(k)}`,
    `let mid = ${choice(k)}`,
    `let right = ${choice(k)}`,
  ];
  shapes.leafPeers = (k) =>
    [
      ...three(k),
      many(k, (i) => `let xs${i} = [${forms[i % 3]}]\nlet n${i}: integer = xs${i}[hostValue.i]`),
      "exit",
    ].join("\n");
  shapes.leafPeersAll = (k) =>
    [
      ...three(k),
      many(k, (i) =>
        forms
          .map(
            (form, f) =>
              `let xs${i}x${f} = [${form}]\nlet n${i}x${f}: integer = xs${i}x${f}[hostValue.i]`,
          )
          .join("\n"),
      ),
      "exit",
    ].join("\n");
  return { shapes: shapes };
})();
export const sizes = [2, 3, 4, 5, 8, 9, 64, 128];
export const shapes = corpus.shapes;

export const checks = ["publication"];
