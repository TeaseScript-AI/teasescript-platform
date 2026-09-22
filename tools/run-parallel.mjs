import { spawn, spawnSync } from "node:child_process";
import { openSync, closeSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const names = process.argv.slice(2);
if (names.length === 0) throw new Error("Pass npm script names to run.");
const serial = process.env.VERIFY_SERIAL === "1";
const scratch = mkdtempSync(join(tmpdir(), "verification-"));
const children = new Set();
let stopping = false;
let forceTimer;
let exitCode = 0;

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

function stop(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  const active = [...children].filter((child) => signalTree(child, "SIGTERM"));
  if (active.length === 0) return;
  forceTimer = setTimeout(() => {
    for (const child of active) signalTree(child, "SIGKILL");
  }, 2000);
}

const interrupt = () => stop(130);
const terminate = () => stop(143);
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
    child.on("error", (error) => {
      console.error(`${name}: ${error.message}`);
      stop(1);
    });
    child.on("close", (code, signal) => {
      console.log(
        `\n[${name}] ${code === 0 ? "PASS" : "FAIL"} (${((performance.now() - start) / 1000).toFixed(2)}s)`,
      );
      process.stdout.write(readFileSync(path));
      if (code !== 0 && !stopping) {
        console.error(`${name}: ${signal ? `signal ${signal}` : `exit ${code}`}`);
        stop(code || 1);
      }
      children.delete(child);
      resolve();
    });
  });
}

try {
  if (serial) {
    for (const [index, name] of names.entries()) {
      if (stopping) break;
      await run(name, index);
    }
  } else {
    await Promise.all(names.map(run));
  }
  // Keep the escalation deadline even if npm exits before a stubborn descendant.
  if (forceTimer) await new Promise((resolve) => setTimeout(resolve, 2100));
} finally {
  clearTimeout(forceTimer);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
  rmSync(scratch, { recursive: true, force: true });
}
process.exitCode = exitCode;
