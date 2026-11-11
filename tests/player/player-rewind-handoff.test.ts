/*
 * The rewind handoff's lifecycle family (`helpers/player/rewind-lifecycle.ts`) and its regression rows, on the rewind tests'
 * shared host.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { effectScope } from "vue";
import { playerRuntimeForeground, type PlayerSession } from "../../player/runtime/runtime-view.js";
import type { RuntimeSnapshot } from "../../src/index.js";
import { coverageGaps, product, type Coordinates } from "../helpers/family-coverage.js";
import {
  LIFECYCLE,
  excluded,
  expectation,
  lifecycleCases,
  type LifecycleCase,
} from "../helpers/player/rewind-lifecycle.js";
import { hostTrace } from "../helpers/player/host-sessions.js";
import { interceptSends } from "../helpers/bridge/sends.js";
import {
  selectPlayerRuntimeChoice,
  playerRuntimeSnapshot,
  useDebugRewind,
  reportsInto,
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
  MutableOwner,
} from "../helpers/player/rewind-host.js";
import { sourceStart } from "../helpers/prepared-plan.js";

/*
 * L5i.6's handoff, by the lifecycle grammar (`tests/helpers/player/rewind-lifecycle.ts`): each schedule holds one step or
 * adoption at one boundary, inserts one lifecycle event there, lets the operation go, and compares the quiescent page
 * and host with the grammar's independent oracle: what shows, and is usable through a real host read; which sessions
 * the host holds; the recording the debug export takes; and the timeline, which is the host's.
 */
const LIFECYCLE_CASES = lifecycleCases();
/**
 * `value` as JSON, one field a line: a snapshot or a recording compared by content, whatever prototypes its copy has;
 * a difference shows as the lines that differ.
 */
const plain = <T extends Readonly<Record<string, unknown>>>(value: T): string =>
  JSON.stringify(value, null, 1);
const lifecycleRun: Coordinates[] = [];

for (const each of LIFECYCLE_CASES)
  test(`a rewind handoff: ${Object.values(each).join(", ")}`, (context) =>
    handoffRow(context, each));

