// 3a review.
export const cases = (() => {
  const cases = [
    { name: "self-null-json-split", source: 'let xs = null\nxs = toJson(xs).split(",")\nexit' },
    {
      name: "other-null-json-split",
      source: 'let xs = null\nlet ys = toJson(xs).split(",")\nxs = ys\nexit',
    },
    {
      name: "self-dynamic-json-split",
      source: 'let xs = hostValue\nxs = toJson(xs).split(",")\nexit',
    },
    {
      name: "other-dynamic-json-split",
      source: 'let xs = hostValue\nlet ys = toJson(xs).split(",")\nxs = ys\nexit',
    },
  ];
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];
