// The differential CLI's one exit decision (docs/TESTING.md "Differential harness"), over every report of a run: 2 when
// any side failed in the harness (`harness-failure`, `serializer-failure`), else 1 when any pair is a `discrepancy` or
// a `mapping-failure`, else 0. A pair not compared for another reason, such as `unsupported-route`, is not a failure.

const HARNESS = new Set(["harness-failure", "serializer-failure"]);

/** The exit status of a run whose reports are `reports`. */
export function exitStatus(reports) {
  let status = 0;
  for (const report of reports) {
    if (report.verdict.kind === "not-compared" && HARNESS.has(report.verdict.because)) return 2;
    if (report.verdict.kind === "discrepancy" || report.verdict.kind === "mapping-failure")
      status = 1;
  }
  return status;
}

/** `text` as a whole number of at least `least`, or a usage error naming `flag`. */
export function wholeNumber(text, flag, least) {
  const value = Number(text);
  if (!/^\d+$/u.test(text) || !Number.isSafeInteger(value) || value < least)
    throw new Error(`${flag} must be a whole number of at least ${least}, not '${text}'`);
  return value;
}
