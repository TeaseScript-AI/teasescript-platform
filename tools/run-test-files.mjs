import { availableParallelism } from "node:os";
import { pipeline } from "node:stream/promises";
import { run } from "node:test";
import { spec } from "node:test/reporters";

// Runs the test files given as arguments in that order, each in its own process, with the reporter and exit status of
// `node --test`, whose command line sorts the files instead. It runs as many files at once as the machine has CPUs,
// one more than `node --test`: this process only relays their results, and on CI's four CPUs the fourth would
// otherwise stay idle (#1638). A signal cancels the run as it cancels `node --test`, which stops the files' processes
// instead of leaving them running.
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());

const tests = run({
  files: process.argv.slice(2),
  concurrency: availableParallelism(),
  isolation: "process",
  signal: controller.signal,
});
tests.on("test:summary", (summary) => {
  if (!summary.success) process.exitCode = 1;
});
// A signal to the whole process group, as from Ctrl+C, also ends the filter that reads stdout, so the cancelled results
// may find no reader.
await pipeline(tests, spec(), process.stdout).catch((error) => {
  if (!controller.signal.aborted || error.code !== "EPIPE") throw error;
});
