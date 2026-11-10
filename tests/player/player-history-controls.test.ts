import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { before, type TestContext } from "node:test";
import { effectScope, type EffectScope, type Ref } from "vue";

import { BridgeLostError, openBridge, type ClientPort } from "../../player/engine-bridge/client.js";
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
import { interceptSends } from "../helpers/bridge/sends.js";

/*
 * #2150 PR 1: Debug's rewind history controls are posted when the Player's rewind lifecycle decides them, in the host's
 * arrival order, behind no unrelated request's reply, as every request of no session now is (`BridgeClient.request` and
 * `post`). With a busy connection queue, Debug turned on during a session takes the choice shown then as its first
 * point even when it is answered at once, and each rewind step and Debug's end and return settle as with an idle queue.
 *
 * #2150 PR 2: every opener renews the history in one host operation (`historyRenew`) posted before the new session's
 * work, so an answer given before the renewal's reply is a point of the new history.
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

test("post says before it returns that it did not post, on a lost client or with arguments that cannot cross", () => {
  const { port, posted } = heldPort();
  const { client } = openBridge(port, BUILD);
  const unclonable = untypedClient(client).post("historyTimeline", { history: () => 1 });
  assert.equal(unclonable.posted, false, "arguments that cannot cross");
  assert.deepEqual(posted, []);
  client.terminate();
  const lost = client.post("historyTimeline", { history: 1 });
  assert.equal(lost.posted, false);
  assert.ok(!lost.posted && lost.error instanceof BridgeLostError);
});

test("requests of no session are posted in the order made, none behind a reply; a session's wait for its replies", () => {
  const { port, posted, reply } = heldPort();
  const { client } = openBridge(port, BUILD);
  const raw = untypedClient(client);
  for (const each of [
    raw.request("planMetadata", { plan: "p1" }),
    raw.request("stepTime", { targetMs: 1 }, { session: "s1", basis: 0 }),
    raw.request("stepTime", { targetMs: 2 }, { session: "s1", basis: 0 }),
    raw.request("planMetadata", { plan: "p1" }),
    raw.request("captureKeep", { session: "s1", plan: null }, { after: "s1" }),
  ])
    void each.catch(() => {});
  // Consecutive posts, and posts and requests mixed, all while every earlier reply is withheld.
  for (const sent of [
    client.post("historyClose", { history: 1, by: "debugOff", owner: 0 }),
    client.post("historyTimeline", { history: 1 }),
  ])
    if (sent.posted) void sent.reply.catch(() => {});
  void raw.request("planMetadata", { plan: "p1" }).catch(() => {});
  const last = client.post("historyTimeline", { history: 2 });
  if (last.posted) void last.reply.catch(() => {});
  assert.deepEqual(
    posted.map((each) => each.op),
    [
      "planMetadata",
      "stepTime",
      "planMetadata",
      "historyClose",
      "historyTimeline",
      "planMetadata",
      "historyTimeline",
    ],
  );
  assert.deepEqual(
    posted.map((each) => each.id),
    posted.map((each) => each.id).toSorted((a, b) => a - b),
    "in the order made",
  );
  reply(posted[1]!.id);
  return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
    assert.deepEqual(
      posted.slice(7).map((each) => each.op),
      ["stepTime"],
      "the session's next request, once its first has its reply",
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
  /** Ends the session and shows the start page, as the Player's Start page control does. */
  toStartPage(): void | Promise<void>;
  loadScriptStorage(): Promise<void>;
  /** Adopts an inspected state as the session before input, as the Player's controls do. */
  prepareInput(): true | Promise<boolean>;
  setDebugTracing(on: boolean): void;
  setDebugMode(on: boolean): void;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
}
interface DebugRewind {
  readonly state: Readonly<
    Ref<{
      readonly history: number | null;
      readonly points: readonly { readonly id: number; readonly response: unknown }[];
      readonly inspection: unknown;
    }>
  >;
  back(point: number): Promise<boolean>;
  forward(): Promise<boolean>;
  returnToSession(): Promise<boolean>;
}
let usePlayerSession: (options: Record<string, unknown>) => RewindPlayer;
let useDebugRewind: (player: RewindPlayer) => DebugRewind;
let usePlayerDebug: (
  player: RewindPlayer,
  initial: { readonly menu: boolean; readonly autoSkip: boolean },
) => { readonly menu: Ref<boolean> };
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
  const debug = await loadPlayerModule("player/vue/src/debug/usePlayerDebug.ts");
  assert.equal(typeof debug.usePlayerDebug, "function");
  // EVIDENCE: validation: as above, the Debug features' composable.
  usePlayerDebug = debug.usePlayerDebug as typeof usePlayerDebug;
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
    /** Ends Debug's features, as the Debug switch does. */
    debugOff: () => scoped?.stop(),
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

