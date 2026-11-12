/*
 * Continuation ownership: an operation's handles, and every keep, import and restore route recorded against its
 * operation, with the family's controls.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  StaleOperation,
  persistenceOwnership,
} from "../../player/persistence/persistence-ownership.js";
import {
  KEEP_WRITES,
  SAVED_DATA_SCRIPTS,
  type ImportedScript,
  OWNERSHIP_MODES,
  RECORDED_STORES,
  SURFACES,
  UNOPERATED,
  MOVE_WRITES,
  OPERATED,
  OTHER_SCRIPT_WRITES,
  MOVES,
  POSTED,
  PRODUCERS,
  ROUTES,
  UNDRIVEN_ROUTES,
  UNHELD_AWAITS,
  VARIANTS,
  stale,
  type Move,
  type Variant,
  type VariantName,
} from "../helpers/player/plan-json-family.js";
import {
  CapturedMediaStore,
  isWellFormedCapturedMediaReference,
} from "../../player/media/captured-media.js";
import { FakeMediaRepository } from "../helpers/player/fake-media-repository.js";
import {
  stubBrowser,
  SCOPE,
  browser,
  planWrites,
  faults,
  writesOn,
  held,
  mount,
  tasks,
  until,
  ASKS,
  ASKS_OTHER,
} from "../helpers/player/keep-host.js";
import {
  OPERATION,
  MOVE,
  contexts,
  type RecordedCall,
  unowned,
  unledgered,
  methodClass,
  recorder,
  familyBrowser,
  type FamilyBrowser,
  pageLog,
} from "../helpers/player/keep-ownership-recorder.js";
import {
  PNG,
  PHOTO_PLAN,
  SAVED_PHOTO_PLAN,
  TWO_PHOTOS_PLAN,
  TWO_SESSION_PHOTOS_PLAN,
  OTHER_SCOPE,
  VARIANT_DRIVERS,
  CURRENT_FAILURES,
  moveOn,
  holdable,
  reachedWithin,
} from "../helpers/player/keep-ownership-routes.js";

/*
 * Continuation ownership (`player/persistence/persistence-ownership.ts`), closed at admission: an operation reaches its stores and
 * the host only through its ownership's handles, which admit no call once it is stale. The family is generated from the
 * descriptor's variants (`VARIANTS`): each operation on each route it can take, with the fixtures that reach its calls
 * (photos only the session uses, saved photos into a browser that has none, two of them, one another tab stored first,
 * a failed replacement over an older photo, each of the kept store's failures, the debug room). Unheld, each run makes
 * exactly its trace. Held at each call of it while the page moves on (`MOVES`), the calls up to the held one were
 * admitted before the move and must complete; no later one is admitted. One recorder takes every call of the kept
 * store, its photos, the saved values' provider, the media store, the debug rooms and the host: its admission, with the
 * store it went to and the async context that made it, and its settlement apart. It fails a call no context owns, and a
 * write in the move's context the move does not make itself (`MOVE_WRITES`). Every row also asserts that a stale
 * operation changes nothing of the page (activation, the loaded saved values and the stored files they name, the
 * notices, the importing mark, the room and the debug room's marks) but releasing its own importing mark; that the saved
 * data's revision, which is no state of the page, moves once where its change landed on the route shown, and not
 * otherwise (`persistence-ownership.ts`); that its failure is neither shown nor thrown, and that no rejection goes unhandled; a current one
 * goes on, and a current failure surfaces. Each read of the saved values gives values of its own, so a stale read's
 * values are seen if shown.
 */
