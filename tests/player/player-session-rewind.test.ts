import assert from "node:assert/strict";
import test, { before } from "node:test";
import { effectScope } from "vue";
import {
  restorePlayerRuntimeSessionAt,
  type PlayerRuntimeSession,
} from "../../player/runtime/runtime-adapter.js";
import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import { playerRuntimeForeground } from "../../player/runtime/runtime-view.js";
import { memoryKeptRoomStore } from "../../player/persistence/kept-sessions.js";
import { coverageGaps, product, type Coordinates } from "../helpers/family-coverage.js";
import {
  hostTrace,
  onHost,
  hostIntroduced,
  loadHostFacade,
} from "../helpers/player/host-sessions.js";
import { interceptSends } from "../helpers/bridge/sends.js";
import {
  selectPlayerRuntimeChoice,
  playerRuntimeSnapshot,
  RewindHost,
  reportsInto,
  backTo,
  BridgeLostError,
  usePlayerDebug,
  memoryStorage,
  createHost,
  settle,
  script,
  start,
  choose,
  shownView,
  EXIT_AXES,
  ExitCase,
  holdRead,
  heldInHost,
  untilShown,
} from "../helpers/player/rewind-host.js";
import { sourceStart } from "../helpers/prepared-plan.js";

/** Ends the capture `reportsInto` began, at the check of what it captured, so that a later host error prints again. */
function endCapture() {
  // `reportsInto` replaced `console.error` by a mock of the test's context, which carries its `mock`.
  const error: unknown = console.error;
  const capture = typeof error === "function" && "mock" in error ? error.mock : undefined;
  assert.ok(
    typeof capture === "object" &&
      capture !== null &&
      "restore" in capture &&
      typeof capture.restore === "function",
    "the capture reportsInto began",
  );
  capture.restore();
}

// `hostIntroduced` registers adapter sessions through the facade of the bundle the composable runs in.
before(loadHostFacade);

/** The value trace the host's session runs with, as the host holds it. */
const traceOf = (session: PlayerRuntimeSession | null | undefined) =>
  session === null || session === undefined
    ? null
    : onHost((held: PlayerRuntimeSession) => held.debugTrace)(session);

const SCOPES_USED_UP = /nextScopeId is at its largest value, so it cannot advance/u;

function said(host: RewindHost): string[] {
  return (host.session.value?.transcriptEntries ?? []).map((entry) => entry.text);
}

test("Back shows an earlier state paused, and Forward and Return restore the state it left", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  const tip = host.session.value!;
  assert.deepEqual(storage.saved(), { k: 1, pick: "One" });
  assert.deepEqual(
    rewind.state.value.points.map((point) => point.response?.text ?? null),
    ["One", null],
  );

  assert.equal(await backTo(rewind, 0), true);
  assert.equal(host.rewind.inspecting.value, true);
  assert.deepEqual(said(host), []);
  assert.equal(playerRuntimeForeground(host.session.value!)?.kind, "choose");
  // Nothing runs on its own while inspecting: no time is observed, and saved data stay as they were.
  const inspected = host.session.value;
  assert.equal(await host.observe(), inspected);
  assert.deepEqual(storage.saved(), { k: 1, pick: "One" });
  // The restored state is a diagnostic fork, and its recording begins at it.
  assert.deepEqual(
    (await host.debugExportCandidate(() => ({}), new AbortController().signal))
      .rewoundWhileDebugging,
    { restoredSceneTimeMs: inspected!.state.observedSessionTimeMs, rewindCount: 1 },
  );
  assert.deepEqual(
    (await host.debugRecording())?.anchorSnapshot,
    playerRuntimeSnapshot(inspected!),
  );

  assert.equal(await rewind.forward(), true);
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!), playerRuntimeSnapshot(tip));
  assert.deepEqual(said(host), ["One", "first One"]);
  assert.equal(host.rewind.inspecting.value, true);

  assert.equal(await backTo(rewind, 0), true);
  assert.equal(await rewind.returnToSession(), true);
  assert.equal(host.session.value, tip);
  assert.equal(host.rewind.inspecting.value, false);
  assert.equal(
    (await host.debugExportCandidate(() => ({}), new AbortController().signal))
      .rewoundWhileDebugging,
    null,
  );
  assert.deepEqual(storage.calls, ["write k", "write pick"]);
});

