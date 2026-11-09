import assert from "node:assert/strict";
import test from "node:test";

import { playerBridgeOps, playerOpsContext } from "../../player/engine-bridge/player-ops.js";
import { READ_OPS } from "../../player/engine-bridge/session-protocol.js";
import {
  EMPTY_PLAN_JSON_LEASE,
  settle,
  type PlanJsonEvent,
  type PlanJsonLease,
  type PlanJsonMessage,
} from "../../player/persistence/plan-json-lease.js";
import {
  NOT_PRODUCERS,
  PRODUCERS,
  RETIREMENTS,
  caseName,
  familyCases,
  unclassifiedOps,
  type FamilyCase,
  type Producer,
} from "../helpers/player/plan-json-family.js";
import { HOST_OPS, type HostOp } from "../helpers/player/host-ops.js";

/*
 * How long the host holds a plan's JSON (`player/persistence/plan-json-lease.ts`), over the generated family of
 * `helpers/player/plan-json-family.ts`: `settle` against a model of the host's ops (`ops/persistence.ts`). The model keeps a
 * reservation apart from its write: `preparePlanText` reserves, its task writes (or fails to, leaving the write to the
 * first reader), `releasePlanText` cancels or removes, and a reader reads a written slot, writes a reserved one once,
 * and writes for itself alone where none is reserved.
 * After every step of every case: the host holds a plan's JSON only for the live page's current plan; it is written at
 * most once per plan tenure; nothing is posted once the page closed.
 */

/** The host's plan JSON as the model holds it: reserved and waiting for its task, reserved after its task failed, or written. */
class HostModel {
  readonly slots = new Map<string, "pending" | "unwritten" | "ready">();
  /** Writes into a slot, per plan and tenure. */
  readonly writes = new Map<string, number>();
  /** Writes for one reader alone, which nothing keeps. */
  transient = 0;
  readonly #tenureOf: () => number;
  constructor(tenureOf: () => number) {
    this.#tenureOf = tenureOf;
  }
  #written(plan: string) {
    const key = `${plan}#${this.#tenureOf()}`;
    this.writes.set(key, (this.writes.get(key) ?? 0) + 1);
  }
  receive(message: PlanJsonMessage) {
    if (message.kind === "release") this.slots.delete(message.plan);
    else if (!this.slots.has(message.plan)) this.slots.set(message.plan, "pending");
  }
  /** The reservation's own task, whose write may fail, as one of a plan too large for this browser does. */
  task(plan: string, fails = false) {
    if (this.slots.get(plan) !== "pending") return;
    if (fails) {
      this.slots.set(plan, "unwritten");
      return;
    }
    this.slots.set(plan, "ready");
    this.#written(plan);
  }
  /** A reader of `plan`'s JSON: it never creates or removes a slot. */
  read(plan: string) {
    const slot = this.slots.get(plan);
    if (slot === "ready") return;
    if (slot === "pending" || slot === "unwritten") {
      this.slots.set(plan, "ready");
      this.#written(plan);
    } else this.transient += 1;
  }
}

/** The page's lease and the host, stepped together, with the invariants checked after each step. */
function harness(name: string) {
  let lease: PlanJsonLease = EMPTY_PLAN_JSON_LEASE;
  let tenure = 0;
  let closed = false;
  const host = new HostModel(() => tenure);
  const check = (after: string) => {
    for (const plan of host.slots.keys())
      assert.ok(
        lease.live && plan === lease.current,
        `${name}: the host holds ${plan} after ${after}`,
      );
    for (const [key, count] of host.writes)
      assert.ok(count <= 1, `${name}: ${key} was written ${count} times`);
  };
  return {
    host,
    lease: () => lease,
    event(event: PlanJsonEvent) {
      const settled = settle(lease, event);
      if (settled.lease.current !== lease.current) tenure += 1;
      lease = settled.lease;
      if (closed) assert.deepEqual(settled.messages, [], `${name}: posted after closing`);
      for (const message of settled.messages) host.receive(message);
      if (event.kind === "dispose") closed = true;
      check(event.kind);
    },
    onHost(step: (host: HostModel) => void, label: string) {
      step(host);
      check(label);
    },
  };
}

