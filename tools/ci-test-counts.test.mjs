import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { countsOf } from "./ci-test-counts.mjs";

const tool = fileURLToPath(new URL("./ci-test-counts.mjs", import.meta.url));

/** Lines of run 42403132352's `gh run view --log` (#1976's merge-ref run), long output lines cut. */
const RECORDED = [
  "check-1\tSet up job\t2026-11-07T18:49:14.5224612Z Current runner version: '2.338.2'",
  'check-1\tBuild and run tests, shard 1 of 2\t2026-11-07T18:57:18.9077788Z {"replyDecoderCoverage":{"begin/value/e',
  "check-1\tBuild and run tests, shard 1 of 2\t2026-11-07T18:57:37.1888613Z ℹ tests 3600",
  "check-1\tBuild and run tests, shard 1 of 2\t2026-11-07T18:57:37.1889160Z ℹ suites 0",
  "check-1\tBuild and run tests, shard 1 of 2\t2026-11-07T18:57:37.1889525Z ℹ pass 3599",
  "check-1\tBuild and run tests, shard 1 of 2\t2026-11-07T18:57:37.1889812Z ℹ fail 0",
  "check-1\tBuild and run tests, shard 1 of 2\t2026-11-07T18:57:37.1890053Z ℹ cancelled 0",
  "check-1\tBuild and run tests, shard 1 of 2\t2026-11-07T18:57:37.1890290Z ℹ skipped 1",
  "check-1\tBuild and run tests, shard 1 of 2\t2026-11-07T18:57:37.1890490Z ℹ todo 0",
  "check-1\tBuild and run tests, shard 1 of 2\t2026-11-07T18:57:37.1890749Z ℹ duration_ms 462808.951342",
  "check-1\tName the runtime oracle's pin\t2026-11-07T18:57:37.2290594Z ##[group]Run echo \"key=runtime-oracle-$(nod",
  "check-1\tName the runtime oracle's pin\t2026-11-07T18:57:37.2291746Z ^[[36;1mecho \"key=runtime-oracle-$(node -p ",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:43.4284966Z ✔ --shard=i/N names shard i of N, and anyth",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:43.4348931Z ✔ the filter's two shards run every compile",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:43.4397361Z ℹ tests 44",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:43.4423866Z ℹ suites 1",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:43.4452419Z ℹ pass 44",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:43.4541645Z ℹ fail 0",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:43.4559345Z ℹ cancelled 0",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:43.4622586Z ℹ skipped 0",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:43.4665081Z ℹ todo 0",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:43.4732716Z ℹ duration_ms 7922.828914",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:46.3292676Z ℹ tests 10",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:46.3381188Z ℹ suites 0",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:46.3463236Z ℹ pass 10",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:46.3542800Z ℹ fail 0",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:46.3596724Z ℹ cancelled 0",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:46.3674110Z ℹ skipped 0",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:46.3762721Z ℹ todo 0",
  "check-2\tCheck source before the tests\t2026-11-07T18:49:46.3792744Z ℹ duration_ms 11322.453002",
  "check-2\tCheck source before the tests\t2026-11-07T18:50:37.1125031Z ℹ tests 37",
  "check-2\tCheck source before the tests\t2026-11-07T18:50:37.1125402Z ℹ suites 0",
  "check-2\tCheck source before the tests\t2026-11-07T18:50:37.1125743Z ℹ pass 37",
  "check-2\tCheck source before the tests\t2026-11-07T18:50:37.1126034Z ℹ fail 0",
  "check-2\tCheck source before the tests\t2026-11-07T18:50:37.1126414Z ℹ cancelled 0",
  "check-2\tCheck source before the tests\t2026-11-07T18:50:37.1126739Z ℹ skipped 0",
  "check-2\tCheck source before the tests\t2026-11-07T18:50:37.1127093Z ℹ todo 0",
  "check-2\tCheck source before the tests\t2026-11-07T18:50:37.1127490Z ℹ duration_ms 58989.223877",
  "check-2\tBuild and run tests, shard 2 of 2\t2026-11-07T18:58:36.2543481Z [player] camera-denied: The session cam",
  "check-2\tBuild and run tests, shard 2 of 2\t2026-11-07T18:59:10.6843021Z ℹ tests 2106",
  "check-2\tBuild and run tests, shard 2 of 2\t2026-11-07T18:59:10.6844972Z ℹ suites 0",
  "check-2\tBuild and run tests, shard 2 of 2\t2026-11-07T18:59:10.6845804Z ℹ pass 2106",
  "check-2\tBuild and run tests, shard 2 of 2\t2026-11-07T18:59:10.6847164Z ℹ fail 0",
  "check-2\tBuild and run tests, shard 2 of 2\t2026-11-07T18:59:10.6848151Z ℹ cancelled 0",
  "check-2\tBuild and run tests, shard 2 of 2\t2026-11-07T18:59:10.6848628Z ℹ skipped 0",
  "check-2\tBuild and run tests, shard 2 of 2\t2026-11-07T18:59:10.6848953Z ℹ todo 0",
  "check-2\tBuild and run tests, shard 2 of 2\t2026-11-07T18:59:10.6849364Z ℹ duration_ms 492263.705155",
].join("\n");