test("after an engine call throws, the export, Back, Forward, and Return work from the state the Player showed", async (context) => {
  const { host, rewind } = createHost(context, memoryStorage().provider);
  // With the scope IDs used up, the run after the second answer throws (TSR101) when it enters the block, an error no
  // script reaches otherwise.
  const source = [
    'let first = askChoice "One", "Two"',
    'say "first ${first}", instant',
    'let second = askChoice "Red", "Long"',
    'if second == "Long" {',
    '  say "deep", instant',
    "}",
    'say "second ${second}", instant',
    "exit",
  ].join("\n");
  await host.loadScriptStorage();
  const started = createPlayerRuntimeSession(source, host.scriptStorageOptions());
  const usedUp = JSON.stringify({
    ...playerRuntimeSnapshot(started),
    nextScopeId: Number.MAX_SAFE_INTEGER,
  });
  // The used-up state, restored outside the host and registered there, goes on as a Continue, which begins the recording.
  host.prepareRestore(
    hostIntroduced(
      await host.bridge,
      restorePlayerRuntimeSessionAt(started.plan, usedUp, started.events),
    ),
  );
  host.activate();
  await settle(context);
  await choose(context, host, "One");
  const tip = host.session.value!;
  const shown = playerRuntimeSnapshot(tip);
  await assert.rejects(choose(context, host, "Long"), SCOPES_USED_UP);
  assert.equal(host.session.value, tip);

  const candidate = await host.debugExportCandidate(() => ({}), new AbortController().signal);
  assert.deepEqual(candidate.session?.snapshot, shown);
  assert.deepEqual(
    candidate.recording?.operations.map((operation) => [operation.kind, operation.thrown]),
    [
      // A Continue's recording begins with its capture and the run that resumes the restored state.
      ["recordContinueCapture", null],
      ["run", null],
      ["completeAction", null],
      ["run", null],
      ["completeAction", null],
      ["run", "RuntimeDataError"],
    ],
  );
  assert.equal(candidate.recording?.complete, true);

  // After another error, Back keeps the state it left, the one the Player showed, for Forward.
  await assert.rejects(choose(context, host, "Long"), SCOPES_USED_UP);
  assert.equal(await backTo(rewind, 0), true);
  assert.equal(playerRuntimeForeground(host.session.value!)?.kind, "choose");
  assert.equal(await rewind.forward(), true);
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!), shown);
  assert.equal(await backTo(rewind, 0), true);
  assert.equal(await rewind.returnToSession(), true);
  assert.equal(host.session.value, tip);
  await choose(context, host, "Red");
  assert.equal(host.session.value!.state.status, "halted");
  assert.deepEqual(said(host).slice(-2), ["Red", "second Red"]);
});

test("a different choice adopts the restored state: its saved data, then the new writes, and no way back", async (context) => {
  const storage = memoryStorage();
  const { host, rewind, debug } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  assert.equal(await backTo(rewind, 0), true);

  await choose(context, host, "Two");
  assert.equal(host.rewind.inspecting.value, false);
  // The saved data are the point's, then the branch saves as any session.
  assert.deepEqual(storage.calls, ["write k", "write pick", "replace", "write pick"]);
  assert.deepEqual(storage.saved(), { k: 1, pick: "Two" });
  assert.deepEqual(said(host), ["Two", "first Two"]);
  // The later point went with the discarded future; the branch's own takes its place.
  assert.deepEqual(
    rewind.state.value.points.map((point) => point.response?.text ?? null),
    ["Two", null],
  );
  assert.equal(await rewind.returnToSession(), false);
  assert.equal(rewind.state.value.inspection, null);
  assert.deepEqual(
    (await host.debugExportCandidate(() => ({}), new AbortController().signal))
      .rewoundWhileDebugging?.rewindCount,
    1,
  );

  // Turning Debug off keeps the branch: it is the session now.
  const branch = host.session.value;
  debug.stop();
  assert.equal(host.session.value, branch);
  await choose(context, host, "Red");
  assert.deepEqual(said(host), ["Two", "first Two", "Red", "second Red"]);
});

test("Resume adopts the restored state without input", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  assert.equal(await backTo(rewind, 0), true);
  assert.equal(await rewind.resume(), true);
  assert.equal(host.rewind.inspecting.value, false);
  assert.deepEqual(storage.saved(), { k: 1 });
  assert.equal(await rewind.returnToSession(), false);
});

