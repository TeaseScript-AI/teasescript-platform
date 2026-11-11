/*
 * The Player and its scene clock for the clock's tests (`player-clock-work.test.ts`, `player-clock-families.test.ts`):
 * a Player whose host requests are tracked and held (`mount`), and the clock alone over its session (`mountClock`).
 */

import assert from "node:assert/strict";
import { before, type TestContext } from "node:test";
import { effectScope, ref, shallowRef, type Ref } from "vue";

import { compilePlayerProject } from "../../../player/runtime/compile-project.js";
import type { StartOptions } from "../../../player/engine-bridge/ops/session.js";
import type { PrepareResult } from "../../../player/engine-bridge/player-ops.js";
import type { PlayerBridge } from "../../../player/runtime/player-bridge.js";
import type { PlayerSession } from "../../../player/runtime/runtime-view.js";
import {
  observePlayerRuntimeTime,
  type PlayerRuntimeSession,
} from "../../../player/runtime/runtime-adapter.js";
import { memoryKeptSessionStore } from "../../../player/persistence/kept-sessions.js";
import type { ScriptStorageProvider } from "../../../player/persistence/script-storage.js";
import { serializeValidatedRuntimeJson } from "../../../src/runtime/snapshot/checkpoint-json.js";
import { loadHostFacade, onHost } from "./host-sessions.js";
import { loadPlayerModule } from "../player-modules.js";
import type { ClockTicket } from "../../../player/runtime/clock-ticket.js";
import { untypedClient } from "../bridge/untyped.js";
import { inProcessBackend } from "./worker-topology.js";

interface SessionHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly bridge: Promise<PlayerBridge>;
  prepareScript(
    token: string,
    start: { readonly plan: string; readonly options: () => Omit<StartOptions, "debugMode"> },
  ): Promise<void>;
  scriptStorageOptions(): Omit<StartOptions, "debugMode">;
  temporalCapture(): Omit<StartOptions, "debugMode">;
  activate(): Promise<void>;
  loadScriptStorage(): Promise<void>;
  observe(): Promise<PlayerRuntimeSession | null>;
  setDebugMode(enabled: boolean): void;
  setRandomControl(control: { readonly sites: readonly [] } | null): void;
}
let usePlayerSession: (options: Record<string, unknown>) => SessionHost;
/** An observation the host runs at once on a session it holds, past the session's queue (the facade). */
export const observeOnHost = onHost(observePlayerRuntimeTime);
/** The bundle's refusal, which the composable's `refusalCode` recognizes. */
export let refusal: (code: string) => Error;

before(async () => {
  await loadHostFacade();
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/session/usePlayerSession.ts",
  );
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  const client: Record<string, unknown> = await loadPlayerModule("player/engine-bridge/client.ts");
  assert.equal(typeof client.BridgeRequestError, "function");
  // EVIDENCE: validation: the bundle's refusal class, checked as a constructor above.
  const Refusal = client.BridgeRequestError as new (info: Record<string, unknown>) => Error;
  refusal = (code) =>
    new Refusal({ kind: "bridge", class: "BridgeRefusal", code, message: "refused", ended: false });
});

/**
 * Ops whose reply the caller sees only once `release` is called (the host has run them, the session's queue goes
 * on), and section ops refused as their basis would be, without reaching the host.
 */
interface Gate {
  hold(op: string, count?: number): void;
  /** Lets the held replies through, or rejects them with `error`. */
  release(error?: Error): void;
  /** Lets the oldest held reply through, and keeps the others held. */
  releaseFirst(): void;
  refuse(op: string, count: number, code: string): void;
}

/** One request the host received, in order, with the observed time of the session's latest publication then. */
interface Received {
  readonly op: string;
  readonly args: unknown;
  readonly atMs: number | null;
}

/**
 * The requests `bridge`'s host receives, in the order it receives them: the in-process client posts each one as a
 * structured clone, at its queue turn. Also counts the section sends, refused ones included (`attempts`).
 */
