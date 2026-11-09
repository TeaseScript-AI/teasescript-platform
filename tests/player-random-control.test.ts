import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { compilePlayerProject } from "../player/runtime/compile-project.js";
import { BridgeRequestError, connectBridge } from "../player/engine-bridge/client.js";
import { heldRandom, introduceNow } from "../player/engine-bridge/in-process.js";
import { nodeWorkerPort } from "../player/engine-bridge/node-client.js";
import type { ResolveDrawResult } from "../player/engine-bridge/ops/random.js";
import { HeldSession } from "../player/engine-bridge/ops/session.js";
import {
  alignRandom,
  playerBridgeOps,
  playerOpsContext,
  type PrepareResult,
  type RandomIntent,
} from "../player/engine-bridge/player-ops.js";
import { PlayerBridge } from "../player/runtime/player-bridge.js";
import { decideDraw, RandomHistory, type RandomNext } from "../player/debug/random-decisions.js";
import {
  beginPlayerRuntimeCatchUp,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  resumePlayerRuntimeRandomDraw,
} from "../player/runtime/runtime-adapter.js";
import type { PlayerSession } from "../player/runtime/runtime-view.js";
import { listRandomSites, type InstructionPlan, type RandomOutcome } from "../src/playback.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../src/temporal.js";
import { inProcessBridge } from "./helpers/in-process-bridge.js";
import { NO_MARKS } from "../player/debug/debug-history-marks.js";
import { clockTicket } from "./helpers/clock-ticket.js";

/*
 * L5i.4: Debug's random control as the engine host's connection state. Its owner's sessions decide their draws from the
 * newest random intent, whichever channel brings it; a session of a Player that ended neither reads nor changes the
 * next one's; a reset an intent overtook still resets; a changed control never meets a catch-up's copy.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../player/engine-bridge/node-worker.js", import.meta.url);
const START = { wallClockMs: 0, temporalContext: DEFAULT_TEMPORAL_CONTEXT };

async function worker(): Promise<PlayerBridge> {
  return new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));
}

/** Both backends, the Worker's ended after `body`. */
async function onBoth(body: (bridge: PlayerBridge, name: string) => Promise<void>) {
  await body(await inProcessBridge(), "in-process");
  const remote = await worker();
  try {
    await body(remote, "worker");
  } finally {
    remote.client.terminate();
  }
}

function compiled(script: string): InstructionPlan {
  const plan = compilePlayerProject(script).plan;
  assert.ok(plan, "the fixture compiles");
  return plan;
}

async function prepared(bridge: PlayerBridge, plan: InstructionPlan): Promise<string> {
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: serializeValidatedRuntimeJson(plan) },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const result = reply.result as PrepareResult;
  assert.equal(result.kind, "prepared");
  return result.kind === "prepared" ? result.plan : "";
}

/** The plan's sites of `kinds`, in that order: `listRandomSites` gives no source order. */
const sitesOf = (plan: InstructionPlan, ...kinds: string[]) =>
  kinds.map(
    (kind) =>
      listRandomSites(plan).find((site) => site.kinds.some((each) => each === kind))?.id ?? "",
  );

/** An intent of `owner`: Choose outcomes on with `sites` (every other site asks), or off. */
const intentOf = (
  owner: number,
  intent: number,
  sites: readonly (readonly [string, RandomNext])[] | null,
  resetAt = 0,
): RandomIntent => ({ owner, control: sites === null ? null : { sites }, resetAt, intent });

/** Sends `intent`, after `ahead`'s earlier requests when given; it adopts no session. */
function control(bridge: PlayerBridge, intent: RandomIntent, ahead?: PlayerSession) {
  return bridge.client.request(
    "randomControl",
    { intent },
    ahead === undefined ? {} : { after: ahead.id },
  );
}

