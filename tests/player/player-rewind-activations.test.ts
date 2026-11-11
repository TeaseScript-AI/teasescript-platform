/*
 * Rewind across activations: the debug export's marks, incident and recording, each activation's run, and its
 * completions' lifetime, on the rewind tests' shared host.
 */

import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { effectScope } from "vue";
import {
  restorePlayerRuntimeSessionAt,
  type PlayerRuntimeSession,
} from "../../player/runtime/runtime-adapter.js";
import { coverageGaps, product, type Coordinates } from "../helpers/family-coverage.js";
import { onHost, hostIntroduced, loadHostFacade } from "../helpers/player/host-sessions.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import { preparedSource } from "../helpers/prepared-plan.js";
import {
  playerRuntimeSnapshot,
  RewindHost,
  Rewind,
  usePlayerSession,
  useDebugRewind,
  backTo,
  heldRuns,
  heldTickets,
  memoryStorage,
  createHost,
  settle,
  script,
  start,
  choose,
  shownView,
  holdRead,
  untilShown,
} from "../helpers/player/rewind-host.js";

// `hostIntroduced` registers adapter sessions through the facade of the bundle the composable runs in.
before(loadHostFacade);

/*
 * L5h.3b, orchestrator 2's ruling on 21.7: while a rewind lifecycle gate is pending, a debug export captures the shown
 * publication's marks, never the candidate's, and copies that publication's events and transcript from the store's view.
 * One row per pending state: a prepared step whose commit is not yet acknowledged, an adoption begun and not settled,
 * and a reinstatement waiting at its restart gate.
 */
/** A session's event sequences and transcript texts, as a candidate copies them; none without a session. */
function prefixOf(
  session: {
    readonly events: readonly { readonly sequence: number }[];
    readonly transcriptEntries: readonly { readonly text: string }[];
  } | null,
): { readonly events: readonly number[]; readonly transcript: readonly string[] } {
  return {
    events: session?.events.map((event) => event.sequence) ?? [],
    transcript: session?.transcriptEntries.map((entry) => entry.text) ?? [],
  };
}

test("an export while a rewind gate is pending takes the shown publication's marks", async (context) => {
  const marksOf = async (host: RewindHost) => {
    const candidate = await host.debugExportCandidate(() => ({}), new AbortController().signal);
    assert.ok(candidate !== null, "the export is a candidate");
    return {
      rewound: candidate.rewoundWhileDebugging,
      edited: candidate.editedWhileDebugging,
      ...prefixOf(candidate.session),
    };
  };
  // The marks of the shown publication, and its events and transcript, which the candidate copies from the store's view.
  const shownMarks = (host: RewindHost) => ({
    rewound: shownView(host).marks.rewoundWhileDebugging,
    edited: shownView(host).marks.editedWhileDebugging,
    ...prefixOf(shownView(host)),
  });

  await context.test("a prepared step, its commit not yet acknowledged", async (subtest) => {
    const { host, rewind } = createHost(subtest, memoryStorage().provider);
    await start(subtest, host);
    await choose(subtest, host, "One");
    const bridge = await host.bridge;
    const held = holdRead(subtest, bridge, "rewindCommit", "reply", false);
    const stepped = backTo(rewind, 0);
    await held.arrived;
    // Whatever shows while the commit is not acknowledged, the export takes its marks.
    assert.deepEqual(await marksOf(host), shownMarks(host));
    held.release();
    assert.equal(await stepped, true);
  });

  await context.test("an adoption begun and not settled", async (subtest) => {
    const storage = memoryStorage();
    const { host, rewind } = createHost(subtest, storage.provider);
    await start(subtest, host);
    await choose(subtest, host, "One");
    assert.equal(await backTo(rewind, 0), true);
    const release = storage.holdReplaces();
    const chosen = choose(subtest, host, "Two");
    await settle(subtest);
    const shown = shownMarks(host);
    // The inspected state shows while its adoption is under way: rewound once.
    assert.equal(shown.rewound?.rewindCount, 1);
    assert.deepEqual(await marksOf(host), shown);
    release();
    await chosen;
  });

  await context.test("a reinstatement waiting at its restart gate", async (subtest) => {
    const made = createHost(subtest, memoryStorage().provider);
    const { host, rewind } = made;
    await start(subtest, host);
    await choose(subtest, host, "One");
    assert.equal(await backTo(rewind, 0), true);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    host.rewind.beforeRestart = () => gate;
    made.debug.stop();
    await settle(subtest);
    const shown = shownMarks(host);
    assert.equal(shown.rewound?.rewindCount, 1, "the inspected state still shows");
    assert.deepEqual(await marksOf(host), shown);
    open();
    await settle(subtest);
  });
});

