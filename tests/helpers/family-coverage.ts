/*
 * The coverage check of a generated test family: its cases' coordinates against the feasible ones, which the test
 * enumerates on its own from the axes' domains and constraints. An axis a case has no value on is absent from it.
 */

/** A case's coordinates: its value on each axis it has, as text. */
export type Coordinates = Readonly<Record<string, string>>;

/** Every tuple of the domains' values, in the domains' order. */
export function product(domains: Readonly<Record<string, readonly string[]>>): Coordinates[] {
  return Object.entries(domains).reduce<Coordinates[]>(
    (tuples, [axis, values]) =>
      tuples.flatMap((tuple) => values.map((value) => ({ ...tuple, [axis]: value }))),
    [{}],
  );
}

function pairsOf(tuples: readonly Coordinates[]): Set<string> {
  const pairs = new Set<string>();
  for (const tuple of tuples) {
    const entries = Object.entries(tuple).sort(([one], [other]) => (one < other ? -1 : 1));
    for (let first = 0; first < entries.length; first += 1)
      for (let second = first + 1; second < entries.length; second += 1)
        pairs.add(`${entries[first]!.join("=")} × ${entries[second]!.join("=")}`);
  }
  return pairs;
}

const keyOf = (tuple: Coordinates) =>
  JSON.stringify(Object.entries(tuple).sort(([one], [other]) => (one < other ? -1 : 1)));

/**
 * What `observed` misses of `feasible`, and what it has that is not feasible. By default it matches the feasible pair
 * projections only: a family can cover every pair and still miss whole cases. With `tuples`, it also matches the
 * complete coordinates, so empty then means the family is exactly the feasible space.
 */
export function coverageGaps(
  feasible: readonly Coordinates[],
  observed: readonly Coordinates[],
  { tuples = false }: { readonly tuples?: boolean } = {},
): string[] {
  const gaps: string[] = [];
  const [want, have] = [pairsOf(feasible), pairsOf(observed)];
  for (const pair of want) if (!have.has(pair)) gaps.push(`missing pair ${pair}`);
  for (const pair of have) if (!want.has(pair)) gaps.push(`infeasible pair ${pair}`);
  if (tuples) {
    const [wanted, had] = [new Set(feasible.map(keyOf)), new Set(observed.map(keyOf))];
    for (const tuple of wanted) if (!had.has(tuple)) gaps.push(`missing case ${tuple}`);
    for (const tuple of had) if (!wanted.has(tuple)) gaps.push(`infeasible case ${tuple}`);
  }
  return gaps;
}