const resolve = (
  bridge: PlayerBridge,
  session: PlayerSession,
  drawId: number,
  outcome: "natural" | "untried" | RandomOutcome,
  record: { readonly resetAt: number } | null = { resetAt: 0 },
) => bridge.request<ResolveDrawResult>(session, "resolveDraw", { drawId, outcome, record });

const tried = (bridge: PlayerBridge, session: PlayerSession, site: string) =>
  bridge.read(session, "randomTried", { site });

const shown = (bridge: PlayerBridge, session: PlayerSession) => bridge.latest(session)!;
const said = (session: { readonly transcriptEntries: readonly { readonly text: string }[] }) =>
  session.transcriptEntries.map((entry) => entry.text);

/** Holds `session`'s turn until the returned function releases it. */
function holdTurn(bridge: PlayerBridge, session: PlayerSession) {
  let release = () => {};
  const held = bridge.section(
    session,
    clockTicket(),
    () => new Promise<void>((done) => (release = done)),
  );
  return async () => {
    release();
    await held;
  };
}

/** The adapter's own control, with the same history and settings: the oracle of what the host's control must do. */
function adapterMirror(plan: InstructionPlan, settings: ReadonlyMap<string, RandomNext>) {
  const history = new RandomHistory();
  let session = createPlayerRuntimeSession(plan, {
    ...START,
    randomControl: { decide: (draw) => decideDraw(settings, history, draw) },
  });
  return {
    history,
    get session() {
      return session;
    },
    resolve(outcome: "natural" | "untried" | RandomOutcome) {
      const draw = session.state.randomDraw!;
      let resolved: "natural" | RandomOutcome = outcome === "untried" ? "natural" : outcome;
      if (outcome === "untried") {
        const least = history.leastTried(draw);
        resolved = least === null || least === draw.natural ? "natural" : least;
      }
      const taken = resolved === "natural" ? draw.natural : resolved;
      const undo = taken.kind === "failure" ? null : history.record(draw, taken);
      const result = resumePlayerRuntimeRandomDraw(session, {
        drawId: draw.drawId,
        outcome: resolved,
      });
      if (result.outcome.kind !== "resolved") undo?.();
      session = result.session;
      return result.outcome;
    },
  };
}

test("the host's control decides, pauses, refuses and records as the adapter's own control does", async () => {
  const plan = compiled(
    'for turn in 1..=3 {\n    let hit = chance(50)\n    let roll = randomInteger(1..=6)\n    say "${hit} ${roll}", instant\n}\nshowButton "Done"\nexit',
  );
  const [hitSite = "", rollSite = ""] = sitesOf(plan, "chance", "randomInteger");
  const settings: [string, RandomNext][] = [[hitSite, "untried"]];
  await onBoth(async (bridge, name) => {
    const mirror = adapterMirror(plan, new Map(settings));
    const session = await bridge.start(await prepared(bridge, plan), START, false, {
      owner: 1,
      intent: intentOf(1, 1, settings),
    });
    const steps: ("natural" | "untried" | RandomOutcome)[] = [
      { kind: "number", value: 123 },
      { kind: "number", value: 6 },
      "untried",
      "natural",
    ];
    for (const step of steps) {
      const draw = shown(bridge, session).state.randomDraw!;
      assert.equal(draw.site, rollSite, name);
      const result = await resolve(bridge, session, draw.drawId, step);
      assert.deepEqual(result.outcome, mirror.resolve(step), `${name}: ${JSON.stringify(step)}`);
      assert.deepEqual(said(shown(bridge, session)), said(mirror.session), name);
    }
    // A stale draw is refused as the adapter refuses it.
    assert.deepEqual(
      (await resolve(bridge, session, 1, "natural")).outcome,
      resumePlayerRuntimeRandomDraw(mirror.session, { drawId: 1, outcome: "natural" }).outcome,
      name,
    );
    for (const site of [hitSite, rollSite]) {
      const host = await tried(bridge, session, site);
      const own = mirror.history.tried(site);
      assert.deepEqual(
        [host!.history, host!.first, host!.counts],
        [own.history, own.first, own.counts],
        name,
      );
    }
    const capture = await bridge.read(session, "captureCheckpoint");
    assert.equal(
      capture.checkpointJson,
      createPlayerRuntimeRestorePoint(mirror.session).checkpointJson,
      name,
    );
  });
});

