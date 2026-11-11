import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pretestSteps } from "./run-check.mjs";

const tool = fileURLToPath(new URL("./run-check.mjs", import.meta.url));

/**
 * A package whose `check:pretest` runs `lint` and `format`, with a `build` and a stand-in suite: each exits with the
 * status `exits` gives it (0 when not named) and records that it ran, with the `BUILD_SOURCEMAPS` it saw.
 */
function run(t, exits) {
  const cwd = mkdtempSync(join(tmpdir(), "run-check-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const part = (name) =>
    "import { appendFileSync } from 'node:fs'; " +
    `appendFileSync('ran', '${name} ' + process.env.BUILD_SOURCEMAPS + '\\n'); ` +
    `process.exit(${exits[name] ?? 0});`;
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
  const result = spawnSync(process.execPath, [tool], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, VERIFY_SERIAL: "1", BUILD_SOURCEMAPS: "" },
  });
  const ran = existsSync(join(cwd, "ran")) ? readFileSync(join(cwd, "ran"), "utf8") : "";
  return {
    status: result.status,
    ran: ran.trim().split("\n"),
    last: result.stdout.trimEnd().split("\n").at(-1),
    output: result.stdout + result.stderr,
  };
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
