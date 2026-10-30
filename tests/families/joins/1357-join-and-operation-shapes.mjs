// original joinMixedDeclared, joinMixedUndeclared and related inputs; #1417, builder/review archive
// (desktop:~/work/evidence/1417/a0abf39f0/tools/shapes.mjs).
const corpus = (() => {
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
  return { shapes: shapes };
})();
export const sizes = [1, 2, 3, 5, 9, 16, 64, 128]; // the recorded consumers' sizes
export const shapes = corpus.shapes;

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "otherHost"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node growth.mjs <tree> desktop:~/work/evidence/1417/a0abf39f0/tools/shapes.mjs all 64 src,rev,srcOff,revOff literalUnits,mergeItems,checks,invSteps",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:20",
    ],
    [
      "node answers.mjs <tree> <out> shapes desktop:~/work/evidence/1417/a0abf39f0/tools/shapes.mjs 1,3,5,16",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:26",
    ],
    [
      "node oracle-run.mjs <base> <head> <out> desktop:~/work/evidence/1417/a0abf39f0/tools/shapes.mjs",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:34",
    ],
  ],
  sources: 176,
  sha256: "2e27501a2d17e7551d986cf8e39ecf33481d31c922bc8d9f1ad30550be5509a1",
};