test("a refused resolution leaves the history exactly as before, for a site with outcomes and for one without", async () => {
  const plan = compiled(
    'for turn in 1..=2 {\n    let hit = chance(50)\n    let roll = randomInteger(1..=6)\n}\nshowButton "Done"\nexit',
  );
  const [hitSite = "", rollSite = ""] = sitesOf(plan, "chance", "randomInteger");
  await onBoth(async (bridge, name) => {
    const session = await bridge.start(await prepared(bridge, plan), START, false, {
      owner: 1,
      intent: intentOf(1, 1, []),
    });
    // The first hit taken, so its site has outcomes; the roll's site has none yet.
    await resolve(bridge, session, shown(bridge, session).state.randomDraw!.drawId, "natural");
    const refusals: [string, RandomOutcome][] = [
      [rollSite, { kind: "number", value: 123 }],
      [hitSite, { kind: "number", value: 123 }],
    ];
    // Malformed outcomes too (Sol r1 C1): one the engine refuses, or one whose shape makes the op fail.
    // EVIDENCE: fixture: deliberately malformed outcomes, which the bridge carries as plain records.
    const malformed = JSON.parse(
      '[{"kind":"number"},{"kind":"index"},{"kind":"boolean","value":"yes"},{"kind":"order","order":[9]},{"kind":"unknown"}]',
    ) as RandomOutcome[];
    for (const [site, refusal] of refusals) {
      // At the roll, then (after taking the roll) at the second hit.
      const before = JSON.stringify(await tried(bridge, session, site));
      const draw = shown(bridge, session).state.randomDraw!;
      assert.equal(draw.site, site, name);
      for (const outcome of [refusal, ...malformed]) {
        const refused = await resolve(bridge, session, draw.drawId, outcome).catch(() => null);
        assert.notEqual(refused?.outcome.kind, "resolved", `${name}: ${JSON.stringify(outcome)}`);
        assert.equal(
          JSON.stringify(await tried(bridge, session, site)),
          before,
          `${name}: ${site}, ${JSON.stringify(outcome)}`,
        );
      }
      await resolve(bridge, session, draw.drawId, "natural");
    }
  });
});

test("a settings change posted before an observation applies to the draws that observation makes", async () => {
  const plan = compiled(
    'wait 1 s\nlet hit = chance(50)\nsay "after", instant\nshowButton "Done"\nexit',
  );
  await onBoth(async (bridge, name) => {
    const session = await bridge.start(await prepared(bridge, plan), START, false, { owner: 1 });
    void control(bridge, intentOf(1, 1, []), session);
    await bridge.request(session, "observeTime", { atMs: 2_000, media: [] });
    assert.notEqual(shown(bridge, session).state.randomDraw, null, `${name}: paused at its draw`);
    assert.deepEqual(said(shown(bridge, session)), [], name);
  });
});

