// Astra review.
export const cases = (() => {
  const capture =
    "let groups: integer[][] = [[], [21]]\nlet chosen = groups.random\nif chosen.length > 0 { say chosen.last }\nexit\n";
  return [["capture", capture]];
})();
export const checks = ["publication"];