test("an operation's handles admit each call while it is current, and none once it was stale", async () => {
  let current = true;
  const ownership = persistenceOwnership(() => current);
  assert.equal(
    ownership.commit(() => 1),
    1,
  );
  // An apply that awaits would go on after the commit's check: the type refuses one, and so does the run.
  const later = Promise.resolve();
  // @ts-expect-error -- `commit` takes no thenable apply.
  assert.throws(() => ownership.commit(() => later), TypeError);
  // @ts-expect-error -- nor an async one.
  assert.throws(() => ownership.commit(async () => {}), TypeError);
  // @ts-expect-error -- nor one that may return a thenable.
  assert.throws(() => ownership.commit(() => (later !== null ? later : 1)), TypeError);
  const reached: string[] = [];
  let finish = () => {};
  const values = ownership.values({
    scope: "s",
    load: async () => [],
    write: async () => {},
    replace: () => {
      reached.push("replace");
      return new Promise<void>((resolve) => (finish = resolve));
    },
    clear: async () => {
      reached.push("clear");
    },
  });
  // Admitted while current, a call completes after the operation went stale.
  const replacing = values.replace([]);
  current = false;
  finish();
  await replacing;
  assert.throws(() => values.clear(), StaleOperation);
  let applied = false;
  assert.throws(() => ownership.commit(() => (applied = true)), StaleOperation);
  assert.equal(applied, false);
  assert.deepEqual(reached, ["replace"]);
  // Once stale, for good.
  current = true;
  assert.equal(ownership.current(), false);
});

test("a promotion admitted before its operation went stale stores the photo, but marks nothing durable after", async () => {
  let current = true;
  const ownership = persistenceOwnership(() => current);
  let finish = () => {};
  const repository = new FakeMediaRepository();
  const add = repository.add.bind(repository);
  repository.add = async (record) => {
    await new Promise<void>((resolve) => (finish = resolve));
    return add(record);
  };
  const media = new CapturedMediaStore(repository, { create: () => "url", revoke: () => {} }, "s");
  const { reference } = media.add("image", new Blob([PNG], { type: "image/png" }));
  const promoting = media.promote([reference], ownership);
  current = false;
  finish();
  await assert.rejects(promoting, StaleOperation);
  // The admitted insert stored the photo; the stale operation did not mark it as stored, so a keep still takes it.
  assert.equal(repository.size, 1);
  assert.equal(media.sessionRecords([reference]).length, 1);
});

/**
 * One run of `name`: unheld when `at` is null, else held at the trace's call `at` while its page moves as `move` says
 * (or does not, without one).
 */
