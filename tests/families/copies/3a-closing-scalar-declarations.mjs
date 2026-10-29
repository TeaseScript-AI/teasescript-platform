// complete closing-bench scalar programs at the retained family/size arguments; 3a review, round unrecorded
// (R/pr-3a-closing-check-files/bench.mjs).
function program(family, n) {
  let source;
  const listDecl = (count) =>
    Array.from({ length: count }, (_, i) => `let a${i}: integer[] | number[] = [1]`).join("\n");
  const scalarDecl = (count) =>
    Array.from({ length: count }, (_, i) => `let a${i}: integer | number = 1`).join("\n");
  if (family === "distinct" || family === "repeat")
    source =
      (family === "distinct" ? listDecl(n) : listDecl(1)) +
      "\nlet r = " +
      Array.from({ length: n }, (_, i) => `a${family === "distinct" ? i : 0}`).join(" + ") +
      "\nexit";
  else if (family === "bad-string" || family === "bad-min")
    source =
      scalarDecl(n) +
      "\nlet r = " +
      (family === "bad-string" ? "toString" : "min") +
      "(" +
      Array.from({ length: n }, (_, i) => `a${i}`).join(",") +
      (family === "bad-min" ? ", default: 1" : "") +
      ")\nexit";
  else if (family === "cap-pair")
    source =
      "let a = [" +
      Array(Math.max(1, n - 1))
        .fill("[1]")
        .join(",") +
      "].get(0, default: [2])\nlet r = a + a\nexit";
  else if (family === "wide" || family === "wide-pair")
    source =
      "let a = [" +
      Array(Math.max(1, n - 1))
        .fill("[1]")
        .join(",") +
      "].get(0, default: [2])\nlet r = toString(a" +
      (family === "wide-pair" ? ",a" : "") +
      ")\nexit";
  else if (family === "fold")
    source = "let a: integer | number = 1\nlet r = min(" + Array(n).fill("a").join(",") + ")\nexit";
  else if (family.startsWith("feedback-"))
    source =
      "let xs = " +
      {
        "feedback-get": "[[1]].get(0, default: [2])",
        "feedback-otherwise": "[1] otherwise [2]",
        "feedback-literal": "[1]",
      }[family] +
      "\n" +
      Array(n).fill("xs = xs + []").join("\n") +
      "\nexit";
  else if (family === "copy-chain")
    source =
      "let a0=[1]\n" +
      Array.from({ length: n }, (_, i) => `let a${i + 1}=a${i}`).join("\n") +
      "\nexit";

  return source;
}
export const cases = [
  ["bad-min", 16],
  ["bad-min", 17],
  ["bad-min", 18],
  ["bad-min", 19],
  ["bad-min", 20],
  ["bad-string", 12],
  ["bad-string", 18],
  ["bad-string", 21],
  ["bad-string", 22],
  ["bad-string", 23],
  ["fold", 256],
  ["fold", 1024],
].map(([family, n]) => [family + "@" + n, program(family, n)]);
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node bench.mjs <family> <size> for bad-min 16 to 20; bad-string 12, 18, 21, 22, 23; fold 256, 1024",
      "R/pr-3a-closing-check-files/measurements.jsonl (one row per invocation)",
    ],
  ],
  sources: 12,
  sha256: "1220966b9b1a668692df3b8a7a2e8b357b0c2fdfec841c8141c0106feb52d6a7",
};