/** Where the producer's plan JSON stands when it starts. */
const SLOTS = ["absent", "pending", "ready"] as const;
/** When the plan retires, relative to the producer's request and reply. */
const POINTS = ["beforeRequest", "whileOut", "afterReply"] as const;
/** Whether a Start of the same plan is prepared again while the producer's reply is out. */
const REPREPARE = ["no", "yes"] as const;

interface LayerCase extends FamilyCase {
  readonly slot: (typeof SLOTS)[number];
  readonly point: (typeof POINTS)[number] | "none";
  readonly reprepare: (typeof REPREPARE)[number];
}

/** A combination is a case unless its values cannot meet. */
function valid(c: LayerCase): boolean {
  if (c.producer === "preparePlanText") {
    // The reservation is the producer: it starts with none, and a cancelled one needs a retirement before its task.
    if (c.slot !== "absent" || c.point !== "none") return false;
    return !(c.outcome === "cancelled" && c.retirement === "current");
  }
  return (c.retirement === "current") === (c.point === "none");
}

function* layerCases(): Generator<LayerCase> {
  for (const base of familyCases())
    for (const slot of SLOTS)
      for (const point of [...POINTS, "none"] as const)
        for (const reprepare of REPREPARE) {
          const c: LayerCase = { ...base, slot, point, reprepare };
          if (valid(c)) yield c;
        }
}
const layerName = (c: LayerCase) =>
  `${caseName(c)} slot:${c.slot} at:${c.point} reprepare:${c.reprepare}`;

/** Whether the producer's outcome reads the plan's JSON in the host. */
const reads = (producer: Producer, outcome: string) =>
  !(producer === "captureKeep" && outcome === "gone") &&
  !(producer === "reviewTransfer" && outcome === "released");

function run(c: LayerCase) {
  const h = harness(layerName(c));
  const retire = () => {
    if (c.retirement === "replaced") {
      h.event({ kind: "replace", plan: "B" });
      h.event({ kind: "prepare", plan: "B" });
    } else if (c.retirement === "disposed") h.event({ kind: "dispose" });
  };
  h.event({ kind: "replace", plan: "A" });
  if (c.producer === "preparePlanText") {
    h.event({ kind: "prepare", plan: "A" });
    if (c.reprepare === "yes") h.event({ kind: "prepare", plan: "A" });
    if (c.outcome === "cancelled") retire();
    h.onHost((host) => host.task("A", c.outcome === "writeFailed"), "the reservation's task");
    if (c.outcome !== "cancelled") retire();
    return h;
  }
  if (c.slot !== "absent") h.event({ kind: "prepare", plan: "A" });
  if (c.slot === "ready") h.onHost((host) => host.task("A"), "the reservation's task");
  if (c.point === "beforeRequest") retire();
  // The producer reaches the host.
  if (reads(c.producer, c.outcome)) h.onHost((host) => host.read("A"), `${c.producer} reading`);
  if (c.reprepare === "yes") h.event({ kind: "prepare", plan: "A" });
  if (c.point === "whileOut") retire();
  // Its reply arrives: no lease event, for a reader keeps nothing; a waiting task may still run.
  h.onHost((host) => host.task("A"), "a late task");
  if (c.point === "afterReply") retire();
  return h;
}

const CASES = [...layerCases()];

test("every op of the host is classified once: its plan JSON role and whether it is a session-free read", () => {
  const composed = Object.keys(playerBridgeOps(playerOpsContext())).sort();
  assert.deepEqual(
    Object.keys(HOST_OPS).sort(),
    composed,
    "the inventory is the composed host's ops",
  );
  assert.deepEqual(unclassifiedOps(Object.fromEntries(composed.map((op) => [op, null]))), []);
  const facet = (has: (op: HostOp) => boolean) =>
    Object.entries(HOST_OPS)
      .filter(([, op]) => has(op))
      .map(([name]) => name)
      .sort();
  assert.deepEqual(
    facet((op) => op.planJson === "producer"),
    Object.keys(PRODUCERS).sort(),
  );
  assert.deepEqual(
    facet((op) => op.read),
    Object.keys(READ_OPS).sort(),
  );
  for (const op of Object.keys(NOT_PRODUCERS)) assert.ok(composed.includes(op), op);
});