test("a settings change racing a Start applies to the right session: queued, and through the facade", async () => {
  const plan = compiled('let hit = chance(50)\nsay "after", instant\nshowButton "Done"\nexit');
  await onBoth(async (bridge, name) => {
    const token = await prepared(bridge, plan);
    const before = await bridge.start(token, START, false, { owner: 1 });
    // The intent waits behind the earlier session's held turn; the Start carries it.
    const release = holdTurn(bridge, before);
    const waiting = control(bridge, intentOf(1, 1, []), before);
    const started = await bridge.start(token, START, false, {
      owner: 1,
      intent: intentOf(1, 1, []),
    });
    assert.notEqual(started.state.randomDraw, null, `${name}: the Start runs with its intent`);
    assert.equal(before.state.randomDraw, null, `${name}: the earlier session ran without it`);
    await release();
    await waiting;
    assert.notEqual(shown(bridge, started).state.randomDraw, null, name);
  });
  // In-process, a Start in the host carries a newer intent than one still queued: the older one changes nothing.
  const bridge = await inProcessBridge(5);
  const token = await prepared(bridge, plan);
  const blocking = bridge.client.request("prepare", { source: { kind: "source", script: "exit" } });
  const older = control(bridge, intentOf(1, 1, null));
  const started = introduceNow(
    bridge,
    { plan: token, options: START, recording: false },
    NO_MARKS,
    undefined,
    { owner: 1, intent: intentOf(1, 2, []) },
  );
  assert.notEqual(started.state.randomDraw, null, "the facade's Start pauses at its first draw");
  await blocking;
  await older;
  assert.notEqual(heldRandom(bridge).control, null, "the older queued intent changed nothing");
});

test("a reset an intent overtook still resets once, and a repeated watermark resets nothing", async () => {
  const plan = compiled(
    'for turn in 1..=3 {\n    let hit = chance(50)\n}\nlet roll = randomInteger(1..=6)\nshowButton "Done"\nexit',
  );
  const [hitSite = ""] = sitesOf(plan, "chance");
  await onBoth(async (bridge, name) => {
    const token = await prepared(bridge, plan);
    // The hit site's draws go on by themselves, recorded; each session pauses at its roll.
    const first = await bridge.start(token, START, false, {
      owner: 1,
      intent: intentOf(1, 1, [[hitSite, "random"]]),
    });
    assert.equal((await tried(bridge, first, hitSite))!.history.length, 3, name);
    // The reset (2) waits behind the session's held turn; a newer intent (3) that carries it overtakes it.
    const release = holdTurn(bridge, first);
    const reset = control(bridge, intentOf(1, 2, null, 2), first);
    const second = await bridge.start(token, START, false, {
      owner: 1,
      intent: intentOf(1, 3, [[hitSite, "random"]], 2),
    });
    assert.equal(
      (await tried(bridge, second, hitSite))!.history.length,
      3,
      `${name}: forgotten, then three anew`,
    );
    await release();
    await reset;
    // The same watermark again forgets nothing.
    await control(bridge, intentOf(1, 4, [[hitSite, "random"]], 2), second);
    assert.equal((await tried(bridge, second, hitSite))!.history.length, 3, name);
  });
});

test("a session of a Player that ended neither decides by nor records into the next Player's history", async () => {
  const plan = compiled(
    'wait 1 s\nlet hit = chance(50)\nsay "hit ${hit}", instant\nshowButton "Done"\nexit',
  );
  const [hitSite = ""] = sitesOf(plan, "chance");
  await onBoth(async (bridge, name) => {
    const token = await prepared(bridge, plan);
    const old = await bridge.start(token, START, false, {
      owner: 1,
      intent: intentOf(1, 1, [[hitSite, "untried"]]),
    });
    // Its observation, queued before the handover, runs after the next Player asks at every draw.
    const release = holdTurn(bridge, old);
    const observed = bridge.request(old, "observeTime", { atMs: 2_000, media: [] });
    const next = await bridge.start(token, START, false, { owner: 2, intent: intentOf(2, 2, []) });
    const before = JSON.stringify(await tried(bridge, next, hitSite));
    await release();
    await observed;
    assert.equal(
      shown(bridge, old).state.randomDraw,
      null,
      `${name}: the old session paused nowhere`,
    );
    assert.equal(said(shown(bridge, old)).length, 1, `${name}: it went on naturally`);
    assert.equal(
      JSON.stringify(await tried(bridge, next, hitSite)),
      before,
      `${name}: nothing entered the next history`,
    );
    assert.equal(await tried(bridge, old, hitSite), null, `${name}: the old session reads none`);
  });
});

