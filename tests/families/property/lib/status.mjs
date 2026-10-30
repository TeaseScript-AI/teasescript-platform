export const STATUSES = [
  "PASS",
  "FAIL",
  "UNSUPPORTED",
  "OUT_OF_SCOPE",
  "ERROR",
  "TIMEOUT",
  "CANCELLED",
  "NOT_RUN",
];
export function summarize(rows, expected = rows.length) {
  const counts = Object.fromEntries(STATUSES.map((k) => [k, 0]));
  for (const row of rows) {
    if (!(row.status in counts)) throw new Error(`Unknown status ${row.status}`);
    counts[row.status]++;
  }
  if (rows.length !== expected) throw new Error(`Missing result rows: ${rows.length}/${expected}`);
  const checksComplete = counts.PASS + counts.FAIL === expected;
  const verdict = counts.FAIL
    ? "FAIL"
    : counts.ERROR || counts.TIMEOUT || counts.CANCELLED
      ? "ERROR"
      : checksComplete && expected > 0
        ? "PASS"
        : "INCOMPLETE";
  return {
    expected,
    counts,
    verdict,
    checksComplete,
    actualRuntimeExecutions: rows.reduce((n, r) => n + (r.executions ?? 0), 0),
    assertions: rows.reduce((n, r) => n + (r.assertions ?? 0), 0),
  };
}
export function exitCode(summary) {
  return summary.verdict === "PASS" ? 0 : summary.verdict === "FAIL" ? 1 : 2;
}
