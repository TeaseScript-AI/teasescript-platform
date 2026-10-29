// Astra review.
export const cases = (() => {
  const collision =
    'let value = "inventory"\nlet remaining = [3, null]\nlet value = remaining[0]\nif value != null { repeat value {} }\nsay value\nexit\n';
  return [["collision", collision]];
})();
export const checks = ["publication"];