/*
 * L5h.3b's export observation over the Player's activations (§21.4 family 1): a Player error's incident is the run's.
 * A rewind keeps it, as it keeps the run; the next Start begins a run without one; a retired dialog gets no candidate.
 */
test("a debug export's incident is the run's: kept through Back and Return, gone with the next Start", async (context) => {
  const exported = async (host: RewindHost, wanted = new AbortController().signal) => {
    const candidate = await host.debugExportCandidate(() => ({}), wanted);
    // EVIDENCE: fixture: the composable returns `null` for a refused candidate; the local type does not name it.
    const nullable = candidate as typeof candidate | null;
    return nullable === null
      ? null
      : {
          hostError: nullable.hostError,
          rewound: nullable.rewoundWhileDebugging?.rewindCount ?? 0,
        };
  };
  const made = createHost(context, memoryStorage().provider);
  const { host, rewind } = made;
  await start(context, host);
  await choose(context, host, "One");
  assert.deepEqual(await exported(host), { hostError: null, rewound: 0 });
  host.reportHostError(new TypeError("A component failed."));
  await settle(context);
  assert.equal(host.hostError.value, "TypeError");
  assert.deepEqual(await exported(host), { hostError: "TypeError", rewound: 0 });
  assert.equal(await backTo(rewind, 0), true);
  assert.deepEqual(
    await exported(host),
    { hostError: "TypeError", rewound: 1 },
    "Back keeps the run",
  );
  assert.equal(await rewind.returnToSession(), true);
  await settle(context);
  assert.deepEqual(await exported(host), { hostError: "TypeError", rewound: 0 }, "Return keeps it");
  // A dialog that no longer wants the candidate gets none (its ticket's release is the bridge's family's).
  assert.equal(await exported(host, AbortSignal.abort()), null);
  await start(context, host);
  assert.equal(host.hostError.value, null);
  assert.deepEqual(
    await exported(host),
    { hostError: null, rewound: 0 },
    "a new run has no incident",
  );
});

/*
 * L5h.3b, Sol code r1: B1, a Player error whose recording capture failed exports no recording, never the one the host
 * began at a restored state; B2, an activation that fails before its Start reaches the host commits its incident in a
 * run of its own, also after an earlier failed activation.
 */
test("a Player error whose recording capture failed exports no recording, also after Back and a later error", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host, rewind } = made;
  await start(context, host);
  await choose(context, host, "One");
  const bridge = await host.bridge;
  const request = bridge.client.request.bind(bridge.client);
  const selected: unknown[] = [];
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    if (args[0] === "captureExport") {
      // EVIDENCE: fixture: `captureExport`'s arguments name the recording it selects.
      const { recording } = args[1] as { readonly recording: unknown };
      selected.push(recording);
    }
    return args[0] === "captureRecording"
      ? Promise.reject(new Error("The capture failed."))
      : request(...args);
  });
  host.reportHostError(new TypeError("A component failed."));
  await settle(context);
  assert.equal(await backTo(rewind, 0), true);
  host.reportHostError(new RangeError("A later failure."));
  await settle(context);
  const candidate = await host.debugExportCandidate(() => ({}), new AbortController().signal);
  assert.equal(candidate.hostError, "TypeError");
  assert.equal(
    candidate.recording,
    null,
    "the failure's recording is unavailable, not the restored one's",
  );
  assert.deepEqual(selected, ["none"]);
  // No failure ticket: the export's is the connection's first.
  assert.deepEqual(heldTickets(bridge), ["r1"]);
  candidate.release();
  await settle(context);
  assert.deepEqual(heldTickets(bridge), []);
  made.scope.stop();
  await settle(context);
  assert.deepEqual(
    { runs: heldRuns(bridge), tickets: heldTickets(bridge) },
    { runs: [], tickets: [] },
  );
});

test("a Player error's captured recording stays the export's through Back and a later error, and goes with the Player", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host, rewind } = made;
  await start(context, host);
  await choose(context, host, "One");
  const bridge = await host.bridge;
  const request = bridge.client.request.bind(bridge.client);
  let captures = 0;
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    if (args[0] === "captureRecording") captures += 1;
    return request(...args);
  });
  host.reportHostError(new TypeError("A component failed."));
  await settle(context);
  assert.deepEqual(heldTickets(bridge), ["r1"]);
  assert.equal(await backTo(rewind, 0), true);
  host.reportHostError(new RangeError("A later failure."));
  await settle(context);
  const candidate = await host.debugExportCandidate(() => ({}), new AbortController().signal);
  assert.equal(candidate.hostError, "TypeError");
  assert.deepEqual(heldTickets(bridge), ["r1", "r2"]);
  candidate.release();
  await settle(context);
  assert.deepEqual(heldTickets(bridge), ["r1"]);
  assert.equal(captures, 1, "the first error's capture is the only one");
  made.scope.stop();
  await settle(context);
  assert.deepEqual(
    { runs: heldRuns(bridge), tickets: heldTickets(bridge) },
    { runs: [], tickets: [] },
  );
});

