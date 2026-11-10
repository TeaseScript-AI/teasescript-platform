/*
 * The rewind lineage transfers' family (`helpers/player/rewind-transfer-domain.ts`), on the rewind tests' shared host.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import {
  obligations as transferObligations,
  transferCoverage,
  type Obligation,
} from "../helpers/player/rewind-transfer-domain.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import {
  backTo,
  memoryStorage,
  createHost,
  settle,
  script,
  start,
  choose,
  shownView,
  holdRead,
  deniedStorage,
  chooseAt,
  heldInHost,
} from "../helpers/player/rewind-host.js";
import { untypedClient } from "../helpers/bridge/untyped.js";
import { sourceStart } from "../helpers/prepared-plan.js";

/*
 * L5i.6: every lineage transfer of Debug's rewind (`transferLineages`), as the declared domain generates its obligations
 * (`tests/helpers/player/rewind-transfer-domain.ts`), each run through the Player's real session host and its host ops: the
 * page is brought into the inspection state, the transition runs as the Player or its host runs it, and the fates of
 * the parked and the shown lineage are read back from the host (a released session is gone there) and the page. A
 * refusal is the composable's and the host op's both, and changes no ownership; so does a failed guard. The coverage
 * check binds the cases run to the obligations.
 */
const TRANSFERS = transferObligations();
const transfersRun = new Set<string>();

/** The page in `inspection`, with the lineage parked (or live) and the one shown, as the family's transitions meet it. */
async function transferState(
  context: TestContext,
  each: Obligation,
): Promise<{
  readonly made: ReturnType<typeof createHost>;
  readonly storage: ReturnType<typeof memoryStorage> | null;
  readonly bridge: PlayerBridge;
  readonly parked: PlayerSession;
  readonly shown: PlayerSession | null;
  /** The adoption under way, and how it is let go: it succeeds, or fails. */
  readonly adoption: { readonly done: Promise<void>; release(): void } | null;
}> {
  const sessionLocal = each.variant.includes("session-local");
  const storage = sessionLocal ? null : memoryStorage();
  const made = createHost(context, storage?.provider ?? deniedStorage());
  const { host, rewind } = made;
  await start(context, host);
  await choose(context, host, "One");
  await choose(context, host, "Red");
  // A clear needs a session that ended.
  if (each.transition === "close by clear" && each.inspection === "not inspecting")
    await choose(context, host, "A");
  const bridge = await host.bridge;
  const parked = shownView(host);
  if (each.inspection === "not inspecting")
    return { made, storage, bridge, parked, shown: null, adoption: null };
  assert.equal(await backTo(rewind, 1), true);
  if (each.inspection === "inspecting without a future") assert.equal(await rewind.forward(), true);
  await settle(context);
  const shown = shownView(host);
  if (each.inspection !== "adopting")
    return { made, storage, bridge, parked, shown, adoption: null };
  // The adoption's read is held in the host's reply; it then succeeds, or fails as its persistence fails.
  const fails = each.variant.startsWith("failed") || each.case.includes("failure");
  if (fails && storage !== null) storage.failReplaces();
  const held = holdRead(context, bridge, "captureStorage", "reply", fails && storage === null);
  const done = chooseAt(host, 1);
  await held.arrived;
  assert.equal(host.rewind.adopting.value, true);
  return { made, storage, bridge, parked, shown, adoption: { done, release: held.release } };
}

/** Runs `each`'s transition as the Player (or, for a teardown, its host) runs it; resolves to whether the page acted. */
async function runTransfer(
  context: TestContext,
  each: Obligation,
  state: Awaited<ReturnType<typeof transferState>>,
): Promise<boolean> {
  const { made, bridge, adoption } = state;
  const { host, rewind } = made;
  const guard = each.case.endsWith("guard fails") ? each.case.split(" ")[0] : null;
  if (guard === "readiness")
    // A Start being prepared: the session may not be left now.
    host.prepare(
      await sourceStart(host.bridge, script, () => ({ ...host.scriptStorageOptions() })),
    );
  if (guard === "read") made.failGets();
  const settleAdoption = async () => {
    adoption?.release();
    await adoption?.done.catch(() => {});
  };
  switch (each.transition) {
    case "back": {
      // The target guard names a point that does not lead to the state shown: the point shown, or none at all.
      const index = guard !== "target" ? 0 : each.inspection === "inspecting with a future" ? 1 : 9;
      return backTo(rewind, index);
    }
    case "forward":
      return rewind.forward();
    case "return":
      return await rewind.returnToSession();
    case "adopt begun": {
      if (each.inspection === "not inspecting" || each.inspection === "adopting") {
        // No state to adopt, or one being adopted: the input does not adopt.
        if (each.inspection === "adopting") return (await host.prepareInput()) !== false;
        return false;
      }
      if (state.storage === null) holdRead(context, bridge, "captureStorage", "reply", false);
      else state.storage.holdReplaces();
      void chooseAt(host, 1);
      await settle(context);
      return host.rewind.adopting.value;
    }
    case "adopt ended":
      if (adoption === null) return false;
      await settleAdoption();
      return true;
    case "close by debugOff":
      made.debug.stop();
      await settleAdoption();
      return true;
    case "close by replacement":
      await start(context, host);
      await settleAdoption();
      return true;
    case "close by import": {
      const review = await host.reviewSavedDataImport({
        scripts: [{ scope: "test", name: null, photos: [], entries: [] }],
        images: [],
      });
      await host.importSavedData(review, new Set(["test"]));
      await settleAdoption();
      if (each.variant === "with a replacement") await start(context, host);
      return true;
    }
    case "close by clear":
      return host.clearScriptStorage();
    case "close by disposal":
      // The Player unmounts, its Debug features with it (as `usePlayerDebug` ends them), on a connection that lives.
      rewind.endWithPlayer();
      made.debug.stop();
      made.scope.stop();
      await settleAdoption();
      return true;
  }
  throw new Error(`No such transition: ${each.transition}`);
}

