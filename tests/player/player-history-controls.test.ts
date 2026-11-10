import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { before, type TestContext } from "node:test";
import { effectScope, type EffectScope, type Ref } from "vue";

import {
  BridgeLostError,
  HISTORY_CONTROL_OPS,
  openBridge,
  type ClientPort,
} from "../../player/engine-bridge/client.js";
import { historyOps } from "../../player/engine-bridge/ops/history.js";
import { playerOpsContext } from "../../player/engine-bridge/player-ops.js";
import { decodeMessage } from "../../player/engine-bridge/transport.js";
import type * as CompileProject from "../../player/runtime/compile-project.js";
import type * as InProcess from "../../player/engine-bridge/in-process.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type {
  PlayerRuntimeSession,
  PlayerRuntimeSessionOptions,
} from "../../player/runtime/runtime-adapter.js";
import { playerRuntimeForeground, type PlayerSession } from "../../player/runtime/runtime-view.js";
import {
  presentedAction,
  runtimeInput,
  type RuntimeInput,
} from "../helpers/player/player-input.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import { memoryStorage } from "../helpers/player/rewind-host.js";
import { untypedClient } from "../helpers/bridge/untyped.js";

/*
 * #2150 PR 1: Debug's rewind history controls are posted when the Player's rewind lifecycle decides them, in the host's
 * arrival order, behind no unrelated request's reply (`BridgeClient.post`). The sender sends the history controls and
 * nothing else. With a busy connection queue, Debug turned on during a session takes the choice shown then as its first
 * point even when it is answered at once, and each rewind step and Debug's end and return settle as with an idle queue.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };

/** A port that keeps what the client posts, decoded, and answers nothing until the test replies. */
function heldPort() {
  const posted: { readonly id: number; readonly op: string }[] = [];
  let toClient: ((data: unknown) => void) | null = null;
  const port: ClientPort = {
    post: (message) => {
      // EVIDENCE: fixture: the client posts encoded requests, each with an ID and an op.
      const data = decodeMessage(structuredClone(message)) as {
        readonly id: number;
        readonly op: string;
      };
      posted.push({ id: data.id, op: data.op });
    },
    listen: (listener) => void (toClient = listener),
    onFailure: () => {},
    terminate: () => {},
  };
  const reply = (id: number) =>
    toClient?.({
      v: 1,
      kind: "reply",
      id,
      session: null,
      ok: true,
      revision: null,
      eventsThrough: null,
      result: null,
      view: null,
    });
  return { port, posted, reply };
}

test("the history controls are the host's connection ops of Debug's rewind, but for the adoption's read", () => {
  const host = historyOps(playerOpsContext());
  // `captureStorage` reads a held session's saved values for an adoption, after that session's earlier work.
  const reads = new Set(["captureStorage"]);
  const connectionOps = Object.entries(host)
    .filter(([name, op]) => op.session === "none" && !reads.has(name))
    .map(([name]) => name)
    .sort();
  assert.deepEqual([...HISTORY_CONTROL_OPS].sort(), connectionOps);
});

test("post sends the history controls alone, refuses on a lost client, and says so before it returns", () => {
  const { port, posted } = heldPort();
  const { client } = openBridge(port, BUILD);
  const raw = untypedClient(client);
  for (const op of [
    "selectChoice",
    "observeTime",
    "observeInput",
    "halt",
    "planMetadata",
    "noSuchOp",
  ]) {
    const sent = raw.post(op, {});
    assert.equal(sent.posted, false, op);
  }
  assert.deepEqual(posted, []);
  const unclonable = raw.post("historyTimeline", { history: () => 1 });
  assert.equal(unclonable.posted, false, "arguments that cannot cross");
  assert.deepEqual(posted, []);
  client.terminate();
  const lost = client.post("historyTimeline", { history: 1 });
  assert.equal(lost.posted, false);
  assert.ok(!lost.posted && lost.error instanceof BridgeLostError);
});