async function ownershipRun(
  context: TestContext,
  name: VariantName,
  at: { readonly index: number; readonly name: string; readonly skip: number } | null,
  move: Move | null,
  // A control's own work once the run settled, before its checks: they must catch it.
  intrude?: (at: FamilyBrowser) => Promise<void>,
) {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  context.after(() => process.off("unhandledRejection", onUnhandled));
  const shown = stubBrowser(context);
  planWrites(
    context,
    PHOTO_PLAN,
    SAVED_PHOTO_PLAN,
    TWO_PHOTOS_PLAN,
    TWO_SESSION_PHOTOS_PLAN,
    ASKS_OTHER,
  );
  context.after(() => {
    faults.nextSnapshot = false;
    faults.planWrite = null;
  });
  const variant: Variant = VARIANTS[name];
  const browserAt = familyBrowser(variant.route === "plain" ? "plain" : "captured");
  const recorded = recorder(context, browserAt);
  const operation = await VARIANT_DRIVERS[name](context, browserAt, {
    watchHost: recorded.watchHost,
    hide: shown.hide,
    failHost: recorded.failHost,
  });
  const log = pageLog(operation.host);
  context.after(log.stop);
  const bridge = await operation.host.bridge;
  const callsAtStart = recorded.calls.length;
  const reached = at === null ? null : recorded.hold(at.name, at.skip);
  const done = contexts
    .run(OPERATION, () => operation.start())
    .then(
      () => ({ rejected: false as const }),
      (error: unknown) => ({ rejected: true as const, error }),
    );
  if (reached !== null) await reachedWithin(reached, at!.name, recorded.calls);
  const producer = variant.producer;
  const retires = move !== null && stale(producer, move, variant.route, variant.ownership) === true;
  // The page goes on with what the move prepared, where it can: its Start runs. An import under way holds Start back
  // until a room change takes the page over; a room change waits for the saved values' calls issued before it, so an
  // import held at one of them holds the room change too.
  // An import holds Start back while it runs, the session's and the saved data's alike.
  const anImport = producer === "planText" || producer === "savedDataImport";
  const moveWaits =
    anImport &&
    move === "room" &&
    (at!.name.startsWith("provider.") || at!.name.startsWith("repository."));
  const startsAnew =
    move !== null &&
    move !== "disposed" &&
    (producer === "restoreKept" || (anImport && move === "room" && !moveWaits));
  if (move !== null)
    await contexts.run(MOVE, async () => {
      await moveOn(operation, move);
      if (startsAnew) {
        await operation.host.activate();
        await until(
          () => operation.host.session.value !== null && operation.host.activation.value === null,
          "the moved-on page did not start",
        );
      }
      for (let turn = 0; turn < 4; turn++) await tasks();
    });
  const callsAtMark = recorded.calls.length;
  const changesAtMark = log.changes.length;
  const publishedAtMark = browserAt.published.length;
  const before = log.snapshot();
  recorded.release();
  const outcome = await done;
  for (let turn = 0; turn < 6; turn++) await tasks();
  await intrude?.(browserAt);
  const after = log.snapshot();
  const since = recorded.calls.slice(callsAtStart);
  // Every call from the operation's start is the operation's, the move's, or the page's lifecycle, which reaches no store.
  assert.deepEqual(unowned(since), [], "a call no context owns");
  const own = (calls: readonly RecordedCall[]) =>
    calls.filter((made) => made.by === OPERATION).map((made) => made.name);
  assert.deepEqual(unhandled, [], "a rejection went unhandled");
  const result = { outcome, at: browserAt, log, publishedAtMark, changesAtMark };
  if (at === null) {
    // Unheld, the operation makes exactly the calls of its trace.
    assert.deepEqual(own(since), variant.trace, `${name}: the trace`);
    return result;
  }
  // Up to the held call, each call of the trace was admitted before the move.
  assert.deepEqual(
    own(recorded.calls.slice(callsAtStart, callsAtMark)),
    variant.trace.slice(0, at.index + 1),
    "the calls admitted before the move",
  );
  // The held call, admitted before the move, completes as its store makes it.
  const heldCall = recorded.calls
    .slice(callsAtStart, callsAtMark)
    .filter((made) => made.by === OPERATION)[at.index]!;
  assert.notEqual(heldCall.settled, null, `the admitted ${at.name} did not complete`);
  // The move writes only what it makes itself: nothing, or its started session's keep, or the debug room it opens.
  if (move !== null) {
    const allowed = new Set<string>(
      (startsAnew ? MOVE_WRITES[move].starting : MOVE_WRITES[move].still).flatMap(
        (name: string): readonly string[] =>
          name === "kept" || name === "rooms" ? KEEP_WRITES[name] : [name],
      ),
    );
    assert.deepEqual(
      recorded.calls
        .slice(callsAtStart)
        .filter((made) => made.by === MOVE && made.write && !allowed.has(made.name))
        .map((made) => made.name),
      [],
      "the move wrote what it does not make itself",
    );
    // And each of its kept-store writes is one of the keeps of the session it started, by the host's own captures.
    assert.deepEqual(unledgered(since), [], "the move's kept-store writes are not its keeps");
  }
  // Another script's writes are no call of this page's operation: they finish after the move (`OTHER_SCRIPT_WRITES`).
  const ofThisPage = (made: RecordedCall) =>
    made.scope === undefined || !Object.hasOwn(OTHER_SCRIPT_WRITES, made.scope);
  const late = own(recorded.calls.slice(callsAtMark).filter(ofThisPage));
  if (!retires) {
    // Current, the operation goes on with the rest of its trace.
    assert.deepEqual(late, variant.trace.slice(at.index + 1), "the current operation's calls");
    return result;
  }
  // Stale: no call is admitted after the move. The held call completes; a restored session is released.
  assert.deepEqual(
    late.filter((made) => made !== "host.release"),
    [],
    `the stale ${producer} made calls after the move`,
  );
  // No page effect after the move but releasing its own importing mark, which shows what the mark held back, and the
  // saved data's revision, which is no state of the page: it follows the store of the route shown
  // (`persistence-ownership.ts`). The held call's completion moves it once where it changed that store, resolved, on the
  // route the page still shows: after a re-prepare the same route; after a room change only on the captured route, whose
  // switch waits for the call, so the route it leaves is still the one shown, while the plain route's switch does not
  // wait and the call lands after it. The debug room's import of the script's own values bypasses the route shown. Nothing
  // else of the stale operation moves it.
  const landsOnShownRoute =
    /^provider\.(write|replace|clear)$/.test(at.name) &&
    heldCall.settled === "resolved" &&
    variant.route !== "debug" &&
    move !== "disposed" &&
    (move !== "room" || (moveWaits && variant.route === "captured"));
  let revisionMoves = 0;
  for (const change of log.changes.slice(changesAtMark).filter((made) => made.by === OPERATION)) {
    const {
      importing: markFrom,
      activation: activationFrom,
      savedDataRevision: revisionFrom,
      ...restFrom
    } = change.from;
    const {
      importing: markTo,
      activation: activationTo,
      savedDataRevision: revisionTo,
      ...restTo
    } = change.to;
    const moved = revisionTo - revisionFrom;
    revisionMoves += moved;
    // Each change releases the importing mark or moves the revision once, the activation as it was; nothing else.
    assert.ok(
      (moved === 0 || moved === 1) &&
        ((markFrom && !markTo) ||
          (markFrom === markTo && moved === 1 && activationFrom === activationTo)) &&
        JSON.stringify(restFrom) === JSON.stringify(restTo),
      `the stale ${producer} changed the page: ${JSON.stringify(change)}`,
    );
  }
  assert.equal(
    revisionMoves,
    landsOnShownRoute ? 1 : 0,
    `the stale ${producer}'s moves of the saved data's revision`,
  );
  // The page stays as the move left it, where the move did not wait for the operation.
  if (!moveWaits)
    assert.deepEqual(
      after,
      {
        ...before,
        importing: false,
        activation: before.importing ? after.activation : before.activation,
        savedDataRevision: before.savedDataRevision + revisionMoves,
      },
      `the page after the stale ${producer}`,
    );
  // Where the room change waited for the operation, the page ends in the debug room as the change leaves it, once both
  // settled: its saved values, and its Start or Continue.
  if (moveWaits) {
    assert.equal(after.room, "debug");
    assert.equal(after.importing, false);
    assert.deepEqual(
      after.savedValues,
      await browserAt.rooms.values(SCOPE).load(),
      "the page shows the debug room's saved values",
    );
    assert.equal(after.activation, after.debugSession ? "continue" : "start");
  }
  // Its failure is neither shown nor thrown.
  assert.equal(outcome.rejected, false, `the stale ${producer} rejected`);
  const introduced = recorded.introduced();
  if (introduced !== null && move !== "disposed")
    assert.equal(bridge.store(introduced), null, "the stale restore's session was released");
  return result;
}