test("an old Player's queued Least tried is refused before it reads the next Player's history", async () => {
  const plan = compiled(
    'let roll = randomInteger(1..=6)\nsay "${roll}", instant\nshowButton "Done"\nexit',
  );
  const [rollSite = ""] = sitesOf(plan, "randomInteger");
  await onBoth(async (bridge, name) => {
    const token = await prepared(bridge, plan);
    const old = await bridge.start(token, START, false, { owner: 1, intent: intentOf(1, 1, []) });
    const drawId = shown(bridge, old).state.randomDraw!.drawId;
    const release = holdTurn(bridge, old);
    const queued = resolve(bridge, old, drawId, "untried");
    // The next Player's history: a forced six at its own session's roll.
    const next = await bridge.start(token, START, false, { owner: 2, intent: intentOf(2, 2, []) });
    await resolve(bridge, next, shown(bridge, next).state.randomDraw!.drawId, {
      kind: "number",
      value: 6,
    });
    const before = JSON.stringify(await tried(bridge, next, rollSite));
    await release();
    assert.deepEqual((await queued).outcome, { kind: "notOwned" }, name);
    assert.notEqual(shown(bridge, old).state.randomDraw, null, `${name}: the old session waits on`);
    assert.equal(JSON.stringify(await tried(bridge, next, rollSite)), before, name);
  });
});

test("a changed control never meets a catch-up's copy: an adoption keeps its copy, a replacement begins anew", async () => {
  const plan = compiled(
    'repeat 20 {\n    wait 10 ms\n}\nlet hit = chance(50)\nsay "hit", instant\nshowButton "Done"\nexit',
  );
  await onBoth(async (bridge, name) => {
    const token = await prepared(bridge, plan);
    // Adopted after the control changed: the copy ran without it, and the session's next draw pauses.
    const session = await bridge.start(token, START, false, { owner: 1 });
    await bridge.request(session, "beginCatchUp", { targetMs: 100 });
    while ((await bridge.request<string>(session, "stepCatchUp", { budgetMs: 50 })) === "more");
    await control(bridge, intentOf(1, 1, []), session);
    const adopted = await bridge.request<{ readonly adopted: boolean }>(
      session,
      "adoptCatchUp",
      null,
    );
    assert.equal(adopted.adopted, true, `${name}: the adoption keeps the copy`);
    assert.ok(shown(bridge, session).state.observedSessionTimeMs >= 100, name);
    await bridge.request(session, "observeTime", { atMs: 1_000, media: [] });
    assert.notEqual(shown(bridge, session).state.randomDraw, null, `${name}: then the control`);
    // A catch-up begun again after the change runs with the control: its draw pauses the session.
    const other = await bridge.start(token, START, false, { owner: 1 });
    await bridge.request(other, "beginCatchUp", { targetMs: 1_000 });
    await control(bridge, intentOf(1, 2, null), other);
    await control(bridge, intentOf(1, 3, []), other);
    await bridge.request(other, "beginCatchUp", { targetMs: 1_000 });
    let step: string;
    while (
      (step = await bridge.request<string>(other, "stepCatchUp", { budgetMs: 50 })) === "more"
    );
    if (step === "done") await bridge.request(other, "adoptCatchUp", null);
    else await bridge.request(other, "observeTime", { atMs: 1_000, media: [] });
    assert.notEqual(shown(bridge, other).state.randomDraw, null, `${name}: no draw ran without it`);
  });
});

test("a held session's next read attaches a changed control only after ending a catch-up in flight", () => {
  const plan = compiled(
    'repeat 20 {\n    wait 10 ms\n}\nlet hit = chance(50)\nshowButton "Done"\nexit',
  );
  const context = playerOpsContext();
  const held = new HeldSession(
    createPlayerRuntimeSession(plan, START),
    "p1",
    context,
    NO_MARKS,
    1,
    null,
  );
  held.beginCatchUp(beginPlayerRuntimeCatchUp(held.sessionForOperation(), 1_000));
  alignRandom(context, intentOf(1, 1, []));
  // The publication as it is keeps the catch-up; reading the session ends it and attaches.
  void held.publication;
  assert.notEqual(held.catchUp, null);
  const current = held.sessionForOperation();
  assert.equal(held.catchUp, null);
  assert.notEqual(observePlayerRuntimeTime(current, 1_000, []).session.state.randomDraw, null);
});

