// original boundWideHost, boundWideHostProjection and related inputs; #1359, r1, reviewer unrecorded (retained in
// #1417) (desktop:~/work/evidence/1417/a0abf39f0/tools/r1/own-shapes.mjs).
const corpus = (() => {
  const many = (n, f, by = ", ") => Array.from({ length: n }, (_, i) => f(i)).join(by);
  const lines = (...s) => s.join("\n");
  const shapes = {
    boundWideHost: (k) =>
      lines(
        `let root = {${many(k, (i) => `f${i}: hostValue`)}}`,
        `let xs = [${many(k, () => "root")}]`,
        "let n: integer = xs[hostValue.i].f0",
        "exit",
      ),
    boundWideHostProjection: (k) =>
      lines(
        `let root = {${many(k, (i) => `f${i}: hostValue.n`)}}`,
        `let xs = [${many(k, () => "root")}]`,
        "let n: integer = xs[hostValue.i].f0",
        "exit",
      ),
    boundWideConstant: (k) =>
      lines(
        `let root = {${many(k, (i) => `f${i}: ${i}`)}}`,
        `let xs = [${many(k, () => "root")}]`,
        "let n: integer = xs[hostValue.i].f0",
        "exit",
      ),
    boundJoinCopies: (k) =>
      lines(
        "let first: (integer | string)[] = [0]",
        `let joined = first + ${many(k, (i) => `[${i}]`, " + ")} + ["x"]`,
        `let xs = [${many(k, () => "joined")}]`,
        "say xs[hostValue.i][0]",
        "exit",
      ),
    boundJoinHostCopies: (k) =>
      lines(
        `let joined = hostValue + ${many(k, (i) => `[${i}]`, " + ")}`,
        `let xs = [${many(k, () => "joined")}]`,
        "say xs[0][0]",
        "exit",
      ),
    boundOtherwiseCopies: (k) =>
      lines(
        `let root = ${many(k, (i) => `hostValue.f${i}`, " otherwise ")} otherwise {a: 0}`,
        `let xs = [${many(k, () => "root")}]`,
        "let n: integer = xs[0].a",
        "exit",
      ),
    boundScalarOperation: (k) =>
      lines(
        `let root = hostValue + ${many(k, (i) => `${i}`, " + ")}`,
        `let xs = [${many(k, () => "root")}]`,
        "say xs[0]",
        "exit",
      ),
    boundGetChain: (k) =>
      lines(
        `let root = hostValue${many(k, (i) => `.get("a", default: {n: ${i}})`, "")}`,
        `let xs = [${many(k, () => "root")}]`,
        "let n: integer = xs[hostValue.i].n",
        "exit",
      ),
    boundMaxChain: (k) =>
      lines(
        `let root = ${"max(".repeat(k)}hostValue${many(k, (i) => `, ${i})`, "")}`,
        `let xs = [${many(k, () => "root")}]`,
        "say xs[0]",
        "exit",
      ),
    wrappedJoinPrefixes: (k) =>
      lines(
        "let first: (integer | string)[] = [0]",
        `let result = ${Array.from({ length: k }, (_, i) => i).reduce((s, i) => `({n: ${s} + [${i}]}).n`, "first")} + ["s"]`,
        "say result.length",
        "exit",
      ),
    wrappedScalarPrefixes: (k) =>
      lines(
        `let result = ${Array.from({ length: k }, (_, i) => i).reduce((s, i) => `({n: ${s} + ${i}}).n`, "hostValue")}`,
        "say result",
        "exit",
      ),
    wrappedFallbackPrefixes: (k) =>
      lines(
        `let result = ${Array.from({ length: k }, (_, i) => i).reduce((s, i) => `({n: (${s} otherwise hostValue.f${i})}).n`, "hostValue")}`,
        "let n: integer = result",
        "exit",
      ),
    boundHostSeparateLists: (k) =>
      lines(
        `let root = {${many(k, (i) => `f${i}: hostValue`)}}`,
        many(
          k,
          (i) => `let xs${i} = [root, {f0: 1}]\nlet n${i}: integer = xs${i}[hostValue.i].f0`,
          "\n",
        ),
        "exit",
      ),
    boundJoinSeparateLists: (k) =>
      lines(
        "let first: (integer | string)[] = [0]",
        `let root = first + ${many(k, (i) => `[${i}]`, " + ")} + ["s"]`,
        many(k, (i) => `let xs${i} = [root, [1]]\nsay xs${i}[hostValue.i][0]`, "\n"),
        "exit",
      ),
  };
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
      "node growth.mjs <tree> desktop:~/work/evidence/1417/a0abf39f0/tools/r1/own-shapes.mjs all 64 src,rev,srcOff,revOff literalUnits,mergeItems,checks,invSteps",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:20",
    ],
    [
      "node answers.mjs <tree> <out> shapes desktop:~/work/evidence/1417/a0abf39f0/tools/r1/own-shapes.mjs 1,3,8",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:26",
    ],
    [
      "node oracle-run.mjs <base> <head> <out> desktop:~/work/evidence/1417/a0abf39f0/tools/r1/own-shapes.mjs",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:34",
    ],
    [
      "node prefix-differential.mjs",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:36",
    ],
  ],
  sources: 112,
  sha256: "b696a2ce18aa3bbe12192f8a7e7d30c658c7570b70c48b567fe6489b2ab99de8",
};