/** The saved-data import `name`'s declared scripts, or `null` for another variant. */
const savedDataScripts = (name: VariantName) =>
  Object.entries(SAVED_DATA_SCRIPTS).find(([variant]) => variant === name)?.[1] ?? null;

/**
 * The saved data of a script as `bundleOf` imports it, complete: its score, and its photo under the reference the import
 * stored it with, which must name a record in that script's media store (`media`, under its namespace) holding
 * `bundleOf`'s bytes; or none at all for a script the import did not write, as the page and the other script start with
 * none (#1963 L5).
 */
async function assertImported(
  entries: readonly { readonly key: string; readonly value: unknown }[],
  written: boolean,
  media: { readonly repository: FakeMediaRepository; readonly namespace: string },
  what: string,
) {
  // The fixture's provider adds its own read counter to each load (`familyBrowser`): no saved value of the script.
  const values = entries.filter((entry) => entry.key !== "read");
  if (!written) return assert.deepEqual(values, [], what);
  const sorted = [...values].sort((one, other) => (one.key < other.key ? -1 : 1));
  const photo = sorted[0]?.value;
  assert.ok(
    typeof photo === "string" && isWellFormedCapturedMediaReference(photo),
    `${what}: its photo's reference`,
  );
  const record = await media.repository.get(media.namespace, photo);
  assert.ok(record !== null, `${what}: its photo is stored under ${photo}`);
  assert.ok(record.data instanceof Blob, `${what}: its photo's bytes`);
  assert.deepEqual(
    new Uint8Array(await record.data.arrayBuffer()),
    PNG,
    `${what}: the stored photo is the imported one`,
  );
  assert.deepEqual(
    sorted,
    [
      { key: "photo", value: photo },
      { key: "score", value: 3 },
    ],
    what,
  );
}

