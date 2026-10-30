import { spawn, spawnSync } from "node:child_process";
import { fstatSync, globSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { costlyTestFiles } from "./costly-test-files.mjs";

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function isPassingTestLine(line) {
  const plain = line.replace(ANSI_ESCAPE_PATTERN, "").trimStart();
  return /^✔(?:\s|$)/u.test(plain);
}

async function refuse(text) {
  // Exiting at once could cut off diagnostics that a pipe has not taken yet.
  await new Promise((resolve) => process.stderr.write(text, resolve));
  process.exit(1);
}

const usage =
  "test-output-filter: this tool runs the tests itself and takes no standard input, so do not pipe into it.\n" +
  "Usage: node tools/test-output-filter.mjs [--full-output] [test file ...]\n";

// The filter runs tests and never filters its standard input, so data piped in, most likely another command's output,
// would be ignored while the tests ran, without arguments the whole suite. Only data counts: a GitHub Actions step's
// standard input is a pipe that ends at once, and one from ssh or from a parent's default `spawn` can stay open without
// data.
function standardInput() {
  try {
    const stats = fstatSync(0);
    if (stats.isFile()) return stats.size > 0 ? "data" : "none";
    return stats.isFIFO() || stats.isSocket() ? "stream" : "none";
  } catch {
    // Standard input is closed.
    return "none";
  }
}
const input = standardInput();
if (input === "data") await refuse(usage);

const arguments_ = process.argv.slice(2);
const fullOutput = arguments_[0] === "--full-output";
if (fullOutput) arguments_.shift();
const fullSuite = arguments_.length === 0;
let testFiles = arguments_;
if (fullSuite) {
  const files = readdirSync("dist/tests")
    .filter((file) => file.endsWith(".test.js"))
    .sort();
  testFiles = [
    ...costlyTestFiles.filter((file) => files.includes(file)),
    ...files.filter((file) => !costlyTestFiles.includes(file)),
  ].map((file) => join("dist/tests", file));
}

// Node matches its path arguments as globs and reports one that matches nothing only when none matches, so a misspelled
// path beside a valid one would let a focused run pass without running its test. Its runner globs with the same
// `exclude`, which leaves out the `node_modules` folder in the working directory and any `node_modules` that a `**`
// reaches, so the check uses it too. An argument right after an option without `=` may be that option's value, as in
// `--test-concurrency 1`, so it is not checked.
const unmatched = arguments_.filter((path, index) => {
  const previous = arguments_[index - 1];
  const optionValue = previous !== undefined && previous.startsWith("-") && !previous.includes("=");
  return (
    !path.startsWith("-") &&
    !optionValue &&
    globSync(path, { exclude: (name) => name === "node_modules" }).length === 0
  );
});
if (unmatched.length > 0) {
  await refuse(
    unmatched.map((path) => `test-output-filter: no test file matches '${path}'.\n`).join(""),
  );
}

// Node's command line sorts the files it runs, so the full suite goes through a runner that keeps the costly files
// first: started late, one of them would run alone at the end.
const nodeArguments = fullSuite
  ? [join(import.meta.dirname, "run-test-files.mjs"), ...testFiles]
  : ["--test", "--test-reporter=spec", ...testFiles];
const child = spawn(process.execPath, nodeArguments, {
  stdio: fullOutput ? "inherit" : ["inherit", "pipe", "inherit"],
});

// Data can arrive on a pipe at any time, so it also stops a run that has started: both runners cancel on SIGTERM and
// stop the files' processes. Windows ends a process at once on any signal, before it can cancel, so there the whole
// process tree is ended instead.
let refused = false;
if (input === "stream") {
  process.stdin.once("data", () => {
    refused = true;
    process.exitCode = 1;
    process.stderr.write(usage);
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  });
  // Neither a read error nor a pipe that stays open keeps the filter from ending with its tests.
  process.stdin.on("error", () => {}).unref();
}

let pending = "";
if (!fullOutput) {
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (refused) return;
    pending += chunk;

    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline + 1);
      pending = pending.slice(newline + 1);
      if (!isPassingTestLine(line)) process.stdout.write(line);
    }
  });

  child.stdout.on("end", () => {
    if (!refused && pending.length > 0 && !isPassingTestLine(pending)) {
      process.stdout.write(pending);
    }
  });
}

child.on("error", (error) => {
  console.error(`Unable to start Node tests: ${error.message}`);
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  if (refused) return;
  if (signal !== null) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
