import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pretestSteps } from "./run-check.mjs";

const tool = fileURLToPath(new URL("./run-check.mjs", import.meta.url));

/**
 * A package whose `check:pretest` runs `lint` and `format`, with a `build` and a stand-in suite: each exits with the
 * status `exits` gives it (0 when not named) and records that it ran, with the `BUILD_SOURCEMAPS` it saw. The part
 * `waits` names (`build` or `suite`) instead starts a descendant that ignores SIGTERM, writes its pid to `pid`, and
 * prints `LATE` after 2.5 s, then waits.
 */
function fixture(t, exits, waits = null) {
  const cwd = mkdtempSync(join(tmpdir(), "run-check-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const part = (name) =>
    "import { appendFileSync } from 'node:fs'; import { spawn } from 'node:child_process'; " +
    `appendFileSync('ran', '${name} ' + process.env.BUILD_SOURCEMAPS + '\\n'); ` +
    (name === waits
      ? `spawn(process.execPath, ['-e', "require('node:fs').writeFileSync('pid', String(process.pid)); ` +
        `process.on('SIGTERM', () => {}); setTimeout(() => console.log('LATE'), 2500); setInterval(() => {}, 1000);"], ` +
        "{ stdio: 'inherit' }); setInterval(() => {}, 1000);"
      : `process.exit(${exits[name] ?? 0});`);
  const scripts = {
    "check:pretest": "node tools/run-parallel.mjs lint format",
    build: "node build.mjs",
  };
  for (const name of ["lint", "format"]) {
    writeFileSync(join(cwd, `${name}.mjs`), part(name));
    scripts[name] = `node ${name}.mjs`;
  }
  writeFileSync(join(cwd, "build.mjs"), part("build"));
  mkdirSync(join(cwd, "tools"));
  writeFileSync(join(cwd, "tools", "test-output-filter.mjs"), part("suite"));
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

function run(t, exits) {
  const cwd = fixture(t, exits);
  const result = spawnSync(process.execPath, [tool], { cwd, encoding: "utf8", env: environment });
  return outcome(cwd, result.status, result.stdout, result.stderr);
}

test("a failed check before the tests stops no other part: the build and the suite still run (#2106)", (t) => {
  const result = run(t, { lint: 3 });
  assert.equal(result.status, 3, result.output);
  assert.deepEqual(result.ran, ["lint ", "format ", "build 0", "suite 0"]);
  assert.equal(result.last, "ran: lint, format, build, test suite; failed: lint; not run: none");
});

test("a failed build stops the suite, and the last line says it did not run and why (#2106)", (t) => {
  const result = run(t, { format: 4, build: 2 });
  assert.equal(result.status, 4, result.output);
  assert.deepEqual(result.ran, ["lint ", "format ", "build 0"]);
  assert.equal(
    result.last,
    "ran: lint, format, build; failed: format, build; not run: test suite (the build failed)",
  );
});

test("a run that passes, and one whose suite fails, name every part in the last line", (t) => {
  const passing = run(t, {});
  assert.equal(passing.status, 0, passing.output);
  assert.equal(passing.last, "ran: lint, format, build, test suite; failed: none; not run: none");
  const failing = run(t, { suite: 1 });
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
  "a signal during the build or the suite stops its whole process group, keeps the first failure's or the signal's status, and the last line comes after (#2106)",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const [waits, exits, status, last] of [
      ["build", {}, 143, "ran: lint, format; failed: none; not run: build, test suite (stopped)"],
      ["suite", {}, 143, "ran: lint, format, build; failed: none; not run: test suite"],
      [
        "build",
        { lint: 3 },
        3,
        "ran: lint, format; failed: lint; not run: build, test suite (stopped)",
      ],
    ]) {
      const cwd = fixture(t, exits, waits);
      const child = spawn(process.execPath, [tool], { cwd, env: environment });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      t.after(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"));
      let exited = false;
      const closed = new Promise((resolve) =>
        child.on("close", (code) => {
          exited = true;
          resolve(code);
        }),
      );
      // (no deadline, so a loaded host only makes it slower (#2379); a runner that ends first fails the wait)
      while (!existsSync(join(cwd, "pid")) || readFileSync(join(cwd, "pid"), "utf8") === "") {
        if (exited) assert.fail(`the runner ended before the ${waits} started: ${stdout}${stderr}`);
        await new Promise((wait) => setTimeout(wait, 20));
      }
      const pid = Number(readFileSync(join(cwd, "pid"), "utf8"));
      // (a run that fails to stop it leaves no stray process behind the test either)
      t.after(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      });
      child.kill("SIGTERM");
      const result = outcome(cwd, await closed, stdout, stderr);
      const at = `${waits}, ${JSON.stringify(exits)}`;
      assert.equal(result.status, status, `${at}: ${result.output}`);
      assert.equal(result.last, last, at);
      assert.doesNotMatch(result.output, /LATE/u, at);
      // (the descendant that ignored SIGTERM is gone, or a zombie its parent has not reaped)
      let alive = true;
      try {
        process.kill(pid, 0);
        alive = !/\) Z /u.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
      } catch (error) {
        if (error.code !== "ESRCH" && error.code !== "ENOENT") throw error;
        alive = false;
      }
      if (alive) process.kill(pid, "SIGKILL");
      assert.equal(alive, false, `${at}: the descendant outlived the run`);
    }
  },
);
