import { spawn, spawnSync } from "node:child_process";
import { openSync, closeSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs npm scripts side by side, or one after another under `VERIFY_SERIAL=1`, each to its end: a failed step stops no
// other, so one run shows every failure (#2106). Each step's output prints together when it ends, after `[name] PASS`,
// `FAIL` or `ABORTED` and its seconds; a failed step's leftover descendants (its process group) are stopped. SIGINT and
// SIGTERM stop every running step, labelled `ABORTED`, and start no other. The last line says what ran, failed and did
// not run (`summaryLine`):
//
//   node tools/run-parallel.mjs <npm script>...
//
// Exit status: the first failed step's, or 130 or 143 for a signal that came first, else 0. `runSteps` does the same for another tool, and
// leaves the last line to it.

function signalTree(child, signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    return (
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }).status ===
      0
    );
  } else {
    try {
      // npm and shell scripts can outlive their immediate parent.
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return false;
    }
  }
}

/** Stops `child`'s process group, escalating to SIGKILL after a grace period; resolves when that is done. */
function stopTree(child) {
  if (!signalTree(child, "SIGTERM")) return Promise.resolve();
  return new Promise((resolve) =>
    setTimeout(() => {
      signalTree(child, "SIGKILL");
      resolve();
    }, 2000),
  );
}

/**
 * `ran: …; failed: …; not run: …` for `steps`, each `{ name, status }`: a step that ended (`PASS` or `FAIL`) ran, one
 * that failed is also named under failed, and any other status (stopped, never started) did not run. An empty list
 * reads `none`.
 */
export function summaryLine(steps) {
  const list = (names) => (names.length > 0 ? names.join(", ") : "none");
  const named = (keep) => list(steps.filter(keep).map(({ name }) => name));
  return (
    `ran: ${named(({ status }) => status === "PASS" || status === "FAIL")}; ` +
    `failed: ${named(({ status }) => status === "FAIL")}; ` +
    `not run: ${named(({ status }) => status !== "PASS" && status !== "FAIL")}`
  );
}

/**
 * Runs the npm scripts `names` as the header says, and returns each one's `{ name, status }` (`PASS`, `FAIL`,
 * `ABORTED`, or `NOT RUN` for a step a signal kept from starting) and the exit status.
 */
export async function runSteps(names, { serial = false } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "verification-"));
  const children = new Set();
  const status = new Map(names.map((name) => [name, "NOT RUN"]));
  const stopping = [];
  // (the steps a signal stopped, labelled ABORTED whatever their exit)
  const aborted = new Set();
  let signalled = false;
  let exitCode = 0;
  const onSignal = (code) => () => {
    if (signalled) return;
    signalled = true;
    if (exitCode === 0) exitCode = code;
    for (const child of children) {
      aborted.add(child);
      stopping.push(stopTree(child));
    }
  };
  const interrupt = onSignal(130);
  const terminate = onSignal(143);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);

  async function run(name, index) {
    const path = join(scratch, `${index}.log`);
    const fd = openSync(path, "w");
    const start = performance.now();
    let child;
    try {
      child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", name], {
        stdio: ["ignore", fd, fd],
        detached: process.platform !== "win32",
        shell: process.platform === "win32",
      });
    } finally {
      closeSync(fd);
    }
    children.add(child);
    await new Promise((resolve) => {
      let failure = null;
      child.on("error", (error) => (failure = error.message));
      child.on("close", (code, signal) => {
        children.delete(child);
        const result =
          code === 0 && failure === null ? "PASS" : aborted.has(child) ? "ABORTED" : "FAIL";
        status.set(name, result);
        console.log(`\n[${name}] ${result} (${((performance.now() - start) / 1000).toFixed(2)}s)`);
        process.stdout.write(readFileSync(path));
        if (result === "FAIL") {
          console.error(`${name}: ${failure ?? (signal ? `signal ${signal}` : `exit ${code}`)}`);
          if (exitCode === 0) exitCode = code || 1;
          stopping.push(stopTree(child));
        }
        resolve();
      });
    });
  }

  try {
    if (serial) {
      for (const [index, name] of names.entries()) {
        if (signalled) break;
        await run(name, index);
      }
    } else {
      await Promise.all(names.map(run));
    }
    // Keep each escalation deadline even if npm exits before a stubborn descendant.
    await Promise.all(stopping);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    rmSync(scratch, { recursive: true, force: true });
  }
  return { steps: names.map((name) => ({ name, status: status.get(name) })), exitCode };
}

if (import.meta.main) {
  const names = process.argv.slice(2);
  if (names.length === 0) throw new Error("Pass npm script names to run.");
  const { steps, exitCode } = await runSteps(names, { serial: process.env.VERIFY_SERIAL === "1" });
  console.log(`\n${summaryLine(steps)}`);
  process.exitCode = exitCode;
}
