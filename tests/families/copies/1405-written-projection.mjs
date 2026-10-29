// #1405; builder/review archive.
export const cases = (() => {
  const source =
    [
      "let tally = 1",
      ...Array.from({ length: 60 }, (_, i) => `tally = ${i + 2}`),
      "tally = hostValue",
      "let pair = [tally]",
      "let count = 1",
      "count = 0.5",
      "repeat count {}",
      "repeat pair.first {}",
      "repeat tally {}",
      'say "DONE"',
      "exit",
    ].join("\n") + "\n";
  return [["source", source]];
})();
export const checks = ["publication", "stops"];