/** One schedule of the lifecycle grammar; `mutate`, a caller mutant, changes the real owner first. */
async function handoffRow(
  context: TestContext,
  each: LifecycleCase,
  mutate?: (owner: MutableOwner) => void,
  /** A negative control of the candidate's state: the target captured with a wrong saved value. */
  wrongTarget = false,
): Promise<void> {
  {
    const local = each.operation === "adopt session-local";
    const gated = each.operation === "Return" || each.operation === "reinstate";
    const storage = local ? null : memoryStorage();
    const made = createHost(context, storage?.provider ?? deniedStorage(), {
      lossy: each.event === "loss",
    });
    const { host, rewind } = made;
    // The owner is a plain object, whose methods the composable calls through it.
    mutate?.(host.rewind.owner);
    const want = expectation(each);
    // An adoption that succeeds adopts by its answer, so the session runs on from the restored state; after a loss its
    // completion is refused, and nothing runs on.
    const adopted = each.operation.startsWith("adopt") && each.outcome === "succeeds" && !want.lost;
    // Traced, so a restart shows as a new epoch of the value trace.
    host.setDebugTracing(true);
    // Each shown state as the page showed it, captured apart from the history: the first point Back restores, and the
    // tip Forward does.
    const shownStates: { readonly snapshot: RuntimeSnapshot; readonly sceneTimeMs: number }[] = [];
    const capture = () => {
      const page = shownView(host);
      shownStates.push({
        snapshot: playerRuntimeSnapshot(page),
        sceneTimeMs: page.state.observedSessionTimeMs,
      });
    };
    await start(context, host);
    capture();
    await choose(context, host, "One");
    capture();
    await choose(context, host, "Red");
    capture();
    // A clear is admitted only once the session ended.
    if (each.event === "clear on an ended session") {
      await choose(context, host, "A");
      assert.equal(host.session.value?.state.status, "halted");
      capture();
    }
    const bridge = await host.bridge;
    // The event's Start is prepared before anything is held: a held read can hold the host's queue, behind which a
    // `prepare` would wait for the hold that the event comes before.
    const eventStart =
      each.event === "Start prepared" || each.event === "replacement"
        ? await sourceStart(host.bridge, script, () => ({ ...host.scriptStorageOptions() }))
        : null;
    const live = shownView(host);
    let restored: PlayerSession | null = null;
    if (each.operation !== "back") {
      assert.equal(await backTo(rewind, 1), true);
      await settle(context);
      restored = shownView(host);
    }
    // The candidates the host prepares, from their replies, and the adoptions' captures, by their requests.
    const candidates: string[] = [];
    let captures = 0;
    const replaces = () => storage?.calls.filter((call) => call === "replace").length ?? 0;
    interceptSends(context, bridge.client, async (op, _args, send) => {
      if (op === "captureStorage") captures += 1;
      const reply = await send();
      if ((op === "rewindBack" || op === "rewindForward") && typeof reply.session === "string")
        candidates.push(reply.session);
      return reply;
    });
    // The hold: a step's snapshot read or its restart gate, or an adoption's saved-data write; `reached` says whether
    // the operation arrived there.
    let release: () => void;
    let reached: () => boolean;
    let acknowledged: Promise<void> = Promise.resolve();
    const arrival = (arrived: Promise<void>) => {
      let at = false;
      void arrived.then(() => (at = true));
      return () => at;
    };
    if (each.boundary === "read") {
      const held = made.holdGets();
      release = held;
      reached = held.reached;
    } else if (each.boundary === "acknowledgement") {
      const held = holdRead(context, bridge, "rewindCommit", "reply", false);
      acknowledged = held.arrived;
      reached = arrival(held.arrived);
      release = held.release;
    } else if (each.boundary === "gate") {
      let open!: () => void;
      let at = false;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const original = host.rewind.beforeRestart.bind(host.rewind);
      host.rewind.beforeRestart = async () => {
        at = true;
        await gate;
        if (gated && each.outcome === "fails") throw new Error("The restart gate failed.");
        await original();
      };
      release = () => open();
      reached = () => at;
    } else if (local) {
      // Saved data that live only in the session: held where the adoption reads them; a failing one fails that read.
      const held = holdRead(context, bridge, "captureStorage", "reply", each.outcome === "fails");
      release = held.release;
      reached = arrival(held.arrived);
    } else {
      // The provider's replacement, admitted and held; a failing one fails there.
      // The import's own replacement, later, is not the adoption's and succeeds.
      if (each.outcome === "fails") storage!.failNextReplace();
      const held = storage!.holdReplaces();
      release = held;
      reached = held.reached;
    }
    const recordingBefore = await host.debugRecording();
    const epochBefore = hostTrace(bridge)!.status().epoch;
    // What each identity is before the operation, and the events a step restores as the history names them: Back's
    // first point, or the state Forward restores.
    const before = {
      live: { snapshot: playerRuntimeSnapshot(live), events: live.events, marks: live.marks },
      restored:
        restored === null
          ? null
          : {
              snapshot: playerRuntimeSnapshot(restored),
              events: restored.events,
              marks: restored.marks,
            },
    };
    const history = host.rewind.owner.view.value!;
    const target =
      each.operation === "forward"
        ? history.timeline.inspection?.future
        : history.timeline.points[0];
    const targetEvents = target === undefined || target === null ? null : history.eventsAt(target);
    if (!each.operation.startsWith("adopt")) assert.ok(targetEvents !== null, "the step's target");
    const replacesBefore = replaces();
    let inputAdmitted: boolean | null = null;
    const operation: Promise<unknown> =
      each.operation === "forward"
        ? rewind.forward()
        : each.operation === "Return"
          ? rewind
              .returnToSession()
              .then((returned) =>
                assert.equal(
                  returned,
                  each.outcome === "succeeds" && !want.lost && each.event !== "disposal",
                  "returned",
                ),
              )
          : each.operation === "reinstate"
            ? Promise.resolve(made.debug.stop())
            : each.operation.startsWith("adopt")
              ? (async () => {
                  // The answer adopts the restored state; it is evaluated only if its input is admitted.
                  // A preparation that rejects (its host lost) admits nothing either.
                  inputAdmitted = await Promise.resolve(host.prepareInput()).catch(() => false);
                  if (!inputAdmitted) return;
                  const session = host.session.value!;
                  const foreground = playerRuntimeForeground(session);
                  assert.ok(foreground?.kind === "choose");
                  host.update(
                    selectPlayerRuntimeChoice(session, foreground.options[1]!.id)!.session,
                  );
                })()
              : backTo(rewind, 0);
    await settle(context);
    // The commit's reply is held only once the page accepted the step.
    await acknowledged;
    assert.equal(reached(), true, "the operation reached its hold");
    // The event, while the operation is held.
    let atError: RuntimeSnapshot | null = null;
    let event: Promise<unknown> = Promise.resolve();
    switch (each.event) {
      case "publication":
        context.mock.timers.tick(1_000);
        event = host.observe();
        break;
      case "Return":
        event = rewind.returnToSession().then((returned) => assert.equal(returned, false));
        break;
      case "clear":
      case "clear on an ended session":
        event = host
          .clearScriptStorage()
          .then((cleared) => assert.equal(cleared, want.clears, "the clear's admission"));
        break;
      case "Player error":
        host.reportHostError(new Error("A Player error."));
        await settle(context);
        atError = playerRuntimeSnapshot(host.session.value!);
        break;
      case "Start prepared":
        host.prepare(eventStart!);
        break;
      case "Debug off":
        made.debug.stop();
        break;
      case "Debug off and on": {
        made.debug.stop();
        const again = effectScope();
        again.run(() => useDebugRewind(host));
        context.after(() => again.stop());
        break;
      }
      case "replacement":
        // A replacement Start begins while the operation is held.
        await host.loadScriptStorage();
        host.prepare(eventStart!);
        event = Promise.resolve(host.activate());
        break;
      case "import ending the session": {
        // Reviewed first, so the import ends the session before the hold is let go.
        const review = await host.reviewSavedDataImport({
          scripts: [{ scope: "test", name: null, photos: [], entries: [] }],
          images: [],
        });
        event = host.importSavedData(review, new Set(["test"]));
        break;
      }
      case "disposal":
        rewind.endWithPlayer();
        made.debug.stop();
        made.scope.stop();
        break;
      // Attempts to adopt while the return waits: refused, they read, write and evaluate nothing.
      case "answer":
        event = Promise.resolve(host.prepareInput()).then((prepared) =>
          assert.equal(prepared, false, "the answer is refused"),
        );
        break;
      case "Resume":
        event = rewind
          .resume()
          .then((resumed) => assert.equal(resumed, false, "Resume is refused"));
        break;
      case "loss":
        made.lose!();
        break;
    }
    release();
    // A gated operation's own assertion stands; a step's or an adoption's rejection is its outcome, compared below.
    await (gated ? operation : operation.catch(() => false));
    await event;
    await settle(context);
    // An adoption's answer is admitted only where the adoption runs on: a completion the owner refused admits none.
    if (each.operation.startsWith("adopt"))
      assert.equal(inputAdmitted, want.recording === "continued", "the answer's input admitted");
    // A refused attempt read nothing in the host and replaced no saved data.
    if (each.event === "answer" || each.event === "Resume")
      assert.deepEqual(
        { captures, replaces: replaces() - replacesBefore },
        { captures: 0, replaces: 0 },
        "a refused attempt's effects",
      );

    const page = host.session.value === null ? null : shownView(host);
    const candidate = candidates.at(-1) ?? null;
    const lineages = { live: live.lineage, restored: restored?.lineage };
    if (want.shows !== "none") {
      assert.ok(page !== null, "a session shows");
      const shown =
        page.lineage === lineages.live
          ? "live"
          : page.lineage === lineages.restored
            ? "restored"
            : page.id === candidate
              ? "candidate"
              : "new";
      assert.equal(shown, want.shows, "the session shown");
      assert.equal(host.rewind.inspecting.value, want.inspecting, "inspected");
      // Shown on the surviving bridge: usable through a real host read, at the revision it shows.
      if (!want.lost)
        assert.equal((await bridge.read(page, "captureStorage")).revision, page.revision);
      // The state the session shows is the one it was: a candidate shows its target's events with one rewind more;
      // a live or restored session shows its own state, events and marks unchanged. A new session's state is the
      // Start's, which this family does not compare.
      if (shown === "candidate") {
        assert.deepEqual(page.events, targetEvents, "the target's events");
        // Its state is the target's as the page showed it, and its marks one rewind of it.
        const target = shownStates[each.operation === "forward" ? shownStates.length - 1 : 0]!;
        const expected = wrongTarget
          ? {
              ...target.snapshot,
              scriptStorage: target.snapshot.scriptStorage.map((entry) =>
                entry.key === "k" ? { ...entry, value: 999 } : entry,
              ),
            }
          : target.snapshot;
        assert.equal(
          plain({ at: playerRuntimeSnapshot(page) }),
          plain({ at: expected }),
          "the target's state",
        );
        assert.deepEqual(
          plain({ marks: page.marks }),
          plain({
            marks: {
              editedWhileDebugging: null,
              rewoundWhileDebugging: { restoredSceneTimeMs: target.sceneTimeMs, rewindCount: 1 },
            },
          }),
          "the candidate's marks",
        );
      } else if (shown === "restored" && adopted) {
        // Adopted by its answer: the restored session's events, then the answer's.
        const was = before.restored!;
        assert.deepEqual(
          page.events.slice(0, was.events.length),
          was.events,
          "the restored events",
        );
        assert.notEqual(
          plain({ at: playerRuntimeSnapshot(page) }),
          plain({ at: was.snapshot }),
          "the answer's state",
        );
      } else if (shown !== "new") {
        const was = before[shown]!;
        // After a loss its state is no longer the host's to read: its events and marks still are the page's.
        assert.deepEqual(
          plain({
            ...(want.lost ? {} : { snapshot: playerRuntimeSnapshot(page) }),
            events: page.events,
            marks: page.marks,
          }),
          plain({
            ...(want.lost ? {} : { snapshot: was.snapshot }),
            events: was.events,
            marks: was.marks,
          }),
          "the session shown, unchanged",
        );
      }
    }
    const ids: Record<"live" | "restored" | "candidate", string | null> = {
      live: live.id,
      restored: restored?.id ?? null,
      candidate,
    };
    for (const identity of ["live", "restored", "candidate"] as const) {
      const held = want.held[identity];
      if (held === undefined) continue;
      const id = ids[identity];
      if (id === null) assert.equal(held, false, `${identity} was never made`);
      else assert.equal(await heldInHost(bridge, id), held, `the host holds ${identity}`);
    }
    // The recording begun once at the shown session, with nothing recorded since; or the one before, unchanged. Read
    // only in rows that compare one: a row that ends the connection has no host to read from.
    const recording = want.recording === null ? null : await host.debugRecording();
    // Read only where a recording is compared: the Player's end takes the trace with it.
    const epochs = () => hostTrace(bridge)!.status().epoch - epochBefore;
    if (want.recording === "shown") {
      const at = playerRuntimeSnapshot(page!);
      assert.deepEqual(
        plain({
          anchor: recording?.anchorSnapshot,
          end: recording?.endSnapshot,
          operations: recording?.operations,
          complete: recording?.complete,
          epochs: epochs(),
        }),
        plain({ anchor: at, end: at, operations: [], complete: true, epochs: want.restarts ?? 1 }),
        "begun once at the shown session",
      );
    }
    if (want.recording === "continued") {
      // The same recording, run on by the answer: its anchor, and its operations before, then the answer's.
      const was = recordingBefore!.operations;
      assert.deepEqual(
        plain({
          anchor: recording?.anchorSnapshot,
          operations: recording?.operations.slice(0, was.length),
          epochs: epochs(),
        }),
        plain({ anchor: recordingBefore?.anchorSnapshot, operations: was, epochs: 0 }),
        "the recording before it, run on",
      );
      assert.ok(recording!.operations.length > was.length, "the answer is recorded");
    }
    if (want.recording === "kept")
      assert.deepEqual(
        plain({ recording, epochs: epochs() }),
        plain({ recording: recordingBefore, epochs: 0 }),
        "the recording before it",
      );
    if (want.recording === "error")
      assert.deepEqual(recording?.endSnapshot, atError, "the recording up to the error");
    // The page's timeline is the host's, and every point's log resolves from a session the page holds.
    const view = host.rewind.owner.view.value;
    if (want.lost) assert.ok(view !== null, "the history's view stays, read-only");
    else if (want.history) {
      assert.ok(view !== null, "a history is open");
      const timeline = await bridge.historyTimeline(view.timeline.history);
      assert.ok(timeline !== null, "the host holds the history");
      assert.deepEqual(view.timeline.inspection, timeline.inspection);
      assert.deepEqual(view.timeline.points, timeline.points);
      // Every retained position's log resolves: each point, and the shown and future states of an inspection.
      const { inspection } = view.timeline;
      for (const position of [
        ...view.timeline.points,
        ...(inspection === null ? [] : [inspection.shown]),
        ...(inspection?.future == null ? [] : [inspection.future]),
      ])
        assert.ok(
          view.eventsAt(position) !== null,
          `the log at ${JSON.stringify(position)} resolves`,
        );
    } else assert.equal(view, null, "no history is open");
    // The owner's return state: nothing waits once the gate settled, opened or failed.
    if (gated && !want.lost && (want.shows === "live" || want.shows === "restored"))
      assert.equal(host.rewind.owner.reinstatement.value, null, "the return's state");
    if (mutate === undefined) lifecycleRun.push(each);
  }
}

