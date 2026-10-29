// #1417; builder/review archive.
export const sizes = [4, 8];
export const shapes = (() => {
  const many = (k, f, sep = " + ") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const lines = (...parts) => parts.join("\n");
  const shapes = {
    // the issue's generator, and its undeclared variant
    joinMixedDeclared: (k) =>
      lines(
        "let xs: (integer | string)[] = [0]",
        `let s = xs + ${many(k, (i) => `[${i + 1}]`)} + ["x"]`,
        "say s.length",
        "exit",
      ),
    joinMixedUndeclared: (k) =>
      lines(
        "let xs = [0]",
        `let s = xs + ${many(k, (i) => `[${i + 1}]`)} + ["x"]`,
        "say s.length",
        "exit",
      ),
    // one type, the other type first or amid, every term the other type, objects, nested lists
    joinOneType: (k) =>
      lines("let xs = [0]", `let s = xs + ${many(k, (i) => `[${i + 1}]`)}`, "say s.length", "exit"),
    joinOtherFirst: (k) =>
      lines(
        "let xs: (integer | string)[] = [0]",
        `let s = xs + ["x"] + ${many(k, (i) => `[${i + 1}]`)}`,
        "say s.length",
        "exit",
      ),
    joinAlternating: (k) =>
      lines(
        "let xs: (integer | string)[] = [0]",
        `let s = xs + ${many(k, (i) => (i % 2 ? `["x${i}"]` : `[${i}]`))}`,
        "say s.length",
        "exit",
      ),
    joinObjects: (k) =>
      lines(
        `let s = ${many(k, (i) => `[{n: ${i}, m: "a"}]`)} + [{n: "x", m: 1}]`,
        "say s.length",
        "exit",
      ),
    joinNested: (k) =>
      lines(`let s = ${many(k, (i) => `[[${i}]]`)} + [["x"]]`, "say s.length", "exit"),
    joinReadElement: (k) =>
      lines(
        "let xs: (integer | string)[] = [0]",
        `let s = xs + ${many(k, (i) => `[${i + 1}]`)} + ["x"]`,
        "say s[1]",
        "exit",
      ),
    joinInList: (k) =>
      lines(
        "let xs: (integer | string)[] = [0]",
        `let s = [xs + ${many(k, (i) => `[${i + 1}]`)} + ["x"]]`,
        "say s.length",
        "exit",
      ),
    joinHostFirst: (k) =>
      lines(
        `let s = hostValue.items + ${many(k, (i) => `[${i + 1}]`)} + ["x"]`,
        "say s.length",
        "exit",
      ),
    joinRightNested: (k) =>
      lines(
        "let xs: (integer | string)[] = [0]",
        `let s = ${"(".repeat(0)}xs + ${many(k, (i) => `([${i + 1}]`)} + ["x"]${")".repeat(k)}`,
        "say s.length",
        "exit",
      ),
    // other operators: sums, text, `otherwise`, comparisons on a sum
    sumRun: (k) => lines("let a = 1", `let s = a + ${many(k, (i) => `${i + 1}`)}`, "say s", "exit"),
    textRun: (k) =>
      lines('let a = "a"', `let s = a + ${many(k, (i) => `"${i}"`)}`, "say s", "exit"),
    textNumberRun: (k) =>
      lines('let a = "a"', `let s = a + ${many(k, (i) => `${i}`)}`, "say s", "exit"),
    hostSumRun: (k) =>
      lines(`let s = hostValue.n + ${many(k, (i) => `${i + 1}`)}`, "say s", "exit"),
    otherwiseRun: (k) =>
      lines(
        `let s = ${many(k, (i) => `hostValue.f${i}`, " otherwise ")} otherwise 0`,
        "say s",
        "exit",
      ),
    otherwiseDefaults: (k) =>
      lines(
        `let s = ${many(k, (i) => `load("k${i}", default: ${i})`, " otherwise ")}`,
        "say s",
        "exit",
      ),
    // projections and calls nested k deep
    propertyChain: (k) =>
      lines(`let o = ${"{a: ".repeat(k)}1${"}".repeat(k)}`, `say o${".a".repeat(k)}`, "exit"),
    hostPropertyChain: (k) => lines(`say hostValue${".a".repeat(k)}`, "exit"),
    maxChain: (k) =>
      lines(
        "let a = 1",
        `let s = ${"max(".repeat(k)}a${many(k, (i) => `, ${i})`, "")}`,
        "say s",
        "exit",
      ),
    // each prefix bound: a chain of bindings, and k statements adding in place
    boundJoins: (k) =>
      lines(
        "let s0: (integer | string)[] = [0]",
        many(k, (i) => `let s${i + 1} = s${i} + [${i + 1}]`, "\n"),
        `let t = s${k} + ["x"]`,
        "say t.length",
        "exit",
      ),
    compoundJoins: (k) =>
      lines(
        "let xs: (integer | string)[] = [0]",
        many(k, (i) => `xs += [${i}]`, "\n"),
        'xs += ["x"]',
        "say xs.length",
        "exit",
      ),
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
