import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

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

async function waitFor(read) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const value = read();
      if (value) return value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Fixture did not reach the requested state");
}

const record = `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';`;

test(
  "parallel commands run once and overlap; serial route runs once in order",
  { timeout: 15000 },
  async (t) => {
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
  },
);

test(
  "failure reports diagnostics and prevents the next serial command",
  { timeout: 10000 },
  async (t) => {
    const cwd = fixture(t, {
      failure: "console.error('distinct failure diagnostic'); process.exit(7);",
      later: "throw new Error('MUST NOT RUN');",
    });
    const result = await start(t, cwd, ["failure", "later"], true).done;
    assert.equal(result.code, 7, result.output);
    assert.match(result.output, /distinct failure diagnostic/);
    assert.doesNotMatch(result.output, /MUST NOT RUN/);
  },
);

// Process-group assertions target the POSIX environment used by repository CI.
describe("process cleanup", { concurrency: true }, () => {
  for (const reason of ["failure", "parent-failure", "SIGINT", "SIGTERM"]) {
    test(
      `${reason} stops npm descendants, including a child that ignores termination`,
      { skip: process.platform === "win32", timeout: 15000, concurrency: true },
      async (t) => {
        const cwd = fixture(t, {
          waiting: `import { existsSync } from 'node:fs'; import { spawn } from 'node:child_process';
        spawn(process.execPath, ['-e', "require('node:fs').writeFileSync('pid', String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {stdio:'inherit'});
        ${reason === "parent-failure" ? "while (!existsSync('pid')) await new Promise(r => setTimeout(r, 10)); process.exit(9);" : "setInterval(() => {}, 1000);"}`,
          failure: `${record} while (!existsSync('pid')) await new Promise(r => setTimeout(r, 10));
        console.error('parallel failure diagnostic'); process.exit(9);`,
        });
        const { child, done } = start(
          t,
          cwd,
          reason === "failure" ? ["waiting", "failure"] : ["waiting"],
        );
        const pid = await waitFor(() => Number(readFileSync(join(cwd, "pid"), "utf8")));
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
          reason.endsWith("failure") ? 9 : reason === "SIGINT" ? 130 : 143,
          result.output,
        );
        if (reason === "failure") assert.match(result.output, /parallel failure diagnostic/);
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