test("the generated family holds every declared obligation and every pair of values that can meet", () => {
  const names = new Set(CASES.map(layerName));
  assert.equal(names.size, CASES.length, "each case has its own name");
  // Every producer and outcome, at every retirement it can meet.
  for (const base of familyCases()) {
    const possible =
      base.producer !== "preparePlanText" ||
      base.outcome !== "cancelled" ||
      base.retirement !== "current";
    assert.equal(
      CASES.some((c) => caseName(c) === caseName(base)),
      possible,
      caseName(base),
    );
  }
  // Every reader at every slot state and retirement point, with and without a re-prepare.
  for (const producer of Object.keys(PRODUCERS)) {
    if (producer === "preparePlanText") continue;
    for (const slot of SLOTS)
      for (const point of POINTS)
        for (const reprepare of REPREPARE)
          assert.ok(
            CASES.some(
              (c) =>
                c.producer === producer &&
                c.slot === slot &&
                c.point === point &&
                c.reprepare === reprepare,
            ),
            `${producer} slot:${slot} at:${point} reprepare:${reprepare}`,
          );
  }
  for (const retirement of RETIREMENTS) assert.ok(CASES.some((c) => c.retirement === retirement));
});

test(`plan JSON lifetime over the generated family (${CASES.length} cases, each named in its assertions)`, () => {
  for (const c of CASES) {
    const h = run(c);
    // At the end the host holds the JSON of the live page's current plan alone, written once for this tenure.
    if (c.retirement === "current" && c.outcome === "writeFailed") {
      // The reservation stays, unwritten; its first reader writes it, once.
      assert.equal(h.host.slots.get("A"), "unwritten", layerName(c));
      h.onHost((host) => host.read("A"), "the first reader");
      assert.equal(h.host.slots.get("A"), "ready", layerName(c));
    } else if (c.retirement === "current") {
      const reserved =
        c.producer === "preparePlanText" || c.slot !== "absent" || c.reprepare === "yes";
      assert.equal(h.host.slots.get("A"), reserved ? "ready" : undefined, layerName(c));
    } else assert.equal(h.host.slots.has("A"), false, layerName(c));
    if (c.retirement === "disposed") assert.equal(h.host.slots.size, 0, layerName(c));
    assert.equal(h.lease().live, c.retirement !== "disposed", layerName(c));
  }
});

test("A, then B, then A again: each tenure of A writes its JSON once, and B's is let go", () => {
  const h = harness("A B A");
  for (const plan of ["A", "B", "A"]) {
    h.event({ kind: "replace", plan });
    h.event({ kind: "prepare", plan });
    h.onHost((host) => host.task(plan), `${plan}'s task`);
    h.onHost((host) => host.read(plan), `a read of ${plan}`);
  }
  assert.deepEqual([...h.host.slots.keys()], ["A"]);
  assert.equal(h.host.transient, 0);
  assert.equal(
    [...h.host.writes.values()].reduce((sum, count) => sum + count, 0),
    3,
  );
});

test("a restore racing a Start of the same plan reads the one reservation, which neither removes", () => {
  const h = harness("restore racing Start");
  h.event({ kind: "replace", plan: "A" });
  h.event({ kind: "prepare", plan: "A" });
  // The comparison reads while the task waits; the Start prepares again meanwhile; a keep's capture reads it too.
  h.onHost((host) => host.read("A"), "the comparison");
  h.event({ kind: "prepare", plan: "A" });
  h.onHost((host) => host.task("A"), "the reservation's task");
  h.onHost((host) => host.read("A"), "the first save's capture");
  assert.equal(h.host.slots.get("A"), "ready");
  assert.equal(h.host.writes.get("A#1"), 1);
  assert.equal(h.host.transient, 0);
});
