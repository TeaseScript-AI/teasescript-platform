import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { summaryLine } from "./run-parallel.mjs";
import {
  awaitFile,
  idleBounded,
  killRecorded,
  spawnTool,
  waitFor,
} from "./runner-test-support.mjs";

const runner = fileURLToPath(new URL("./run-parallel.mjs", import.meta.url));

function fixture(t, sources) {
  const cwd = mkdtempSync(join(tmpdir(), "verification-test-"));
  // (after hooks run in the order they are registered: the recorded process's kill, then the folder's removal)
  killRecorded(t, cwd, "pid");
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
  // (`output` both streams in arrival order, `stdout` alone, whose order is the runner's: the last line is read there)
  return spawnTool(t, process.execPath, [runner, ...names], {
    cwd,
    env: { ...process.env, VERIFY_SERIAL: serial ? "1" : "0" },
  });
}

const record = `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';`;

test("parallel commands run once and overlap; serial route runs once in order", async (t) => {
  const cwd = fixture(t, {
    first: `${record} appendFileSync('events', 'first-start\\n'); writeFileSync('first-ready', '');
      if (process.env.VERIFY_SERIAL !== '1') ${awaitFile("second-ready", "second to start beside it")}
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
  // (`later` ends only after run-parallel has reported the failure, when the abort it no longer does would come)
  const cwd = fixture(t, {
    failure: "console.error('distinct failure diagnostic'); process.exit(7);",
    later: `${record} ${awaitFile("release", "the failure to be reported")} appendFileSync('events', 'later-end\\n');`,
  });
  for (const serial of [false, true]) {
    const run = start(t, cwd, ["failure", "later"], serial);
    await waitFor(
      "run-parallel to report the failed step",
      () => run.output().includes("[failure] FAIL"),
      run.child,
    );
    writeFileSync(join(cwd, "release"), "");
    const result = await run.done;
    assert.equal(result.code, 7, result.output);
    assert.match(result.output, /distinct failure diagnostic/);
    assert.match(result.output, /\[failure\] FAIL/);
    assert.match(result.output, /\[later\] PASS/);
    assert.equal(readFileSync(join(cwd, "events"), "utf8"), "later-end\n");
    assert.equal(
      result.stdout.trimEnd().split("\n").at(-1),
      "ran: failure, later; failed: failure; not run: none",
    );
    for (const file of ["events", "release"]) rmSync(join(cwd, file));
  }
});

test("--list runs the npm scripts a file lists, in its order, and refuses a list of what is not a script or no file (#2440)", async (t) => {
  const cwd = fixture(t, { a: "", b: "" });
  writeFileSync(join(cwd, "steps.txt"), "# the steps\nb\na\n");
  writeFileSync(join(cwd, "bad.txt"), "a\nc\n");
  const listed = await start(t, cwd, ["--list", "steps.txt"], true).done;
  assert.equal(listed.code, 0, listed.output);
  assert.equal(listed.stdout.trim().split("\n").at(-1), "ran: b, a; failed: none; not run: none");
  assert.match(listed.stdout, /\[b\] PASS[\s\S]*\[a\] PASS/u);
  const refused = await start(t, cwd, ["--list", "bad.txt"]).done;
  assert.equal(refused.code, 1, refused.output);
  assert.match(refused.stderr, /bad\.txt lists what is not an npm script: c/u);
  // without its file, `--list` is no npm script to run, but a usage error (Sol r1)
  const bare = await start(t, cwd, ["--list"]).done;
  assert.equal(bare.code, 1, bare.output);
  assert.match(bare.stderr, /usage: node tools\/run-parallel\.mjs --list <file>/u);
  assert.doesNotMatch(bare.stdout, /ran:/u);
});

test("a step npm cannot start fails with exit 1 and is named", async (t) => {
  const cwd = fixture(t, { first: "" });
  // (no npm on PATH: the spawn itself fails)
  const { code, output, stdout } = await spawnTool(t, process.execPath, [runner, "first"], {
    cwd,
    env: { ...process.env, PATH: cwd },
  }).done;
  assert.equal(code, 1, output);
  assert.match(output, /\[first\] FAIL/u);
  assert.match(output, /first: spawn npm ENOENT/u);
  assert.equal(stdout.trimEnd().split("\n").at(-1), "ran: first; failed: first; not run: none");
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
        spawn(process.execPath, ['-e', "require('node:fs').writeFileSync('pid', String(process.pid)); process.on('SIGTERM', () => {}); ${idleBounded}"], {stdio:'inherit'});
        ${reason === "parent-failure" ? `${awaitFile("pid", "its descendant to start")} process.exit(9);` : idleBounded}`,
        });
        const { child, done } = start(t, cwd, ["waiting"]);
        const pid = await waitFor(
          "the descendant that ignores SIGTERM to start",
          () => Number(readFileSync(join(cwd, "pid"), "utf8")),
          child,
        );
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
          result.stdout.trimEnd().split("\n").at(-1),
          reason === "parent-failure"
            ? "ran: waiting; failed: waiting; not run: none"
            : "ran: none; failed: none; not run: waiting",
        );
        await waitFor(
          "the descendant that ignores SIGTERM to end, after run-parallel's SIGKILL",
          () => {
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
          },
        );
      },
    );
  }
});
