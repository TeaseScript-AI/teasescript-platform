import { hash, requireInteger } from "./json.mjs";

function tuples(c, groups) {
  return groups.map((g) => JSON.stringify(g.map((k) => [k, c.dimensions[k]])));
}
/** Cover declared interactions; no claim that undeclared interactions are covered. */
export function select(cases, groups, limit, seed) {
  requireInteger(limit, "case limit", 1);
  requireInteger(seed, "seed", 0, 0xffffffff);
  const universe = new Set(cases.flatMap((c) => tuples(c, groups)));
  const left = new Map(cases.map((c) => [c.id, c]));
  const covered = new Set(),
    selected = [];
  // A stable representative is an anchor, not an imported regression source.
  const anchor = cases.find(
    (c) =>
      c.dimensions.leaf === "integer" &&
      c.dimensions.depth === 2 &&
      c.dimensions.nullable === "none" &&
      c.dimensions.carrier === "copy",
  );
  const take = (c) => {
    selected.push(c);
    left.delete(c.id);
    for (const t of tuples(c, groups)) covered.add(t);
  };
  if (anchor) take(anchor);
  while (left.size && selected.length < limit) {
    const ranked = [...left.values()].map((c) => ({
      c,
      gain: tuples(c, groups).filter((t) => !covered.has(t)).length,
      tie: hash(`${seed}:${c.id}`),
    }));
    ranked.sort((a, b) => b.gain - a.gain || a.tie.localeCompare(b.tie));
    take(ranked[0].c);
  }
  return {
    selected,
    coverage: {
      declaredInteractionGroups: groups,
      possible: universe.size,
      covered: covered.size,
      missing: [...universe].filter((t) => !covered.has(t)).sort(),
      exhaustiveSources: selected.length === cases.length,
    },
  };
}
export const modes = Array.from({ length: 8 }, (_, i) => ({
  id: `c${i & 1}s${(i >> 1) & 1}h${(i >> 2) & 1}`,
  reverseConsumers: !!(i & 1),
  reverseSolver: !!(i & 2),
  sharing: !(i & 4),
}));
export const profiles = {
  quick: {
    sources: 12,
    modes: [modes[0], modes[3]],
    policies: [
      { kind: "none" },
      { kind: "demand", units: 32 },
      { kind: "demand", units: 64 },
      { kind: "program", units: 1 },
    ],
    deadlineMs: 180000,
  },
  focused: {
    sources: 90,
    modes,
    policies: [
      { kind: "none" },
      ...[1, 16, 32, 64, 128, 256, 512].map((units) => ({ kind: "demand", units })),
      { kind: "program", units: 1 },
    ],
    deadlineMs: 900000,
  },
  deep: {
    sources: 90,
    modes,
    policies: [
      { kind: "none" },
      ...[1, 2, 8, 16, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 257, 512, 1024].map(
        (units) => ({ kind: "demand", units }),
      ),
      ...[1, 64, 256, 1024].map((units) => ({ kind: "program", units })),
    ],
    deadlineMs: 1800000,
  },
};
