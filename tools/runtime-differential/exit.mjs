// The differential CLI's one exit decision (docs/TESTING.md "Differential harness"), over every report of a run, by what
// each verdict means:
// - 0: identity (`equivalent`); not compared because the route is unsupported; or censored, both sides equal up to the
//   step limit, which is a sampling bound, not a failure;
// - 1: a decided difference: a `discrepancy`, a `mapping-failure`, or one build rejecting the input at compile or
//   admission while the other does not;
// - 2: a harness or serializer failure, or a verdict the decision does not know.
// 2 wins over 1, and 1 over 0.

const SAME = new Set(["unsupported-route", "censored"]);
const DIFFERENT = new Set(["compile-rejected", "admission-rejected"]);

/** The exit status of a run whose reports are `reports`. */
export function exitStatus(reports) {
  let status = 0;
  for (const report of reports) {
    const kind = report?.verdict?.kind;
    const because = kind === "not-compared" ? report.verdict.because : undefined;
    if (kind === "equivalent" || SAME.has(because)) continue;
    if (kind === "discrepancy" || kind === "mapping-failure" || DIFFERENT.has(because)) status = 1;
    else return 2;
  }
  return status;
}

/**
 * How many reports of each verdict, for the run's summary: `not-compared` ones by their reason, an unsupported route
 * also by the side its verdict names (the first that refused: `left` also when both did), so that a refusal on the right
 * alone, the candidate's against the oracle, shows apart.
 */
export function verdictCounts(reports) {
  const counts = {};
  for (const report of reports) {
    const kind = report?.verdict?.kind;
    const because = kind === "not-compared" ? report.verdict.because : undefined;
    const key =
      because === "unsupported-route"
        ? `not-compared:${because}:${report.verdict.side}`
        : because !== undefined
          ? `not-compared:${because}`
          : String(kind);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** `text` as a whole number of at least `least`, or a usage error naming `flag`. */
export function wholeNumber(text, flag, least) {
  const value = Number(text);
  if (!/^\d+$/u.test(text) || !Number.isSafeInteger(value) || value < least)
    throw new Error(`${flag} must be a whole number of at least ${least}, not '${text}'`);
  return value;
}