test("Debug's end posts its history close in the turn it decides it, behind a busy connection queue", async (context) => {
  const mounted = await mount(context);
  const queued = mounted.busy();
  const posted: string[] = [];
  const clone = globalThis.structuredClone;
  context.after(() => void (globalThis.structuredClone = clone));
  globalThis.structuredClone = <T>(value: T, options?: StructuredSerializeOptions): T => {
    if (
      typeof value === "object" &&
      value !== null &&
      "kind" in value &&
      value.kind === "request" &&
      "op" in value
    )
      posted.push(String(value.op));
    return clone(value, options);
  };
  mounted.debugOff();
  assert.ok(posted.includes("historyClose"), `posted in the same turn: ${posted.join(", ")}`);
  await queued;
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

test("Round 1 R1-01: Debug turned on, Back and Return behind a busy queue end on the trace Return began", async (context) => {
  const mounted = await mount(context, false);
  const plan = mounted.player.session.value!.planToken;
  const queued = Promise.allSettled(
    Array.from({ length: 60 }, () => mounted.bridge.client.request("planMetadata", { plan })),
  );
  // The order of `usePlayerDebug`'s enabled watcher: the features, then tracing, then Debug mode.
  mounted.toggle();
  mounted.player.setDebugTracing(true);
  mounted.player.setDebugMode(true);
  await until(() => mounted.rewind().state.value.points.length === 1, "the first point");
  await mounted.answer();
  await until(() => mounted.rewind().state.value.points.length === 2, "the second point");
  assert.equal(await mounted.rewind().back(mounted.rewind().state.value.points[0]!.id), true);
  assert.equal(await mounted.rewind().returnToSession(), true);
  await queued;
  await until(() => facade.heldTrace(mounted.bridge) !== null, "the trace");
  const status = facade.heldTrace(mounted.bridge)!.status();
  // Variables reads the origin as "Recording since Continue" (`DebugVariables.vue`).
  assert.deepEqual({ epoch: status.epoch, origin: status.origin }, { epoch: 3, origin: "restore" });
  healthy(mounted);
});

test("the in-process host holds a request made while it awaits another in its arrival order", async (context) => {
  const mounted = await mount(context);
  await mounted.answer();
  await until(() => mounted.rewind().state.value.points.length === 2, "the second point");
  const replies: number[] = [];
  const requests: { readonly op: string; readonly id: number }[] = [];
  const clone = globalThis.structuredClone;
  context.after(() => void (globalThis.structuredClone = clone));
  globalThis.structuredClone = <T>(value: T, options?: StructuredSerializeOptions): T => {
    if (typeof value === "object" && value !== null && "kind" in value && "id" in value) {
      // EVIDENCE: fixture: the bridge's envelopes carry a numeric ID, and a request its op.
      const envelope = value as {
        readonly kind: string;
        readonly id: number;
        readonly op?: string;
      };
      if (envelope.kind === "request" && envelope.op !== undefined)
        requests.push({ op: envelope.op, id: envelope.id });
      if (envelope.kind === "reply") replies.push(envelope.id);
    }
    return clone(value, options);
  };
  // Back reads its snapshot asynchronously: the host awaits it while the next request arrives.
  const back = mounted.rewind().back(mounted.rewind().state.value.points[0]!.id);
  const metadata = mounted.bridge.client.request("planMetadata", {
    plan: mounted.player.session.value!.planToken,
  });
  // A request made from a reply's hook, as a publication's reaction makes one.
  let nested: Promise<unknown> | null = null;
  await mounted.bridge.client.request(
    "planMetadata",
    { plan: mounted.player.session.value!.planToken },
    {
      onReply: () =>
        void (nested = mounted.bridge.client.request("planMetadata", {
          plan: mounted.player.session.value!.planToken,
        })),
    },
  );
  assert.equal(await back, true);
  await metadata;
  await nested;
  const backAt = requests.findIndex((each) => each.op === "rewindBack");
  const after = requests.slice(backAt + 1).find((each) => each.op === "planMetadata")!;
  const backReply = replies.indexOf(requests[backAt]!.id);
  // Posted before Back's reply, the request is answered only after it: the host held it in its queue.
  assert.ok(
    backReply >= 0 && replies.indexOf(after.id) > backReply,
    JSON.stringify({ requests, replies }),
  );
  healthy(mounted);
});

test("Round 2 R2-01: Debug turned on behind a busy queue traces from the moment it is turned on", async (context) => {
  const mounted = await mount(context, false);
  const plan = mounted.player.session.value!.planToken;
  const queued = Promise.allSettled(
    Array.from({ length: 100 }, () => mounted.bridge.client.request("planMetadata", { plan })),
  );
  const scope = effectScope();
  context.after(() => scope.stop());
  const debug = scope.run(() => usePlayerDebug(mounted.player, { menu: false, autoSkip: false }))!;
  debug.menu.value = true;
  await mounted.answer();
  // The base traced nothing until the queue drained: no record of this answer.
  const records = facade.heldTrace(mounted.bridge)?.status().records ?? 0;
  assert.ok(records > 0, `records of the first answer: ${records}`);
  await queued;
});

/**
 * Holds the reply of every renewal (`historyRenew`) the Player posts: the host runs it at once, and the page receives
 * its reply only at `release`.
 */
function holdRenewals(context: TestContext, bridge: PlayerBridge) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = 0;
  interceptSends(context, bridge.client, (op, _args, send) => {
    if (op !== "historyRenew") return send();
    held += 1;
    const reply = send();
    return gate.then(() => reply);
  });
  return { release, held: () => held };
}

test("#2150: a new Start's choice answered before its renewal's reply is the new history's first point", async (context) => {
  const mounted = await mount(context);
  const renewals = holdRenewals(context, mounted.bridge);
  const first = mounted.player.session.value!.lineage;
  await mounted.player.toStartPage();
  mounted.player.prepare((recording) =>
    compiler.createPlayerRuntimeSession(REWIND, {
      ...mounted.player.scriptStorageOptions(),
      ...recording,
      wallClockMs: 0,
    }),
  );
  await mounted.player.activate();
  await until(
    () =>
      mounted.player.session.value?.lineage !== first &&
      playerRuntimeForeground(mounted.player.session.value!) !== null,
    "the new session's choice",
  );
  assert.equal(renewals.held(), 1, "its renewal was posted, and its reply waits");
  assert.equal(mounted.rewind().state.value.history, null, "no history shows yet");
  const answered = await mounted.answer();
  assert.equal(answered.kind, "answered");
  renewals.release();
  await until(() => mounted.rewind().state.value.points.length === 2, "both points");
  const [point] = mounted.rewind().state.value.points;
  assert.ok(point!.response !== null, "the answered choice is the first point, with its answer");
  assert.equal(await mounted.rewind().back(point!.id), true, "Back to it");
  healthy(mounted);
});

test("#2150: Debug turned on, with the choice answered before its renewal's reply, keeps that choice as its first point", async (context) => {
  const mounted = await mount(context, false);
  const renewals = holdRenewals(context, mounted.bridge);
  mounted.toggle();
  await until(() => renewals.held() === 1, "the renewal's post");
  const answered = await mounted.answer();
  assert.equal(answered.kind, "answered");
  renewals.release();
  await until(() => mounted.rewind().state.value.points.length === 2, "both points");
  assert.ok(mounted.rewind().state.value.points[0]!.response !== null);
  healthy(mounted);
});

test("#2150: Debug turned on posts its renewal in that turn, behind the shown session's queued work", async (context) => {
  const mounted = await mount(context, false);
  const session = mounted.player.session.value!;
  // The session's own requests, each waiting for the one before it.
  const queued = Promise.allSettled(
    [1, 2, 3, 4].map(() => mounted.bridge.request(session, "observeTime", { atMs: 0, media: [] })),
  );
  const posted: string[] = [];
  const clone = globalThis.structuredClone;
  context.after(() => void (globalThis.structuredClone = clone));
  globalThis.structuredClone = <T>(value: T, options?: StructuredSerializeOptions): T => {
    if (
      typeof value === "object" &&
      value !== null &&
      "kind" in value &&
      value.kind === "request" &&
      "op" in value
    )
      posted.push(String(value.op));
    return clone(value, options);
  };
  mounted.toggle();
  // The renewal is posted in the turn the lifecycle decides it, before the session's queued replies come back.
  await until(() => mounted.player.rewind.owner.state.debug, "the renewal's decision");
  assert.ok(posted.includes("historyRenew"), `posted in the deciding turn: ${posted.join(", ")}`);
  await queued;
  await until(() => mounted.rewind().state.value.points.length === 1, "the first point");
  healthy(mounted);
});
