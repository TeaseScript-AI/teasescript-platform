// Astra review.
export const cases = (() => {
  const fixed =
    "let groups: integer[][] = [[], [21]]\nif groups.random.length > 0 { say groups.random.last }\nexit\n";
  return [["fixed", fixed]];
})();
export const checks = ["publication"];
