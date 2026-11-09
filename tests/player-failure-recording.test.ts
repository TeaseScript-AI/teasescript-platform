import assert from "node:assert/strict";
import test from "node:test";

import type { RecordingCaptureReply } from "../player/engine-bridge/session-protocol.js";
import type { PlayerBridge } from "../player/runtime/player-bridge.js";
import type { PlayerSession } from "../player/runtime/runtime-view.js";
import { useFailureRecording } from "../player/vue/src/session/activation/useFailureRecording.js";
import { coverageGaps, product, type Coordinates } from "./helpers/family-coverage.js";

/*
 * L5h.3b's failure recording family (`session/activation/useFailureRecording.ts`): the recording up to a Player error, captured
 * under a ticket as the stop is sent. The domain: the capture's settlement × what comes before it settles. Each case
 * checks, apart: the first-error rule (a later stop captures nothing more), what a restart waits for and that it never
 * rejects, the ticket the export selects, and that every ticket a retired or later capture got is released.
 */

const SETTLEMENTS = ["captured", "stale", "rejected", "lost"] as const;
const BEFORE = ["nothing", "restart", "secondStop", "start", "disposal"] as const;
type Settlement = (typeof SETTLEMENTS)[number];
type Before = (typeof BEFORE)[number];

/** A bridge whose `captureRecording` reads wait until the case settles them, and which records its releases. */
function fakeBridge() {
  const reads: { readonly settle: (reply: RecordingCaptureReply | Error) => void }[] = [];
  const released: string[] = [];
  const bridge = {
    read: (_session: PlayerSession, op: string) => {
      assert.equal(op, "captureRecording");
      return new Promise<RecordingCaptureReply>((resolve, reject) =>
        reads.push({
          settle: (reply) => (reply instanceof Error ? reject(reply) : resolve(reply)),
        }),
      );
    },
    releaseRecording: async (ticket: string) => void released.push(ticket),
  };
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: the owner calls only `read` and `releaseRecording` of a bridge, which this fake has.
  const typed = bridge as unknown as PlayerBridge;
  return { bridge: typed, reads, released };
}

/** The reply each settlement gives the capture with ticket `ticket`. */
function replyOf(settlement: Settlement, ticket: string): RecordingCaptureReply | Error {
  switch (settlement) {
    case "captured":
      return { kind: "captured", ticket, end: "live", complete: true };
    case "stale":
      return { kind: "stale" };
    case "rejected":
      return new Error("The host holds no such session.");
    case "lost":
      return Object.assign(new Error("The engine Worker failed."), { name: "BridgeLostError" });
  }
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

interface Outcome {
  readonly captures: number;
  readonly restart: "waited" | "immediate" | "none";
  readonly ticket: string | null;
  readonly released: readonly string[];
}

async function runCase(settlement: Settlement, before: Before): Promise<Outcome> {
  const { bridge, reads, released } = fakeBridge();
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: the owner reads only a stopped session's `connection`.
  const stopped = { connection: bridge } as unknown as PlayerSession;
  const owner = useFailureRecording();
  owner.stopped(stopped);
  let restarted: "waited" | "immediate" | "none" = "none";
  let restart: Promise<void> | null = null;
  if (before === "restart") {
    let done = false;
    restart = owner.beforeRestart().then(() => void (done = true));
    await turn();
    restarted = done ? "immediate" : "waited";
  } else if (before === "secondStop") owner.stopped(stopped);
  else if (before === "start" || before === "disposal") owner.retire();
  reads[0]!.settle(replyOf(settlement, "r1"));
  await turn();
  if (restart !== null) await restart;
  // A restart after settlement does not wait, whatever the outcome.
  let after = false;
  await owner.beforeRestart().then(() => void (after = true));
  assert.ok(after);
  return {
    captures: reads.length,
    restart: restarted,
    ticket: owner.ticket()?.ticket ?? null,
    released: [...released],
  };
}

/** What each case must give, from its coordinates alone. */
function expected(settlement: Settlement, before: Before): Outcome {
  const retired = before === "start" || before === "disposal";
  const captured = settlement === "captured";
  return {
    // The first stop's capture is the only one: a second stop captures nothing more.
    captures: 1,
    restart: before === "restart" ? "waited" : "none",
    // A retired activation keeps nothing; its late success is released as it arrives.
    ticket: captured && !retired ? "r1" : null,
    released: captured && retired ? ["r1"] : [],
  };
}

test("the failure recording latches its first capture, a restart waits for it, and a late or retired one is released", async () => {
  const cases = product({ settlement: [...SETTLEMENTS], before: [...BEFORE] });
  const observed: Coordinates[] = [];
  for (const coordinates of cases) {
    // EVIDENCE: invariant: `product` gives the declared domains' values.
    const settlement = coordinates.settlement as Settlement;
    // EVIDENCE: invariant: as above.
    const before = coordinates.before as Before;
    assert.deepEqual(
      await runCase(settlement, before),
      expected(settlement, before),
      `${settlement} before ${before}`,
    );
    observed.push(coordinates);
  }
  assert.deepEqual(coverageGaps(cases, observed, { tuples: true }), []);
});

test("a retired activation's ticket is released, it captures nothing more, and the next activation's captures anew", async () => {
  const { bridge, reads, released } = fakeBridge();
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: the owner reads only a stopped session's `connection`.
  const stopped = { connection: bridge } as unknown as PlayerSession;
  const owner = useFailureRecording();
  owner.stopped(stopped);
  reads[0]!.settle(replyOf("captured", "r1"));
  await turn();
  assert.equal(owner.ticket()?.ticket, "r1");
  owner.retire();
  assert.deepEqual(released, ["r1"]);
  assert.equal(owner.ticket(), null);
  // Retirement is terminal: a later stop of the retired activation captures nothing.
  owner.stopped(stopped);
  assert.equal(reads.length, 1);
  const next = useFailureRecording();
  next.stopped(stopped);
  reads[1]!.settle(replyOf("captured", "r2"));
  await turn();
  assert.equal(next.ticket()?.ticket, "r2");
  assert.equal(owner.ticket(), null);
});
