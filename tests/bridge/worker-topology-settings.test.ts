import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  delayedDelivery,
  rerunRegistry,
  RowEnd,
  withinHostTime,
  workerDelayMs,
} from "../helpers/player/worker-topology.js";

/*
 * The Worker-topology settings (docs/TESTING.md "Worker-topology settings"): the delayed delivery's order, real time
 * and lifetime, a setting refused when malformed, and the registry's owed rows. The registry runs this file again in a
 * child process as its own fixture (`SELECTION_FIXTURE`).
 */

const FIXTURE = process.env["SELECTION_FIXTURE"];

if (FIXTURE !== undefined) {
  // A registered case. With `fails` or `early`, its row throws or returns without its end.
  const RERUN = rerunRegistry({ row: ["worker"] });
  RERUN.rows("row", "fixture row", async (_context, _topology, end) => {
    if (FIXTURE === "fails") throw new Error("the fixture's row fails");
    // Another row's end, as a body that returns without its own.
    if (FIXTURE === "early") return new RowEnd("another row");
    return end();
  });
} else {
  /** Waits on real time, which a mocked `setTimeout` does not move, until `check` holds. */
  const realTime = async (check: () => boolean, label: string) => {
    const within = withinHostTime();
    while (!check()) {
      assert.ok(within(), label);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const realSleep = async (ms: number) => {
    const deadline = process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
    await realTime(() => process.hrtime.bigint() >= deadline, `${ms} ms passed`);
  };

  /** Milliseconds on the monotonic clock, which mocked timers, `Date` and `performance` do not move. */
  const monotonic = () => Number(process.hrtime.bigint()) / 1e6;

  // Each check below reads only lower bounds and orders taken inside the deliveries, never that an observer ran before a
  // deadline, so a slow runner cannot fail it.
  test("delayed deliveries arrive in the order given, each at least its delay after it was given and in a task of its own", async () => {
    const delivery = delayedDelivery(40);
    const order: string[] = [];
    const late: number[] = [];
    const given = (name: string, more: () => void = () => {}) => {
      const at = monotonic();
      delivery.run(() => {
        late.push(monotonic() - at);
        order.push(name);
        more();
      });
    };
    // Due together, the second still waits for the promise work the first started, as a Worker's next event does.
    given("a", () => queueMicrotask(() => order.push("a's promise work")));
    given("b");
    await realSleep(10);
    given("c");
    await realTime(() => order.length === 4, "all three delivered");
    assert.deepEqual(order, ["a", "a's promise work", "b", "c"]);
    assert.ok(
      late.every((ms) => ms >= 39),
      `each at least its delay after it was given: ${late.join(", ")}`,
    );
    assert.equal(delivery.pending(), 0);
  });

  test("a delayed delivery runs on real time: a mocked clock neither holds nor hastens it", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const delivery = delayedDelivery(30);
    const at = monotonic();
    let late: number | null = null;
    delivery.run(() => void (late = monotonic() - at));
    context.mock.timers.tick(1_000_000_000);
    await realTime(() => late !== null, "delivered while the mocked clock stood still");
    assert.ok(late! >= 29, `a mocked tick does not hasten it: ${late}`);
  });

  test("a cancelled delivery drops what is pending and everything given later", async () => {
    const delivery = delayedDelivery(20);
    const order: string[] = [];
    delivery.run(() => order.push("pending"));
    delivery.cancel();
    delivery.run(() => order.push("later"));
    await realSleep(60);
    assert.equal(order.length, 0, order.join(", "));
    assert.equal(delivery.pending(), 0);
    // At no delay, a delivery runs at once, and after cancel not at all.
    const immediate = delayedDelivery(0);
    immediate.run(() => order.push("at once"));
    immediate.cancel();
    immediate.run(() => order.push("dropped"));
    assert.deepEqual(order, ["at once"]);
  });

  test("a malformed delay is refused", () => {
    for (const [setting, ms] of [
      [undefined, 0],
      ["", 0],
      ["0", 0],
      ["3000", 3000],
    ] as const)
      assert.equal(workerDelayMs(setting), ms, String(setting));
    for (const setting of ["-1", "1.5", "abc", " 5", "1e3", "99999999999999999999"])
      assert.throws(() => workerDelayMs(setting), /PLAYER_TEST_WORKER_DELAY_MS/u, setting);
  });

  /** This file run as the selection fixture: its exit status and the tests that passed. */
  const fixture = (environment: Record<string, string>) => {
    // Without the parent runner's `NODE_TEST_CONTEXT`, the child reports on its own output, as a run of its own.
    const { NODE_TEST_CONTEXT: _, ...inherited } = process.env;
    const run = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)],
      { encoding: "utf8", env: { ...inherited, ...environment } },
    );
    const passed = [...run.stdout.matchAll(/^\s*ok \d+ - (fixture .*)$/gmu)].map(
      (match) => match[1],
    );
    return { status: run.status, passed: passed.sort(), output: run.stdout + run.stderr };
  };

  test("a registered row runs, and one that fails or returns without its end is still owed", () => {
    const run = fixture({ SELECTION_FIXTURE: "passes" });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.passed, ["fixture row (worker)"]);
    for (const mode of ["fails", "early"]) {
      const failed = fixture({ SELECTION_FIXTURE: mode });
      assert.equal(failed.status, 1, failed.output);
      assert.match(failed.output, /registered rows/u, mode);
    }
  });
}