test("when the saved data cannot be restored, the state stays inspected and Return still reinstates the session", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  const tip = host.session.value;
  assert.equal(await backTo(rewind, 0), true);
  const inspected = host.session.value;
  storage.failReplaces();
  await choose(context, host, "Two");
  assert.equal(host.rewind.inspecting.value, true);
  assert.equal(host.session.value, inspected);
  assert.ok(host.notices.value.some((notice) => notice.key === "rewind-not-adopted"));
  assert.deepEqual(storage.saved(), { k: 1, pick: "One" });
  assert.equal(await rewind.returnToSession(), true);
  assert.equal(host.session.value, tip);
});

test("Debug off during a pending adoption, then a loss: the adoption's late outcome reinstates nothing and rejects nothing unhandled", async (context) => {
  for (const hold of ["request", "reply"] as const) {
    await context.test(hold, async (subtest) => {
      const made = createHost(subtest, memoryStorage().provider, { lossy: true });
      const { host, rewind } = made;
      await start(subtest, host);
      await choose(subtest, host, "One");
      const tip = shownView(host);
      assert.equal(await backTo(rewind, 0), true);
      const held = holdRead(subtest, await host.bridge, "captureStorage", hold, false);
      // Input adopts the inspected state; the adoption waits for its read.
      const chosen = Promise.resolve(host.prepareInput());
      await held.arrived;
      const reported: unknown[] = [];
      reportsInto(subtest, reported);
      made.debug.stop();
      made.lose!();
      held.release();
      await chosen.catch(() => {});
      await settle(subtest);
      endCapture();
      assert.deepEqual(
        reported.map((error) => (error instanceof Error ? error.message : String(error))),
        ["The engine Worker failed: injected."],
        "only the loss is reported",
      );
      assert.notEqual(
        host.session.value === null ? null : shownView(host).lineage,
        tip.lineage,
        "the parked session is not reinstated",
      );
    });
  }
});

test("a rewind reply that rejects on a live connection is reported as a host failure; one the loss ended is not", async (context) => {
  for (const lost of [false, true]) {
    await context.test(lost ? "lost" : "live", async (subtest) => {
      const { host, rewind } = createHost(subtest, memoryStorage().provider);
      await start(subtest, host);
      await choose(subtest, host, "One");
      assert.equal(await backTo(rewind, 0), true);
      const bridge = await host.bridge;
      const failure = lost
        ? new BridgeLostError("The engine Worker failed: injected.")
        : new Error("A host failure.");
      interceptSends(subtest, bridge.client, (op, _args, send) =>
        op === "rewindReturn" ? Promise.reject(failure) : send(),
      );
      const reported: unknown[] = [];
      reportsInto(subtest, reported);
      assert.equal(await rewind.returnToSession(), true);
      await settle(subtest);
      assert.deepEqual(reported, lost ? [] : [failure]);
    });
  }
});

test("turning Debug off while inspecting reinstates the session and deletes the history", async (context) => {
  const storage = memoryStorage();
  const { host, rewind, debug, spill } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  const tip = host.session.value;
  assert.equal(await backTo(rewind, 0), true);
  debug.stop();
  // Debug off goes through the Player's lifecycle queue and the restart gate, then shows the parked session.
  await settle(context);
  assert.equal(host.session.value, tip);
  assert.equal(host.rewind.inspecting.value, false);
  await settle(context);
  assert.equal(spill.destroyed, 1);
});

for (const end of ["Debug off", "unmount"] as const)
  test(`after the connection is lost, ${end} while a state is inspected reinstates nothing and throws nothing`, async (context) => {
    const storage = memoryStorage();
    const made = createHost(context, storage.provider, { lossy: true });
    const { host, rewind, debug } = made;
    await start(context, host);
    await choose(context, host, "One");
    assert.equal(await backTo(rewind, 0), true);
    const inspected = host.session.value;
    const reported: unknown[] = [];
    reportsInto(context, reported);
    made.lose!();
    await settle(context);
    endCapture();
    assert.deepEqual(
      reported.map((error) => (error instanceof Error ? error.message : String(error))),
      ["The engine Worker failed: injected."],
      "the loss is reported",
    );
    // The lost host's states are gone, and with them Debug's history: the rewind is sealed by the loss.
    assert.equal(host.rewind.owner.state.sealed, "loss");
    if (end === "Debug off") debug.stop();
    else made.scope.stop();
    assert.equal(host.session.value, inspected, "nothing reinstated");
  });

