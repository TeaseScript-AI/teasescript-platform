import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test, { before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  delayedDelivery,
  loadTopology,
  rerunRegistry,
  RowEnd,
  selectedTopologies,
  TOPOLOGIES,
  topologyBridge,
  until,
  withinHostTime,
  workerDelayMs,
} from "../helpers/player/worker-topology.js";

/*
 * The Worker-topology settings (docs/TESTING.md "Worker-topology settings"): the delayed delivery's order, real time
 * and lifetime, the settings refused when malformed, and the registries' rows under each selection. The selection runs
 * this file again in a child process as its own fixture (`SELECTION_FIXTURE`), with the settings in its environment.
 */

const FIXTURE = process.env["SELECTION_FIXTURE"];

if (FIXTURE !== undefined) {
  // A registered case on both topologies, one on the in-process host only, and a standalone test per topology. With
  // `fails` or `early`, the Worker row of the first case throws or returns without its end.
  const RERUN = rerunRegistry({ both: TOPOLOGIES, "in-process only": ["in-process"] });
  RERUN.rows("both", "fixture both", async (_context, topology, end) => {
    if (topology === "worker" && FIXTURE === "fails") throw new Error("the fixture's row fails");
    // Another row's end, as a body that returns without its own.
    if (topology === "worker" && FIXTURE === "early") return new RowEnd("another row");
    return end();
  });
  RERUN.rows("in-process only", "fixture in-process only", async (_context, _topology, end) =>
    end(),
  );
  for (const topology of TOPOLOGIES) test(`fixture standalone (${topology})`, () => {});
} else {
  before(loadTopology);

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

  test("delayed deliveries arrive in the order given, each its delay after it was given and in a task of its own", async () => {
    const delivery = delayedDelivery(40);
    const order: string[] = [];
    // Due together, the second still waits for the promise work the first started, as a Worker's next event does.
    delivery.run(() => {
      order.push("a");
      queueMicrotask(() => order.push("a's promise work"));
    });
    delivery.run(() => order.push("b"));
    await realSleep(10);
    delivery.run(() => order.push("c"));
    assert.equal(order.length, 0, `nothing before its delay: ${order.join(", ")}`);
    await realTime(() => order.length === 3, "the first two delivered");
    assert.deepEqual(order, ["a", "a's promise work", "b"], "c is not due yet");
    await realTime(() => order.length === 4, "the third delivered");
    assert.deepEqual(order, ["a", "a's promise work", "b", "c"]);
    assert.equal(delivery.pending(), 0);
  });

  test("a delayed delivery runs on real time: a mocked clock neither holds nor hastens it", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const delivery = delayedDelivery(30);
    let delivered = false;
    delivery.run(() => void (delivered = true));
    context.mock.timers.tick(1_000_000_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(delivered, false, "a mocked tick does not hasten it");
    await realTime(() => delivered, "delivered while the mocked clock stood still");
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

  test("a reply a delayed Worker sent before its loss reaches the client before the loss does", async (context) => {
    const transport = await topologyBridge(context, "worker", { workerDelayMs: 300 });
    const order: string[] = [];
    transport.bridge.client.onLoss(() => order.push("loss"));
    const received = transport.thread!.messages();
    const reply = transport.bridge.client.request("planMetadata", { plan: "missing" }).then(
      () => order.push("reply"),
      (error: unknown) => order.push(`reply: ${error instanceof Error ? error.name : "?"}`),
    );
    await until(() => transport.thread!.messages() > received, "the reply received", "host");
    assert.equal(order.length, 0, `received, not yet delivered: ${order.join(", ")}`);
    await transport.lose();
    await reply;
    assert.equal(order.length, 2, order.join(", "));
    assert.match(order[0]!, /^reply/u, "the reply first");
    assert.notEqual(order[0], "reply: BridgeLostError", "answered, not ended by the loss");
    assert.equal(order[1], "loss");
  });

  test("malformed settings are refused", () => {
    for (const setting of [undefined, "", "both"])
      assert.deepEqual(selectedTopologies(setting), ["in-process", "worker"], String(setting));
    assert.deepEqual(selectedTopologies("worker"), ["worker"]);
    for (const setting of ["in-process", "Worker", "all"])
      assert.throws(() => selectedTopologies(setting), /PLAYER_TEST_TOPOLOGY/u, setting);
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
      { encoding: "utf8", env: { ...inherited, PLAYER_TEST_TOPOLOGY: "", ...environment } },
    );
    const passed = [...run.stdout.matchAll(/^\s*ok \d+ - (fixture .*)$/gmu)].map(
      (match) => match[1],
    );
    return { status: run.status, passed: passed.sort(), output: run.stdout + run.stderr };
  };

  test("the default selection runs and owes both topologies' rows", () => {
    const run = fixture({ SELECTION_FIXTURE: "passes" });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.passed, [
      "fixture both (in-process)",
      "fixture both (worker)",
      "fixture in-process only (in-process)",
      "fixture standalone (in-process)",
      "fixture standalone (worker)",
    ]);
  });

  test("the Worker selection runs and owes the Worker's rows only, standalone ones included", () => {
    const run = fixture({ SELECTION_FIXTURE: "passes", PLAYER_TEST_TOPOLOGY: "worker" });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.passed, ["fixture both (worker)", "fixture standalone (worker)"]);
  });

  test("a selected row that fails or returns without its end is still owed", () => {
    for (const mode of ["fails", "early"]) {
      const run = fixture({ SELECTION_FIXTURE: mode, PLAYER_TEST_TOPOLOGY: "worker" });
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /registered rows/u, mode);
    }
  });

  test("a malformed setting stops the run that reads it", () => {
    const run = fixture({ SELECTION_FIXTURE: "passes", PLAYER_TEST_TOPOLOGY: "bogus" });
    assert.notEqual(run.status, 0, run.output);
    assert.match(run.output, /PLAYER_TEST_TOPOLOGY is both or worker/u);
  });
}
