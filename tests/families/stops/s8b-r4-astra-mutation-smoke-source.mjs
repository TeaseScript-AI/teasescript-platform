// #1165 / S8; Astra review.
export const cases = (() => {
  const source =
    "let amount: integer = hostValue\nlet title: string = hostOther\nsay title\nexit\n";
  return [["source", source]];
})();
export const checks = ["publication", "stops"];
