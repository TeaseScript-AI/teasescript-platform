// #1165 / S8; Astra review.
export const cases = (() => {
  const source = [
    "let tally = 1",
    ...Array.from({ length: 24 }, (_, i) => `tally = ${i + 2}`),
    "tally = hostValue",
    "let picked: integer = tally",
    "repeat tally {}",
    'say "DONE"',
    "exit",
  ].join("\n");
  return [["source", source]];
})();
export const checks = ["publication", "stops"];
