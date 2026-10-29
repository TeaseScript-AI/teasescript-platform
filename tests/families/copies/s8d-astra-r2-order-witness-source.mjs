// Astra review.
export const cases = (() => {
  const source =
    'let flagHost = askBoolean "flag"\nlet value: integer | string | null = null\nif flagHost { value = "bad" }\nsay value + 1\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication"];