test("a Start that fails before it reaches the host commits its incident in its own run", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  const { host } = made;
  const exported = async () => {
    const candidate = await host.debugExportCandidate(() => ({}), new AbortController().signal);
    candidate.release();
    return candidate.hostError;
  };
  await host.loadScriptStorage();
  const bridge = await host.bridge;
  const prepared = await bridge.client.request("prepare", { source: { kind: "source", script } });
  // EVIDENCE: fixture: `prepare` of a source replies with its held plan's token.
  const plan = (prepared.result as { readonly plan: string }).plan;
  // A fresh Player whose first Start's options throw.
  host.prepare({
    plan,
    options: () => {
      throw new TypeError("The options could not be read.");
    },
  });
  host.activate();
  await settle(context);
  assert.equal(host.hostError.value, "TypeError");
  assert.equal(await exported(), "TypeError");
  // Its run, the connection's first, with no older one; no session.
  assert.deepEqual(heldRuns(bridge), [1]);
  // A later Start whose options throw another error: its own run, so its own incident.
  host.prepare({
    plan,
    options: () => {
      throw new RangeError("The options are out of range.");
    },
  });
  host.activate();
  await settle(context);
  assert.equal(host.hostError.value, "RangeError");
  assert.equal(await exported(), "RangeError");
  made.scope.stop();
  await settle(context);
  assert.deepEqual(
    { runs: heldRuns(bridge), tickets: heldTickets(bridge) },
    { runs: [], tickets: [] },
  );
});

test("a debug export copies the shown publication's events and transcript, after Back and Return too", async (context) => {
  const { host, rewind } = createHost(context, memoryStorage().provider);
  const exportedPrefix = async () =>
    prefixOf((await host.debugExportCandidate(() => ({}), new AbortController().signal)).session);
  await start(context, host);
  await choose(context, host, "One");
  const live = prefixOf(shownView(host));
  assert.ok(live.events.length > 0 && live.transcript.length > 0, "the session has said something");
  assert.deepEqual(await exportedPrefix(), live);
  assert.equal(await backTo(rewind, 0), true);
  assert.deepEqual(await exportedPrefix(), prefixOf(shownView(host)), "the restored state's");
  assert.equal(await rewind.returnToSession(), true);
  await settle(context);
  assert.deepEqual(await exportedPrefix(), prefixOf(shownView(host)), "the reinstated session's");
});

/*
 * L5h.3b, Sol code r2's B2-L: each activation's run reaches the host once, on its first host request, or on its incident's
 * commit when it failed before one; either way it ends the run before it. So the host holds the latest activation's run
 * only, across successes and failures, and none once the Player is disposed of.
 */
test("the host holds only the latest activation's run, whether activations succeed or fail before the host", async (context) => {
  const made = createHost(context, memoryStorage().provider, { lossy: true });
  const { host } = made;
  const bridge = await host.bridge;
  await host.loadScriptStorage();
  const prepared = await bridge.client.request("prepare", { source: { kind: "source", script } });
  // EVIDENCE: fixture: `prepare` of a source replies with its held plan's token.
  const plan = (prepared.result as { readonly plan: string }).plan;
  const failing = () => {
    host.prepare({
      plan,
      options: () => {
        throw new TypeError("The options could not be read.");
      },
    });
    host.activate();
    return settle(context);
  };
  const held: number[][] = [];
  await start(context, host);
  held.push(heldRuns(bridge));
  await failing();
  held.push(heldRuns(bridge));
  await failing();
  held.push(heldRuns(bridge));
  await start(context, host);
  held.push(heldRuns(bridge));
  await failing();
  held.push(heldRuns(bridge));
  made.scope.stop();
  await settle(context);
  held.push(heldRuns(bridge));
  assert.deepEqual(held, [[1], [2], [3], [4], [5], []]);
});

/*
 * L5h.3b, B2-L-C (orchestrator 2's invariant): every host message that names an activation's run carries its begin, and
 * the host begins the run the first time it sees it, whatever the message: a Start's, Continue's handoff, a halt's or an
 * incident's stop arguments. Generated over the activation × where it fails × how its Player
 * error reaches the host; each case then Starts anew and disposes of the Player. The host holds the latest activation's
 * run only, and none after the disposal.
 */
const RUN_AXES = {
  activation: ["heldStart", "continue"],
  failure: ["none", "beforeHost", "afterHost"],
  path: ["none", "commitIncident", "halt"],
} as const;
type RunCase = { readonly [A in keyof typeof RUN_AXES]: (typeof RUN_AXES)[A][number] };

/** A case's coordinates as the case they name. */
function asRunCase(coordinates: Coordinates): RunCase {
  // EVIDENCE: invariant: `product` gives the declared axes' values.
  return coordinates as RunCase;
}