function track(context: TestContext, bridge: PlayerBridge) {
  const posts: Received[] = [];
  const attempts: string[] = [];
  const held = new Map<string, number>();
  const refused = new Map<string, { left: number; code: string }>();
  // Each held reply waits for its own release, oldest first.
  const waiting: ((error: Error | null) => void)[] = [];
  const shown: { session: PlayerRuntimeSession | null } = { session: null };
  const observedMs = () => {
    const current = shown.session;
    if (current === null) return null;
    // EVIDENCE: fixture: the composable's shown session is a publication of this bridge.
    return bridge.latest(current as never)?.state.observedSessionTimeMs ?? null;
  };
  const seen = new Set<unknown>();
  const clone = globalThis.structuredClone;
  context.mock.method(
    globalThis,
    "structuredClone",
    (value: unknown, options?: StructuredSerializeOptions) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === "request" &&
        "op" in value &&
        typeof value.op === "string" &&
        "id" in value &&
        !seen.has(value.id)
      ) {
        seen.add(value.id);
        posts.push({ op: value.op, args: "args" in value ? value.args : null, atMs: observedMs() });
      }
      return clone(value, options);
    },
  );
  const delayed = <T>(op: string, reply: Promise<T>): Promise<T> => {
    const left = held.get(op) ?? 0;
    if (left === 0) return reply;
    held.set(op, left - 1);
    return new Promise<Error | null>((resolve) => waiting.push(resolve)).then((error) =>
      error === null ? reply : Promise.reject(error),
    );
  };
  // The mocks forward each op as it is sent, whatever it is: the client as its transport carries requests.
  const client = untypedClient(bridge.client);
  const request = client.request.bind(client);
  context.mock.method(
    client,
    "request",
    (op: string, args: unknown, options?: Parameters<typeof request>[2]) =>
      delayed(op, request(op, args, options)),
  );
  const section = client.section.bind(client);
  context.mock.method(
    client,
    "section",
    (session: string, ticket: ClockTicket, body: Parameters<typeof section>[2]) =>
      section(session, ticket, (send) =>
        body((op, args, basis, onReply) => {
          attempts.push(op);
          const refusing = refused.get(op);
          if (refusing !== undefined && refusing.left > 0) {
            refusing.left -= 1;
            return Promise.reject(refusal(refusing.code));
          }
          return delayed(op, send(op, args, basis, onReply));
        }),
      ),
  );
  const gate: Gate = {
    hold: (op, count = 1) => void held.set(op, count),
    refuse: (op, count, code) => void refused.set(op, { left: count, code }),
    release: (error) => {
      for (const resolve of waiting.splice(0)) resolve(error ?? null);
      held.clear();
    },
    releaseFirst: () => waiting.shift()?.(null),
  };
  return { posts, attempts, gate, shown, observedMs };
}

