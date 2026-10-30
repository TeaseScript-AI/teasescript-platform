// original choicePeers, choicePeersBesideLiteral and related inputs; #1417, builder/review archive
// (desktop:~/work/evidence/1417/a0abf39f0/tools/shapes-leaf.mjs).
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
export const sizes = [1, 2, 3, 5, 8, 9, 64, 128]; // the recorded consumers' sizes
export const shapes = corpus.shapes;

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "otherHost"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node growth.mjs <tree> desktop:~/work/evidence/1417/a0abf39f0/tools/shapes-leaf.mjs all 64 src,rev,srcOff,revOff literalUnits,mergeItems,checks,invSteps",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:20",
    ],
    [
      "node answers.mjs <tree> <out> shapes desktop:~/work/evidence/1417/a0abf39f0/tools/shapes-leaf.mjs 1,3,8",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:26",
    ],
    [
      "node oracle-run.mjs <base> <head> <out> desktop:~/work/evidence/1417/a0abf39f0/tools/shapes-leaf.mjs",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:34",
    ],
  ],
  sources: 72,
  sha256: "5f317da45431e1d80ce75ac9b798cc90a0cb8ffdeb41f82d0c20cc7eb750285b",
};
