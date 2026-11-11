import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { summaryLine } from "./run-parallel.mjs";

const runner = fileURLToPath(new URL("./run-parallel.mjs", import.meta.url));

function fixture(t, sources) {
  const cwd = mkdtempSync(join(tmpdir(), "verification-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const scripts = {};
  for (const [name, source] of Object.entries(sources)) {
    writeFileSync(join(cwd, `${name}.mjs`), source);
    scripts[name] = `node ${name}.mjs`;
  }
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts }));
  return cwd;
}

function start(t, cwd, names, serial = false) {
  const child = spawn(process.execPath, [runner, ...names], {
    cwd,
    env: { ...process.env, VERIFY_SERIAL: serial ? "1" : "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
  return { child, done };
}

/**
 * Waits until `read` returns a value, and returns it. It has no deadline, so a loaded host only makes it slower
 * (#2379): it ends on the event itself, or fails once `runner`, when given, has exited without it.
 */
async function waitFor(read, runner = null) {
  for (;;) {
    try {
      const value = read();
      if (value) return value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (runner !== null && (runner.exitCode !== null || runner.signalCode !== null))
      throw new Error("The runner exited before the fixture reached the requested state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const record = `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';`;

test("parallel commands run once and overlap; serial route runs once in order", async (t) => {
  const cwd = fixture(t, {
    first: `${record} appendFileSync('events', 'first-start\\n'); writeFileSync('first-ready', '');
      if (process.env.VERIFY_SERIAL !== '1') {
        while (!existsSync('second-ready')) await new Promise(r => setTimeout(r, 10));
      }
      appendFileSync('events', 'first-end\\n');`,
    second: `${record} appendFileSync('events', 'second-start\\n'); writeFileSync('second-ready', '');
      console.error('visible warning'); appendFileSync('events', 'second-end\\n');`,
  });
  for (const serial of [false, true]) {
    const result = await start(t, cwd, ["first", "second"], serial).done;
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /visible warning/);
    const events = readFileSync(join(cwd, "events"), "utf8").trim().split("\n");
    assert.equal(events.length, 4);
    for (const event of ["first-start", "first-end", "second-start", "second-end"]) {
      assert.equal(events.filter((value) => value === event).length, 1);
    }
    if (serial)
      assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
    else assert.ok(events.indexOf("second-start") < events.indexOf("first-end"));
    for (const file of ["events", "first-ready", "second-ready"]) rmSync(join(cwd, file));
  }
});

test("a failed step stops no other, serial or parallel; the last line names what ran, failed and did not run (#2106)", async (t) => {
  const cwd = fixture(t, {
    failure: "console.error('distinct failure diagnostic'); process.exit(7);",
    later: `${record} await new Promise(r => setTimeout(r, 300)); appendFileSync('events', 'later-end\\n');`,
  });
  for (const serial of [false, true]) {
    const result = await start(t, cwd, ["failure", "later"], serial).done;
    assert.equal(result.code, 7, result.output);
    assert.match(result.output, /distinct failure diagnostic/);
    assert.match(result.output, /\[failure\] FAIL/);
    assert.match(result.output, /\[later\] PASS/);
    assert.equal(readFileSync(join(cwd, "events"), "utf8"), "later-end\n");
    assert.equal(
      result.output.trimEnd().split("\n").at(-1),
      "ran: failure, later; failed: failure; not run: none",
    );
    rmSync(join(cwd, "events"));
  }
});

test("a step npm cannot start fails with exit 1 and is named", async (t) => {
  const cwd = fixture(t, { first: "" });
  // (no npm on PATH: the spawn itself fails)
  const child = spawn(process.execPath, [runner, "first"], {
    cwd,
    env: { ...process.env, PATH: cwd },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 1, output);
  assert.match(output, /\[first\] FAIL/u);
  assert.match(output, /first: spawn npm ENOENT/u);
  assert.equal(output.trimEnd().split("\n").at(-1), "ran: first; failed: first; not run: none");
});

test("summaryLine names each step that ended under ran, a failed one also under failed, and every other under not run", () => {
  assert.equal(summaryLine([]), "ran: none; failed: none; not run: none");
  assert.equal(
    summaryLine([
      { name: "a", status: "PASS" },
      { name: "b", status: "FAIL" },
      { name: "c", status: "ABORTED" },
      { name: "d", status: "NOT RUN" },
    ]),
    "ran: a, b; failed: b; not run: c, d",
  );
});

// Process-group assertions target the POSIX environment used by repository CI.
describe("process cleanup", { concurrency: true }, () => {
  for (const reason of ["parent-failure", "SIGINT", "SIGTERM"]) {
    test(
      `${reason} stops npm descendants, including a child that ignores termination`,
      { skip: process.platform === "win32", concurrency: true },
      async (t) => {
        const cwd = fixture(t, {
          waiting: `import { existsSync } from 'node:fs'; import { spawn } from 'node:child_process';
        spawn(process.execPath, ['-e', "require('node:fs').writeFileSync('pid', String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {stdio:'inherit'});
        ${reason === "parent-failure" ? "while (!existsSync('pid')) await new Promise(r => setTimeout(r, 10)); process.exit(9);" : "setInterval(() => {}, 1000);"}`,
        });
        const { child, done } = start(t, cwd, ["waiting"]);
        const pid = await waitFor(() => Number(readFileSync(join(cwd, "pid"), "utf8")), child);
        t.after(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        });
        if (reason === "SIGINT" || reason === "SIGTERM") child.kill(reason);
        const result = await done;
        assert.equal(
          result.code,
          reason === "parent-failure" ? 9 : reason === "SIGINT" ? 130 : 143,
          result.output,
        );
        // A step that failed on its own is a failure; one a signal stopped is ABORTED, and did not run.
        const failed = result.output.includes("[waiting] FAIL");
        const aborted = result.output.includes("[waiting] ABORTED");
        assert.ok(
          reason === "parent-failure" ? failed && !aborted : aborted && !failed,
          result.output,
        );
        assert.equal(
          result.output.trimEnd().split("\n").at(-1),
          reason === "parent-failure"
            ? "ran: waiting; failed: waiting; not run: none"
            : "ran: none; failed: none; not run: waiting",
        );
        await waitFor(() => {
          try {
            process.kill(pid, 0);
            return (
              process.platform === "linux" &&
              /\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
            );
          } catch (error) {
            if (error.code === "ESRCH") return true;
            throw error;
          }
        });
      },
    );
  }
});
