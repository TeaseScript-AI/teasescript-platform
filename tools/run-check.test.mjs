import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pretestSteps } from "./run-check.mjs";
import {
  bounded,
  idleBounded,
  killRecorded,
  runTool,
  slowReader,
  waitFor,
} from "./runner-test-support.mjs";

const tool = fileURLToPath(new URL("./run-check.mjs", import.meta.url));

/**
 * A package shaped as the repository's: `check:pretest` runs `lint` and `format` through run-parallel, `build` runs
 * `build:player` through run-parallel too, as `npm run build` does, and a stand-in suite. Each part exits with the status
 * `exits` gives it (0 when not named) and records that it ran, with the `BUILD_SOURCEMAPS` it saw. The part `waits`
 * names (`build` or `suite`) instead starts a descendant that writes its pid to `pid` and waits: in the build one that
 * ignores SIGTERM, in the suite one that does not.
 */
function fixture(t, exits, waits = null) {
  const cwd = mkdtempSync(join(tmpdir(), "run-check-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const part = (name) =>
    "import { appendFileSync } from 'node:fs'; import { spawn } from 'node:child_process'; " +
    `appendFileSync('ran', '${name} ' + process.env.BUILD_SOURCEMAPS + '\\n'); ` +
    (name === waits
      ? `spawn(process.execPath, ['-e', "require('node:fs').writeFileSync('pid', String(process.pid)); ` +
        `${name === "build" ? "process.on('SIGTERM', () => {}); " : ""}` +
        `${idleBounded}"], ` +
        `{ stdio: 'inherit' }); ${idleBounded}`
      : `process.exit(${exits[name] ?? 0});`);
  const scripts = {
    "check:pretest": "node tools/run-parallel.mjs lint format",
    build: "node tools/run-parallel.mjs build:player",
    "build:player": "node build.mjs",
  };
  for (const name of ["lint", "format"]) {
    writeFileSync(join(cwd, `${name}.mjs`), part(name));
    scripts[name] = `node ${name}.mjs`;
  }
  writeFileSync(join(cwd, "build.mjs"), part("build"));
  mkdirSync(join(cwd, "tools"));
  writeFileSync(join(cwd, "tools", "test-output-filter.mjs"), part("suite"));
  writeFileSync(
    join(cwd, "tools", "run-parallel.mjs"),
    readFileSync(new URL("./run-parallel.mjs", import.meta.url)),
  );
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts }));
  return cwd;
}

const environment = { ...process.env, VERIFY_SERIAL: "1", BUILD_SOURCEMAPS: "" };

/** `npm run check`'s run in `cwd`: its status, the parts that ran, its last line and its output. */
function outcome(cwd, status, stdout, stderr) {
  const ran = existsSync(join(cwd, "ran")) ? readFileSync(join(cwd, "ran"), "utf8") : "";
  return {
    status,
    ran: ran.trim().split("\n"),
    last: stdout.trimEnd().split("\n").at(-1),
    output: stdout + stderr,
  };
}

async function run(t, exits) {
  const cwd = fixture(t, exits);
  const result = await runTool(t, process.execPath, [tool], { cwd, env: environment });
  return outcome(cwd, result.status, result.stdout, result.stderr);
}

test("a failed check before the tests stops no other part: the build and the suite still run (#2106)", async (t) => {
  const result = await run(t, { lint: 3 });
  assert.equal(result.status, 3, result.output);
  assert.deepEqual(result.ran, ["lint ", "format ", "build 0", "suite 0"]);
  assert.equal(result.last, "ran: lint, format, build, test suite; failed: lint; not run: none");
});

test("a failed build stops the suite, and the last line says it did not run and why (#2106)", async (t) => {
  const result = await run(t, { format: 4, build: 2 });
  assert.equal(result.status, 4, result.output);
  assert.deepEqual(result.ran, ["lint ", "format ", "build 0"]);
  assert.equal(
    result.last,
    "ran: lint, format, build; failed: format, build; not run: test suite (the build failed)",
  );
});

