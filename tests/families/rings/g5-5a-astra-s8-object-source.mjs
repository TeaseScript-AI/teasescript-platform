// #1394 G5 5a Astra review / builder corpus.
export const cases = (() => {
  const source =
    [
      "let a0 = {p: 1}",
      "let a1 = a0",
      "let a2 = a1",
      "a0 = a2",
      ...Array.from({ length: 24 }, (_, i) => `a1 = {p: ${i + 2}}`),
      "a1 = {p: hostValue}",
      "let picked: integer = a1.p",
      "let relay = a1",
      "repeat {kept: a1}.kept.p {}",
      "repeat a1.p {}",
      "repeat relay.p {}",
      "exit",
    ].join("\n") + "\n";
  return [["source", source]];
})();
export const checks = ["publication", "stops"];