// The op-table invariant: every session op runs its session through `sessionForOperation`, which attaches a changed control only
// after ending a catch-up; only `adoptCatchUp` reads the publication as it is, to adopt the copy it made.
const SESSION_OPS: Readonly<
  Record<
    string,
    | "ends a catch-up"
    | "runs through sessionForOperation"
    | "steps the copy"
    | "reads a view"
    | "adopts"
  >
> = {
  continue: "runs through sessionForOperation",
  observeTime: "ends a catch-up",
  observeInput: "ends a catch-up",
  stepTime: "ends a catch-up",
  beginCatchUp: "ends a catch-up",
  stepCatchUp: "steps the copy",
  adoptCatchUp: "adopts",
  dropCatchUp: "ends a catch-up",
  skipPacing: "ends a catch-up",
  viewCalls: "reads a view",
  beginRecording: "runs through sessionForOperation",
  restartTrace: "runs through sessionForOperation",
  setDebugMode: "runs through sessionForOperation",
  resolveDraw: "runs through sessionForOperation",
  reportMediaLoad: "ends a catch-up",
  submitComposer: "runs through sessionForOperation",
  selectChoice: "runs through sessionForOperation",
  activateButton: "runs through sessionForOperation",
  stepFormField: "runs through sessionForOperation",
  dismissFormField: "runs through sessionForOperation",
  clearFormField: "runs through sessionForOperation",
  draftForm: "runs through sessionForOperation",
  submitForm: "runs through sessionForOperation",
  cancelForm: "runs through sessionForOperation",
  skipImage: "runs through sessionForOperation",
  answerImage: "runs through sessionForOperation",
  openUrl: "runs through sessionForOperation",
  closePopup: "runs through sessionForOperation",
  closeExport: "runs through sessionForOperation",
  pressPermanentButton: "runs through sessionForOperation",
  completeStorageWrite: "runs through sessionForOperation",
  applyStorageEdit: "runs through sessionForOperation",
  answerCapture: "ends a catch-up",
  answerFileStore: "ends a catch-up",
  answerLock: "ends a catch-up",
  historyEnroll: "runs through sessionForOperation",
};

test("every session op is classified, and only adoptCatchUp reads a session past its attach", () => {
  const ops = Object.entries(playerBridgeOps())
    .filter(([, op]) => op.session === "existing")
    .map(([name]) => name)
    .sort();
  assert.deepEqual(ops, Object.keys(SESSION_OPS).sort(), "each session op is in the table");
  const folder = new URL("../../player/engine-bridge/", import.meta.url);
  const readers: string[] = [];
  for (const dir of ["", "ops/"])
    for (const file of readdirSync(new URL(dir, folder)).filter((each) => each.endsWith(".ts")))
      for (const line of readFileSync(new URL(dir + file, folder), "utf8").split("\n"))
        if (/\w\.publication\b/u.test(line)) readers.push(`${dir}${file}: ${line.trim()}`);
  assert.equal(readers.length, 1, readers.join("\n"));
  assert.match(readers[0]!, /adoptPlayerRuntimeCatchUp\(held\.publication/u);
});

// The caller inventory of Continue's boundary (Sol plan P5, code r1 C3): the calls that introduce or restore a session
// in the session composable's files, `useDebugRewind.ts` and `rewindOwner.ts`, by these callee spellings (`startedSession`,
// `introduceNow`, `prepareRestore`, `host.start`, `showRewound`, `host.show`), each classified. Only a Start carries its Player's
// random ownership (`startRandom()`); a restore takes it at its adoption. A new such call in those files fails until it
// is classified. A new module, or an indirection under another name, needs adding here.
const SESSION_INTRODUCTIONS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  "player/vue/src/session/usePlayerSession.ts": [],
  "player/vue/src/session/activation/useSessionActivation.ts": [
    [
      "begin: (origin) => startedSession(create, { debugMode: debugModeOn() }, origin)",
      "start: Start",
    ],
    ["introduceNow(requireBridge(), () => given, marks ?? NO_MARKS)", "restore: a raw restore"],
    ["return introduceNow(", "by kind: `startedSession`'s factory, with `random`"],
    [
      "return host.start(create.plan, startOptions, true, random, origin.begin)",
      "by kind: `startedSession`'s held plan",
    ],
  ],
  "player/vue/src/session/persistence/useKeptSession.ts": [
    ["prepareRestore(found.session)", "restore: a kept session"],
  ],
  "player/vue/src/session/useSessionRewind.ts": [
    ["show: (next, paused) => showRewound(next, { paused })", "restore: the rewind owner's show"],
  ],
  "player/vue/src/debug/history/useDebugRewind.ts": [],
  "player/vue/src/session/rewindOwner.ts": [
    [
      "host.show(next, paused)",
      "restore: a session Debug's rewind restored or reinstated in the host, shown by its owner",
    ],
  ],
};