test("a run that passes, and one whose suite fails, name every part in the last line", async (t) => {
  const passing = await run(t, {});
  assert.equal(passing.status, 0, passing.output);
  assert.equal(passing.last, "ran: lint, format, build, test suite; failed: none; not run: none");
  const failing = await run(t, { suite: 1 });
  assert.equal(failing.status, 1, failing.output);
  assert.equal(
    failing.last,
    "ran: lint, format, build, test suite; failed: test suite; not run: none",
  );
});

test("the checks before the tests are check:pretest's run-parallel steps, and another form is refused", () => {
  const scripts = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).scripts;
  assert.ok(pretestSteps(scripts).includes("test:verification"));
  assert.deepEqual(pretestSteps({ "check:pretest": "node tools/run-parallel.mjs a b:c" }), [
    "a",
    "b:c",
  ]);
  for (const script of [undefined, "npm run a && node tools/run-parallel.mjs b", "npm run a"])
    assert.throws(() => pretestSteps({ "check:pretest": script }), {
      message: "check:pretest is not one `node tools/run-parallel.mjs <npm script>...` call",
    });
});

// Process-group assertions target the POSIX environment used by repository CI.
test(
  "a signal to its process group, as a terminal or a harness sends it, stops the running part as the part handles it; the status is the first failure's or the signal's, and the last line comes once, after (#2106)",
  // (repeated signals: the slow-reader case below, which sends them from the first to after the last line)
  { skip: process.platform === "win32" },
  async (t) => {
    const stopped = "ran: lint, format; failed: none; not run: build, test suite (stopped)";
    for (const [waits, exits, signal, status, last] of [
      ["build", {}, "SIGTERM", 143, stopped],
      ["build", {}, "SIGINT", 130, stopped],
      ["build", { lint: 3 }, "SIGTERM", 3, stopped.replace("failed: none", "failed: lint")],
      ["suite", {}, "SIGTERM", 143, "ran: lint, format, build; failed: none; not run: test suite"],
    ]) {
      const cwd = fixture(t, exits, waits);
      // (its own process group, as a terminal's job or a harness's command has)
      const child = spawn(process.execPath, [tool], { cwd, env: environment, detached: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const group = (signal) => {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      };
      t.after(() => group("SIGKILL"));
      killRecorded(t, cwd, "pid");
      const closed = new Promise((resolve) => child.on("close", resolve));
      const pid = await waitFor(
        `the ${waits}'s descendant to start`,
        () => Number(readFileSync(join(cwd, "pid"), "utf8")),
        child,
      );
      group(signal);
      const at = `${waits}, ${JSON.stringify(exits)}, ${signal}`;
      const result = outcome(cwd, await bounded(closed, `the run to end (${at})`), stdout, stderr);
      assert.equal(result.status, status, `${at}: ${result.output}`);
      assert.equal(result.last, last, at);
      assert.equal(stdout.split(`\n${last}\n`).length, 2, `${at}: the last line once: ${stdout}`);
      // (the descendant ends, or is a zombie its parent has not reaped: in the build, run-parallel's own escalation
      // stops the one that ignores SIGTERM before run-parallel ends; a survivor fails the wait, naming it)
      await waitFor(`the ${waits}'s descendant to end (${at})`, () => {
        try {
          process.kill(pid, 0);
          return /\) Z /u.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
        } catch (error) {
          if (error.code === "ESRCH" || error.code === "ENOENT") return true;
          throw error;
        }
      });
    }
  },
);

test(
  "a signal while the last line waits for a slow reader changes neither the status nor the last line, for run-check and for run-parallel alone (#2106)",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const [args, waits, last] of [
      [[tool], "suite", "ran: lint, format, build; failed: none; not run: test suite"],
      [
        ["tools/run-parallel.mjs", "build:player"],
        "build",
        "ran: none; failed: none; not run: build:player",
      ],
    ]) {
      const cwd = fixture(t, {}, waits);
      killRecorded(t, cwd, "pid");
      const result = await slowReader(t, {
        cwd,
        args,
        env: environment,
        ready: "pid",
        groupSignal: true,
      });
      const at = `${args.join(" ")}: ${result.stdout}${result.stderr}`;
      assert.deepEqual([result.code, result.signal], [143, null], at);
      assert.ok(result.stdout.endsWith(`\n${last}\n`), at);
      assert.equal(result.stdout.split(last).length, 2, at);
    }
  },
);