/** Why a combination is no case, or `null` for a feasible one. */
function runInfeasible({ activation, failure, path }: RunCase): string | null {
  if ((failure === "none") !== (path === "none"))
    return "an error reaches the host exactly when one happens";
  if (activation === "continue" && path === "commitIncident")
    return "a Continue has its restored session, which its error stops";
  if (activation !== "continue" && failure === "beforeHost" && path === "halt")
    return "a Start that failed before the host has no session to halt";
  return null;
}

test("each activation's run reaches the host once, however the activation ends, and ends the run before it", async (context) => {
  const cases = product({ ...RUN_AXES }).filter(
    (coordinates) => runInfeasible(asRunCase(coordinates)) === null,
  );
  const observed: Coordinates[] = [];
  for (const coordinates of cases) {
    const c = asRunCase(coordinates);
    await context.test(`${c.activation} ${c.failure} ${c.path}`, async (subtest) => {
      const made = createHost(subtest, memoryStorage().provider, { lossy: true });
      const { host } = made;
      const bridge = await host.bridge;
      await start(subtest, host);
      const held = [heldRuns(bridge)];
      const failed = new TypeError("The activation failed.");
      if (c.activation === "continue") {
        const first = host.session.value!;
        host.prepareRestore(
          hostIntroduced(
            bridge,
            restorePlayerRuntimeSessionAt(
              onHost((session: PlayerRuntimeSession) => session.plan)(first),
              JSON.stringify(playerRuntimeSnapshot(first)),
              first.events,
            ),
          ),
        );
        if (c.failure === "beforeHost") {
          // Its handoff fails before it is posted: the host never sees the run but through the halt.
          const request = bridge.client.request.bind(bridge.client);
          let pending = true;
          subtest.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
            if (args[0] !== "beginRecording" || !pending) return request(...args);
            pending = false;
            return Promise.reject(failed);
          });
        }
        host.activate();
      } else {
        const prepared = await bridge.client.request("prepare", {
          source: { kind: "source", script },
        });
        // EVIDENCE: fixture: `prepare` of a source replies with its held plan's token.
        const plan = (prepared.result as { readonly plan: string }).plan;
        host.prepare({
          // A plan the host does not hold fails the Start in the host, after its run began there.
          plan: c.failure === "afterHost" && c.path === "commitIncident" ? "p0" : plan,
          options: () => {
            if (c.failure === "beforeHost") throw failed;
            return host.scriptStorageOptions();
          },
        });
      }
      if (c.activation !== "continue") host.activate();
      await settle(subtest);
      // A Player error after the activation reached the host and made its session.
      if (c.failure === "afterHost" && c.path === "halt") {
        host.reportHostError(failed);
        await settle(subtest);
      }
      if (c.failure !== "none")
        assert.notEqual(host.hostError.value, null, "the activation failed");
      // Each run's export shows its own error, and the successful run after it none.
      const exported = async () => {
        const candidate = await host.debugExportCandidate(() => ({}), new AbortController().signal);
        candidate.release();
        return candidate.hostError;
      };
      const errors = [await exported()];
      held.push(heldRuns(bridge));
      await start(subtest, host);
      errors.push(await exported());
      held.push(heldRuns(bridge));
      made.scope.stop();
      await settle(subtest);
      held.push(heldRuns(bridge));
      assert.deepEqual(held, [[1], [2], [3], []]);
      // A held Start of a plan the host does not hold fails there, with the host's `Error`.
      const own =
        c.failure === "none"
          ? null
          : c.activation === "heldStart" && c.path === "commitIncident" && c.failure === "afterHost"
            ? "Error"
            : "TypeError";
      assert.deepEqual(errors, [own, null]);
      assert.deepEqual(heldTickets(bridge), []);
    });
    observed.push(coordinates);
  }
  assert.deepEqual(
    coverageGaps(
      product({ ...RUN_AXES }).filter(
        (coordinates) => runInfeasible(asRunCase(coordinates)) === null,
      ),
      observed,
      { tuples: true },
    ),
    [],
  );
});

/*
 * L5h.3b, design round r2: an activation's completions act only while the activation lives (`useActivationRun`), and
 * the host refuses whatever names a run that ended (`ExportObservation.retiredThrough`). Generated over where a
 * completion is in transit when its Player error is reported × how the activation retires × its successor × when the
 * held replies arrive × what the last live Player exports. The host's actual replies are held in transit, in order, as
 * an ordered channel holds them; requests still reach the host. Expectations come from the coordinates: the runs and
 * tickets the host holds, the diagnostic work the page starts after the retirement, the incident each export shows,
 * and that no stale reply changes the successor. Excluded, with where it is decided: a lost connection, which serves no
 * request, so no completion of it reaches a host (`player-bridge-loss.test.ts`); a failure capture that settles
 * unavailable, refused or lost, which holds no ticket to leak (`player-failure-recording.test.ts`); the full composable
 * over a Worker (L5i.7).
 */