/*
 * The caller seam's negative controls, for its rule that the page acts only on the owner's decisions
 * (`rewindOwner.ts`): each mutant changes the real owner as the composable calls it,
 * and the named row must fail.
 */
const CALLER_MUTANTS: readonly {
  readonly name: string;
  readonly row: LifecycleCase;
  readonly mutate: (owner: MutableOwner) => void;
}[] = [
  {
    name: "an adoption the owner refused proceeds",
    row: { operation: "reinstate", boundary: "gate", outcome: "succeeds", event: "answer" },
    mutate: (owner) => void (owner.adoptionBegun = () => true),
  },
  {
    // Page flow cannot make a write succeed while the owner refuses its completion (the page's `ownsShown` stops each
    // such path first), so the caller's branch is decided by refusing an otherwise successful completion: the caller
    // must then activate nothing, and the row, which expects the adoption to run on, fails.
    name: "a completion the owner refuses activates nothing",
    row: {
      operation: "adopt persistent",
      boundary: "provider",
      outcome: "succeeds",
      event: "none",
    },
    mutate: (owner) => {
      const settle = owner.adoptionSettled;
      owner.adoptionSettled = (succeeded) => {
        settle(succeeded);
        return false;
      };
    },
  },
  {
    name: "the page keeps a stale inspection",
    row: { operation: "back again", boundary: "gate", outcome: "none", event: "replacement" },
    mutate: (owner) => void (owner.newSession = () => []),
  },
];

