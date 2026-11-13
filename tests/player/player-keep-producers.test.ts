/*
 * The keep family's producers on the composable (`familyCases`): every producer of the shared family, driven here.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { EffectScope } from "vue";
import { keptSession } from "../../player/persistence/kept-sessions.js";
import {
  PRODUCERS,
  caseName,
  familyCases,
  type FamilyCase,
  type Producer,
} from "../helpers/player/plan-json-family.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { InstructionPlan } from "../../src/index.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint.js";
import { readForImport } from "../helpers/player/transfer-read.js";
import {
  KeepHost,
  stubBrowser,
  SCOPE,
  browser,
  planWrites,
  faults,
  writesOn,
  held,
  prepareOn,
  page,
  mount,
  tasks,
  until,
  ASKS,
  ENDS,
  prepareAgain,
  ASKS_OTHER,
} from "../helpers/player/keep-host.js";

/** Holds `op`'s reply on `bridge` until `release`; `sent` resolves once it was posted, `before` sees its arguments. */
function holdReply(
  context: TestContext,
  bridge: PlayerBridge,
  op: string,
  before?: (args: unknown, request: PlayerBridge["client"]["request"]) => void,
) {
  let posted!: () => void;
  const sent = new Promise<void>((resolve) => (posted = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const request = bridge.client.request.bind(bridge.client);
  let first = true;
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    if (args[0] !== op || !first) return request(...args);
    first = false;
    before?.(args[1], request);
    const reply = request(...args).then(async (result) => {
      await gate;
      return result;
    });
    posted();
    return reply;
  });
  return { sent, release: () => release() };
}

/** A kept session in `at` of `plan`: at its first question, or at its end. */
async function seedKept(
  context: TestContext,
  at: ReturnType<typeof browser>,
  plan: InstructionPlan,
  ended: boolean,
) {
  const { host, scope } = await page(context, at, plan);
  await host.activate();
  if (ended)
    await until(
      () => at.published.some((update) => update.events.some((event) => event.kind === "exit")),
      "the seed's end was not kept",
    );
  else await until(() => at.published.length > 0, "the seed was not kept");
  scope.stop();
  await tasks();
}

interface Driven {
  readonly host: KeepHost;
  readonly scope: EffectScope;
  /** The plan under test, which the page holds until it retires. */
  readonly plan: InstructionPlan;
  /** Lets the producer's reply arrive, and resolves once its caller is done with it. */
  readonly finish: () => Promise<void>;
  /** Writes of the plan that are not the lease's: an import's review compares the plans on the main side (L5h.2). */
  readonly reviewWrites?: number;
}

/** Each producer on its real path, its reply held; a new producer needs its driver here (the type requires it). */
const DRIVERS: Record<
  Producer,
  (context: TestContext, at: ReturnType<typeof browser>, c: FamilyCase) => Promise<Driven>
