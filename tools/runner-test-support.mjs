// Waits, process runs and a slow reader for the tests of the check runners (run-parallel, run-check, check-changed). No
// wait depends on how long a loaded host takes (#2379): each ends on its event, or fails naming what it waited for when
// the process it watches has ended without it, or after `BOUND_SECONDS`, which only a hang reaches. A bound that expires
// SIGKILLs what it waited for: a runner keeps handling SIGTERM to the end, so SIGTERM need not end it. A runner the
// tests start through `spawnTool`, `runTool` or `slowReader` runs in its own process group, which the test's end
// SIGKILLs; `runSync` SIGKILLs only its command. The groups a runner detaches (run-parallel's steps, check-changed's
// checks) are not the test's: every process a fixture starts there ends by itself within `BOUND_SECONDS`
// (`idleBounded`, `awaitFile`), and one whose pid a fixture records is SIGKILLed at the test's end (`killRecorded`).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** How long any wait of these tests may last. */
export const BOUND_SECONDS = 300;

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
const exited = (child) => child.exitCode !== null || child.signalCode !== null;

/**
 * Waits until `read` returns a value, and returns it; a missing file reads as not yet. Fails naming `what` once
 * `child`, when given, has exited without it, or after `BOUND_SECONDS`.
 */
export async function waitFor(what, read, child = null) {
  const until = performance.now() + BOUND_SECONDS * 1000;
  for (;;) {
    try {
      const value = read();
      if (value) return value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (child !== null && exited(child)) throw new Error(`The process exited before ${what}`);
    if (performance.now() > until) throw new Error(`Waited ${BOUND_SECONDS} s for ${what}`);
    await pause();
  }
}

/** `promise`, or a failure naming `what` after `BOUND_SECONDS`. */
export function bounded(promise, what) {
  let timer;
  const bound = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Waited ${BOUND_SECONDS} s for ${what}`)),
      BOUND_SECONDS * 1000,
    );
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

/**
 * `spawnSync` for a short fixture command that starts no lasting process of its own, as `git`: SIGKILLed after
 * `BOUND_SECONDS`, with a failure naming the command.
 */
export function runSync(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    timeout: BOUND_SECONDS * 1000,
    killSignal: "SIGKILL",
  });
  if (result.error?.code === "ETIMEDOUT")
    throw new Error(`Waited ${BOUND_SECONDS} s for ${[command, ...args].join(" ")} to end`);
  return result;
}

/**
 * Starts `command` in its own process group, its stdout and stderr collected unless `stdio` says otherwise. `done`
 * resolves to its `code`, `signal`, `stdout`, `stderr` and `output` (both, in arrival order); after `BOUND_SECONDS` it
 * fails, naming the command, and the group is SIGKILLed, as it is when the test ends with it still running.
 */
export function spawnTool(t, command, args, { cwd, env, stdio = ["ignore", "pipe", "pipe"] }) {
  const child = spawn(command, args, { cwd, env, stdio, detached: true });
  const kill = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  t.after(kill);
  let stdout = "";
  let stderr = "";
  let output = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
    output += chunk;
  });
  const what = [command, ...args].join(" ").slice(0, 200);
  const done = bounded(
    new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, output }));
    }),
    `${what} to end`,
  ).catch((error) => {
    kill();
    throw error;
  });
  return { child, done, output: () => output };
}

/** `spawnTool`'s run, awaited: `{ status, signal, stdout, stderr }`, as `spawnSync` gives. */
export async function runTool(t, command, args, options) {
  const { code, signal, stdout, stderr } = await spawnTool(t, command, args, options).done;
  return { status: code, signal, stdout, stderr };
}

/** Fixture source for a process that idles, as a stuck leaf or a long check, and ends by itself after `BOUND_SECONDS`. */
export const idleBounded = `setTimeout(() => process.exit(0), ${BOUND_SECONDS * 1000});`;

/**
 * Registers, before the test waits for anything, the SIGKILL at its end of the process whose pid the fixture in `cwd`
 * writes to `file`, if it has, and if that pid, where `/proc` tells, still works in `cwd`: a reused pid is not killed.
 */
export function killRecorded(t, cwd, file) {
  t.after(() => {
    let pid = 0;
    try {
      pid = Number(readFileSync(join(cwd, file), "utf8"));
      if (existsSync("/proc/self/cwd") && readlinkSync(`/proc/${pid}/cwd`) !== cwd) return;
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (pid > 0)
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
  });
}

/** Fixture source that waits until `file` exists, or exits 1 after `BOUND_SECONDS`, naming `what`. */
export const awaitFile = (file, what) =>
  `{ const { existsSync } = await import('node:fs'); const until = performance.now() + ${BOUND_SECONDS * 1000}; ` +
  `while (!existsSync('${file}')) { if (performance.now() > until) { ` +
  `console.error('waited ${BOUND_SECONDS} s for ${what}'); process.exit(1); } ` +
  `await new Promise(r => setTimeout(r, 10)); } }`;

/**
 * Runs `node <args>` in `cwd`, in its own process group, with its stdout on a FIFO this test fills before it starts,
 * so that every write of the runner waits for a reader. A test-only preload marks the start of the last line (one write
 * beginning `\n`, then `ran: ` or `check-changed: ran: `). Once `ready` (a file in `cwd`, or null for at once), its group
 * gets SIGTERM when `groupSignal`; then the runner itself gets SIGTERM every 20 ms until the last line is marked (only
 * from then on without `signalsBefore`), and three times more, before the FIFO is read. POSIX systems with `mkfifo`.
 * Returns its exit, its stdout without the filling, and its stderr.
 */
export async function slowReader(
  t,
  { cwd, args, env, ready = null, groupSignal = false, signalsBefore = true },
) {
  const fifo = join(cwd, "stdout.fifo");
  assert.equal(runSync("mkfifo", [fifo]).status, 0);
  writeFileSync(
    join(cwd, "mark-last-line.mjs"),
    "import { writeFileSync } from 'node:fs'; const write = process.stdout.write.bind(process.stdout); " +
      "process.stdout.write = (chunk, ...rest) => { " +
      "if (/^\\n(?:check-changed: )?ran: /u.test(String(chunk))) writeFileSync('last-line', ''); " +
      "return write(chunk, ...rest); };",
  );
  const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  const filler = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  let filled = 0;
  for (const size of [4096, 1])
    for (;;) {
      try {
        filled += writeSync(filler, Buffer.alloc(size, "f"));
      } catch (error) {
        if (error.code === "EAGAIN") break;
        throw error;
      }
    }
  closeSync(filler);
  const writer = openSync(fifo, constants.O_WRONLY);
  const child = spawn(process.execPath, ["--import", "./mark-last-line.mjs", ...args], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", writer, "pipe"],
  });
  closeSync(writer);
  const signal = (pid, name) => {
    try {
      process.kill(pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  t.after(() => signal(-child.pid, "SIGKILL"));
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const closed = new Promise((resolve) =>
    child.on("close", (code, name) => resolve({ code, signal: name })),
  );
  if (ready !== null)
    await waitFor(
      `the fixture's ${ready}`,
      () => readFileSync(join(cwd, ready), "utf8") !== "",
      child,
    );
  if (groupSignal) signal(-child.pid, "SIGTERM");
  const until = performance.now() + BOUND_SECONDS * 1000;
  for (let more = 3; !exited(child) && more > 0; await pause()) {
    const marked = existsSync(join(cwd, "last-line"));
    if (marked) more -= 1;
    else if (performance.now() > until)
      throw new Error(`Waited ${BOUND_SECONDS} s for the last line to start: ${stderr}`);
    if (marked || signalsBefore) signal(child.pid, "SIGTERM");
  }
  const chunks = [];
  const buffer = Buffer.alloc(1 << 16);
  for (;;) {
    let length;
    try {
      length = readSync(reader, buffer);
    } catch (error) {
      if (error.code !== "EAGAIN") throw error;
      if (performance.now() > until)
        throw new Error(`Waited ${BOUND_SECONDS} s for the runner's output to end`);
      await pause();
      continue;
    }
    if (length === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, length)));
  }
  closeSync(reader);
  const output = Buffer.concat(chunks);
  assert.equal(output.subarray(0, filled).toString(), "f".repeat(filled));
  const result = await bounded(closed, "the runner to close");
  return { ...result, stdout: output.subarray(filled).toString(), stderr };
}