test("a candidate restored with a wrong saved value fails its row (negative control)", async (context) => {
  const row: LifecycleCase = {
    operation: "back",
    boundary: "read",
    outcome: "none",
    event: "none",
  };
  await assert.rejects(handoffRow(context, row, undefined, true), assert.AssertionError);
});

test("the caller seam's mutants each fail their row", async (context) => {
  for (const { name, row, mutate } of CALLER_MUTANTS) {
    assert.equal(excluded(row), null, `${name}: a schedule of the grammar`);
    await context.test(name, async (subtest) => {
      await assert.rejects(handoffRow(subtest, row, mutate), assert.AssertionError);
    });
  }
});

test("the handoff family ran every schedule of the lifecycle grammar, with its exclusions reasoned", () => {
  const feasible = product(LIFECYCLE).filter((each) => excluded(each) === null);
  assert.deepEqual(coverageGaps(feasible, lifecycleRun, { tuples: true }), []);
});

test("Debug off reinstates the session Back left, and the Player's unmount then releases it", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host, rewind } = made;
  await start(context, host);
  await choose(context, host, "One");
  const tip = shownView(host);
  assert.equal(await backTo(rewind, 0), true);
  const bridge = await host.bridge;
  made.debug.stop();
  await settle(context);
  assert.equal(shownView(host).lineage, tip.lineage, "reinstated");
  made.scope.stop();
  await settle(context);
  assert.equal(await heldInHost(bridge, tip.id), false);
});

