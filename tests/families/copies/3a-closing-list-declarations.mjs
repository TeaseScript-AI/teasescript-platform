// Complete programs from the original closing-bench family/size invocations.
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
  ["cap-pair", 31],
  ["cap-pair", 32],
  ["distinct", 8],
  ["distinct", 11],
  ["distinct", 12],
  ["distinct", 15],
  ["distinct", 16],
  ["feedback-literal", 16],
  ["feedback-literal", 18],
  ["feedback-literal", 20],
  ["repeat", 2],
  ["repeat", 8],
  ["repeat", 16],
  ["wide", 256],
  ["wide", 257],
  ["wide-pair", 31],
  ["wide-pair", 32],
  ["wide-pair", 256],
].map(([family, n]) => [family + "@" + n, program(family, n)]);
export const checks = ["publication"];
