// #1165 / S8; Astra review.
export const cases = (() => {
  const prefix = "let count: integer = 2\nlet base: integer[] = [1]\nlet src = [1, 2]\n";
  return [["prefix", prefix]];
})();
export const checks = ["publication", "stops"];