/**
 * Whether the scripts a saved-data import wrote are those `SAVED_DATA_SCRIPTS` declares, each complete: another script's,
 * written also after the page moved on, and, when the import ran to its end (`ranToEnd`), the shown one's.
 */
async function assertWrites(name: VariantName, at: FamilyBrowser, ranToEnd: boolean) {
  const scripts = savedDataScripts(name);
  if (scripts === null) return;
  const writes: readonly ImportedScript[] = scripts.writes;
  await assertImported(
    await at.otherValues(OTHER_SCOPE),
    writes.includes("other"),
    { repository: at.otherRepository, namespace: OTHER_SCOPE },
    "the other script's saved data",
  );
  if (!ranToEnd) return;
  await assertImported(
    await at.rawProvider.load(),
    writes.includes("shown"),
    { repository: at.rawRepository, namespace: SCOPE },
    "the shown script's saved data",
  );
}

// EVIDENCE: invariant: the keys of `VARIANTS`, declared literally in the descriptor.
for (const name of Object.keys(VARIANTS) as VariantName[]) {
  const variant: Variant = VARIANTS[name];
  test(`continuation ownership: ${name}, unheld`, async (context) => {
    const { outcome, log, at } = await ownershipRun(context, name, null, null);
    await assertWrites(name, at, true);
    const failure = CURRENT_FAILURES[name];
    if (failure === undefined) {
      assert.equal(outcome.rejected, false, `${name} rejected`);
      return;
    }
    // A current failure surfaces, and the page offers what is left.
    assert.equal(outcome.rejected, true, `${name} did not reject`);
    assert.match(String(outcome.rejected && outcome.error), failure.message);
    assert.equal(log.snapshot().activation, failure.offers);
  });
  for (const point of holdable(variant.trace))
    for (const move of MOVES) {
      const retires = stale(variant.producer, move, variant.route, variant.ownership);
      if (retires === "unreachable") continue;
      test(`continuation ownership: ${name} at ${point.name}#${point.skip + 1}, ${move}`, async (context) => {
        const row = await ownershipRun(context, name, point, move);
        // Another script's saved data, which the player confirmed, are written also after this page moved on, while the
        // page shows nothing of the import (`ownershipRun`'s checks); a current import writes the shown one's too.
        await assertWrites(name, row.at, retires !== true);
        if (retires || variant.producer === "savedDataImport") return;
        // A keep the move left current goes on: it saves, or after a state it cannot write, says so.
        if (name === "captureKeep captured forget")
          assert.ok(
            row.log.changes
              .slice(row.changesAtMark)
              .some((change) => change.to.notices.includes("session-not-kept")),
            "the current keep did not say that the session is not kept",
          );
        else if (variant.route === "debug")
          assert.ok((await row.at.rooms.session(SCOPE)) !== null, "the current keep did not save");
        else
          assert.ok(row.at.published.length > row.publishedAtMark, "the current keep did not save");
      });
    }
}

// The checks' own controls, on one row (a stale restore, its page moved to another plan, whose Start runs and keeps
// itself). Once the run settled, each control writes the moved-on page's kept session in a context, with nothing else:
// its setup reads the store as it is, past the recorder. Each must fail the row for its own reason; the same control
// without its write passes.
const CONTROL_POINT = { index: 3, name: "kept.media.get", skip: 0 };
const control = (context: TestContext, write?: (at: FamilyBrowser) => Promise<void>) =>
  ownershipRun(
    context,
    "restoreKept captured sessionPhoto",
    CONTROL_POINT,
    "otherPlan",
    async (at) => {
      assert.ok((await at.rawKept.session(SCOPE)) !== null, "the moved-on session is kept");
      await write?.(at);
    },
  );
const failsFor = (pattern: RegExp) => (error: unknown) =>
  error instanceof assert.AssertionError && pattern.test(error.message);
