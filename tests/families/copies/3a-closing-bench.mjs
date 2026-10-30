// The closing bench's complete list and scalar programs at the retained family and size arguments, one recorded run
// (the two modules #1427 cut from it, merged); 3a review, round unrecorded (R/pr-3a-closing-check-files/bench.mjs).
/** A former module's sources: its fixed cases, then its shapes at its sizes. */
const expand = ({ sizes = [4, 8], shapes = {}, cases = [] }) => [
  ...cases,
  ...sizes.flatMap((size) =>
    Object.entries(shapes).map(([name, shape]) => [`${name}@${size}`, shape(size)]),
  ),
];

// the list declarations
const a3ClosingListDeclarations = (() => {
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
      source =
        "let a: integer | number = 1\nlet r = min(" + Array(n).fill("a").join(",") + ")\nexit";
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
  const cases = [
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
  return { cases };
})();

// the scalar declarations
const a3ClosingScalarDeclarations = (() => {
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
      source =
        "let a: integer | number = 1\nlet r = min(" + Array(n).fill("a").join(",") + ")\nexit";
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
  const cases = [
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
  return { cases };
})();

export const cases = [a3ClosingListDeclarations, a3ClosingScalarDeclarations].flatMap(expand);
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node bench.mjs bad-min 16", "R/pr-3a-closing-check-files/measurements.jsonl:1"],
    ["node bench.mjs bad-min 17", "R/pr-3a-closing-check-files/measurements.jsonl:2"],
    ["node bench.mjs bad-min 18", "R/pr-3a-closing-check-files/measurements.jsonl:3"],
    ["node bench.mjs bad-min 19", "R/pr-3a-closing-check-files/measurements.jsonl:4"],
    ["node bench.mjs bad-min 20", "R/pr-3a-closing-check-files/measurements.jsonl:5"],
    ["node bench.mjs bad-string 12", "R/pr-3a-closing-check-files/measurements.jsonl:34"],
    ["node bench.mjs bad-string 18", "R/pr-3a-closing-check-files/measurements.jsonl:18"],
    ["node bench.mjs bad-string 21", "R/pr-3a-closing-check-files/measurements.jsonl:13"],
    ["node bench.mjs bad-string 22", "R/pr-3a-closing-check-files/measurements.jsonl:14"],
    ["node bench.mjs bad-string 23", "R/pr-3a-closing-check-files/measurements.jsonl:16"],
    ["node bench.mjs cap-pair 31", "R/pr-3a-closing-check-files/measurements.jsonl:35"],
    ["node bench.mjs cap-pair 32", "R/pr-3a-closing-check-files/measurements.jsonl:36"],
    ["node bench.mjs distinct 8", "R/pr-3a-closing-check-files/measurements.jsonl:33"],
    ["node bench.mjs distinct 11", "R/pr-3a-closing-check-files/measurements.jsonl:20"],
    ["node bench.mjs distinct 12", "R/pr-3a-closing-check-files/measurements.jsonl:17"],
    ["node bench.mjs distinct 15", "R/pr-3a-closing-check-files/measurements.jsonl:11"],
    ["node bench.mjs distinct 16", "R/pr-3a-closing-check-files/measurements.jsonl:12"],
    ["node bench.mjs feedback-literal 16", "R/pr-3a-closing-check-files/measurements.jsonl:19"],
    ["node bench.mjs feedback-literal 18", "R/pr-3a-closing-check-files/measurements.jsonl:21"],
    ["node bench.mjs feedback-literal 20", "R/pr-3a-closing-check-files/measurements.jsonl:22"],
    ["node bench.mjs fold 256", "R/pr-3a-closing-check-files/measurements.jsonl:31"],
    ["node bench.mjs fold 1024", "R/pr-3a-closing-check-files/measurements.jsonl:32"],
    ["node bench.mjs repeat 2", "R/pr-3a-closing-check-files/measurements.jsonl:28"],
    ["node bench.mjs repeat 8", "R/pr-3a-closing-check-files/measurements.jsonl:29"],
    ["node bench.mjs repeat 16", "R/pr-3a-closing-check-files/measurements.jsonl:30"],
    ["node bench.mjs wide 256", "R/pr-3a-closing-check-files/measurements.jsonl:23"],
    ["node bench.mjs wide 257", "R/pr-3a-closing-check-files/measurements.jsonl:24"],
    ["node bench.mjs wide-pair 31", "R/pr-3a-closing-check-files/measurements.jsonl:25"],
    ["node bench.mjs wide-pair 32", "R/pr-3a-closing-check-files/measurements.jsonl:26"],
    ["node bench.mjs wide-pair 256", "R/pr-3a-closing-check-files/measurements.jsonl:27"],
  ],
  sources: 30,
  sha256: "aa1b4b139ac8752e4cc1b851ba15fe2b9ef6dde53311b0880a71bcbd96513cc2",
};
