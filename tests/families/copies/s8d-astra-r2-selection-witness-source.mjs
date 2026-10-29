// Astra review.
export const cases = (() => {
  const source = "let groups: integer[][] = [[], [21]]\nsay groups.random.last\nexit\n";
  return [["source", source]];
})();
export const checks = ["publication"];