const LIFETIME_AXES = {
  boundary: ["startReply", "continueReply", "haltAck", "captureReply"],
  retirement: ["none", "replacement", "disposal"],
  successor: ["absent", "samePlayer", "newPlayer"],
  order: ["beforeRetirement", "afterRetirement", "afterSuccessor"],
  observation: ["none", "export", "restoreExport"],
} as const;
type LifetimeCase = {
  readonly [A in keyof typeof LIFETIME_AXES]: (typeof LIFETIME_AXES)[A][number];
};

/** A case's coordinates as the case they name. */
function asLifetimeCase(coordinates: Coordinates): LifetimeCase {
  // EVIDENCE: invariant: `product` gives the declared axes' values.
  return coordinates as LifetimeCase;
}

/** Why a combination is no case, or `null` for a feasible one. */
function lifetimeInfeasible(c: LifetimeCase): string | null {
  if (c.retirement === "none" && (c.successor !== "absent" || c.order !== "beforeRetirement"))
    return "nothing retires the activation: its replies arrive, and no successor begins";
  if ((c.successor === "samePlayer") !== (c.retirement === "replacement"))
    return "a successor in the same Player is the replacement that retires the activation";
  if (c.successor === "newPlayer" && c.retirement !== "disposal")
    return "a new Player claims the connection only once the first gave it up";
  if (c.successor === "absent" && c.order === "afterSuccessor") return "no successor begins";
  if (c.retirement === "replacement" && c.order === "afterRetirement")
    return "the successor's begin is the retirement: nothing comes between them";
  if (
    c.retirement === "replacement" &&
    c.order === "afterSuccessor" &&
    (c.boundary === "startReply" || c.boundary === "continueReply")
  )
    return "a later activation begins only once the one in flight settled (`begunInFlight`)";
  const live = c.retirement === "none" || c.successor !== "absent";
  if (!live && c.observation !== "none") return "no Player lives to export";
  if (live && c.observation === "none") return "the live Player exports";
  if (
    c.retirement === "none" &&
    c.observation === "restoreExport" &&
    (c.boundary === "startReply" || c.boundary === "continueReply")
  )
    return "an activation its error stopped before any input of its own has no earlier point to go Back to";
  return null;
}

/** The host's replies held in transit, in order: the in-process transport delivers each in a microtask of its own. */
function holdTransport(context: TestContext) {
  const deliveries: (() => void)[] = [];
  const real = globalThis.queueMicrotask;
  const scheduling = context.mock.method(
    globalThis,
    "queueMicrotask",
    (callback: () => void) => void deliveries.push(callback),
  );
  return {
    /** Lets the oldest held reply through. */
    passOne: () => deliveries.splice(0, 1).forEach((deliver) => real(deliver)),
    release() {
      scheduling.mock.restore();
      for (const deliver of deliveries.splice(0)) real(deliver);
    },
  };
}

/** What the page posts over `bridge`, in order, with the retirement count it was posted after. */
function postsOf(context: TestContext, bridge: PlayerBridge) {
  const posts: {
    readonly op: string;
    readonly args: unknown;
    readonly phase: number;
    /** A request's reply, as the page receives it; none for a post or a signal. */
    readonly reply?: Promise<unknown>;
  }[] = [];
  const state = { phase: 0 };
  const request = bridge.client.request.bind(bridge.client);
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    const reply = request(...args);
    posts.push({ op: args[0], args: args[1], phase: state.phase, reply });
    return reply;
  });
  const post = bridge.client.post.bind(bridge.client);
  context.mock.method(bridge.client, "post", (...args: Parameters<typeof post>) => {
    posts.push({ op: args[0], args: args[1], phase: state.phase });
    return post(...args);
  });
  const signal = bridge.client.signal.bind(bridge.client);
  context.mock.method(bridge.client, "signal", (...args: Parameters<typeof signal>) => {
    posts.push({ op: args[0], args: args[1], phase: state.phase });
    return signal(...args);
  });
  return {
    posts,
    /** Marks the retirement: what is posted from now on is after it. */
    retired: () => void (state.phase = 1),
    /** The page's diagnostic work after the retirement: error halts, incidents, failure captures; plain halts apart. */
    afterRetirement() {
      const after = posts.filter((post) => post.phase === 1);
      return {
        diagnosticHalts: after.filter((post) => post.op === "halt" && post.args !== null).length,
        incidents: after.filter((post) => post.op === "commitIncident").length,
        captures: after.filter((post) => post.op === "captureRecording").length,
        plainHalts: after.filter((post) => post.op === "halt" && post.args === null).length,
        released: after
          .filter((post) => post.op === "releaseRecording")
          .map((post) => {
            // EVIDENCE: fixture: `releaseRecording`'s arguments name its ticket.
            const { ticket } = post.args as { readonly ticket: string };
            return ticket;
          }),
      };
    },
  };
}