/** Lets the work queued so far run: replies, the clock's continuations and its tasks. */
export async function settle(rounds = 20) {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

/** A script with a repeating timer to catch up on, and an audio cue; `draw` adds a random draw first, which waits. */
const script = (draw: boolean) =>
  compilePlayerProject(
    [
      ...(draw ? ["let r = random()"] : []),
      'let rounds = 0\ntimer(duration: 10 ms, async: true, repeat: true, display: "hidden") {\n  rounds += 1\n}',
      'playAudio async "cue.mp3"',
      'say "Read me", 20 s',
      'showButton "Done"',
      "exit",
    ].join("\n"),
  ).plan!;

/**
 * A Player in a stub page that keeps its sessions, started from a held plan as a hosted script is, with a monotonic
 * clock the test moves and timers it fires. `held`: every random site asks, so the first draw waits and the clock holds.
 */
export async function mount(
  context: TestContext,
  held: boolean,
  source?: string,
  delayMs?: number,
) {
  const elements: EventTarget[] = [];
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const surface = {
    document,
    window: new EventTarget(),
    navigator: {},
    Audio: class extends EventTarget {
      src = "";
      currentTime = 0;
      duration = 1;
      paused = true;
      constructor() {
        super();
        elements.push(this);
      }
      play = async () => {};
      pause() {}
      load() {}
      removeAttribute() {}
    },
  };
  for (const [name, value] of Object.entries(surface)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  // How many timeouts anything armed, as the clock's wake-ups are.
  const timeouts = { armed: 0 };
  const setTimeoutMock = globalThis.setTimeout;
  context.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
    timeouts.armed += 1;
    return setTimeoutMock(...args);
  });
  let nowMs = 0;
  context.mock.method(performance, "now", () => (nowMs += 1));
  const provider: ScriptStorageProvider = {
    scope: "development-package:clock-work",
    load: async () => [],
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  };
  const scope = effectScope();
  const transport =
    delayMs === undefined ? null : await loadPlayerModule("player/engine-bridge/in-process.ts");
  // EVIDENCE: validation: the bundle's in-process backend, whose `createInProcessBackend` makes a `PlayerBridge`.
  const create = transport?.createInProcessBackend as
    ((build: unknown, options: unknown) => PlayerBridge) | undefined;
  const backend =
    create === undefined
      ? null
      : create({ commit: null, dirty: null, mode: null, appVersion: null }, { delayMs });
  const host = scope.run(() =>
    usePlayerSession({
      bridge: backend === null ? inProcessBackend() : Promise.resolve(backend),
      resolveAsset: (path: string) => `https://fixture/${path}`,
      scriptStorage: provider,
      keptSessions: memoryKeptSessionStore(),
      decodeImage: async () => ({ width: 1, height: 1 }),
    }),
  )!;
  context.after(() => scope.stop());
  await host.loadScriptStorage();
  if (held) host.setRandomControl({ sites: [] });
  const bridge = await host.bridge;
  const start = async (draw: boolean) => {
    const reply = await bridge.client.request("prepare", {
      source: {
        kind: "plan",
        text: serializeValidatedRuntimeJson(
          source === undefined ? script(draw) : compilePlayerProject(source).plan!,
        ),
      },
    });
    // EVIDENCE: validation: `prepare` replies from the same build with its result.
    const prepared = reply.result as PrepareResult;
    assert.equal(prepared.kind, "prepared");
    const token = prepared.kind === "prepared" ? prepared.plan : "";
    await host.prepareScript(token, {
      plan: token,
      options: () => ({ ...host.scriptStorageOptions(), ...host.temporalCapture() }),
    });
    await host.activate();
    await settle();
  };
  if (delayMs === undefined) await start(held);
  else {
    let started = false;
    let failure: unknown;
    void start(held).then(
      () => (started = true),
      (error: unknown) => (failure = error),
    );
    for (let n = 0; !started && failure === undefined && n < 100; n++) {
      context.mock.timers.tick(1);
      await settle();
    }
    if (failure !== undefined) throw failure;
    assert.equal(started, true);
  }
  const tracked = track(context, bridge);
  tracked.shown.session = host.session.value;
  return {
    host,
    elements,
    scope,
    timeouts,
    start,
    ...tracked,
    /** The page shows again after `milliseconds` hidden: a late observation, which catches up on a copy. */
    elapse(milliseconds: number) {
      nowMs += milliseconds;
    },
    late(milliseconds: number) {
      nowMs += milliseconds;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    hide() {
      document.visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      document.visibilityState = "visible";
    },
  };
}

/** A session the host shows, as the bridge's methods take it. */
export function asShown(session: unknown): PlayerSession {
  // EVIDENCE: test: `usePlayerSession` shows the bridge's `PlayerSession`s, which `SessionHost` types loosely.
  return session as PlayerSession;
}

/** The real clock on its own over a session the Player started, with the timers and sends the tests drive and count. */
interface ClockFixture {
  observe(): Promise<PlayerSession | null>;
  before(work: string): void;
  catchUp(): void;
}
/**
 * The clock alone (`ClockFixture`) on `source`'s session, started by a Player whose own clock is stopped; with `media`,
 * a loaded medium plays, so every observation carries a media report.
 */
export async function mountClock(context: TestContext, media: boolean, source?: string) {
  const player = await mount(
    context,
    false,
    `${media ? 'playAudio async "cue.mp3"\n' : ""}${source ?? 'wait 10 ms\nshowButton "Done"\nexit'}`,
  );
  const bridge = await player.host.bridge;
  const initial = player.host.session.value!;
  player.scope.stop();
  await settle();
  if (media)
    await bridge.request(asShown(initial), "reportMediaLoad", {
      mediaId: 1,
      report: { kind: "loaded", durationMs: 10000 },
    });
  const shown = shallowRef(bridge.latest(asShown(initial))!);
  const paused = ref(false);
  let now = 0;
  context.mock.method(performance, "now", () => now);
  const module = await loadPlayerModule("player/vue/src/session/useRuntimeSceneClock.ts");
  // EVIDENCE: validation: Vite loaded the real source module; this is the composable's own signature, its first four inputs.
  const useClock = module.useRuntimeSceneClock as (
    shown: unknown,
    samples: () => readonly unknown[],
    paused: Ref<boolean>,
    copies: () => boolean,
  ) => ClockFixture;
  const scope = effectScope();
  const clock = scope.run(() =>
    useClock(
      shown,
      () => (media ? [{ mediaId: 1, segment: 1, progressMs: now }] : []),
      paused,
      () => false,
    ),
  )!;
  context.after(() => scope.stop());
  let sampling: ReturnType<typeof setInterval> | undefined;
  if (media) sampling = setInterval(() => clock.catchUp(), 100);
  const stopSampling = () => {
    if (sampling !== undefined) clearInterval(sampling);
  };
  context.after(stopSampling);
  const advance = async (ms: number) => {
    for (let i = 0; i < ms; i++) {
      now++;
      context.mock.timers.tick(1);
      await settle(3);
    }
  };
  return {
    ...player,
    bridge,
    initial,
    shown,
    paused,
    clock,
    clockScope: scope,
    advance,
    stopSampling,
  };
}