test("Debug off waiting on an adoption when the Player unmounts releases everything, whichever scope ends first", async (context) => {
  for (const order of ["Debug first", "Player first"] as const) {
    await context.test(order, async (subtest) => {
      const storage = memoryStorage();
      const made = createHost(subtest, storage.provider);
      const { host, rewind } = made;
      await start(subtest, host);
      await choose(subtest, host, "One");
      const tip = shownView(host);
      assert.equal(await backTo(rewind, 0), true);
      const restored = shownView(host);
      const bridge = await host.bridge;
      const release = storage.holdReplaces();
      const chosen = chooseAt(host, 1);
      await settle(subtest);
      if (order === "Debug first") {
        made.debug.stop();
        made.scope.stop();
      } else {
        made.scope.stop();
        made.debug.stop();
      }
      release();
      await chosen.catch(() => {});
      await settle(subtest);
      assert.deepEqual(
        { parked: await heldInHost(bridge, tip.id), shown: await heldInHost(bridge, restored.id) },
        { parked: false, shown: false },
      );
    });
  }
});

/*
 * Handoff cases a review reproduced, as rows through the real composables and host: each decided by
 * the page side's one function (`player/debug/rewind-lifecycle.ts`) and the host's (`advanceHistory`).
 */

test("Sol r2 B1: Debug off after a commit was sent, before its acknowledgement, reinstates the parked session", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host, rewind } = made;
  await start(context, host);
  await choose(context, host, "One");
  const tip = shownView(host);
  const bridge = await host.bridge;
  const held = holdRead(context, bridge, "rewindCommit", "reply", false);
  const stepped = backTo(rewind, 0);
  await held.arrived;
  made.debug.stop();
  held.release();
  await stepped;
  await settle(context);
  assert.equal(shownView(host).lineage, tip.lineage, "the parked session shows again");
  assert.equal(
    (await bridge.read(shownView(host), "captureStorage")).revision,
    shownView(host).revision,
  );
});