for (const hold of ["request", "reply"] as const)
  test(`Debug off while an adoption's read is held (${hold}), then a lost connection: nothing is reinstated, and nothing rejects`, async (context) => {
    const rejections: unknown[] = [];
    const record = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", record);
    context.after(() => void process.off("unhandledRejection", record));
    // What the Player reports as host errors: the loss, and nothing a reinstatement attempted after it.
    const reported: unknown[] = [];
    context.mock.method(console, "error", (...args: unknown[]) => void reported.push(args[1]));
    const storage = memoryStorage();
    const made = createHost(context, storage.provider, { lossy: true });
    const { host, rewind, debug } = made;
    await start(context, host);
    await choose(context, host, "One");
    assert.equal(await backTo(rewind, 0), true);
    const shown = host.session.value;
    const held = holdRead(context, await host.bridge, "captureStorage", hold, false);
    const chosen = choose(context, host, "Two");
    await held.arrived;
    debug.stop();
    made.lose!();
    held.release();
    await chosen;
    await settle(context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.session.value, shown, "the lost session is not reinstated");
    assert.deepEqual(rejections, [], "no promise rejected unhandled");
    assert.deepEqual(
      reported.map((error) => (error instanceof Error ? error.message : String(error))),
      ["The engine Worker failed: injected."],
      "only the loss was reported: no reinstatement was attempted",
    );
  });

test("the Player's unmount releases the history's lineages on the connection that lives, an adoption's included", async (context) => {
  for (const adopting of [false, true]) {
    await context.test(adopting ? "adopting" : "inspecting", async (subtest) => {
      // Debug on goes on in the debug room, whose saved data here are the ones `storage` holds.
      const storage = memoryStorage();
      const made = createHost(subtest, memoryStorage().provider, {
        debugRooms: { ...memoryKeptRoomStore(), values: () => storage.provider },
      });
      const { host } = made;
      // The Player's own Debug features, which unmount with it.
      made.debug.stop();
      const features = effectScope();
      const debug = features.run(() => usePlayerDebug(host, { menu: true, autoSkip: false }))!;
      await settle(subtest);
      await start(subtest, host);
      await choose(subtest, host, "One");
      const parked = shownView(host);
      assert.equal(await backTo(debug.rewind.value!, 0), true);
      const shown = shownView(host);
      const bridge = await host.bridge;
      const release = adopting ? storage.holdReplaces() : null;
      const chosen = adopting ? choose(subtest, host, "Two") : null;
      if (adopting) await settle(subtest);
      features.stop();
      made.scope.stop();
      release?.();
      await chosen;
      await settle(subtest);
      assert.deepEqual(
        { parked: await heldInHost(bridge, parked.id), shown: await heldInHost(bridge, shown.id) },
        { parked: false, shown: false },
      );
    });
  }
});

test("Back waits for a pending save, and a new session deletes the history", async (context) => {
  const storage = memoryStorage();
  const { host, rewind, spill } = createHost(context, storage.provider);
  await start(context, host);
  const session = host.session.value!;
  const foreground = playerRuntimeForeground(session);
  assert.ok(foreground?.kind === "choose");
  // The choice saves; the write waits for the host until a later task, and Back with it.
  host.update(selectPlayerRuntimeChoice(session, foreground.options[0]!.id)!.session);
  assert.equal(host.rewind.canRewind.value, false);
  assert.equal(await backTo(rewind, 0), false);
  await settle(context);
  assert.equal(host.rewind.canRewind.value, true);
  assert.equal(rewind.state.value.points.length, 2);

  await start(context, host);
  assert.equal(spill.destroyed, 1);
  assert.equal(rewind.state.value.points.length, 1);
});

