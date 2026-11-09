import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { filesAtOnce } from "./test-files-at-once.mjs";
import { trackInFlight } from "./test-in-flight.mjs";
import { suiteName } from "./test-shards.mjs";

// Runs the test files given as arguments in that order, each in its own process, with the reporter and exit status of
// `node --test`, whose command line sorts the files instead, and as many at once as `node --test` runs, fewer where a
// job's memory holds fewer (`tools/test-files-at-once.mjs`). A file that reported no test of its own, as one whose
// process ended before its tests reported (`process.exit(0)`: `node:test` passes it as its file entry alone), is named
// and fails the run. A signal cancels the run as it cancels
// `node --test`, which stops the files' processes instead of leaving them running. Where `TEST_FILE_SECONDS` names a
// file, it receives each file's seconds from its process's start to its end, as CI's test jobs keep them for
// `tools/measure-test-files.mjs`. A test still running long after it began is named on standard error
// (`tools/test-in-flight.mjs`).
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());

const atOnce = filesAtOnce();
const tests = run({
  files: process.argv.slice(2),
  concurrency: atOnce,
  isolation: "process",
  signal: controller.signal,
});
trackInFlight((type, listener) => tests.on(type, listener));
const seconds = {};
// The files that reported a test of their own, and those `node:test` failed as a whole (a killed process): a given file
// in neither reported nothing.
const reported = new Set();
const failedWhole = new Set();
tests.on("test:complete", (data) => {
  if (data.nesting !== 0 || data.file === undefined) return;
  // (a file's own entry is named by its path as given; its seconds are kept by its path under `dist/tests/`, which for a
  // file at the top is its name, as `suiteTestFiles` names it)
  if (resolve(data.name) === data.file) {
    seconds[suiteName(data.file)] = data.details.duration_ms / 1000;
    if (!data.details.passed) failedWhole.add(data.file);
  } else reported.add(data.file);
});
tests.on("test:summary", (summary) => {
  if (!summary.success) process.exitCode = 1;
});
// A signal to the whole process group, as from Ctrl+C, also ends the filter that reads stdout, so the results may find no
// reader. The same signal ends the files' processes, and this process can report one of them before its own signal
// listener runs, so a write can fail before the run is cancelled. A reader that has gone stops the run, whichever came
// first.
await pipeline(tests, spec(), process.stdout).catch((error) => {
  if (error.code !== "EPIPE") throw error;
  controller.abort();
  process.exitCode = 1;
});
for (const file of process.argv.slice(2).map((given) => resolve(given))) {
  if (controller.signal.aborted || reported.has(file) || failedWhole.has(file)) continue;
  process.stderr.write(
    `run-test-files: ${relative(process.cwd(), file)} reported no test of its own: its process ended before its tests reported\n`,
  );
  process.exitCode = 1;
}
if (process.env.TEST_FILE_SECONDS)
  writeFileSync(
    process.env.TEST_FILE_SECONDS,
    `${JSON.stringify({ filesAtOnce: atOnce, seconds })}\n`,
  );