> = {
  async preparePlanText(context, at, c) {
    const { host, scope } = await mount(context, at);
    const token = await held(host, ASKS);
    if (c.outcome === "writeFailed") faults.planWrite = ASKS;
    context.after(() => (faults.planWrite = null));
    // Prepared without waiting: a retirement right after cancels the reservation before its task runs.
    const preparing = host.prepareScript(token, {
      plan: token,
      options: () => ({ ...host.scriptStorageOptions(), ...host.temporalCapture() }),
    });
    if (c.outcome === "writeFailed") {
      await preparing;
      await until(() => faults.planWrite === null, "the reservation's task did not try to write");
    } else if (c.outcome === "materialized") {
      await preparing;
      for (let turn = 0; (await writesOn(host, ASKS)) === 0; turn++) {
        assert.ok(turn < 200, "the reservation was not written");
        await tasks();
      }
    }
    return { host, scope, plan: ASKS, finish: async () => void (await preparing) };
  },
  async restoreKept(context, at, c) {
    const seeded = c.outcome === "otherPlan" ? ASKS_OTHER : c.outcome === "ended" ? ENDS : ASKS;
    await seedKept(context, at, seeded, c.outcome === "ended");
    if (c.outcome === "rejected") {
      const stored = await at.kept.session(SCOPE);
      assert.ok(stored !== null);
      const entry = keptSession(stored);
      assert.ok(entry !== null);
      await at.kept.publish(SCOPE, {
        planJson: entry.planJson,
        snapshotJson: '{"damaged":true}',
        eventsFrom: 0,
        events: entry.events,
        eventsJson: entry.events.map(serializeValidatedRuntimeJson),
        marks: { editedWhileDebugging: null, rewoundWhileDebugging: null },
      });
    }
    const plan = c.outcome === "ended" ? ENDS : ASKS;
    const { host, scope } = await mount(context, at);
    const reply = holdReply(context, await host.bridge, "restoreKept");
    const preparing = prepareOn(host, plan);
    await reply.sent;
    return {
      host,
      scope,
      plan,
      finish: async () => {
        reply.release();
        await preparing;
      },
    };
  },
  async planText(context, at, c) {
    const exporting = await page(context, at, ASKS);
    await exporting.host.activate();
    await until(() => exporting.host.session.value !== null, "no session to export");
    const { transfer } = await exporting.host.exportSession();
    exporting.scope.stop();
    const { host, scope } = await page(context, at, ASKS);
    const beforeReview = await writesOn(host, ASKS);
    const review = await host.reviewSessionImport(await readForImport(host, transfer));
    // The review compares the plans in the host, with the plan's JSON the lease holds: it writes the plan no more.
    const reviewWrites = (await writesOn(host, ASKS)) - beforeReview;
    assert.equal(reviewWrites, 0, "the review wrote the plan");
    const reply = holdReply(context, await host.bridge, "planText");
    if (c.outcome === "failed") at.state.failing = 1;
    const importing = host.importSession(review).catch(() => {});
    await reply.sent;
    return {
      host,
      scope,
      plan: ASKS,
      reviewWrites,
      finish: async () => {
        reply.release();
        await importing;
      },
    };
  },
  async reviewTransfer(context, at, c) {
    // A session of the page's plan, or of another plan, which the review refuses after comparing the plans.
    const exported = c.outcome === "refused" ? ASKS_OTHER : ASKS;
    const exporting = await page(context, at, exported);
    await exporting.host.activate();
    await until(() => exporting.host.session.value !== null, "no session to export");
    const { transfer } = await exporting.host.exportSession();
    exporting.scope.stop();
    const { host, scope } = await page(context, at, ASKS);
    const read = await readForImport(host, transfer);
    // A ticket let go of first: the review finds no session, and reads no plan JSON.
    if (c.outcome === "released") host.discardSessionReview(read);
    const reply = holdReply(context, await host.bridge, "reviewTransfer");
    const reviewing = host.reviewSessionImport(read).then(
      () => "reviewed",
      () => "refused",
    );
    await reply.sent;
    return {
      host,
      scope,
      plan: ASKS,
      finish: async () => {
        reply.release();
        // A page that closed meanwhile refuses what it reviewed: it shows nothing any more.
        const settled = await reviewing;
        if (c.retirement !== "disposed")
          assert.equal(settled, c.outcome === "reviewed" ? "reviewed" : "refused");
      },
    };
  },
  async captureKeep(context, at, c) {
    const { host, scope } = await page(context, at, ASKS);
    const reply = holdReply(context, await host.bridge, "captureKeep", (args, request) => {
      if (c.outcome === "unkeepable") faults.nextSnapshot = true;
      const session =
        typeof args === "object" && args !== null && "session" in args ? args.session : null;
      // A session the host no longer holds: released just before the capture runs.
      if (c.outcome === "gone" && typeof session === "string")
        void request("release", null, { session });
    });
    const activating = host.activate();
    await reply.sent;
    return {
      host,
      scope,
      plan: ASKS,
      finish: async () => {
        reply.release();
        await activating;
        await tasks();
      },
    };
  },
};

for (const c of familyCases()) {
  if (c.producer === "preparePlanText" && c.outcome === "cancelled" && c.retirement === "current")
    continue;
  test(`the composable's plan JSON: ${caseName(c)}`, async (context) => {
    stubBrowser(context);
    const at = browser();
    planWrites(context, ASKS, ENDS, ASKS_OTHER);
    const driven = await DRIVERS[c.producer](context, at, c);
    const bridge = await driven.host.bridge;
    const token = await held(driven.host, driven.plan);
    // The page's plan retires while the producer's reply is held, or stays.
    if (c.retirement === "replaced")
      await prepareAgain(driven.host, driven.plan === ASKS_OTHER ? ASKS : ASKS_OTHER);
    else if (c.retirement === "disposed") driven.scope.stop();
    await driven.finish();
    for (let turn = 0; turn < 4; turn++) await tasks();
    const written = await writesOn(driven.host, driven.plan);
    assert.ok(
      written - (driven.reviewWrites ?? 0) <= 1,
      `${caseName(c)}: written ${written} times`,
    );
    // Asked for it twice now: held, it is not written again, or once after its task failed; let go of, each read writes
    // it and keeps nothing.
    await bridge.client.request("planText", { plan: token });
    await bridge.client.request("planText", { plan: token });
    assert.equal(
      (await writesOn(driven.host, driven.plan)) - written,
      c.retirement !== "current" ? 2 : c.outcome === "writeFailed" ? 1 : 0,
      `${caseName(c)}: the host's plan JSON after the case`,
    );
  });
}

test("the composable's family drives every producer of the shared family", () => {
  assert.deepEqual(Object.keys(DRIVERS).sort(), Object.keys(PRODUCERS).sort());
});
