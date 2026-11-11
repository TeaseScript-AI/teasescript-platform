import { trackInFlight } from "./test-in-flight.mjs";

// A node:test reporter (`--test-reporter`) that counts each test file's results, for `test-output-filter.mjs`'s compact
// output of a run of named files: when the run ends, it yields one JSON object that maps each file, by its path as
// node:test reports it, to its tests' counts `{ passed, failed, cancelled, skipped, todo }`, in node:test's own classes:
// a test counts for the file whose process ran it (`entryFile`), whichever module registered it; a suite (`describe`)
// is no test; a skipped, then a todo test counts as that, whatever its result; a test that timed out or whose parent
// ended first is cancelled. Every file the run started is there, also one whose process ended before any test
// reported, or that holds suites alone, with all counts 0.
// It also names on standard error a test still running long after it began, as `test-in-flight.mjs`'s reporter does,
// in its place: node:test warns of a possible listener leak on a third reporter beside the spec reporter.
// node:test's failure types of a cancelled test
const CANCELLED = new Set(["cancelledByParent", "testTimeoutFailure"]);

export default async function* testFileCounts(source) {
  const listeners = new Map();
  trackInFlight((type, listener) => listeners.set(type, listener));
  const counts = {};
  const of = (file) =>
    (counts[file] ??= { passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 });
  for await (const { type, data } of source) {
    listeners.get(type)?.(data);
    if (type !== "test:pass" && type !== "test:fail") continue;
    // a file's own entry: the file, with no entry file of its own
    if (data.entryFile === undefined) {
      if (data.nesting === 0 && data.file !== undefined) of(data.file);
      continue;
    }
    const count = of(data.entryFile);
    if (data.details.type === "suite") continue;
    if (data.skip !== undefined) count.skipped += 1;
    else if (data.todo !== undefined) count.todo += 1;
    else if (type === "test:pass") count.passed += 1;
    else if (CANCELLED.has(data.details.error?.failureType)) count.cancelled += 1;
    else count.failed += 1;
  }
  yield `${JSON.stringify(counts)}\n`;
}