test("a history control is posted at once, ahead of a connection request still waiting for an earlier reply", () => {
  const { port, posted, reply } = heldPort();
  const { client } = openBridge(port, BUILD);
  void client.request("planMetadata", { plan: "p1" }).catch(() => {});
  // Waits for the first one's reply on the connection's queue.
  void client.request("planMetadata", { plan: "p1" }).catch(() => {});
  const sent = client.post("historyClose", { history: 1, by: "debugOff" });
  assert.equal(sent.posted, true);
  if (sent.posted) void sent.reply.catch(() => {});
  assert.deepEqual(
    posted.map((each) => each.op),
    ["planMetadata", "historyClose"],
  );
  reply(posted[0]!.id);
  return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
    assert.deepEqual(
      posted.map((each) => each.op),
      ["planMetadata", "historyClose", "planMetadata"],
    );
    client.terminate();
  });
});

// The real Player with Debug's rewind, on a host that replies late, with connection requests queued before each step.

interface RewindPlayer {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly stopped: Readonly<Ref<boolean>>;
  readonly bridge: Promise<PlayerBridge>;
  readonly inputSection: unknown;
  readonly rewind: {
    readonly owner: { readonly state: { readonly blocked: boolean; readonly debug: boolean } };
  };
  prepare(create: (recording: PlayerRuntimeSessionOptions) => PlayerRuntimeSession): void;
  activate(): Promise<void>;
  loadScriptStorage(): Promise<void>;
  /** Adopts an inspected state as the session before input, as the Player's controls do. */
  prepareInput(): true | Promise<boolean>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
}
interface DebugRewind {
  readonly state: Readonly<
    Ref<{
      readonly history: number | null;
      readonly points: readonly { readonly id: number }[];
      readonly inspection: unknown;
    }>
  >;
  back(point: number): Promise<boolean>;
  forward(): Promise<boolean>;
  returnToSession(): Promise<boolean>;
}
let usePlayerSession: (options: Record<string, unknown>) => RewindPlayer;
let useDebugRewind: (player: RewindPlayer) => DebugRewind;
let facade: typeof InProcess;
let compiler: typeof CompileProject;
let input: RuntimeInput;

before(async () => {
  const session = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  const rewind = await loadPlayerModule("player/vue/src/debug/history/useDebugRewind.ts");
  assert.equal(typeof session.usePlayerSession, "function");
  assert.equal(typeof rewind.useDebugRewind, "function");
  // EVIDENCE: validation: Vite loaded the real source modules and the exports are callable; this is their tested API.
  usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: as above.
  useDebugRewind = rewind.useDebugRewind as typeof useDebugRewind;
  // EVIDENCE: validation: the bundle the composable runs in, whose backend it uses.
  facade = (await loadPlayerModule("player/engine-bridge/in-process.ts")) as typeof facade;
  // EVIDENCE: validation: the bundle's compiler module, from the same module graph.
  compiler = (await loadPlayerModule("player/runtime/compile-project.ts")) as typeof compiler;
  input = await runtimeInput();
});

const REWIND = readFileSync(
  new URL("../../../tests/fixtures/packages/rewind/main.tease", import.meta.url),
  "utf8",
);
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string) {
  const end = performance.now() + 8_000;
  while (!check()) {
    assert.ok(performance.now() < end, `${what} did not happen`);
    await later(2);
  }
}

/**
 * The Player on a host replying after 5 ms, started on the rewind fixture: with Debug's rewind and its first point, or,
 * `debug` false, with Debug off until `toggle`.
 */