test("Sol r2 B2: the Player's disposal during Debug off's restart gate releases the parked session", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host, rewind } = made;
  await start(context, host);
  await choose(context, host, "One");
  const tip = shownView(host);
  assert.equal(await backTo(rewind, 0), true);
  const shown = shownView(host);
  const bridge = await host.bridge;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  host.rewind.beforeRestart = () => gate;
  made.debug.stop();
  await settle(context);
  made.scope.stop();
  open();
  await settle(context);
  assert.deepEqual(
    { parked: await heldInHost(bridge, tip.id), shown: await heldInHost(bridge, shown.id) },
    { parked: false, shown: false },
  );
});

test("Sol r2 B3: a step whose restart gate rejects drops its candidate, and the next step goes", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host, rewind } = made;
  await start(context, host);
  await choose(context, host, "One");
  const bridge = await host.bridge;
  const candidates: string[] = [];
  interceptSends(context, bridge.client, async (op, _args, send) => {
    const reply = await send();
    if (op === "rewindBack" && typeof reply.session === "string") candidates.push(reply.session);
    return reply;
  });
  const original = host.rewind.beforeRestart.bind(host.rewind);
  host.rewind.beforeRestart = () => Promise.reject(new Error("The gate failed."));
  assert.equal(await backTo(rewind, 0), false);
  await settle(context);
  assert.equal(await heldInHost(bridge, candidates[0]!), false, "the candidate went");
  host.rewind.beforeRestart = original;
  assert.equal(await backTo(rewind, 0), true, "the next step goes");
});