/** The session composable's files: `usePlayerSession.ts` and the owner modules it is composed of. */
const COMPOSABLE_FILES = [
  "player/vue/src/session/usePlayerSession.ts",
  "player/vue/src/session/useRandomControl.ts",
  "player/vue/src/session/useDebugModeAndTrace.ts",
  "player/vue/src/session/useSessionMedia.ts",
  "player/vue/src/session/useSessionRewind.ts",
  "player/vue/src/session/persistence/useStorageRoute.ts",
  "player/vue/src/session/persistence/useSavedValues.ts",
  "player/vue/src/session/persistence/useKeptSession.ts",
  "player/vue/src/session/persistence/useSavedDataTransfer.ts",
  "player/vue/src/session/persistence/useSessionTransfer.ts",
  "player/vue/src/session/activation/useSessionActivation.ts",
] as const;
/** The text of the session composable's files, one after another. */
function composableText(): string {
  return COMPOSABLE_FILES.map((file) =>
    readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"),
  ).join("\n");
}

// The senders of a random op in the session composable, found by their op names as string literals, each classified: only
// `adoptRandom` gives a session a Player's control, and only at the invariant's points; a settings change never does
// (orchestrator 2's ruling on P5's fourth occurrence). A sender in another module needs adding here.
const RANDOM_SENDERS: readonly (readonly [string, string])[] = [
  ['op: "randomControl" | "adoptRandom",', "the senders' type"],
  ['"randomControl",', "not adopting: a settings change (`flushRandom`)"],
  ['"randomControl",', "not adopting: the Player's teardown"],
  ['"adoptRandom",', "adopting: `adoptRandom`, the one adoption"],
  ['.request("releaseRandom",', "releasing: Continue before its kept draw went on"],
  [
    'clock().before("randomControl");',
    "no sender: the clock's work kind before a settings change (`before`)",
  ],
];

