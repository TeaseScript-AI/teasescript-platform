// #1165 / S8; Astra review.
export const cases = (() => {
  const source =
    'let tally = 1\ntally = 2\ntally = hostValue\nlet picked: integer = tally\nrepeat tally {}\nsay "DONE"\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication", "stops"];