test("Sol r2 B4: after Resume, Back then Forward restores the adopted session's state from its kept log", async (context) => {
  const storage = memoryStorage();
  const { host, rewind } = createHost(context, storage.provider);
  await start(context, host);
  await choose(context, host, "One");
  await choose(context, host, "Red");
  assert.equal(await backTo(rewind, 1), true);
  assert.equal(await rewind.resume(), true);
  await settle(context);
  const adopted = shownView(host);
  assert.equal(await backTo(rewind, 0), true);
  await settle(context);
  assert.ok(rewind.state.value.inspection?.future, "a future to go forward to");
  assert.equal(await rewind.forward(), true);
  await settle(context);
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!), playerRuntimeSnapshot(adopted));
});

test("Sol r2 B5: a clear's close that fails on a live connection is reported, and no history opens after it", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host } = made;
  await start(context, host);
  for (const label of ["One", "Red", "A"]) await choose(context, host, label);
  assert.equal(host.session.value?.state.status, "halted");
  const bridge = await host.bridge;
  const sent: string[] = [];
  // The clear's renewal carries its close (`historyRenew`); the host answers that the close failed.
  interceptSends(context, bridge.client, (op, _args, send) => {
    if (op.startsWith("history")) sent.push(op);
    if (op !== "historyRenew") return send();
    return Promise.resolve({
      session: null,
      revision: null,
      eventsThrough: null,
      result: { kind: "closeFailed", reason: "a host failure", released: [] },
      view: null,
    });
  });
  const reported: unknown[] = [];
  reportsInto(context, reported);
  assert.equal(await host.clearScriptStorage(), true);
  await settle(context);
  assert.deepEqual(sent, ["historyRenew"]);
  assert.equal(reported.length, 1);
  assert.equal(host.rewind.owner.state.blocked, true);
  assert.equal(host.rewind.owner.view.value, null);
});

test("Sol r2 B6: an adoption that succeeds while Debug off waits keeps the recording and the trace's epoch", async (context) => {
  const storage = memoryStorage();
  const made = createHost(context, storage.provider);
  const { host, rewind } = made;
  host.setDebugTracing(true);
  await start(context, host);
  await choose(context, host, "One");
  assert.equal(await backTo(rewind, 0), true);
  const trace = hostTrace(await host.bridge)!;
  const epoch = trace.status().epoch;
  const anchor = (await host.debugRecording())?.anchorSnapshot;
  let gates = 0;
  const original = host.rewind.beforeRestart.bind(host.rewind);
  host.rewind.beforeRestart = () => {
    gates += 1;
    return original();
  };
  const release = storage.holdReplaces();
  const resumed = rewind.resume();
  await settle(context);
  made.debug.stop();
  release();
  assert.equal(await resumed, true);
  await settle(context);
  assert.deepEqual({ epoch: trace.status().epoch, gates }, { epoch, gates: 0 });
  assert.deepEqual((await host.debugRecording())?.anchorSnapshot, anchor);
});

test("Sol r2 S1: a renewal that fails on a live connection is reported", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host } = made;
  await start(context, host);
  const bridge = await host.bridge;
  const failure = new Error("A host failure.");
  interceptSends(context, bridge.client, (op, _args, send) =>
    op === "historyRenew" ? Promise.reject(failure) : send(),
  );
  const reported: unknown[] = [];
  reportsInto(context, reported);
  made.debug.stop();
  const again = effectScope();
  again.run(() => useDebugRewind(host));
  context.after(() => again.stop());
  await settle(context);
  assert.deepEqual(reported, [failure]);
});

test("#2230: Debug off's reinstatement whose gate fails is reported once and reinstates the parked session", async (context) => {
  const reported: unknown[] = [];
  reportsInto(context, reported);
  const made = createHost(context, memoryStorage().provider);
  const { host } = made;
  await start(context, host);
  await choose(context, host, "One");
  const live = shownView(host);
  assert.equal(await backTo(made.rewind, 0), true);
  await settle(context);
  const failure = new Error("The gate failed.");
  host.rewind.beforeRestart = () => Promise.reject(failure);
  made.debug.stop();
  await settle(context);
  assert.deepEqual(reported, [failure], "the failure, reported once");
  assert.equal(host.rewind.inspecting.value, false, "no longer inspected");
  assert.equal(shownView(host).lineage, live.lineage, "the parked session shows");
  assert.equal(host.rewind.owner.reinstatement.value, null, "nothing waits");
});

