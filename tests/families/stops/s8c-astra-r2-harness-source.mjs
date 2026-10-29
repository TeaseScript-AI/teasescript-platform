// #1165 / S8; Astra review.
export const cases = (() => {
  const source = 'let value: integer = "wrong"\nexit';
  return [["source", source]];
})();
export const checks = ["publication", "stops"];