test("turning Debug off while an adoption is under way reinstates the session only if the adoption fails", async (context) => {
  for (const fails of [true, false]) {
    await context.test(fails ? "fails" : "succeeds", async (subtest) => {
      const storage = memoryStorage();
      const { host, rewind, debug } = createHost(subtest, storage.provider);
      await start(subtest, host);
      await choose(subtest, host, "One");
      const tip = host.session.value;
      assert.equal(await backTo(rewind, 0), true);
      const release = storage.holdReplaces();
      if (fails) storage.failReplaces();
      const chosen = choose(subtest, host, "Two");
      debug.stop();
      release();
      await chosen;
      assert.equal(host.rewind.inspecting.value, false);
      if (fails) assert.equal(host.session.value, tip);
      else assert.deepEqual(said(host), ["Two", "first Two"]);
    });
  }
});

test("input to an inspected state is evaluated only once it is adopted, so a failed adoption changes nothing", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  assert.equal(await backTo(rewind, 0), true);
  const inspected = host.session.value!;
  const events = inspected.events.length;
  storage.failReplaces();
  await choose(context, host, "Two");
  assert.equal(host.session.value, inspected);
  assert.deepEqual(said(host), []);
  assert.equal(inspected.events.length, events);
  assert.deepEqual((await host.debugRecording())?.endSnapshot, playerRuntimeSnapshot(inspected));
});

test("a second input while the state is being adopted is refused, and the first applies once", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  assert.equal(await backTo(rewind, 0), true);
  const release = storage.holdReplaces();
  const first = choose(context, host, "Two");
  assert.equal(await host.prepareInput(), false);
  release();
  await first;
  assert.deepEqual(said(host), ["Two", "first Two"]);
  const sequences = host.session.value!.events.map((event) => event.sequence);
  assert.equal(new Set(sequences).size, sequences.length);
  assert.deepEqual(storage.saved(), { k: 1, pick: "Two" });
});

test("Back waits for a Storage editor change until the session took it", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  const release = storage.holdWrites();
  const edit = host.editSavedData({ key: "pick", value: "Edited", expected: "One" });
  await settle(context);
  assert.equal(host.rewind.canRewind.value, false);
  assert.equal(await backTo(rewind, 0), false);
  release();
  assert.deepEqual(await edit, { kind: "saved", live: true });
  await settle(context);
  assert.equal(host.rewind.canRewind.value, true);
});

test("an unmounted Player whose adoption fails publishes nothing", async (context) => {
  const storage = memoryStorage();
  const { host, rewind, debug, scope } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  assert.equal(await backTo(rewind, 0), true);
  const release = storage.holdReplaces();
  storage.failReplaces();
  const chosen = choose(context, host, "Two");
  const generation = host.generation.value;
  scope.stop();
  debug.stop();
  release();
  await chosen;
  assert.equal(host.generation.value, generation);
});

test("every restored state begins a new epoch of the value trace, which may turn off while a state is adopted", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  host.setDebugTracing(true);
  await start(context, host);
  await choose(context, host, "One");
  const trace = hostTrace(await host.bridge)!;
  const epoch = trace.status().epoch;
  assert.equal(await backTo(rewind, 0), true);
  assert.equal(traceOf(host.session.value), trace);
  assert.equal(trace.status().epoch, epoch + 1);
  assert.equal(await rewind.forward(), true);
  assert.equal(trace.status().epoch, epoch + 2);

  // Turning the trace off rewraps the inspected session; the adoption under way still completes.
  assert.equal(await backTo(rewind, 0), true);
  const release = storage.holdReplaces();
  const chosen = choose(context, host, "Two");
  host.setDebugTracing(false);
  release();
  await chosen;
  assert.equal(host.rewind.inspecting.value, false);
  assert.deepEqual(said(host), ["Two", "first Two"]);
  assert.deepEqual(storage.saved(), { k: 1, pick: "Two" });
});

test("turning the Debug switch off while an adoption fails reinstates the session, also as the trace turns off", async (context) => {
  const storage = memoryStorage();
  // Debug on goes on in the debug room, whose saved data here are the ones `storage` holds.
  const { host, debug: rewindScope } = createHost(context, memoryStorage().provider, {
    debugRooms: { ...memoryKeptRoomStore(), values: () => storage.provider },
  });
  // The Player's own Debug features, as the Debug panel's switch turns them on and off.
  rewindScope.stop();
  const scope = effectScope();
  const debug = scope.run(() => usePlayerDebug(host, { menu: true, autoSkip: false }))!;
  context.after(() => scope.stop());
  // Debug on goes on in the debug room first; Start waits for it.
  await settle(context);
  await start(context, host);
  await choose(context, host, "One");
  const tip = playerRuntimeSnapshot(host.session.value!);
  assert.equal(await backTo(debug.rewind.value!, 0), true);
  const release = storage.holdReplaces();
  storage.failReplaces();
  const chosen = choose(context, host, "Two");
  debug.active.value = false;
  release();
  await chosen;
  assert.equal(host.rewind.inspecting.value, false);
  // The session is back as it was, and reads that Debug is off.
  assert.equal(tip.debugMode, true);
  assert.equal(host.session.value!.state.debugMode, false);
  assert.deepEqual({ ...playerRuntimeSnapshot(host.session.value!), debugMode: true }, tip);
  assert.deepEqual(said(host), ["One", "first One"]);
  assert.deepEqual(storage.saved(), { k: 1, pick: "One" });
});

