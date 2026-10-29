// #1165 / S8; Astra review.
export const cases = (() => {
  const source = `repeat hostValue${"[0]".repeat(1040)} {}\nexit`;
  return [["source", source]];
})();
export const checks = ["publication", "stops"];
