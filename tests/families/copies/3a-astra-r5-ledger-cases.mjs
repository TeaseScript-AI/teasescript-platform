// 3a review.
export const cases = (() => {
  const tests = [
    {
      name: "quoted-property-comma",
      source: 'let x = {"a,x,y,z": 1}\nexit',
      from: '"a,x,y,z"',
      to: '"a,y,x,z"',
    },
    { name: "quoted-property-simple", source: 'let x = {"a": 1}\nexit', from: '"a"', to: '"b"' },
    {
      name: "singleton-union",
      source: "let x = 1\nexit",
      from: "integer",
      to: "(integer|integer)",
    },
    { name: "new-kind", source: "let x = 1\nexit", from: "integer", to: "string" },
  ];
  return tests.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];