async function mount(context: TestContext, debug = true) {
  for (const [name, value] of Object.entries({
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    Audio: class {
      src = "";
      play = async () => {};
      pause() {}
      load() {}
      removeAttribute() {}
    },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const reported: unknown[] = [];
  const write = console.error.bind(console);
  context.mock.method(console, "error", (...args: unknown[]) => {
    if (args[0] === "[player] host error") reported.push(args[1]);
    else write(...args);
  });
  const bridge = facade.createInProcessBackend(BUILD, { delayMs: 5 });
  const scope = effectScope();
  // Saved data an adoption can replace.
  const storage = memoryStorage();
  const player = scope.run(() =>
    usePlayerSession({ bridge: Promise.resolve(bridge), scriptStorage: storage.provider }),
  )!;
  let scoped: EffectScope | null = null;
  let rewind: DebugRewind | null = null;
  const debugOn = () => {
    scoped = effectScope();
    rewind = scoped.run(() => useDebugRewind(player))!;
  };
  if (debug) debugOn();
  context.after(() => {
    scoped?.stop();
    scope.stop();
    bridge.client.terminate();
  });
  await player.bridge;
  if (debug) await until(() => rewind!.state.value.history !== null, "the first history's open");
  await player.loadScriptStorage();
  player.prepare((recording) =>
    compiler.createPlayerRuntimeSession(REWIND, {
      ...player.scriptStorageOptions(),
      ...recording,
      wallClockMs: 0,
    }),
  );
  await player.activate();
  if (debug) await until(() => rewind!.state.value.points.length === 1, "the first point");
  else
    await until(() => playerRuntimeForeground(player.session.value!) !== null, "the first choice");
  const answer = async () => {
    const current = player.session.value!;
    const foreground = playerRuntimeForeground(current);
    assert.ok(foreground?.kind === "choose");
    return input.runInput(
      player.inputSection,
      presentedAction(current),
      presentedAction,
      input.intents.choice(foreground.options[0]!.id, "button"),
    );
  };
  /** Four connection requests, queued before what the test does next. */
  const busy = () => {
    const plan = player.session.value!.planToken;
    return Promise.allSettled(
      [1, 2, 3, 4].map(() => bridge.client.request("planMetadata", { plan })),
    );
  };
  return {
    player,
    bridge,
    reported,
    rewind: () => rewind!,
    answer,
    busy,
    /** Ends Debug's features and runs them again, as the Debug switch does. */
    toggle: () => {
      scoped?.stop();
      debugOn();
    },
  };
}

/** The Player is as healthy as with an idle queue: not stopped, its rewind not blocked, nothing reported. */
function healthy(mounted: Awaited<ReturnType<typeof mount>>) {
  assert.equal(mounted.player.stopped.value, false, "stopped");
  assert.equal(mounted.player.rewind.owner.state.blocked, false, "blocked");
  assert.deepEqual(mounted.reported, []);
}

test("Debug's end and a new history behind a busy connection queue: the session goes on, nothing blocks", async (context) => {
  const mounted = await mount(context);
  const queued = mounted.busy();
  mounted.toggle();
  await queued;
  await until(() => mounted.rewind().state.value.points.length === 1, "the new history's point");
  healthy(mounted);
});

test("Debug turned on behind a busy connection queue: the choice shown then is a point, answered at once", async (context) => {
  const mounted = await mount(context, false);
  const queued = mounted.busy();
  mounted.toggle();
  await until(() => mounted.player.rewind.owner.state.debug, "the open's decision");
  await mounted.answer();
  await queued;
  await until(() => mounted.rewind().state.value.points.length === 2, "both points");
  healthy(mounted);
});

test("Back, Forward and Return behind a busy connection queue settle as with an idle one", async (context) => {
  const mounted = await mount(context);
  await mounted.answer();
  await until(() => mounted.rewind().state.value.points.length === 2, "the second point");
  const points = mounted.rewind().state.value.points;
  void mounted.busy();
  assert.equal(await mounted.rewind().back(points[0]!.id), true, "Back");
  void mounted.busy();
  assert.equal(await mounted.rewind().forward(), true, "Forward");
  void mounted.busy();
  assert.equal(await mounted.rewind().returnToSession(), true, "Return");
  await until(() => mounted.rewind().state.value.inspection === null, "the inspection's end");
  healthy(mounted);
});

test("Debug's end during an inspection, behind a busy connection queue, reinstates the session it left", async (context) => {
  const mounted = await mount(context);
  await mounted.answer();
  await until(() => mounted.rewind().state.value.points.length === 2, "the second point");
  const left = mounted.player.session.value!.lineage;
  assert.equal(await mounted.rewind().back(mounted.rewind().state.value.points[0]!.id), true);
  const queued = mounted.busy();
  mounted.toggle();
  await queued;
  await until(
    () =>
      mounted.player.session.value?.lineage === left &&
      mounted.rewind().state.value.history !== null,
    "the reinstated session's new history",
  );
  healthy(mounted);
});

test("an adoption of an inspected state behind a busy connection queue goes on as the session", async (context) => {
  const mounted = await mount(context);
  await mounted.answer();
  await until(() => mounted.rewind().state.value.points.length === 2, "the second point");
  assert.equal(await mounted.rewind().back(mounted.rewind().state.value.points[0]!.id), true);
  void mounted.busy();
  assert.equal(await mounted.player.prepareInput(), true, "the adoption");
  const answered = await mounted.answer();
  assert.equal(answered.kind, "answered");
  await until(() => mounted.rewind().state.value.inspection === null, "the adoption");
  healthy(mounted);
});
