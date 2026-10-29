// #1165 / S8; Astra review.
export const cases = (() => {
  const source =
    "let count = 3\nrepeat count {}\n" +
    "if true {\n".repeat(257) +
    "repeat hostValue {}\n" +
    "}\n".repeat(257) +
    "repeat 0.5 {}\nexit\n";
  return [["source", source]];
})();
export const checks = ["publication", "stops"];