test("input is refused while a step reads a spilled state, so the saved data stay as the shown session's", async (context) => {
  const storage = memoryStorage();
  // Every point is written through to the spill store, so each step reads its state back.
  const { host, rewind, holdGets } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  await choose(context, host, "Red");
  assert.deepEqual(storage.saved(), { k: 1, pick: "One", color: "Red" });
  assert.equal(await backTo(rewind, 1), true);
  const release = holdGets();
  const back = backTo(rewind, 0);
  assert.equal(await host.prepareInput(), false);
  assert.equal(await rewind.returnToSession(), false);
  release();
  assert.equal(await back, true);
  assert.deepEqual(storage.saved(), { k: 1, pick: "One", color: "Red" });
  assert.equal(await rewind.returnToSession(), true);
  const view = Object.fromEntries(
    playerRuntimeSnapshot(host.session.value!).scriptStorage.map((entry) => [
      entry.key,
      entry.value,
    ]),
  );
  assert.deepEqual(view, storage.saved());
});

test("importing the shown script ends its rewind history and an inspected state, also one that ended", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  for (const label of ["One", "Red", "A"]) await choose(context, host, label);
  assert.equal(host.session.value?.state.status, "halted");
  assert.equal(await backTo(rewind, 0), true);
  assert.equal(await rewind.forward(), true);
  assert.equal(host.rewind.inspecting.value, true);
  const review = await host.reviewSavedDataImport({
    scripts: [{ scope: "test", name: null, photos: [], entries: [{ key: "imported", value: 9 }] }],
    images: [],
  });
  await host.importSavedData(review, new Set(["test"]));
  assert.equal(host.rewind.inspecting.value, false);
  assert.deepEqual(rewind.state.value.points, []);
  assert.equal(await rewind.resume(), false);
  assert.equal(await rewind.returnToSession(), false);
  assert.deepEqual(storage.saved(), { imported: 9 });
});

test("a step whose prepared state arrives after Start or Continue began is dropped: it shows nothing and changes nothing", async (context) => {
  for (const step of ["back", "forward"] as const) {
    await context.test(step, async (subtest) => {
      const storage = memoryStorage();
      const { host, rewind, holdGets } = createHost(subtest, storage.provider);
      await start(subtest, host);
      await choose(subtest, host, "One");
      await choose(subtest, host, "Red");
      assert.equal(await backTo(rewind, 1), true);
      if (step === "forward") assert.equal(await backTo(rewind, 0), true);
      const shown = host.session.value;
      const before = rewind.state.value.inspection;
      // Prepared before the hold: a source prepare posted behind the held read would wait for it.
      const replacement = await sourceStart(host.bridge, script, () => ({
        ...host.scriptStorageOptions(),
      }));
      const release = holdGets();
      const pending = step === "back" ? backTo(rewind, 0) : rewind.forward();
      host.prepare(replacement);
      release();
      assert.equal(await pending, false);
      await settle(subtest);
      assert.equal(host.session.value, shown, "the restored state does not show");
      // The handoff was dropped: the host's timeline and the page's are as before, and the shown session is held.
      const bridge = await host.bridge;
      const held = await bridge.historyTimeline(rewind.state.value.history!);
      assert.deepEqual(held!.inspection, before);
      assert.deepEqual(rewind.state.value.inspection, before);
      assert.equal(
        (await bridge.read(shownView(host), "captureStorage")).revision,
        shownView(host).revision,
      );
    });
  }
});