/** The diagnostic run a Player session belongs to, as its publication carries it. */
function runOfShown(host: RewindHost): number | null {
  // EVIDENCE: fixture: a host session's publication carries its diagnostic identity (`Publication.diagnostic`).
  const shown = host.session.value as {
    readonly diagnostic?: { readonly run: number | null };
  } | null;
  return shown?.diagnostic?.run ?? null;
}

/** The host's ID of the session the Player shows, or `null` before one shows. */
function shownId(host: RewindHost): string | null {
  // EVIDENCE: fixture: a host session's publication carries its host ID (`PlayerSession.id`).
  const shown = host.session.value as { readonly id?: string } | null;
  return shown?.id ?? null;
}

/** Starts `host` on `plan`, prepared before any hold: under a held transport (`held`) its show waits for the release. */
async function startOn(context: TestContext, host: RewindHost, plan: string, held: boolean) {
  await host.loadScriptStorage();
  host.prepare({ plan, options: () => ({ ...host.scriptStorageOptions() }) });
  host.activate();
  if (held) await settle(context);
  else await untilShown(context, host);
}

/** A further Player on `bridge`, as a page that claims the connection after another gave it up. */
async function playerOn(context: TestContext, bridge: PlayerBridge) {
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({ bridge: Promise.resolve(bridge), scriptStorage: memoryStorage().provider }),
  )!;
  const debug = effectScope();
  const rewind = debug.run(() => useDebugRewind(host))!;
  const stop = () => {
    debug.stop();
    scope.stop();
  };
  context.after(stop);
  await host.bridge;
  return { host, rewind, stop };
}

/** What a lifetime case observes. */
interface LifetimeObserved {
  readonly carrier: { readonly run: number; readonly retires: number | null } | null;
  readonly runsWhileLive: readonly number[];
  readonly afterRetirement: ReturnType<ReturnType<typeof postsOf>["afterRetirement"]> | null;
  readonly successorUntouched: boolean | null;
  readonly pageError: string | null;
  readonly shownRun: number | null;
  readonly exported: {
    readonly hostError: string | null;
    readonly during: readonly string[];
    readonly after: readonly string[];
  } | null;
  readonly finalRuns: readonly number[];
  readonly finalTickets: readonly string[];
}

/** What each lifetime case must give, from its coordinates alone. */
function lifetimeExpected(c: LifetimeCase): LifetimeObserved {
  // The first Start is run 1; Continue's activation is run 2 after it.
  const own = c.boundary === "continueReply" ? 2 : 1;
  const successor = c.successor !== "absent";
  const retired = c.retirement !== "none";
  // The activation's failure capture is posted with its halt, unless a Start's reply is what waits: its stop target
  // comes only with that reply, which a retired activation no longer acts on.
  const captured = c.boundary !== "startReply" || c.order === "beforeRetirement" || !retired;
  // The export's own ticket follows the failure capture's, when one was allocated.
  const exportTicket = captured ? "r2" : "r1";
  return {
    carrier: { run: own, retires: own === 1 ? null : own - 1 },
    runsWhileLive: retired ? (successor ? [own + 1] : []) : [own],
    afterRetirement: retired
      ? {
          diagnosticHalts: 0,
          incidents: 0,
          captures: 0,
          // A Start's late session of a retired activation is only stopped.
          plainHalts:
            c.boundary === "startReply" &&
            c.retirement === "disposal" &&
            c.order !== "beforeRetirement"
              ? 1
              : 0,
          // The retired activation's failure ticket goes, whenever its capture settles; then the export's own.
          released: [
            ...(captured ? ["r1"] : []),
            ...(c.observation === "none" ? [] : [exportTicket]),
          ],
        }
      : null,
    successorUntouched: c.order === "afterSuccessor" ? true : null,
    pageError: retired ? null : "TypeError",
    shownRun: c.observation === "none" ? null : retired ? own + 1 : own,
    exported:
      c.observation === "none"
        ? null
        : retired
          ? { hostError: null, during: [exportTicket], after: [] }
          : { hostError: "TypeError", during: ["r1", "r2"], after: ["r1"] },
    finalRuns: [],
    finalTickets: [],
  };
}

