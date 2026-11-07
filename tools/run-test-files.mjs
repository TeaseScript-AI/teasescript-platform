import { writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { run } from "node:test";
import { spec } from "node:test/reporters";

// Runs the test files given as arguments in that order, each in its own process, with the reporter and exit status of
// `node --test`, whose command line sorts the files instead. It runs `filesAtOnce` files at once, which is `node --test`'s
// default concurrency, and records that number; it reads no test runner option, so it refuses any given to its own Node
// (`node --test-concurrency=1 tools/run-test-files.mjs …`) rather than ignore it. A signal cancels the run as it
// cancels `node --test`, which stops the files' processes instead of leaving them running. Where `TEST_FILE_SECONDS`
// names a file, it receives each file's seconds from its process's start to its end, as CI's test jobs keep them for
// `tools/measure-test-files.mjs`.
const filesAtOnce = Math.max(availableParallelism() - 1, 1);
const testOptions = process.execArgv.filter((option) =>
  /^--(?:experimental-)?test(?:-|=|$)/u.test(option),
);
if (testOptions.length > 0) {
  await new Promise((resolve) =>
    process.stderr.write(
      `run-test-files: it runs ${filesAtOnce} files at once, as \`node --test\` does by default, and takes no test ` +
        `runner option: ${testOptions.join(" ")}.\n`,
      resolve,
    ),
  );
  process.exit(1);
}

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());

const tests = run({
  files: process.argv.slice(2),
  concurrency: filesAtOnce,
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
// A signal to the whole process group, as from Ctrl+C, also ends the filter that reads stdout, so the cancelled results
// may find no reader.
await pipeline(tests, spec(), process.stdout).catch((error) => {
  if (!controller.signal.aborted || error.code !== "EPIPE") throw error;
});
if (process.env.TEST_FILE_SECONDS)
  writeFileSync(process.env.TEST_FILE_SECONDS, `${JSON.stringify({ filesAtOnce, seconds })}\n`);
