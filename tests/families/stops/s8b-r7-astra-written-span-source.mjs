// #1165 / S8; Astra review.
export const cases = (() => {
  const source = "let reading = 2.75\nlet samples: integer[] = [0]\nsamples = [reading]\nexit";
  return [["source", source]];
})();
export const checks = ["publication", "stops"];
