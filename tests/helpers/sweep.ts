/**
 * A sweep's sample (`docs/TESTING.md`, "Sampled sweeps"): a test that claims something at every member of a list of
 * settled stops, allowances or sizes visits its first, its last and two evenly between, unless `TEASESCRIPT_SWEEP=full`
 * asks for the whole list, as the sweeps' queue evidence does.
 */
export const SWEEP = process.env["TEASESCRIPT_SWEEP"] === "full";

/** A sweep's first, its last and two evenly between; the whole sweep where `SWEEP` holds or it has at most four. */
export function sampled<T>(sweep: readonly T[]): T[] {
  if (SWEEP || sweep.length <= 4) return [...sweep];
  return [0, 1, 2, 3].map((i) => sweep[Math.round((i * (sweep.length - 1)) / 3)]!);
}
