import { spawn, spawnSync } from "node:child_process";
import { fstatSync, globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { shardFiles, shardOption, suiteTestFiles } from "./test-shards.mjs";

// oxlint-disable-next-line no-control-regex -- EVIDENCE: fixture: the pattern matches the ESC character that starts an ANSI escape sequence.
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
  "Usage: node tools/test-output-filter.mjs [--full-output] [--shard=i/N | test file ...]\n";

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
// `TEST_FULL_OUTPUT=1` asks the same as `--full-output`: `npm run check:full-output` sets it for every test run of the
// stages it shares with `npm run check`.
const fullOutput = arguments_[0] === "--full-output" || process.env.TEST_FULL_OUTPUT === "1";
if (arguments_[0] === "--full-output") arguments_.shift();
// (`--shard=i/N`: the full suite's shard i of N, as CI's test jobs run it, `tools/test-shards.mjs`)
let shard = null;
if (arguments_.some((argument) => argument.startsWith("--shard"))) {
  if (arguments_.length > 1)
    await refuse(`test-output-filter: --shard runs the full suite's shard alone.\n${usage}`);
  try {
    shard = shardOption(arguments_[0]);
  } catch (error) {
    await refuse(`test-output-filter: ${error.message}.\n${usage}`);
  }
  arguments_.shift();
}
const fullSuite = arguments_.length === 0;
let testFiles = arguments_;
if (fullSuite) {
  const files = suiteTestFiles("dist/tests", ".test.js");
  testFiles = shardFiles(files, shard?.index ?? 1, shard?.count ?? 1).map((file) =>
    join("dist/tests", file),
  );
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
// Beside the spec reporter, `test-in-flight.mjs` names on standard error a test still running long after it began.
// Compact output of named files ends with one line per file and its tests' counts, the passing tests it leaves out among
// them; a file that failed outside its tests (it threw while loading, or its process ended non-zero) says so beside
// them. A file that ran no test (a suite alone is none) fails the run, unless the tests may be selected (a name or
// skip pattern, or `--test-only`, in any spelling Node takes, as an argument or anywhere in `NODE_OPTIONS`): then its
// line says the selection matched no test in it. A selection's spelling given as another option's value, or joined by
// a stray `"` or `\` in `NODE_OPTIONS`, reads as a selection too. A selection the filter does not read (from
// `--config-file`, from an `--env-file` given after the filter, or `--experimental-test-tag-filter`) fails the run; one
// in the environment must be in the filter's own. The per-file counts, and with them this check, need Node's default
// process isolation (under `--test-isolation=none` a passing test counts as none), and a watch run is not checked per
// cycle. There `test-file-counts.mjs` counts, and names a test in flight in that reporter's place.
const countsFolder =
  fullSuite || fullOutput ? null : mkdtempSync(join(tmpdir(), "test-file-counts-"));
const countsFile = countsFolder === null ? null : join(countsFolder, "counts.json");
// (the arguments are tokens. `NODE_OPTIONS` selects when it names a selection anywhere once every `"` and `\` is
// removed: Node only ever removes those two characters when it reads it, and no selection's name holds either, so any
// selection Node applies stands whole in what is left. A selection's spelling inside another option's value, or one
// that a stray `"` or `\` joins, then reads as one too, which only spares that file the failure)
const selection = /--test[-_](?:(?:name|skip)[-_]pattern|only)/u;
const selected =
  arguments_.some((option) => new RegExp(`^${selection.source}(?:=|$)`, "u").test(option)) ||
  selection.test((process.env.NODE_OPTIONS ?? "").replaceAll(/["\\]/gu, ""));
// The folder is removed when the run ends or the filter exits. The filter installs no signal handler, so a signal that
// ends it leaves the folder in the system's temporary directory, where no run reads it: one counts file, empty until
// the run ends, then one JSON entry per named file: its absolute path and five counts.
const removeCounts = () => countsFolder && rmSync(countsFolder, { recursive: true, force: true });
if (countsFolder !== null) process.once("exit", removeCounts);
const nodeArguments = fullSuite
  ? [join(import.meta.dirname, "run-test-files.mjs"), ...testFiles]
  : [
      "--test",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      ...(countsFile === null
        ? [
            `--test-reporter=${join(import.meta.dirname, "test-in-flight.mjs")}`,
            "--test-reporter-destination=stderr",
          ]
        : [
            `--test-reporter=${join(import.meta.dirname, "test-file-counts.mjs")}`,
            `--test-reporter-destination=${countsFile}`,
          ]),
      ...testFiles,
    ];
// (without `TEST_FULL_OUTPUT`: a test that runs this filter itself chooses its own output)
const { TEST_FULL_OUTPUT: _, ...environment } = process.env;
const child = spawn(process.execPath, nodeArguments, {
  env: environment,
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

/**
 * Each file's counts line, `ℹ <file>: N passed[, N failed][, N cancelled][, N skipped][, N todo][; the file failed
 * outside any test][; <why it ran no test>]`, or why there are none; and whether a file ran no test without a selection
 * to explain it.
 */
function fileCounts() {
  let counts;
  try {
    counts = JSON.parse(readFileSync(countsFile, "utf8"));
  } catch (error) {
    return {
      lines: `ℹ test-output-filter: no counts per file: ${error.message}\n`,
      ranNothing: false,
    };
  }
  let ranNothing = false;
  const lines = Object.entries(counts)
    .map(([file, { passed, failed, cancelled, skipped, todo, fileFailed }]) => {
      const others = Object.entries({ failed, cancelled, skipped, todo })
        .filter(([, count]) => count > 0)
        .map(([word, count]) => `, ${count} ${word}`)
        .join("");
      const own = fileFailed ? "; the file failed outside any test" : "";
      let none = "";
      // (a file that failed outside its tests already fails the run, and says so)
      if (passed + failed + cancelled + skipped + todo === 0 && !fileFailed) {
        if (selected) none = "; the selection matched no test in it";
        else {
          ranNothing = true;
          none = "; it ran no test, which fails the run";
        }
      }
      return `ℹ ${relative(process.cwd(), file)}: ${passed} passed${others}${own}${none}\n`;
    })
    .join("");
  return { lines, ranNothing };
}

child.on("close", (code, signal) => {
  let ranNothing = false;
  if (countsFolder !== null) {
    if (!refused && signal === null) {
      const counts = fileCounts();
      process.stdout.write(counts.lines);
      ranNothing = counts.ranNothing;
    }
    removeCounts();
  }
  if (refused) return;
  if (signal !== null) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code === 0 && ranNothing ? 1 : (code ?? 1);
  }
});
