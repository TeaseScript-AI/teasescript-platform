// Astra review.
export const cases = (() => {
  const cases = [
    {
      name: "nested-empty-under-nonempty",
      source: `let settings = fromJson(${JSON.stringify('{"rows":[[1]]}')}, default: {rows: [[]]})
let row = settings.rows.get(0, default: [])
let first = row.first`,
    },
    {
      name: "named-recursive-json-default",
      source: `let defaults = {next: fromJson("{}")}
defaults.next = defaults
let parsed = fromJson("{}", default: defaults)`,
    },
    {
      name: "deep-bound-and-direction-controls",
      source: `let grid: integer[][] = [[1]]
grid[0].add(2.5)
function bad(x: integer): integer { return 2.5 }
let widened = 1
widened = 2.5
widened = null
let n = toInteger("2", default: 2.5)
let good = toNumber("2", default: 2)`,
    },
    {
      name: "member-union-groups",
      source: `let left: (integer | string)[] = [1]
let right: (integer | string)[] = ["two"]
let joined = left + right
let value = joined.first`,
    },
    { name: "json-typed-null-control", source: `let n: integer = fromJson("1", default: null)` },
  ];
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];
