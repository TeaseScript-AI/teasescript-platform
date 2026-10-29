// Astra review.
export const cases = (() => {
  const selectionPrelude =
    "let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\n";
  return [["selectionPrelude", selectionPrelude]];
})();
export const checks = ["publication"];
