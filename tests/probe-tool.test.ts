import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The compiled test runs from dist/tests; the tool lives in tools/ at the checkout root.
const probe = fileURLToPath(new URL("../../tools/probe.mjs", import.meta.url));

function runProbe(source: string, args: readonly string[]) {
  const child = spawnSync(process.execPath, [probe, ...args, "-"], {
    input: source,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

test("probe reports compile errors with 1-based positions and exits 1", () => {
  const result = runProbe('let x = toInteger("a")\nexit\n', []);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^<stdin>:1:19 error TSV043 /m);
});

test("probe --run shows messages at once and skips timed waits on the script clock", () => {
  const result = runProbe('say "a"\nwait 2 s\nsay "b"\nexit\n', ["--run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^say: a$/m);
  assert.match(result.stdout, /^say: b$/m);
  assert.match(result.stdout, /^halted after \d+ instructions, script time 2000 ms$/m);
});

test("probe --run stops at the first player interaction", () => {
  const result = runProbe('let n = askInteger "How many?"\nsay "${n}"\nexit\n', ["--run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^waiting after \d+ instructions, waiting for \w+$/m);
  assert.doesNotMatch(result.stdout, /^halted/m);
});

test("probe --run reports a runtime failure and exits 3", () => {
  const result = runProbe('let parts = "x,abc".split(",")\nsay "${toInteger(parts[1])}"\nexit\n', [
    "--run",
  ]);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /^runtime failure TSR058 at <stdin>:2:/m);
  assert.match(result.stdout, /^failed after \d+ instructions$/m);
});