test("a session-local state that rewind adopted leaves Play again session-local", async (context) => {
  const writes: string[] = [];
  const { host, rewind } = createHost(context, {
    scope: "test",
    load: async () => {
      throw new Error("Storage is denied.");
    },
    write: async (key) => void writes.push(key),
    replace: async () => void writes.push("replace"),
    clear: async () => {},
  });
  await host.loadScriptStorage();
  host.prepare(
    await sourceStart(
      host.bridge,
      [
        'let k = load("k", default: 0) + 1',
        'save k as "k"',
        'let pick = askChoice "Go", "Stay"',
        'say "${k}", instant',
        "exit",
      ].join("\n"),
      () => ({ ...host.scriptStorageOptions() }),
    ),
  );
  host.activate();
  await untilShown(context, host);
  await choose(context, host, "Go");
  assert.equal(host.session.value?.state.status, "halted");
  assert.equal(await backTo(rewind, 0), true);
  await choose(context, host, "Stay");
  assert.equal(host.rewind.inspecting.value, false);
  assert.equal(host.session.value?.state.status, "halted");

  await host.toStartPage();
  await host.activate();
  await settle(context);
  await choose(context, host, "Go");
  assert.equal(said(host).at(-1), "1");
  assert.deepEqual(writes, []);
});

test("the call view follows the shown session through Back and Return while a demand stands, and ends with it", async (context) => {
  const { host, rewind, scope } = createHost(context, memoryStorage().provider);
  await start(context, host);
  await choose(context, host, "One");
  const tip = shownView(host);
  const bridge = tip.connection;
  const sent: { readonly lineage: object; readonly on: boolean }[] = [];
  const viewCalls = bridge.viewCalls.bind(bridge);
  bridge.viewCalls = (session, on) => {
    sent.push({ lineage: session.lineage, on });
    return viewCalls(session, on);
  };

  // A demand released while its request is in flight: the end follows the start, and none stays.
  host.demandCallView().release();
  await settle(context);
  assert.deepEqual(sent.splice(0), [
    { lineage: tip.lineage, on: true },
    { lineage: tip.lineage, on: false },
  ]);
  assert.equal(shownView(host).callView, null);

  const demand = host.demandCallView();
  // A second demand asks for nothing more.
  const second = host.demandCallView();
  await settle(context);
  assert.deepEqual(sent, [{ lineage: tip.lineage, on: true }]);
  assert.notEqual(shownView(host).callView, null);

  // Back shows another lineage: the left one's calls are no longer viewed, the shown one's are.
  assert.equal(await backTo(rewind, 0), true);
  await settle(context);
  const inspected = shownView(host);
  assert.notEqual(inspected.lineage, tip.lineage);
  assert.deepEqual(sent.slice(1), [
    { lineage: tip.lineage, on: false },
    { lineage: inspected.lineage, on: true },
  ]);
  assert.notEqual(shownView(host).callView, null);

  // Return shows the left lineage again, with its calls viewed again.
  assert.equal(await rewind.returnToSession(), true);
  await settle(context);
  assert.equal(shownView(host).lineage, tip.lineage);
  assert.deepEqual(sent.slice(3), [
    { lineage: inspected.lineage, on: false },
    { lineage: tip.lineage, on: true },
  ]);
  assert.notEqual(shownView(host).callView, null);

  // Released while inspecting: the call view ends, and Return asks for none.
  assert.equal(await backTo(rewind, 0), true);
  await settle(context);
  second.release();
  demand.release();
  // A second release does nothing.
  demand.release();
  await settle(context);
  const back = shownView(host);
  assert.deepEqual(sent.slice(-1), [{ lineage: back.lineage, on: false }]);
  assert.equal(back.callView, null);
  const count = sent.length;
  assert.equal(await rewind.returnToSession(), true);
  await settle(context);
  assert.equal(sent.length, count, "without a demand, Return asks for no call view");

  // An unmount ends a demand still standing.
  host.demandCallView();
  await settle(context);
  assert.deepEqual(sent.at(-1), { lineage: tip.lineage, on: true });
  scope.stop();
  assert.deepEqual(sent.at(-1), { lineage: tip.lineage, on: false });
});
const READS = { back: "rewindBack", adopt: "captureStorage" } as const;

/**
 * Why a combination is no case: a lost connection posts nothing more and delivers no reply; and an inspected state, which
 * an adoption reads, shows no newer publication, for it runs nothing until it is adopted.
 */
