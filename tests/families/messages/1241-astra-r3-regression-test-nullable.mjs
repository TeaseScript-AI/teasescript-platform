// #1241; Astra review.
export const cases = (() => {
  const nullable = "let ns = [2, null]\nlet n = ns[1]\n";
  return [["nullable", nullable]];
})();
export const checks = ["publication"];
