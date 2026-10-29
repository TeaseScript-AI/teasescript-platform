// original ties-rotated, ties-fixed and related inputs; #1359, r5, reviewer unrecorded (retained in #1417)
// (desktop:~/work/evidence/1417/a0abf39f0/tools/r5-shapes.mjs).
export const sizes = [2, 3, 5, 8, 9, 16, 64, 128]; // the recorded consumers' sizes
const corpus = (() => {
  const many = (n, f, separator = "\n") =>
    Array.from({ length: n }, (_, i) => f(i)).join(separator);
  function tied(k, form = "rotated", spacing = 4) {
    const m = Math.max(4, Math.floor(k / spacing));
    return [
      "let base = 1\nlet early = base\nlet late = base",
      many(
        m,
        (j) =>
          `let p${j} = ${"max(".repeat(k)}early${many(k, (r) => `, ${j !== 0 && r % m === j ? "late" : "early"})`, "")}`,
      ),
      many(k, (i) => {
        let order = Array.from({ length: m }, (_, j) => (form === "fixed" ? j : (i + j) % m));
        if (form === "repeated") order = order.flatMap((j) => [j, j]);
        return `let xs${i} = [${order.map((j) => `p${j}`).join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`;
      }),
      "exit",
    ].join("\n");
  }
  const shapes = {
    "ties-rotated": (k) => tied(k),
    "ties-fixed": (k) => tied(k, "fixed"),
    "ties-repeated": (k) => tied(k, "repeated"),
    "ties-more-peers": (k) => tied(k, "rotated", 2),
  };
  return {
    shapes: {
      "ties-rotated": (n) => shapes["ties-rotated"](n),
      "ties-fixed": (n) => shapes["ties-fixed"](n),
      "ties-repeated": (n) => shapes["ties-repeated"](n),
      "ties-more-peers": (n) => shapes["ties-more-peers"](n),
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "otherHost"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node growth.mjs <tree> desktop:~/work/evidence/1417/a0abf39f0/tools/r5-shapes.mjs all 64 src,rev,srcOff,revOff literalUnits,mergeItems,checks,invSteps",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:20",
    ],
    [
      "node answers.mjs <tree> <out> shapes desktop:~/work/evidence/1417/a0abf39f0/tools/r5-shapes.mjs 8,16",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:26",
    ],
    [
      "node oracle-run.mjs <base> <head> <out> desktop:~/work/evidence/1417/a0abf39f0/tools/r5-shapes.mjs",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:34",
    ],
  ],
  sources: 27,
  sha256: "da2a6f7ff80a0a1bd6ba0a9751e71d98c44e7fa5374e4960ffcb4159bdc62f08",
};