test("an activation's completions act only while it lives, whichever reply is in transit when it retires", async (context) => {
  const cases = product({ ...LIFETIME_AXES }).filter(
    (coordinates) => lifetimeInfeasible(asLifetimeCase(coordinates)) === null,
  );
  const observed: Coordinates[] = [];
  for (const coordinates of cases) {
    const c = asLifetimeCase(coordinates);
    await context.test(Object.values(c).join(" "), async (subtest) => {
      const made = createHost(subtest, memoryStorage().provider, { lossy: true });
      const first = { host: made.host, rewind: made.rewind, stop: () => made.scope.stop() };
      const bridge = await first.host.bridge;
      await first.host.loadScriptStorage();
      // The successor's plan, prepared before any hold: a source prepare behind held replies would wait for them.
      const successorPlan = await preparedSource(bridge, script);
      const traffic = postsOf(subtest, bridge);
      const failed = new TypeError("The activation failed.");
      let transport: ReturnType<typeof holdTransport>;
      // Where the activation under test begins in the traffic: a Continue's comes after its Start's own `start` post.
      let carrierFrom = 0;
      if (c.boundary === "startReply") {
        const prepared = await bridge.client.request("prepare", {
          source: { kind: "source", script },
        });
        // EVIDENCE: fixture: `prepare` of a source replies with its held plan's token.
        const plan = (prepared.result as { readonly plan: string }).plan;
        transport = holdTransport(subtest);
        first.host.prepare({ plan, options: () => first.host.scriptStorageOptions() });
        first.host.activate();
        await settle(subtest);
        assert.equal(first.host.session.value, null, "the Start's reply waits in transit");
      } else if (c.boundary === "continueReply") {
        await start(subtest, first.host);
        const shown = first.host.session.value!;
        first.host.prepareRestore(
          hostIntroduced(
            bridge,
            restorePlayerRuntimeSessionAt(
              onHost((session: PlayerRuntimeSession) => session.plan)(shown),
              JSON.stringify(playerRuntimeSnapshot(shown)),
              shown.events,
            ),
          ),
        );
        transport = holdTransport(subtest);
        carrierFrom = traffic.posts.length;
        first.host.activate();
        await settle(subtest);
      } else {
        await start(subtest, first.host);
        await choose(subtest, first.host, "One");
        transport = holdTransport(subtest);
      }
      first.host.reportHostError(failed);
      await settle(subtest);
      // The capture's reply waits behind the halt's acknowledgement, which arrives first.
      if (c.boundary === "captureReply") {
        transport.passOne();
        await settle(subtest);
      }
      const carrierPost = traffic.posts
        .slice(carrierFrom)
        .find(
          (post) =>
            (post.op === "halt" && post.args !== null) ||
            post.op === "commitIncident" ||
            post.op === "start" ||
            post.op === "beginRecording",
        );
      const startRun = (args: unknown) => {
        // EVIDENCE: fixture: a Start's arguments carry its run's begin.
        const { run } = args as {
          readonly run: { readonly run: number; readonly retires: number | null };
        };
        return run;
      };
      const carrierArgs =
        carrierPost === undefined
          ? null
          : carrierPost.op === "start"
            ? startRun(carrierPost.args)
            : carrierPost.args;
      // EVIDENCE: fixture: the carriers this file's activations post hold a run's begin.
      const begin = carrierArgs as { readonly run: number; readonly retires: number | null } | null;
      let live = c.retirement === "none" ? first : null;
      const later: { player: Awaited<ReturnType<typeof playerOn>> | null } = { player: null };
      let untouched: boolean | null = null;
      const retire = async () => {
        traffic.retired();
        if (c.retirement === "disposal") first.stop();
        else {
          await startOn(subtest, first.host, successorPlan, c.order === "afterSuccessor");
          live = first;
        }
        await settle(subtest);
      };
      const begin2 = async () => {
        if (c.successor === "newPlayer") {
          later.player = await playerOn(subtest, bridge);
          await startOn(subtest, later.player.host, successorPlan, c.order === "afterSuccessor");
          live = later.player;
        }
      };
      if (c.order === "beforeRetirement") {
        transport.release();
        await settle(subtest);
      }
      if (c.retirement !== "none") await retire();
      if (c.order !== "afterSuccessor") {
        transport.release();
        await settle(subtest);
      }
      await begin2();
      if (c.order === "afterSuccessor") {
        // The successor's own replies, its Start's too, wait behind the stale ones and then show: stale work that acted
        // would show another session, another run or the page's error in place of the successor's own.
        const successorStart = traffic.posts.findLast((post) => post.op === "start")!;
        const successorRun = startRun(successorStart.args).run;
        transport.release();
        for (let round = 0; round < 20 && runOfShown(live!.host) !== successorRun; round += 1)
          await settle(subtest);
        // EVIDENCE: fixture: a `start` reply names the session it began.
        const { session: successorSession } = (await successorStart.reply) as {
          readonly session: string;
        };
        untouched = isDeepStrictEqual(
          {
            session: shownId(live!.host),
            run: runOfShown(live!.host),
            error: live!.host.hostError.value,
          },
          { session: successorSession, run: successorRun, error: null },
        );
      }
      const runsWhileLive = heldRuns(bridge);
      let exported: LifetimeObserved["exported"] = null;
      let shownRun: number | null = null;
      if (live !== null) {
        const player: { host: RewindHost; rewind: Rewind } = live;
        if (c.retirement !== "none") await choose(subtest, player.host, "One");
        if (c.observation === "restoreExport") assert.equal(await backTo(player.rewind, 0), true);
        shownRun = runOfShown(player.host);
        const candidate = await player.host.debugExportCandidate(
          () => ({}),
          new AbortController().signal,
        );
        const during = heldTickets(bridge);
        candidate.release();
        await settle(subtest);
        exported = { hostError: candidate.hostError, during, after: heldTickets(bridge) };
      }
      const pageError = live === null ? null : live.host.hostError.value;
      first.stop();
      later.player?.stop();
      await settle(subtest);
      assert.deepEqual(
        {
          carrier: begin === null ? null : { run: begin.run, retires: begin.retires },
          runsWhileLive,
          afterRetirement: c.retirement === "none" ? null : traffic.afterRetirement(),
          successorUntouched: untouched,
          pageError,
          shownRun,
          exported,
          finalRuns: heldRuns(bridge),
          finalTickets: heldTickets(bridge),
        },
        lifetimeExpected(c),
      );
    });
    observed.push(coordinates);
  }
  assert.deepEqual(
    coverageGaps(
      product({ ...LIFETIME_AXES }).filter(
        (coordinates) => lifetimeInfeasible(asLifetimeCase(coordinates)) === null,
      ),
      observed,
      { tuples: true },
    ),
    [],
  );
});

