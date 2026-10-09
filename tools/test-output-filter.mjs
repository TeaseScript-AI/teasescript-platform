import { spawn } from "node:child_process";
import { globSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function isPassingTestLine(line) {
  const plain = line.replace(ANSI_ESCAPE_PATTERN, "").trimStart();
  return /^✔(?:\s|$)/u.test(plain);
}

const arguments_ = process.argv.slice(2);
const fullOutput = arguments_[0] === "--full-output";
if (fullOutput) arguments_.shift();
const testFiles =
  arguments_.length > 0
    ? arguments_
    : readdirSync("dist/tests")
        .filter((file) => file.endsWith(".test.js"))
        .map((file) => join("dist/tests", file));

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
  const lines = unmatched.map((path) => `test-output-filter: no test file matches '${path}'.\n`);
  // Exiting at once could cut off diagnostics that a pipe has not taken yet.
  await new Promise((resolve) => process.stderr.write(lines.join(""), resolve));
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", "--test-reporter=spec", ...testFiles], {
  stdio: fullOutput ? "inherit" : ["inherit", "pipe", "inherit"],
});

let pending = "";
if (!fullOutput) {
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;

    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline + 1);
      pending = pending.slice(newline + 1);
      if (!isPassingTestLine(line)) process.stdout.write(line);
    }
  });

  child.stdout.on("end", () => {
    if (pending.length > 0 && !isPassingTestLine(pending)) {
      process.stdout.write(pending);
    }
  });
}

child.on("error", (error) => {
  console.error(`Unable to start Node tests: ${error.message}`);
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
