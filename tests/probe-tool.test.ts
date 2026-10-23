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

test("probe --run moves past an authored reading time", () => {
  const result = runProbe('say "a", 2 s\nsay "b"\nexit\n', ["--run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^say: b$/m);
  assert.match(result.stdout, /^halted after \d+ instructions, script time 2000 ms$/m);
});

test("probe --run stops at a timer's button before a later deadline passes", () => {
  const source =
    'timer async 1 s {\n  showButton "Continue", timeout: 1 s\n  say "after button"\n}\n' +
    'wait 10 s\nsay "after wait"\nexit\n';
  const result = runProbe(source, ["--run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^waiting after \d+ instructions, script time 1000 ms, waiting for button$/m,
  );
  assert.doesNotMatch(result.stdout, /after button|after wait/);
});

test("probe --run reads the given clock in the given time zone as script time passes", () => {
  // Amsterdam keeps summer time (UTC+2) until 2026-10-25.
  const result = runProbe('say "${getDateTime()}"\nwait 90 s\nsay "${getTime()}"\nexit\n', [
    "--run",
    "--clock",
    "2026-10-04T16:30:00Z",
    "--zone",
    "Europe/Amsterdam",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^say: 2026-10-04 18:30$/m);
  assert.match(result.stdout, /^say: 18:31:30$/m);
});

test("probe refuses a clock or time zone it cannot use", () => {
  for (const [option, value] of [
    // Date.parse alone would move this on to March 2.
    ["--clock", "2026-02-30T12:00:00Z"],
    // Date.parse alone would read this in the host's own time zone.
    ["--clock", "2026-10-04T18:30:00"],
    ["--zone", "Mars/Base"],
  ] as const) {
    const result = runProbe("exit\n", ["--run", option, value]);
    assert.equal(result.status, 2, `${option} ${value}`);
    assert.ok(result.stderr.includes(value), result.stderr);
    assert.equal(result.stdout, "");
  }
});

test("probe --json output stays complete through a pipe", () => {
  // Enough events for more than one pipe buffer, so an early exit would cut the JSON off.
  const result = runProbe("for i in 1..=3000 { wait 1 ms }\nexit\n", ["--run", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output: { run: { status: string; events: string[] } } = JSON.parse(result.stdout);
  assert.equal(output.run.status, "halted");
  assert.equal(output.run.events.at(-1), "exit");
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
