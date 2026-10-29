// #1165 / S8; Astra review.
export const cases = (() => {
  const s = "let first: integer=hostValue\nlet second: string=hostOther\nexit";
  return [["s", s]];
})();
export const checks = ["publication", "stops"];