/** The host op `each`'s transition sends, as a refusal must also be the host's. */
function rawTransfer(each: Obligation, history: number, live: PlayerSession) {
  switch (each.transition) {
    case "back":
      return { op: "rewindBack", args: { history, point: 1, live: live.id, events: [] } };
    case "forward":
      return { op: "rewindForward", args: { history, events: [] } };
    case "return":
      return { op: "rewindReturn", args: { history } };
    case "adopt begun":
      return { op: "rewindAdopt", args: { history, phase: "begin" } };
    case "adopt ended":
      return {
        op: "rewindAdopt",
        args: { history, phase: "end", succeeded: each.variant.startsWith("succeeded") },
      };
    case "close by clear":
      return { op: "historyClose", args: { history, by: "clear" } };
  }
  return null;
}

for (const each of TRANSFERS)
  test(`a rewind lineage transfer: ${each.key}`, async (context) => {
    const state = await transferState(context, each);
    const { made, bridge, parked, shown } = state;
    const { host, rewind } = made;
    const history = rewind.state.value.history!;
    const before = { lineage: shownView(host).lineage, inspection: rewind.state.value.inspection };
    const acted = await runTransfer(context, each, state);
    await settle(context);
    const alive = {
      parked: await heldInHost(bridge, parked.id),
      shown: shown === null ? false : await heldInHost(bridge, shown.id),
    };
    const expect = each.expect;
    if (expect.kind !== "transfer") {
      assert.deepEqual(alive, { parked: true, shown: shown !== null }, "no lineage released");
      if (expect.kind === "unchanged" && each.transition.startsWith("close")) {
        // The history closes with no lineage parked: nothing to transfer.
        assert.equal(rewind.state.value.inspection, null);
      } else {
        assert.equal(acted, false, "the page changes nothing");
        assert.equal(shownView(host).lineage, before.lineage, "the same state shows");
        assert.deepEqual(rewind.state.value.inspection, before.inspection, "the same inspection");
      }
      const raw = expect.kind === "refused" ? rawTransfer(each, history, parked) : null;
      if (raw !== null) {
        // The raw op as the test picks it, sent past the page.
        // A close carries the Player's claim generation, which `historyClose` stamps.
        const closing =
          raw.op === "historyClose" ? bridge.historyClose({ history, by: "clear" }) : null;
        if (closing !== null) assert.ok(closing.posted);
        const reply =
          closing?.posted === true
            ? await closing.reply
            : await untypedClient(bridge.client).request(raw.op, raw.args);
        // EVIDENCE: validation: the history ops reply from the same build with a `HistoryOpResult`.
        assert.equal(
          (reply.result as { readonly kind: string }).kind,
          "refused",
          "the host refuses",
        );
      }
    } else {
      const page = host.session.value === null ? null : shownView(host);
      const inspection = rewind.state.value.inspection;
      const parkedFate = !alive.parked
        ? "released"
        : page?.lineage === parked.lineage && !host.rewind.inspecting.value
          ? "live"
          : before.inspection === null
            ? "parked"
            : "kept";
      const showsNew =
        page !== null && page.lineage !== parked.lineage && page.lineage !== shown?.lineage;
      const shownFate =
        showsNew && host.rewind.inspecting.value
          ? each.transition === "forward"
            ? "future"
            : "target"
          : shown === null || !alive.shown
            ? "released"
            : host.rewind.adopting.value
              ? "adopting"
              : page?.lineage === shown.lineage && host.rewind.inspecting.value
                ? "inspecting"
                : "live";
      assert.deepEqual(
        { parked: parkedFate, shown: shownFate },
        { parked: expect.parked, shown: expect.shown },
      );
      // What a step shows is the state it names: Back's target point, or the state Forward restores.
      if (shownFate === "target")
        assert.equal(inspection?.shown.id, rewind.state.value.points[0]!.id);
      if (shownFate === "future")
        assert.equal(inspection?.shown.eventCount, before.inspection?.future?.eventCount);
    }
    transfersRun.add(each.key);
  });

test("the transfer family ran every obligation of the declared domain, and nothing else", () => {
  assert.equal(TRANSFERS.length, 72);
  assert.deepEqual(transferCoverage(TRANSFERS, transfersRun), { missing: [], unexpected: [] });
});