/** The tool's exit status and output for a log file holding `log`. */
function check(log) {
  const directory = mkdtempSync(join(tmpdir(), "ci-test-counts-"));
  try {
    const file = join(directory, "run.log");
    writeFileSync(file, log);
    const result = spawnSync(process.execPath, [tool, "--log", file], { encoding: "utf8" });
    return { status: result.status, out: result.stdout + result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a recorded run's summaries are added up per job and step, then over the run", () => {
  assert.deepEqual(
    countsOf(RECORDED).map(({ job, step, summaries, tests, pass, fail, skipped }) => [
      job,
      step,
      summaries,
      tests,
      pass,
      fail,
      skipped,
    ]),
    [
      ["check-1", "Build and run tests, shard 1 of 2", 1, 3600, 3599, 0, 1],
      ["check-2", "Check source before the tests", 3, 91, 91, 0, 0],
      ["check-2", "Build and run tests, shard 2 of 2", 1, 2106, 2106, 0, 0],
    ],
  );
  const { status, out } = check(RECORDED);
  assert.equal(status, 0, out);
  assert.match(
    out,
    /check-2 +Check source before the tests \(3 summaries\) +tests 91 +pass 91 +fail 0 +skipped 0/u,
  );
  assert.match(
    out.trim().split("\n").at(-1),
    /: 5 summaries in 3 steps of 2 jobs: tests 5797, pass 5796, fail 0, skipped 1$/u,
  );
});

/** Lines of run 42462610771's `gh run view --log` (#1999), fetched when GitHub no longer had its per-step logs. */
const UNNAMED = [
  "check-1\tUNKNOWN STEP\t2026-11-08T08:22:03.3275767Z ##[group]Run npm ci --no-audit --no-fund",
  "check-1\tUNKNOWN STEP\t2026-11-08T08:22:10.7710550Z ##[group]Run npm test -- --shard=1/3",
  "check-1\tUNKNOWN STEP\t2026-11-08T08:27:25.4551576Z ℹ tests 2070",
  "check-1\tUNKNOWN STEP\t2026-11-08T08:27:25.4552424Z ℹ pass 2070",
  "check-1\tUNKNOWN STEP\t2026-11-08T08:27:25.4552755Z ℹ fail 0",
  "check-1\tUNKNOWN STEP\t2026-11-08T08:27:25.4558069Z ℹ skipped 0",
  "check-1\tUNKNOWN STEP\t2026-11-08T08:27:28.6764778Z ##[group]Run npm run oracle:test",
  "check-1\tUNKNOWN STEP\t2026-11-08T08:29:06.3217763Z ℹ tests 255",
  "check-1\tUNKNOWN STEP\t2026-11-08T08:29:06.3218202Z ℹ pass 254",
  "check-1\tUNKNOWN STEP\t2026-11-08T08:29:06.3218407Z ℹ fail 0",
  "check-1\tUNKNOWN STEP\t2026-11-08T08:29:06.3218969Z ℹ skipped 1",
].join("\n");

test("a run whose per-step logs GitHub no longer has names each step by the command it ran, and says why", () => {
  assert.deepEqual(
    countsOf(UNNAMED).map(({ step, tests, pass, skipped }) => [step, tests, pass, skipped]),
    [
      ["run: npm test -- --shard=1/3", 2070, 2070, 0],
      ["run: npm run oracle:test", 255, 254, 1],
    ],
  );
  const { status, out } = check(UNNAMED);
  assert.equal(status, 0, out);
  assert.match(out, /GitHub no longer has this run's per-step logs/u);
  assert.doesNotMatch(check(RECORDED).out, /per-step logs/u);
});

test("a summary that counts a failure, or logs without one, exit 1; bad arguments exit 2", () => {
  const failing = RECORDED.replace("ℹ pass 2106", "ℹ pass 2105").replace(
    /(shard 2 of 2\t\S+ ℹ fail) 0/u,
    "$1 1",
  );
  const { status, out } = check(failing);
  assert.equal(status, 1, out);
  assert.match(out, /shard 2 of 2 +tests 2106 +pass 2105 +fail 1/u);
  const none = check("check-1\tSet up job\t2026-11-07T18:49:14.5224612Z Current runner version\n");
  assert.equal(none.status, 1);
  assert.match(none.out, /no node:test summary/u);
  for (const args of [[], ["abc"], ["--log"], ["--log", "/nonexistent/run.log"]])
    assert.equal(spawnSync(process.execPath, [tool, ...args]).status, 2, args.join(" "));
});
