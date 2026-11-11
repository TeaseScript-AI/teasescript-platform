import { relative, resolve } from "node:path";

// Names where a run has stopped making progress, so that a run a queue's timeout ends (which kills every process of the
// run at once, the test files' too) has already said where it hung. From node:test's own events, `test:dequeue` (a test
// begins) and `test:complete` (it ends), each file's innermost running test is known, and when a test last began or
// ended there. Once a file has gone `AFTER_MS` without either, a line on standard error names its innermost test with
// its parents, and again each `AFTER_MS` while it stays so; files are looked at once a minute. The longest test of the
// suite took 99 s at 15 files at once on desktop (2026-11-08), so a passing run of today's suite prints nothing. A test
// fails at `TEST_LIMIT_MS`, so this names what that limit does not end: synchronous work, a file stalled outside its
// tests (loading, or between them), or a test given a longer `timeout` of its own. The timer does not keep a run alive.
export const AFTER_MS = 5 * 60_000;

/**
 * The longest a test, and each of its hooks apart, may wait: past it Node fails the test as `test timed out`, its `✖`
 * line printed then, and its file's other tests still run. It cannot end synchronous work, which holds its timer back.
 * Both runners of the suite give it (`run-test-files.mjs`, and `test-output-filter.mjs` for named files, where a later
 * `--test-timeout` replaces it), so an asynchronous hang is a named failure before a job's limit (#2454). What the test
 * left running can still keep its file's process, and the run, alive until that limit. A test's own `timeout` option
 * replaces it for the test, not for its hooks, which take one of their own.
 * 5 minutes is a measurement, to redo as the suite's costliest tests change (2026-11-11): the longest test took 125 s and
 * 159 s in two full runs on queue workers (jobs 11111622335a16, 11111647209084), the costliest file 177 s in CI (median,
 * `costly-test-files.mjs`), and CI's test jobs take 5 to 7 of their 15 minutes.
 */
export const TEST_LIMIT_MS = 5 * 60_000;
const LOOK_MS = 60_000;

/** `ms` as minutes and seconds: `10m 0s`. */
const duration = (ms) => `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;

/**
 * Follows the events `on(type, listener)` gives and reports, through `write`, each file's innermost test once the file
 * has gone `after` without a test beginning or ending, and again each `after` while it stays so, looking every `look`
 * (`now` and `every`, the clock and the timer, a test can replace). Returns the look, for a test to call.
 */
export function trackInFlight(
  on,
  {
    after = AFTER_MS,
    look = LOOK_MS,
    write = (line) => process.stderr.write(line),
    now = Date.now,
    every = (callback, ms) => setInterval(callback, ms).unref(),
  } = {},
) {
  // Per file, its running tests from the outermost in; the innermost has when the file last had a test begin or end. In
  // a run of separate processes, a file's own entry is named by its path and its top-level tests share its nesting 0,
  // so the file's entry is told apart by its name, and a test's ancestors by their smaller nesting.
  const running = new Map();
  const ownEntry = ({ file, name }) => file !== undefined && resolve(name) === file;
  // (a test ending, or its sibling beginning, ends whatever ran at its depth or deeper; the file's entry stays)
  const unwind = (stack, nesting) => {
    while (stack.length > 0 && !stack.at(-1).file && stack.at(-1).nesting >= nesting) stack.pop();
  };
  // A monitor never fails the run it watches: an event it cannot place is left out.
  const guarded = (listener) => (data) => {
    try {
      listener(data);
    } catch {
      // (nothing to report about the report)
    }
  };
  on(
    "test:dequeue",
    guarded((data) => {
      const stack = ownEntry(data) ? [] : (running.get(data.file) ?? []);
      unwind(stack, data.nesting);
      stack.push({ name: data.name, nesting: data.nesting, file: ownEntry(data), since: now() });
      running.set(data.file, stack);
    }),
  );
  on(
    "test:complete",
    guarded((data) => {
      const stack = running.get(data.file);
      if (stack === undefined) return;
      if (ownEntry(data)) return void running.delete(data.file);
      unwind(stack, data.nesting);
      if (stack.length === 0) return void running.delete(data.file);
      Object.assign(stack.at(-1), { since: now(), reported: undefined });
    }),
  );
  const report = guarded(() => {
    for (const [file, stack] of running) {
      const innermost = stack.at(-1);
      if (innermost === undefined || now() - (innermost.reported ?? innermost.since) < after)
        continue;
      innermost.reported = now();
      const names = stack.filter((test) => !test.file).map((test) => test.name);
      write(
        `test-in-flight: ${duration(now() - innermost.since)} without a test beginning or ending in ` +
          `${[relative(process.cwd(), file ?? "?"), ...names].join(" › ")}\n`,
      );
    }
  });
  every(report, look);
  return report;
}

/** As a reporter (`--test-reporter`): it follows the run's events and yields nothing of its own. */
export default async function* inFlightReporter(source) {
  const listeners = new Map();
  trackInFlight((type, listener) => listeners.set(type, listener));
  for await (const event of source) listeners.get(event.type)?.(event.data);
}
