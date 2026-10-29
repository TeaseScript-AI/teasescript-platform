// #1165 / S8; Astra review.
export const cases = (() => {
  const source = "repeat 1.25 {}\nlet flag:boolean=hostValue\nexit";
  return [["source", source]];
})();
export const checks = ["publication", "stops"];
