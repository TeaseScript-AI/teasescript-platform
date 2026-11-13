import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { trackInFlight } from "./test-in-flight.mjs";

/** A tracker on hand-made events and a hand-set clock: `emit(type, data)`, `at(ms)`, `look()`, and the lines written. */
function tracker(after = 300_000) {
  const listeners = new Map();
  const lines = [];
  let clock = 0;
  const look = trackInFlight((type, listener) => listeners.set(type, listener), {
    after,
    write: (line) => lines.push(line.trim()),
    now: () => clock,
    every: () => {},
  });
  return {
    emit: (type, data) => listeners.get(type)(data),
    at: (ms) => void (clock = ms),
    look,
    lines,
  };
}

test("a file's innermost test is named once the file has gone the threshold without a test beginning or ending, and again each threshold after", () => {
  const { emit, at, look, lines } = tracker();
  emit("test:dequeue", {
    file: "/r/dist/tests/a.test.js",
    name: "/r/dist/tests/a.test.js",
    nesting: 0,
  });
  emit("test:dequeue", { file: "/r/dist/tests/a.test.js", name: "outer", nesting: 0 });
  at(1_000);
  emit("test:dequeue", { file: "/r/dist/tests/a.test.js", name: "inner", nesting: 1 });
  at(300_999);
  look();
  assert.deepEqual(lines, []);
  at(301_000);
  look();
  at(400_000);
  look();
  at(601_000);
  look();
  assert.equal(lines.length, 2);
  assert.match(
    lines[0],
    /^test-in-flight: 5m 0s without a test beginning or ending in .*a\.test\.js › outer › inner$/u,
  );
  assert.match(lines[1], /^test-in-flight: 10m 0s without .* › outer › inner$/u);
});

test("a test that ends restarts its file's clock at its parent, the file alone between its tests, and a finished file is dropped", () => {
  const { emit, at, look, lines } = tracker();
  const file = "/r/dist/tests/b.test.js";
  emit("test:dequeue", { file, name: file, nesting: 0 });
  emit("test:dequeue", { file, name: "outer", nesting: 0 });
  emit("test:dequeue", { file, name: "first", nesting: 1 });
  at(200_000);
  emit("test:complete", { file, name: "first", nesting: 1 });
  at(400_000);
  look();
  assert.deepEqual(lines, [], "200 s since the last test ended");
  at(500_000);
  look();
  assert.match(lines[0], /^test-in-flight: 5m 0s without .*b\.test\.js › outer$/u);
  emit("test:complete", { file, name: "outer", nesting: 0 });
  at(800_000);
  look();
  assert.match(
    lines[1],
    /^test-in-flight: 5m 0s without .*b\.test\.js$/u,
    "between top-level tests",
  );
  emit("test:complete", { file, name: file, nesting: 0 });
  at(2_000_000);
  look();
  assert.equal(lines.length, 2);
});

test("events without the file's own entry, or that it cannot place, never throw", () => {
  const { emit, at, look, lines } = tracker();
  const file = "/r/dist/tests/c.test.js";
  emit("test:complete", { file, name: "never began", nesting: 2 });
  emit("test:dequeue", { file, name: "outer", nesting: 0 });
  emit("test:dequeue", { file, name: "inner", nesting: 1 });
  emit("test:complete", { file, name: "inner", nesting: 1 });
  emit("test:complete", { file, name: "outer", nesting: 0 });
  emit("test:complete", { file, name: "outer", nesting: 0 });
  emit("test:dequeue", { file: undefined, name: "loose", nesting: 0 });
  at(400_000);
  look();
  assert.match(lines.join("\n"), /^test-in-flight: 6m 40s without .* › loose$/u);
});

// node:test's `run()` refuses to run files from inside a test file, so a script of its own runs the hung file and
// follows it, with the threshold and the look in tenths of a second. The script is a file, not `node -e`: `run()` gives
// its files' processes this process's `execArgv`, which would carry the `-e` code into them. On a loaded machine the
// threshold can pass before the hung subtest begins, so an earlier line may rightly name the file or `outer` alone: the
// script stops at the line naming the hung subtest, or after 5 s.
test("a real hung file is named down to its hung subtest from node:test's own events", () => {
  const directory = mkdtempSync(join(tmpdir(), "test-in-flight-"));
  try {
    const file = join(directory, "hung.test.mjs");
    writeFileSync(
      file,
      [
        'import test from "node:test";',
        'test("outer", async (t) => {',
        '  await t.test("inner passes", () => {});',
        '  await t.test("inner hangs", () => new Promise(() => setInterval(() => {}, 1000)));',
        "});",
        "",
      ].join("\n"),
    );
    const tracker = pathToFileURL(join(import.meta.dirname, "test-in-flight.mjs")).href;
    const script = [
      'import { run } from "node:test";',
      `import { trackInFlight } from ${JSON.stringify(tracker)};`,
      "const controller = new AbortController();",
      `const stream = run({ files: [${JSON.stringify(file)}], isolation: "process", signal: controller.signal });`,
      "const write = (line) => {",
      "  process.stdout.write(line);",
      '  if (line.includes(" › inner hangs")) controller.abort();',
      "};",
      "setTimeout(() => controller.abort(), 5_000).unref();",
      "trackInFlight((type, listener) => stream.on(type, listener), { after: 200, look: 50, write });",
      'stream.on("data", () => {});',
    ].join("\n");
    const follower = join(directory, "follow.mjs");
    writeFileSync(follower, script);
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const result = spawnSync(process.execPath, [follower], {
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    const lines = result.stdout.split("\n").filter(Boolean);
    assert.match(
      lines.find((line) => line.includes(" › inner hangs")) ?? lines.join("\n"),
      /^test-in-flight: \d+m \d+s without a test beginning or ending in .*hung\.test\.mjs › outer › inner hangs$/u,
      result.stderr,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
