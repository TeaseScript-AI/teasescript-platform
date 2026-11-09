import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { filesAtOnce } from "./test-files-at-once.mjs";
import { trackInFlight } from "./test-in-flight.mjs";
import { suiteName } from "./test-shards.mjs";

// Runs the test files given as arguments in that order, each in its own process, with the reporter and exit status of
// `node --test`, whose command line sorts the files instead, and as many at once as `node --test` runs, fewer where a
// cgroup memory limit holds fewer (`tools/test-files-at-once.mjs`); it records that number. It reads no test runner
// option, so it refuses any given to its own Node (`node --test-concurrency=1 tools/run-test-files.mjs …`) rather than
// ignore it. A signal cancels the run as it cancels `node --test`, which stops the files' processes instead of leaving
// them running. Where `TEST_FILE_SECONDS` names a file, it receives each file's seconds from its process's start to its
// end, as CI's test jobs keep them for `tools/measure-test-files.mjs`. A test still running long after it began is
// named on standard error (`tools/test-in-flight.mjs`).
const atOnce = filesAtOnce();
// A test runner option is any of Node's `--test…` or `--experimental-test…` options, also negated with `--no-`; Node
// reads `_` in an option's name as `-`, so `--test_name_pattern=x` is one too.
const testOptions = process.execArgv.filter((option) =>
  /^--(?:no-)?(?:experimental-)?test(?:-|$)/u.test(option.split("=", 1)[0].replaceAll("_", "-")),
);
if (testOptions.length > 0) {
  await new Promise((resolve) =>
    process.stderr.write(
      `run-test-files: it runs ${atOnce} files at once, as \`node --test\` does by default or fewer under a memory ` +
        `limit, and takes no test runner option: ${testOptions.join(" ")}.\n`,
      resolve,
    ),
  );
  process.exit(1);
}

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());

const tests = run({
  files: process.argv.slice(2),
  concurrency: atOnce,
  isolation: "process",
  signal: controller.signal,
});
trackInFlight((type, listener) => tests.on(type, listener));
const seconds = {};
tests.on("test:complete", (data) => {
  // (a file's own entry is named by its path as given; its seconds are kept by its path under `dist/tests/`, which for a
  // file at the top is its name, as `suiteTestFiles` names it)
  if (data.nesting === 0 && data.file !== undefined && resolve(data.name) === data.file)
    seconds[suiteName(data.file)] = data.details.duration_ms / 1000;
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
