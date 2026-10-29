// 3a review.
export const cases = (() => {
  const init = "let a = [" + Array(31).fill("[1]").join(",") + "].get(0, default: [2])\n";
  return [["init", init]];
})();
export const checks = ["publication"];