test("every random-op sender in the composable is classified as adopting or not", () => {
  const lines = composableText()
    .split("\n")
    .filter((line) => /"(randomControl|adoptRandom|releaseRandom)"/u.test(line));
  assert.equal(lines.length, RANDOM_SENDERS.length, lines.map((line) => line.trim()).join(" / "));
  const left = [...lines];
  for (const [anchor, kind] of RANDOM_SENDERS) {
    const at = left.findIndex((line) => line.includes(anchor));
    assert.notEqual(at, -1, `${kind} at ${anchor}`);
    left.splice(at, 1);
  }
  // `adoptRandom` is called only at the invariant's points.
  const composable = composableText();
  const calls = composable
    .split("\n")
    .filter((line) => /\badoptRandom\(/u.test(line) && !/function adoptRandom/u.test(line));
  assert.deepEqual(
    calls.map((line) => line.trim()),
    [
      // The activation owner's and the rewind owner's dependencies, which forward their adoption to the random control's.
      "adoptRandom: (next, origin) => adoptRandom(next, origin),",
      "adoptRandom: (next) => adoptRandom(next, activationRun.current()),",
      "if (!paused) adoptRandom(next, activationRun.current());",
      "if (session.value !== null) adoptRandom(session.value);",
      "adoptRandom(continued, origin);",
    ],
  );
});

test("every session introduction in the composable and rewind is classified as a Start or a restore", () => {
  const callee =
    /\b(startedSession|introduceNow|prepareRestore|host\.start|showRewound|host\.show)\(/u;
  const definition = /function (startedSession|prepareRestore|showRewound)\(/u;
  for (const [file, classified] of Object.entries(SESSION_INTRODUCTIONS)) {
    const calls = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
      .split("\n")
      .filter((line) => callee.test(line) && !definition.test(line));
    assert.equal(
      calls.length,
      classified.length,
      `${file}: ${calls.map((line) => line.trim()).join(" / ")}`,
    );
    const left = [...calls];
    for (const [anchor, kind] of classified) {
      const at = left.findIndex((line) => line.includes(anchor));
      assert.notEqual(at, -1, `${file}: ${kind} at ${anchor}`);
      left.splice(at, 1);
    }
  }
  // `startedSession` carries `startRandom()` for a Start only; the activation owner's dependency forwards it.
  const composable = composableText();
  assert.deepEqual(
    composable.match(/.*startRandom\(\).*/gu)?.map((line) => line.trim()),
    ["startRandom: () => startRandom(),", "const random = startRandom();"],
  );
});

test("malformed random arguments are refused before anything runs", async () => {
  const bridge = await inProcessBridge();
  const plan = compiled("let roll = randomInteger(1..=6)\nexit");
  const session = await bridge.start(await prepared(bridge, plan), START, false, {
    owner: 1,
    intent: intentOf(1, 1, []),
  });
  const refused = (error: unknown) =>
    error instanceof BridgeRequestError && error.code === "arguments";
  for (const intent of [
    null,
    { ...intentOf(1, 2, []), owner: 0 },
    { ...intentOf(1, 2, []), intent: 0 },
    { ...intentOf(1, 2, []), resetAt: 3 },
    { ...intentOf(1, 2, []), control: { sites: [["a", "ask"]] } },
    { ...intentOf(1, 2, []), more: 1 },
  ])
    await assert.rejects(
      bridge.client.request("randomControl", { intent }),
      refused,
      JSON.stringify(intent),
    );
  const drawId = shown(bridge, session).state.randomDraw!.drawId;
  for (const args of [
    { drawId, outcome: "natural" },
    { drawId, outcome: 3, record: null },
    { drawId, outcome: "natural", record: { resetAt: "0" } },
  ])
    await assert.rejects(
      bridge.request(session, "resolveDraw", args),
      refused,
      JSON.stringify(args),
    );
  await assert.rejects(bridge.client.request("randomTried", { session: session.id }), refused);
  // A settings change names no session: only `adoptRandom` gives one control.
  await assert.rejects(
    bridge.client.request("randomControl", { intent: intentOf(1, 3, []), session: session.id }),
    refused,
  );
  for (const args of [
    { session: session.id },
    { intent: intentOf(1, 3, []) },
    { session: 1, intent: intentOf(1, 3, []) },
  ])
    await assert.rejects(bridge.client.request("adoptRandom", args), refused, JSON.stringify(args));
  for (const args of [{}, { session: 1 }, { session: session.id, more: 1 }])
    await assert.rejects(
      bridge.client.request("releaseRandom", args),
      refused,
      JSON.stringify(args),
    );
  await assert.rejects(
    bridge.start("p1", START, false, { owner: 1, intent: intentOf(2, 1, []) }),
    refused,
  );
});
