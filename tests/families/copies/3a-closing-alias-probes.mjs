// 3a review.
export const cases = (() => {
  const cases = [
    ["self-dynamic-split", 'let xs = hostValue\nxs = toString(xs).split(",")\nexit'],
    ["other-dynamic-split", 'let xs = hostValue\nlet ys = toString(xs).split(",")\nxs = ys\nexit'],
    ["self-null-split", 'let xs = null\nxs = toString(xs).split(",")\nexit'],
    ["other-null-split", 'let xs = null\nlet ys = toString(xs).split(",")\nxs = ys\nexit'],
    ["self-list-set", "let xs = [1]\nxs = xs.toSet()\nexit"],
    ["other-list-set", "let xs = [1]\nlet ys = xs.toSet()\nxs = ys\nexit"],
    ["self-set-list", "let xs = set {1}\nxs = xs.toList()\nexit"],
    ["self-null-list", "let xs = null\nxs = toList(xs)\nexit"],
    ["self-dynamic-list", "let xs = hostValue\nxs = toList(xs)\nexit"],
    ["self-list-split", 'let xs = [1]\nxs = toString(xs).split(",")\nexit'],
    ["self-bound-list-set", "let xs: integer[] = [1]\nxs = xs.toSet()\nexit"],
    ["self-bound-cross", "let xs: integer[] | string set = [1]\nxs = xs.toSet()\nexit"],
    ["self-form-return", 'let xs = [1]\nxs = askForm("Q", fields: {q: {options: xs}})\nexit'],
    ["self-ignored-input", 'let xs = [1]\nxs = toString("a,b", xs).split(",")\nexit'],
    ["self-split-ref", 'let xs = [1]\nxs = toString(xs).split(",")\nexit'],
    ["self-bound-number", "let xs: integer[] = [1]\nxs = xs + [2.5]\nexit"],
  ];
  return cases.map(([name, source]) => [name, source]);
})();
export const checks = ["publication"];

for (const index of [8, 7, 6]) cases.splice(index, 1);