test("continuation ownership's checks: a control without its write passes", async (context) => {
  await control(context);
});
for (const [label, reason] of [
  [MOVE, /the move's kept-store writes are not its keeps/],
  ["foreign", /a call no context owns/],
  [OPERATION, /made calls after the move/],
  [undefined, /a call no context owns/],
] as const)
  test(`continuation ownership's checks catch a stray discard in context ${label ?? "none"}`, async (context) => {
    await assert.rejects(
      control(context, (at) =>
        label === undefined
          ? at.kept.discard(SCOPE)
          : contexts.run(label, () => at.kept.discard(SCOPE)),
      ),
      failsFor(reason),
    );
  });
/** The page's first kept state, an earlier one than the moved-on session's, published in the move's context. */
async function republish(at: FamilyBrowser, scope: string, from: "later" | "first") {
  const earlier = at.published[0]!;
  const count = (await at.rawKept.session(SCOPE))?.events.length ?? 0;
  await contexts.run(MOVE, async () => {
    if (from === "first") await at.kept.discard(scope);
    await at.kept.publish(
      scope,
      from === "first"
        ? earlier
        : { ...earlier, planJson: null, eventsFrom: count, events: [], eventsJson: [] },
    );
  });
}
for (const [what, scope, from] of [
  ["a later save of an earlier state", SCOPE, "later"],
  ["a whole keep of an earlier state", SCOPE, "first"],
  ["a whole keep in another scope", "development-package:other", "first"],
] as const)
  test(`continuation ownership's checks catch ${what} in the move's context`, async (context) => {
    await assert.rejects(
      control(context, (at) => republish(at, scope, from)),
      failsFor(/the move's kept-store writes are not its keeps/),
    );
  });
test("continuation ownership's checks: a call of an unknown context is no one's", () => {
  const made: RecordedCall = {
    name: "kept.discard",
    destination: "kept",
    by: "foreign",
    write: true,
    settled: "resolved",
  };
  assert.deepEqual(unowned([made]), ["foreign:kept.discard"]);
});

// An import queued behind saved-values work issued before it, and retired while it waits: when the queue reaches it,
// none of its calls is admitted.
for (const move of MOVES)
  test(`continuation ownership: planText captured savedPhoto queued, ${move}`, async (context) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    context.after(() => process.off("unhandledRejection", onUnhandled));
    const shown = stubBrowser(context);
    planWrites(context, SAVED_PHOTO_PLAN, ASKS_OTHER);
    const at = familyBrowser();
    const recorded = recorder(context, at);
    const operation = await VARIANT_DRIVERS["planText captured savedPhoto"](context, at, {
      watchHost: recorded.watchHost,
      hide: shown.hide,
      failHost: recorded.failHost,
    });
    // The page's own read of the saved values, issued first, holds the queue.
    const reached = recorded.hold("provider.load", 0, null);
    const reading = operation.host.readSavedData().catch(() => []);
    await reachedWithin(reached, "the page's own read", recorded.calls);
    const done = contexts.run(OPERATION, () => operation.start()).catch((error: unknown) => error);
    for (let turn = 0; turn < 4; turn++) await tasks();
    const queued = ["provider.replace", "repository.add", "repository.get"];
    const ownQueued = (from: number) =>
      recorded.calls
        .slice(from)
        .filter((made) => made.by === OPERATION && queued.includes(made.name))
        .map((made) => made.name);
    // It waits behind the read: one issue order for the page and its operations.
    assert.deepEqual(ownQueued(0), [], "the import did not wait for the work issued before it");
    const mark = recorded.calls.length;
    await contexts.run(MOVE, () => moveOn(operation, move));
    recorded.release();
    await reading;
    assert.equal(await done, undefined, "the stale import rejected");
    for (let turn = 0; turn < 6; turn++) await tasks();
    assert.deepEqual(ownQueued(mark), [], "the queued import's calls were admitted after the move");
    assert.deepEqual(unhandled, []);
  });

/** A reservation whose task has not run, while its page moves on. */
for (const move of MOVES)
  test(`continuation ownership: preparePlanText at task, ${move}`, async (context) => {
    stubBrowser(context);
    const at = browser();
    planWrites(context, ASKS, ASKS_OTHER);
    const { host, scope } = await mount(context, at);
    const token = await held(host, ASKS);
    const preparing = host.prepareScript(token, {
      plan: token,
      options: () => ({ ...host.scriptStorageOptions(), ...host.temporalCapture() }),
    });
    // The page reserves once its host is ready; the move comes before the reservation's task.
    await host.bridge;
    await held(host, ASKS);
    await moveOn({ host, scope, plan: ASKS, start: async () => {} }, move);
    await preparing;
    for (let turn = 0; turn < 4; turn++) await tasks();
    // Let go of where the move retired the plan, kept where it did not.
    const bridge = await host.bridge;
    const before = await writesOn(host, ASKS);
    await bridge.client.request("planText", { plan: token });
    assert.equal((await writesOn(host, ASKS)) - before, stale("preparePlanText", move) ? 1 : 0);
  });

test("continuation ownership covers its descriptor: each route driven or named, each variant held at each call", (context) => {
  for (const unheld of Object.keys(UNHELD_AWAITS))
    assert.ok(!Object.hasOwn(POSTED, unheld), `${unheld} is both posted and named unheld`);
  assert.deepEqual(Object.keys(VARIANT_DRIVERS).sort(), Object.keys(VARIANTS).sort());
  const variants: Variant[] = Object.values(VARIANTS);
  const named = new Set<string>();
  for (const producer of OPERATED)
    for (const ownership of OWNERSHIP_MODES[producer])
      for (const route of ROUTES) {
        const path = `${producer} ${route} ${ownership}`;
        named.add(path);
        const driven = variants.some(
          (v) => v.producer === producer && v.route === route && v.ownership === ownership,
        );
        assert.equal(driven, !Object.hasOwn(UNDRIVEN_ROUTES, path), path);
      }
  for (const variant of variants)
    assert.ok(
      OWNERSHIP_MODES[variant.producer].some((mode) => mode === variant.ownership),
      `${variant.producer} takes no ${variant.ownership} ownership`,
    );
  for (const path of Object.keys(UNDRIVEN_ROUTES)) assert.ok(named.has(path), `${path} is a path`);
  // Every producer's caller is an operation, or named as none.
  for (const producer of Object.keys(PRODUCERS))
    assert.equal(
      OPERATED.some((operated) => operated === producer),
      !Object.hasOwn(UNOPERATED, producer),
      producer,
    );
  // Every surface is a store the recorder installs or one a store method gives, and each such store is a surface.
  const within = Object.entries(SURFACES).flatMap(([surface, methods]) =>
    Object.entries(methods)
      .filter(([, kind]) => kind === "store")
      .map(([method]) => `${surface}.${method}`),
  );
  assert.deepEqual(Object.keys(SURFACES).sort(), [...RECORDED_STORES, ...within].sort());
  // Each saved-data import declares its scripts, and writes only scripts it imports.
  // EVIDENCE: invariant: the keys of `VARIANTS`, declared literally in the descriptor.
  for (const name of Object.keys(VARIANTS) as VariantName[])
    assert.equal(
      savedDataScripts(name) !== null,
      VARIANTS[name].producer === "savedDataImport",
      name,
    );
  for (const [name, { imports, writes }] of Object.entries(SAVED_DATA_SCRIPTS))
    for (const script of writes)
      assert.ok(
        imports.some((imported) => imported === script),
        `${name} writes ${script}`,
      );
  // No surface classifies a method it does not name: an unknown name, or one every object inherits.
  for (const surface of Object.keys(SURFACES))
    for (const key of [
      "unknownMethod",
      "toString",
      "constructor",
      "hasOwnProperty",
      "valueOf",
      "__proto__",
    ])
      assert.equal(methodClass(surface, key), undefined, `${surface}.${key}`);
  let held = 0;
  for (const variant of variants) {
    assert.ok(holdable(variant.trace).length > 0, `a variant of ${variant.producer} holds nothing`);
    held += holdable(variant.trace).length;
  }
  context.diagnostic(`${variants.length} variants, ${held} held calls`);
});
