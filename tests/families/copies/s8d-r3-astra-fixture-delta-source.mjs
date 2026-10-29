// Astra review.
export const cases = (() => {
  const source =
    'let choice: integer | string | null = null\nif askBoolean "Continue?" { choice = "later" }\nsay choice + 2\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication"];