for (const gateA of ["succeeds", "fails"] as const)
  test(`Sol r5 B1: an obsolete reinstatement gate that ${gateA} decides nothing; the current one reinstates`, async (context) => {
    const reported: unknown[] = [];
    reportsInto(context, reported);
    const made = createHost(context, memoryStorage().provider);
    const { host } = made;
    // The reinstatement gates held, in the order asked; a step's gate goes through as it is.
    const gates: { readonly resolve: () => void; readonly reject: (error: Error) => void }[] = [];
    const original = host.rewind.beforeRestart.bind(host.rewind);
    let holding = false;
    host.rewind.beforeRestart = () =>
      holding
        ? new Promise<void>((resolve, reject) => void gates.push({ resolve, reject }))
        : original();
    await start(context, host);
    await choose(context, host, "One");
    assert.equal(await backTo(made.rewind, 0), true);
    // Debug off: gate A waits.
    holding = true;
    made.debug.stop();
    holding = false;
    await settle(context);
    assert.equal(gates.length, 1);
    // A replacement session, Debug on again, and a later inspection of the new history.
    await host.loadScriptStorage();
    host.prepare(
      await sourceStart(host.bridge, script, () => ({ ...host.scriptStorageOptions() })),
    );
    await host.activate();
    await settle(context);
    const again = effectScope();
    const rewind = again.run(() => useDebugRewind(host))!;
    context.after(() => again.stop());
    await settle(context);
    await choose(context, host, "One");
    assert.equal(await backTo(rewind, 0), true);
    await settle(context);
    const inspected = shownView(host);
    // Debug off again: gate B waits.
    holding = true;
    again.stop();
    holding = false;
    await settle(context);
    assert.equal(gates.length, 2);
    // A settles: obsolete, it decides nothing, its failure is not reported, and the later inspection stands.
    if (gateA === "succeeds") gates[0]!.resolve();
    else gates[0]!.reject(new Error("Gate A failed."));
    await settle(context);
    assert.deepEqual(reported, [], "nothing reported");
    assert.equal(host.rewind.inspecting.value, true, "still inspected");
    assert.equal(shownView(host).lineage, inspected.lineage, "the later inspection shows");
    // B, the current gate, reinstates.
    gates[1]!.resolve();
    await settle(context);
    assert.equal(host.rewind.inspecting.value, false, "reinstated");
    assert.notEqual(shownView(host).lineage, inspected.lineage);
  });

test("an obsolete Back gate's failure leaves no problem on the replacement's history", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host } = made;
  // The Back's restart gate held; every other gate goes through.
  let reject!: (error: Error) => void;
  let held = false;
  const original = host.rewind.beforeRestart.bind(host.rewind);
  host.rewind.beforeRestart = () => {
    if (held) return original();
    held = true;
    return new Promise<void>((_, fail) => (reject = fail));
  };
  await start(context, host);
  await choose(context, host, "One");
  const back = backTo(made.rewind, 0);
  await settle(context);
  assert.equal(held, true, "the Back waits at its gate");
  // Debug off abandons it; a replacement session takes the page.
  made.debug.stop();
  await host.loadScriptStorage();
  host.prepare(await sourceStart(host.bridge, script, () => ({ ...host.scriptStorageOptions() })));
  await host.activate();
  await settle(context);
  reject(new Error("obsolete Back gate"));
  assert.equal(await back, false);
  await settle(context);
  // Debug on again: the replacement's history shows no problem of the obsolete Back.
  const again = effectScope();
  const rewind = again.run(() => useDebugRewind(host))!;
  context.after(() => again.stop());
  await settle(context);
  assert.equal(rewind.problem.value, null);
});
