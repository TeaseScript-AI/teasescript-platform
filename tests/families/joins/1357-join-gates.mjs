// original join-run-ending-in-another-type, join-prefixes-each-in-an-object; #1417, builder/review archive
// (desktop:~/work/evidence/1417/a0abf39f0/tools/gates.mjs).
const corpus = (() => {
  const many = (k, f, sep) => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const shapes = {
    "join-run-ending-in-another-type": (k) =>
      [
        "let xs: (integer | string)[] = [0]",
        `let s = xs + ${many(k, (i) => `[${i + 1}]`, " + ")} + ["x"]`,
        "say s.length",
        "exit",
      ].join("\n"),
    "join-prefixes-each-in-an-object": (k) => {
      let joined = "xs";
      for (let i = 0; i < k; i += 1) joined = `({n: ${joined} + [${i}]}).n`;
      return [
        "let xs: (integer | string)[] = [0]",
        `let s = ${joined} + ["x"]`,
        "say s.length",
        "exit",
      ].join("\n");
    },
  };
  return { shapes: shapes };
})();
export const sizes = [1, 2, 3, 5, 8, 9, 16, 64, 128]; // the recorded consumers' sizes
export const shapes = corpus.shapes;

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "otherHost"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node growth.mjs <tree> desktop:~/work/evidence/1417/a0abf39f0/tools/gates.mjs all 64 src,rev,srcOff,revOff literalUnits,mergeItems,checks,invSteps",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:20",
    ],
    [
      "node answers.mjs <tree> <out> shapes desktop:~/work/evidence/1417/a0abf39f0/tools/gates.mjs 1,3,8",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:26",
    ],
    [
      "node oracle-run.mjs <base> <head> <out> desktop:~/work/evidence/1417/a0abf39f0/tools/gates.mjs",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:34",
    ],
    [
      "node growth.mjs <tree> desktop:~/work/evidence/1417/a0abf39f0/tools/gates.mjs all 8 src,srcOff literalUnits",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/quick.sh:6",
    ],
  ],
  sources: 18,
  sha256: "6369c67e3e7e77dbe0e88924ddf9d3d398f5ec8f363c1a512cebcc5b49e6b9d8",
};
