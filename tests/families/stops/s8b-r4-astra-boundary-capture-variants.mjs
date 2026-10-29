// #1165 / S8; Astra review.
export const cases = (() => {
  const variants = [
    ["add", "let total = hostValue + 8\nrepeat hostOther { say total }\nexit\n", 253],
    ["add-say", "let total = hostValue + 6\nsay total\nexit\n"],
    ["subtract", "let total = hostValue - 6\nsay total\nexit\n"],
    ["multiply", "let total = hostValue * 6\nsay total\nexit\n"],
    ["compare", "let total = hostValue > 6\nsay total\nexit\n"],
    ["written", "let total: number = hostValue + 6\nsay total\nexit\n"],
  ];
  return variants.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];
