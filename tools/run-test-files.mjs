import { writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { filesAtOnce } from "./test-files-at-once.mjs";

// Runs the test files given as arguments in that order, each in its own process, with the reporter and exit status of
// `node --test`, whose command line sorts the files instead, and as many at once as `node --test` runs, fewer where a
// cgroup memory limit holds fewer (`tools/test-files-at-once.mjs`). A signal cancels the run as it cancels
// `node --test`, which stops the files' processes instead of leaving them running. Where `TEST_FILE_SECONDS` names a
// file, it receives each file's seconds from its process's start to its end, as CI's test jobs keep them for
// `tools/measure-test-files.mjs`.
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());

const atOnce = filesAtOnce();
const tests = run({
  files: process.argv.slice(2),
  concurrency: atOnce,
  isolation: "process",
  signal: controller.signal,
});
const seconds = {};
tests.on("test:complete", (data) => {
  // (a file's own entry is named by its path as given)
  if (data.nesting === 0 && data.file !== undefined && resolve(data.name) === data.file)
    seconds[basename(data.file)] = data.details.duration_ms / 1000;
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
if (process.env.TEST_FILE_SECONDS)
  writeFileSync(
    process.env.TEST_FILE_SECONDS,
    `${JSON.stringify({ filesAtOnce: atOnce, seconds })}\n`,
  );