/** Holds the replies of `op` on `bridge` until `release(error)`: the host's answer, or `error` in its place. */
function holdOp(context: TestContext, bridge: PlayerBridge, op: string) {
  let open!: (error: Error | null) => void;
  const gate = new Promise<Error | null>((resolve) => (open = resolve));
  const request = bridge.client.request.bind(bridge.client);
  const held = { count: 0 };
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    if (args[0] !== op) return request(...args);
    held.count += 1;
    const answered = request(...args);
    return gate.then((error) => (error === null ? answered : Promise.reject(error)));
  });
  return { held: () => held.count, release: (error: Error | null = null) => open(error) };
}

// Design round r2: Continue's asynchronous handlers keep the activation they began in. A trace restart that fails only
// after a successor began stops nothing of the successor.
test("a Continue's trace restart that fails after a successor began reports nothing to the successor", async (context) => {
  const { host } = createHost(context, memoryStorage().provider);
  const bridge = await host.bridge;
  host.setDebugTracing(true);
  await settle(context);
  await start(context, host);
  const shown = host.session.value!;
  host.prepareRestore(
    hostIntroduced(
      bridge,
      restorePlayerRuntimeSessionAt(
        onHost((session: PlayerRuntimeSession) => session.plan)(shown),
        JSON.stringify(playerRuntimeSnapshot(shown)),
        shown.events,
      ),
    ),
  );
  const restart = holdOp(context, bridge, "restartTrace");
  host.activate();
  await settle(context);
  assert.equal(runOfShown(host), 2, "the Continue's run");
  assert.equal(restart.held(), 1, "its trace restart waits");
  await start(context, host);
  const traffic = postsOf(context, bridge);
  traffic.retired();
  restart.release(new Error("The trace could not restart."));
  await settle(context);
  assert.deepEqual(
    {
      error: host.hostError.value,
      run: runOfShown(host),
      runs: heldRuns(bridge),
      after: traffic.afterRetirement(),
    },
    {
      error: null,
      run: 3,
      runs: [3],
      after: { diagnosticHalts: 0, incidents: 0, captures: 0, plainHalts: 0, released: [] },
    },
  );
});

// Design round r2: an export keeps the activation it began in. One that waits for a Player error's capture while its
// activation retires gives no candidate and holds nothing.
test("an export that waits for a failure capture while its activation retires gives no candidate and holds no ticket", async (context) => {
  const { host } = createHost(context, memoryStorage().provider);
  const bridge = await host.bridge;
  await start(context, host);
  await choose(context, host, "One");
  const capture = holdOp(context, bridge, "captureRecording");
  host.reportHostError(new TypeError("A component failed."));
  await settle(context);
  const traffic = postsOf(context, bridge);
  const pending = host.debugExportCandidate(() => ({}), new AbortController().signal);
  await settle(context);
  assert.equal(capture.held(), 1, "the export waits for the failure capture");
  await start(context, host);
  capture.release();
  await settle(context);
  const candidate = await pending;
  await settle(context);
  assert.deepEqual(
    {
      candidate,
      exports: traffic.posts.filter((post) => post.op === "captureExport").length,
      tickets: heldTickets(bridge),
    },
    { candidate: null, exports: 0, tickets: [] },
  );
});