const infeasible = ({ read, lifecycle, settlement }: Coordinates) =>
  (lifecycle === "lost" && settlement === "reply") ||
  (read === "adopt" && lifecycle === "publication");

/** Every case of the declaration, but the infeasible. */
function exitCases(): ExitCase[] {
  const cases: ExitCase[] = [];
  for (const read of EXIT_AXES.read)
    for (const hold of EXIT_AXES.hold)
      for (const lifecycle of EXIT_AXES.lifecycle)
        for (const settlement of EXIT_AXES.settlement) {
          const each: ExitCase = { read, hold, lifecycle, settlement };
          if (!infeasible(each)) cases.push(each);
        }
  return cases;
}

/** What the step does in `each`: whether it succeeds, whether the saved values are written, and whether it says it failed. */
function exitOutcome({ read, lifecycle, settlement }: ExitCase): {
  readonly done: boolean;
  readonly wrote: boolean;
  readonly notice: boolean;
} {
  const replied = settlement === "reply";
  // Back parks the host's session itself, not a capture of it, so a newer publication of it moves nothing.
  if (read === "back")
    return {
      done:
        replied && (lifecycle === "none" || lifecycle === "stopped" || lifecycle === "publication"),
      wrote: false,
      notice: false,
    };
  // The adoption owns the page while nothing replaced, stopped or unmounted it; Debug's end waits for it.
  const owns = lifecycle === "none" || lifecycle === "debugOff";
  return { done: owns && replied, wrote: owns && replied, notice: owns && !replied };
}

for (const each of exitCases())
  test(`a rewind read in the host: ${Object.values(each).join(", ")}`, async (context) => {
    const storage = memoryStorage();
    const made = createHost(context, storage.provider, { lossy: each.lifecycle === "lost" });
    const { host, rewind } = made;
    await start(context, host);
    await choose(context, host, "One");
    if (each.read === "adopt") assert.equal(await backTo(rewind, 0), true);
    const bridge = await host.bridge;
    const shown = shownView(host);
    const callsBefore = storage.calls.length;
    const held = holdRead(
      context,
      bridge,
      READS[each.read],
      each.hold,
      each.settlement === "rejection",
    );
    const step = each.read === "back" ? backTo(rewind, 0) : rewind.resume();
    await held.arrived;
    const reported: unknown[] = [];
    reportsInto(context, reported);
    if (each.lifecycle === "publication") {
      // The page shows a newer publication of the session, which the read did not see: a later observation.
      context.mock.timers.tick(1_000);
      host.observe();
      await settle(context);
      assert.notEqual(shownView(host).revision, shown.revision, "a newer publication shows");
    } else if (each.lifecycle === "replaced") {
      host.prepare(
        await sourceStart(host.bridge, script, () => ({ ...host.scriptStorageOptions() })),
      );
      host.activate();
    } else if (each.lifecycle === "debugOff") made.debug.stop();
    else if (each.lifecycle === "stopped") host.reportHostError(new Error("A Player error."));
    else if (each.lifecycle === "disposed") {
      made.debug.stop();
      made.scope.stop();
    } else if (each.lifecycle === "lost") made.lose!();
    held.release();
    const done = await step.catch(() => false);
    await settle(context);
    // The host errors the Player reports: the case's own Player error or loss, and nothing else.
    endCapture();
    assert.deepEqual(
      reported.map((error) => (error instanceof Error ? error.message : String(error))),
      each.lifecycle === "stopped"
        ? ["A Player error."]
        : each.lifecycle === "lost"
          ? ["The engine Worker failed: injected."]
          : [],
      "the host errors reported",
    );
    const want = exitOutcome(each);
    assert.equal(done, want.done, "the step's result");
    assert.equal(
      storage.calls.slice(callsBefore).includes("replace"),
      want.wrote,
      "the saved values written",
    );
    assert.equal(
      host.notices.value.some((one) => one.key === "rewind-not-adopted"),
      want.notice,
      "the adoption's failure said",
    );
    if (each.read === "back")
      assert.equal(host.rewind.inspecting.value, want.done, "a state parked");
  });

test("the rewind reads' exit cases are every feasible coordinate of their declaration", () => {
  const all = product(EXIT_AXES).filter((each) => !infeasible(each));
  assert.deepEqual(coverageGaps(all, exitCases(), { tuples: true }), []);
});
