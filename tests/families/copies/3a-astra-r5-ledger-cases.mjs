// 3a review.
export const cases = (() => {
  const tests = [
    { name: "singleton-union", source: "let x = 1\nexit" },
    { name: "new-kind", source: "let x = 1\nexit" },
  ];
  return tests.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];
