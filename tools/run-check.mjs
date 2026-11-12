import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { listedSteps, runSteps, summaryLine } from "./run-parallel.mjs";

// `npm run check`, in three parts (#2106):
//
// 1. the checks before the tests: the steps `check:pretest` runs, each to its end, through `tools/run-parallel.mjs`;
// 2. whatever they found, the build (`npm run build`), without UI source maps;
// 3. when the build passed, the compiled suite (`tools/test-output-filter.mjs`). It runs what the build wrote, so after a
//    failed build it does not run: it would test stale or missing code. No check before the tests writes what it runs.
//
// The last line names what ran, failed and did not run (`summaryLine`), the suite with why when it did not run.
//
// SIGINT and SIGTERM: it passes the signal to the running part and starts no other; a part either signal ended counts
// as stopped by it even when that end is handled before the signal (#2549), and one another signal ended before any
// stop as failed. It kills nothing itself and has no deadline of its own: the part stops as it handles the signal
// (run-parallel stops the process groups it made, and is the only one to escalate to SIGKILL). A part's output is
// relayed, not inherited, so its end is the end of every process still writing that output, a run-parallel finishing
// its escalation included; the last line follows that end, once, whatever signals come later.
// The parts run in its own process group, so a signal to that group (a terminal's Ctrl-C, a harness's stop) reaches
// them as it reaches it. Exit status: the first failed part's, or 130 or 143 for a signal that came first, else 0. A
// signal that comes after the last line's write has finished can still end the process, by that signal, as it exits.
// `VERIFY_SERIAL=1` runs the checks before the tests one after another.

/**
 * The steps of `pkg`'s `check:pretest`, which must be one `tools/run-parallel.mjs` call: of the scripts it names, or of
 * those the file it names with `--list` holds (`listedSteps`), read by `read`.
 */
export function pretestSteps(pkg, read = (file) => readFileSync(file, "utf8")) {
  const script = pkg.scripts?.["check:pretest"] ?? "";
  const listed = /^node tools\/run-parallel\.mjs --list (\S+)$/u.exec(script);
  if (listed !== null) return listedSteps(pkg, read(listed[1]), listed[1]);
  const words = /^node tools\/run-parallel\.mjs((?: [\w:.-]+)+)$/u.exec(script);
  if (words === null)
    throw new Error(
      "check:pretest is not one `node tools/run-parallel.mjs <npm script>...` or `--list <file>` call",
    );
  return words[1].trim().split(" ");
}

const SIGNALS = { SIGINT: 130, SIGTERM: 143 };

async function main() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  let signalled = 0;
  let running = null;
  // (installed until the process exits, the last line's write included: a later signal is passed on to a running part
  // too, but the status stays the first's)
  for (const [signal, code] of Object.entries(SIGNALS))
    process.on(signal, () => {
      if (signalled === 0) signalled = code;
      running?.kill(signal);
    });
  const env = { ...process.env, BUILD_SOURCEMAPS: "0" };
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  /** A part's run: `PASS`, `FAIL`, or `ABORTED` when a signal stopped it, and its exit status (1 for a spawn error). */
  const part = (command, args) =>
    new Promise((resolve) => {
      let failed = false;
      // (its output relayed, so the part ends when every process writing it has: the last line then comes after it)
      running = spawn(command, args, {
        stdio: ["inherit", "pipe", "pipe"],
        env,
        shell: process.platform === "win32" && command === npm,
      });
      running.stdout.pipe(process.stdout, { end: false });
      running.stderr.pipe(process.stderr, { end: false });
      running.on("error", (error) => {
        failed = true;
        console.error(`${args.join(" ")}: ${error.message}`);
      });
      running.on("close", (code, signal) => {
        running = null;
        // (a part SIGINT or SIGTERM ended was stopped by it, whether run-check's own handler has run yet or not)
        if (signalled === 0 && Object.hasOwn(SIGNALS, signal)) signalled = SIGNALS[signal];
        if (code === 0 && !failed) resolve({ status: "PASS", code: 0 });
        else if (signalled !== 0) resolve({ status: "ABORTED", code: signalled });
        else resolve({ status: "FAIL", code: !failed && code > 0 ? code : 1 });
      });
    });

  const pretest = await runSteps(pretestSteps(pkg), { serial: process.env.VERIFY_SERIAL === "1" });
  const steps = [...pretest.steps];
  let exitCode = pretest.exitCode;
  const fail = (code) => {
    if (exitCode === 0) exitCode = code;
  };
  const build = signalled === 0 ? await part(npm, ["run", "build"]) : null;
  steps.push({ name: "build", status: build?.status ?? "NOT RUN" });
  if (build !== null && build.status !== "PASS") fail(build.code);
  if (build?.status === "PASS" && signalled === 0) {
    const suite = await part(process.execPath, ["tools/test-output-filter.mjs"]);
    steps.push({ name: "test suite", status: suite.status });
    if (suite.status !== "PASS") fail(suite.code);
  } else
    steps.push({
      name: `test suite (${signalled !== 0 ? "stopped" : "the build failed"})`,
      status: "NOT RUN",
    });
  if (signalled !== 0) fail(signalled);
  console.log(`\n${summaryLine(steps)}`);
  process.exitCode = exitCode;
}

if (import.meta.main) await main();
