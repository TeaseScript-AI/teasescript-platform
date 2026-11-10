import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { before, type TestContext } from "node:test";
import ts from "typescript";
import { effectScope, ref, shallowRef, type Ref, type ShallowRef } from "vue";

import { compilePlayerProject } from "../../player/runtime/compile-project.js";
import type { StartOptions } from "../../player/engine-bridge/ops/session.js";
import type { PrepareResult } from "../../player/engine-bridge/player-ops.js";
import type { PlayerBridge, SessionRequestOptions } from "../../player/runtime/player-bridge.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import {
  observePlayerRuntimeTime,
  type PlayerRuntimeSession,
} from "../../player/runtime/runtime-adapter.js";
import { memoryKeptSessionStore } from "../../player/persistence/kept-sessions.js";
import type { ScriptStorageProvider } from "../../player/persistence/script-storage.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";
import { coverageGaps, product } from "../helpers/family-coverage.js";
import { loadHostFacade, onHost } from "../helpers/player/host-sessions.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import type { ClockTicket } from "../../player/runtime/clock-ticket.js";
import { clockTicket } from "../helpers/clock-ticket.js";
import { untypedBridge, untypedClient } from "../helpers/bridge/untyped.js";

/*
 * L5i.5: session work that must follow the scene clock posts what it needs into the shown session's queue first
 * (`clock.before`), so the host runs it before the work. The family drives each kind of work through its real entry
 * point, in each state of the clock, and checks the host's request log against what this file states independently of
 * the clock's table (`CLOCK_WORK`): a removed `before`, or a wrong row, fails here.
 */

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
const observeOnHost = onHost(observePlayerRuntimeTime);
/** The bundle's refusal, which the composable's `refusalCode` recognizes. */
let refusal: (code: string) => Error;

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

// The family's axes, declared once.
/** Each kind of session work that follows the clock, by its real entry point. */
const WORK = ["debugMode", "randomControl", "keepCapture", "pageHide", "audioEnded"] as const;
/** The clock's state when the work comes. */
const STATES = [
  "idle",
  "catch-up begun",
  "catch-up stepped",
  "observation in flight",
  "held",
] as const;
type Work = (typeof WORK)[number];
type State = (typeof STATES)[number];

/**
 * The oracle, stated here and not read from the clock: what each kind of work needs before it, `settle` (a catch-up
 * under way finishes first, as one observation) or `observe` (an observation now, also when idle).
 */
const NEEDS: Readonly<Record<Work, "settle" | "observe">> = {
  debugMode: "settle",
  randomControl: "settle",
  keepCapture: "observe",
  pageHide: "observe",
  audioEnded: "observe",
};
/** The work's own op, which comes after what it needs; `null` for an opportunity that only observes. */
const OWN_OP: Readonly<Record<Work, string | null>> = {
  debugMode: "setDebugMode",
  randomControl: "randomControl",
  keepCapture: "captureKeep",
  pageHide: null,
  audioEnded: null,
};

/**
 * The clock's ops (`dropCatchUp`, `observeTime`) and the work's own op the host receives from the work's trigger on,
 * exactly, in order, as the oracle derives them. The oracle checks nothing else the trigger causes: turning Debug mode
 * on in the normal room also keeps the session for its debug-room copy (`captureKeep`), which is the debug room's work,
 * not the clock's.
 */
function expected(work: Work, state: State): string[] {
  const own = OWN_OP[work] === null ? [] : [OWN_OP[work]];
  // Held (a waiting draw), nothing is observed; and Debug mode reaches a session only while it runs or waits for
  // input, as today, so it goes to the host once the draw is decided.
  if (state === "held") return work === "debugMode" ? [] : own;
  const catchingUp = state === "catch-up begun" || state === "catch-up stepped";
  const observes = NEEDS[work] === "observe" || catchingUp;
  // An observation drops the catch-up under way first.
  return [
    ...(observes && catchingUp ? ["dropCatchUp"] : []),
    ...(observes ? ["observeTime"] : []),
    ...own,
  ];
}

const CASES = WORK.flatMap((work) =>
  STATES.map((state) => ({ work, state, name: `${work}; ${state}` })),
);

/** The kinds of work the clock's own type declares (`ClockWork` in `useRuntimeSceneClock.ts`). */
function declaredWork(): string[] {
  const path = new URL("../../../player/vue/src/session/useRuntimeSceneClock.ts", import.meta.url);
  const file = ts.createSourceFile(
    "clock.ts",
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = file.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === "ClockWork",
  );
  assert.ok(declaration && ts.isUnionTypeNode(declaration.type), "ClockWork is a union of names");
  return declaration.type.types.map((member) => {
    assert.ok(ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal));
    return member.literal.text;
  });
}

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
async function settle(rounds = 20) {
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
async function mount(context: TestContext, held: boolean, source?: string, delayMs?: number) {
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
      ...(backend === null ? {} : { bridge: Promise.resolve(backend) }),
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

type Mounted = Awaited<ReturnType<typeof mount>>;

/** Puts the clock in `state`. */
async function enter(player: Mounted, state: State) {
  if (state === "idle" || state === "held") return;
  if (state === "observation in flight") {
    player.gate.hold("observeTime");
    void player.host.observe();
    await settle();
    return;
  }
  // A late observation begins a catch-up; it stays begun while its first reply waits, or stepped while its second does.
  if (state === "catch-up begun") player.gate.hold("beginCatchUp");
  else player.gate.hold("stepCatchUp", 2);
  player.late(1_000);
  await settle();
}

/** Triggers `work` through its real entry point. */
function trigger(player: Mounted, work: Work) {
  switch (work) {
    case "debugMode":
      return player.host.setDebugMode(true);
    case "randomControl":
      return player.host.setRandomControl({ sites: [] });
    case "keepCapture":
      return player.hide();
    case "pageHide":
      return void window.dispatchEvent(new Event("pagehide"));
    case "audioEnded": {
      const element = player.elements.at(-1);
      assert.ok(element, "the cue has an element");
      return void element.dispatchEvent(new Event("ended"));
    }
  }
}

/** The `(work, state)` coordinates registered as clock-work cases below. */
const registeredCases: { work: string; state: string }[] = [];
for (const { work, state, name } of CASES) {
  registeredCases.push({ work, state });
  test(`the clock comes before session work: ${name}`, async (context) => {
    const player = await mount(context, state === "held");
    if (state === "held")
      assert.notEqual(player.host.session.value?.state.randomDraw, null, "a draw waits");
    await enter(player, state);
    const from = player.posts.length;
    const atTrigger = player.observedMs();
    trigger(player, work);
    await settle();
    player.gate.release();
    await settle(40);
    const own = OWN_OP[work];
    // What `expected` counts, and only that (see there).
    const counted = new Set(["dropCatchUp", "observeTime", ...(own === null ? [] : [own])]);
    const after = player.posts
      .slice(from)
      .map((post) => post.op)
      .filter((op) => counted.has(op));
    assert.deepEqual(after, expected(work, state), name);
    const want = expected(work, state);
    // The work sees the observed time: with an observation before it, its op goes out after the observation applied.
    if (own !== null && want.includes("observeTime")) {
      const post = player.posts.slice(from).find((each) => each.op === own)!;
      assert.ok((post.atMs ?? 0) > (atTrigger ?? 0), `${name}: the work follows the observation`);
    }
  });
}

test("the clock-work family covers every kind of work in every state of the clock", () => {
  // The axis is the clock's own domain: a kind of work the clock gains needs its row here.
  assert.deepEqual([...WORK].sort(), declaredWork().sort());
  const feasible = product({ work: [...WORK], state: [...STATES] });
  // The coordinates the loop above registered as cases, not the list it reads.
  const observed = registeredCases;
  assert.deepEqual(coverageGaps(feasible, observed, { tuples: true }), []);
  const lacking = observed.filter(
    (each) => !(each.work === "keepCapture" && each.state === "held"),
  );
  assert.ok(coverageGaps(feasible, lacking, { tuples: true }).length > 0);
});

// R1: the clock observes inside a section of the shown session, so its basis is read at its own turn.
function atMsOf(post: { readonly args: unknown }): number {
  // EVIDENCE: fixture: an `observeTime` post's arguments, as the clock sends them.
  const args = post.args as { readonly atMs: number };
  return args.atMs;
}

test("two overlapping observations both succeed, and the later's time is what the session observed", async (context) => {
  const player = await mount(context, false);
  const from = player.posts.length;
  const [first, second] = await Promise.all([player.host.observe(), player.host.observe()]);
  assert.notEqual(first, null);
  assert.notEqual(second, null);
  const observations = player.posts.slice(from).filter((post) => post.op === "observeTime");
  assert.equal(observations.length, 2, "both are posted, neither refused");
  assert.equal(
    player.host.session.value?.state.observedSessionTimeMs,
    Math.max(...observations.map(atMsOf)),
  );
});

test("an observation behind an earlier section that published succeeds, at its own time", async (context) => {
  const player = await mount(context, false);
  const bridge = await player.host.bridge;
  const shown = player.host.session.value!;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  // EVIDENCE: fixture: the shown session is a publication of this bridge.
  const earlier = bridge.section(asShown(shown), clockTicket(), async (section) => {
    await opened;
    // A publication that moves the revision, not the time.
    await section.send("setDebugMode", { on: true });
  });
  const observing = player.host.observe();
  open();
  await earlier;
  const observed = await observing;
  assert.notEqual(observed, null, "not refused for the basis the earlier section moved");
  const last = player.posts.filter((post) => post.op === "observeTime").at(-1)!;
  assert.equal(player.host.session.value?.state.observedSessionTimeMs, atMsOf(last));
});

test("an observation refused twice returns null without publishing and retains its future deadline", async (context) => {
  const player = await mount(context, false);
  const shown = player.host.session.value;
  player.gate.refuse("observeTime", 2, "basis");
  const armed = player.timeouts.armed;
  const from = player.attempts.length;
  assert.equal(await player.host.observe(), null);
  await settle();
  assert.equal(
    player.attempts.slice(from).filter((op) => op === "observeTime").length,
    2,
    "one retry",
  );
  assert.equal(player.host.session.value, shown, "nothing published");
  assert.equal(player.timeouts.armed, armed + 1, "release retains the future deadline");
});

test("a refusal of another kind is not retried", async (context) => {
  const player = await mount(context, false);
  player.gate.refuse("observeTime", 1, "session");
  const from = player.attempts.length;
  await assert.rejects(player.host.observe());
  assert.equal(player.attempts.slice(from).filter((op) => op === "observeTime").length, 1);
});

// R4: an observation's completion publishes and schedules nothing once it is retired.
test("a rejection after disposal arms no timer", async (context) => {
  const player = await mount(context, false);
  player.gate.hold("observeTime");
  // A page-hide opportunity: fire and forget, its failure handled by the clock.
  window.dispatchEvent(new Event("pagehide"));
  await settle();
  player.scope.stop();
  const armed = player.timeouts.armed;
  // An error the clock handles by going on from the latest session: disposed, it schedules nothing.
  player.gate.release(new Error("The reply failed."));
  await settle();
  assert.equal(player.timeouts.armed, armed);
});

test("a newer publication of the session during an observation is what the observation returns", async (context) => {
  const player = await mount(context, false);
  const bridge = await player.host.bridge;
  player.gate.hold("observeTime");
  const observing = player.host.observe();
  await settle();
  // Meanwhile the host publishes the session again, past the session's queue (the facade), after the observation ran.
  const shown = player.host.session.value!;
  observeOnHost(shown, shown.state.observedSessionTimeMs + 50_000, []);
  player.gate.release();
  const observed = await observing;
  await settle();
  assert.equal(observed, player.host.session.value, "the newest shown");
  // EVIDENCE: fixture: as above.
  assert.equal(observed?.revision, bridge.latest(asShown(shown))?.revision);
});

test("an unmount or a replacement with an observation in flight publishes nothing", async (context) => {
  for (const interference of ["unmount", "replacement"] as const) {
    await context.test(interference, async (inner) => {
      const player = await mount(inner, false);
      player.gate.hold("observeTime");
      const observing = player.host.observe();
      await settle();
      if (interference === "unmount") player.scope.stop();
      else {
        await player.start(false);
      }
      const shown = player.host.session.value;
      player.gate.release();
      assert.equal(await observing, null);
      await settle();
      assert.equal(player.host.session.value, shown);
    });
  }
});

test("a kind of work the clock's table does not hold throws, whatever the clock's state", async (context) => {
  const player = await mount(context, false);
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/session/useRuntimeSceneClock.ts",
  );
  assert.equal(typeof module.useRuntimeSceneClock, "function");
  // EVIDENCE: validation: the bundle's clock, checked callable above; `before` is its policy entry.
  const useClock = module.useRuntimeSceneClock as (
    session: ShallowRef<PlayerRuntimeSession | null>,
    reports: () => readonly [],
    paused: Ref<boolean>,
  ) => { before(work: string): void };
  for (const paused of [false, true])
    for (const shown of [null, player.host.session.value]) {
      const scope = effectScope();
      const clock = scope.run(() => useClock(shallowRef(shown), () => [], ref(paused)))!;
      try {
        // An inherited name is no member either.
        for (const work of ["nope", "toString"])
          assert.throws(() => clock.before(work), /No clock work/u, `${work}, paused ${paused}`);
      } finally {
        scope.stop();
      }
    }
});

// #1983: `clock.section` opens its section under a `SECTION_WORK` row and observes what that row needs at the turn,
// before its body. Exclusions, decided where named: which row a sender names is visible at its call site and reviewed;
// that `runInput`'s target check, intent and tab run after the observation's reply is `player-runtime-input.test.ts`
// ("a blocked tab posts no answer…"); that a service's delivery settles its answer on a `null` observation is
// `player-session-camera.test.ts` ("a capture whose section finds its session retired…").

/** Each kind of section work, as the clock's table names it. */
const SECTION_ROWS = [
  "inputAnswer",
  "inputDraft",
  "storageEdit",
  "storageWriteDone",
  "service",
  "mediaLoadObserved",
  "mediaLoad",
] as const;
type SectionRow = (typeof SECTION_ROWS)[number];
/** The oracle, stated here and not read from the clock: the op each row observes with, or none. */
const ROW_OBSERVES: Readonly<Record<SectionRow, "observeInput" | "observeTime" | null>> = {
  inputAnswer: "observeInput",
  inputDraft: null,
  storageEdit: null,
  storageWriteDone: null,
  service: "observeTime",
  mediaLoadObserved: "observeTime",
  mediaLoad: null,
};
/**
 * What holds at the section's turn: its session owned and shown; the clock held (an inspected state, a waiting draw);
 * its ownership retired; or its observation refused for its basis, which only the media rows' delivery recovers from
 * (it keeps the reports for the next publication), so only they have it.
 */
const SECTION_STATES = ["owned", "held", "retired", "basis refused"] as const;
type SectionState = (typeof SECTION_STATES)[number];
const SECTION_CASES = SECTION_ROWS.flatMap((row) =>
  SECTION_STATES.filter((state) => state !== "basis refused" || row.startsWith("mediaLoad")).map(
    (state) => ({ row, state, name: `${row}; ${state}` }),
  ),
);

/** What the oracle derives for a row and state: the clock's posts, and the observation the body receives. */
function sectionExpected(row: SectionRow, state: SectionState) {
  const op = ROW_OBSERVES[row];
  const observes = op !== null && (state === "owned" || state === "basis refused");
  return {
    // A refused observation is attempted, but never reaches the host.
    posts: observes && state === "owned" ? [op] : [],
    samples: observes ? 1 : 0,
    // The refusal rejects the section before its body.
    body: !(observes && state === "basis refused"),
    observed: op !== null && state === "retired" ? ("none" as const) : ("section's" as const),
  };
}

/** The keys of the clock's `SECTION_WORK` table, read from its source. */
function declaredSectionWork(): string[] {
  const path = new URL("../../../player/vue/src/session/useRuntimeSceneClock.ts", import.meta.url);
  const file = ts.createSourceFile(
    "clock.ts",
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let keys: string[] | undefined;
  file.forEachChild(function visit(node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "SECTION_WORK")
      node.forEachChild(function find(inner): void {
        if (ts.isObjectLiteralExpression(inner))
          keys ??= inner.properties.map((property) => property.name?.getText(file) ?? "");
        else inner.forEachChild(find);
      });
    else node.forEachChild(visit);
  });
  assert.ok(keys, "the clock has its section table");
  return keys;
}

interface SectionClock {
  section<T>(
    work: string,
    current: PlayerRuntimeSession,
    owned: () => boolean,
    body: (
      section: { readonly session: PlayerRuntimeSession },
      observed: PlayerRuntimeSession | null,
    ) => Promise<T>,
  ): Promise<T>;
}
/** A clock of the bundle over `shown`, with its media samples counted and its hold in the test's hand. */
async function sectionClock(context: TestContext, shown: PlayerRuntimeSession) {
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/session/useRuntimeSceneClock.ts",
  );
  assert.equal(typeof module.useRuntimeSceneClock, "function");
  // EVIDENCE: validation: the bundle's clock, checked callable above; `section` is its section entry.
  const useClock = module.useRuntimeSceneClock as (
    session: ShallowRef<PlayerRuntimeSession | null>,
    reports: () => readonly [],
    paused: Ref<boolean>,
  ) => SectionClock;
  const paused = ref(false);
  const sampled = { count: 0 };
  const scope = effectScope();
  const clock = scope.run(() =>
    useClock(
      shallowRef(shown),
      () => {
        sampled.count += 1;
        return [];
      },
      paused,
    ),
  )!;
  context.after(() => scope.stop());
  return { clock, paused, sampled };
}

/** The `(row, state)` coordinates registered as section cases below. */
const registeredSections: { row: string; state: string }[] = [];
for (const { row, state, name } of SECTION_CASES) {
  registeredSections.push({ row, state });
  test(`the clock opens a section under its row, observing at its turn: ${name}`, async (context) => {
    const player = await mount(context, false);
    const bridge = await player.host.bridge;
    const shown = player.host.session.value!;
    const { clock, paused, sampled } = await sectionClock(context, shown);
    // An earlier section holds the session's queue, so this one waits for its turn.
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    // EVIDENCE: fixture: the shown session is a publication of this bridge.
    const earlier = bridge.section(asShown(shown), clockTicket(), () => opened);
    let owned = true;
    if (state === "basis refused") player.gate.refuse(ROW_OBSERVES[row]!, 1, "basis");
    const from = { posts: player.posts.length, attempts: player.attempts.length };
    const clockOps = new Set(["observeTime", "observeInput", "dropCatchUp"]);
    const posted = () =>
      player.posts
        .slice(from.posts)
        .map((post) => post.op)
        .filter((op) => clockOps.has(op));
    const reached: {
      body: {
        readonly posts: number;
        readonly observed: PlayerRuntimeSession | null;
        readonly session: PlayerRuntimeSession;
      } | null;
    } = { body: null };
    const done = clock
      .section(
        row,
        shown,
        () => owned,
        async (section, observed) => {
          reached.body = { posts: posted().length, observed, session: section.session };
        },
      )
      .then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    await settle();
    assert.equal(sampled.count, 0, "nothing is sampled before the section's turn");
    assert.deepEqual(posted(), [], "nothing is posted before the section's turn");
    if (state === "held") paused.value = true;
    if (state === "retired") owned = false;
    open();
    await earlier;
    const outcome = await done;
    await settle();
    const want = sectionExpected(row, state);
    assert.deepEqual(posted(), want.posts, `${name}: posts`);
    assert.equal(sampled.count, want.samples, `${name}: media samples, taken at the turn`);
    if (!want.body) {
      assert.equal(reached.body, null, `${name}: the body does not run`);
      assert.notEqual(outcome, "resolved");
      assert.deepEqual(player.attempts.slice(from.attempts), [ROW_OBSERVES[row]]);
      return;
    }
    assert.equal(outcome, "resolved");
    const body = reached.body;
    assert.ok(body, `${name}: the body runs`);
    assert.equal(body.posts, want.posts.length, `${name}: the observation precedes the body`);
    assert.equal(
      body.observed,
      want.observed === "none" ? null : body.session,
      `${name}: the observation`,
    );
  });
}

test("the section-work family covers every row in each state its turn can have", () => {
  // The coordinates the loop above registered as cases, not the list it reads.
  assert.deepEqual([...SECTION_ROWS].sort(), declaredSectionWork().sort());
  const feasible = [
    ...product({ row: [...SECTION_ROWS], state: ["owned", "held", "retired"] }),
    ...product({ row: ["mediaLoadObserved", "mediaLoad"], state: ["basis refused"] }),
  ];
  const observed = registeredSections;
  assert.deepEqual(coverageGaps(feasible, observed, { tuples: true }), []);
  const lacking = observed.filter((each) => !(each.row === "service" && each.state === "held"));
  assert.ok(coverageGaps(feasible, lacking, { tuples: true }).length > 0);
});

test("a kind of section work the clock's table does not hold throws, and opens nothing", async (context) => {
  const player = await mount(context, false);
  const shown = player.host.session.value!;
  const { clock } = await sectionClock(context, shown);
  const from = player.attempts.length;
  for (const work of ["nope", "toString"])
    assert.throws(
      () =>
        clock.section(
          work,
          shown,
          () => true,
          async () => {},
        ),
      /No section work/u,
      work,
    );
  await settle();
  assert.deepEqual(player.attempts.slice(from), []);
});

// The barrier: a retired observation still sends at its turn, so the work queued behind it follows an observation.
test("a later observation does not take the hidden page's observation from the keep queued behind it", async (context) => {
  const player = await mount(context, false);
  const bridge = await player.host.bridge;
  const shown = player.host.session.value!;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  // EVIDENCE: fixture: the shown session is a publication of this bridge.
  const earlier = bridge.section(asShown(shown), clockTicket(), () => opened);
  const from = player.posts.length;
  player.hide();
  // The keep's capture is queued behind the hidden page's observation; then another observation retires that one.
  await settle();
  const later = player.host.observe();
  open();
  await earlier;
  await later;
  await settle(40);
  const ops = player.posts
    .slice(from)
    .map((post) => post.op)
    .filter((op) => op === "observeTime" || op === "captureKeep");
  assert.deepEqual(ops, ["observeTime", "captureKeep", "observeTime"]);
  const kept = player.posts.slice(from).find((post) => post.op === "captureKeep")!;
  assert.ok(
    (kept.atMs ?? 0) > shown.state.observedSessionTimeMs,
    "the keep captures the visible time",
  );
});

test("a retired observation's reply publishes nothing, while the next one's waits", async (context) => {
  const player = await mount(context, false);
  player.gate.hold("observeTime", 2);
  const first = player.host.observe();
  await settle();
  const second = player.host.observe();
  await settle();
  const shown = player.host.session.value;
  player.gate.releaseFirst();
  await first;
  await settle();
  assert.equal(player.host.session.value, shown, "the retired one publishes nothing");
  player.gate.release();
  assert.notEqual(await second, null);
  assert.notEqual(player.host.session.value, shown, "the live one publishes");
});

test("an old observation's rejection after a replacement arms no timer", async (context) => {
  const player = await mount(context, false);
  player.gate.hold("observeTime");
  window.dispatchEvent(new Event("pagehide"));
  await settle();
  await player.start(false);
  await settle();
  const armed = player.timeouts.armed;
  player.gate.release(new Error("The reply failed."));
  await settle();
  assert.equal(player.timeouts.armed, armed);
});

test("every completion effect of an observation goes through its one lifetime decision", () => {
  const path = new URL("../../../player/vue/src/session/useRuntimeSceneClock.ts", import.meta.url);
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile("clock.ts", text, ts.ScriptTarget.Latest, true);
  let observing: ts.FunctionDeclaration | undefined;
  const generations: string[] = [];
  file.forEachChild(function visit(node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "observing") observing = node;
    if (ts.isPropertyAccessExpression(node) && node.getText(file) === "observation.generation") {
      let at: ts.Node | undefined = node;
      while (at !== undefined && !(ts.isFunctionDeclaration(at) && at.name !== undefined))
        at = at.parent;
      generations.push(
        at !== undefined && ts.isFunctionDeclaration(at) ? (at.name?.text ?? "") : "(none)",
      );
    }
    node.forEachChild(visit);
  });
  assert.ok(observing?.body, "the clock has its observation");
  assert.deepEqual(generations, ["whileLive"], "only the decision reads an observation's lifetime");
  // An admit-list: every call `observing` makes outside `whileLive`'s effect argument is one named here as having no
  // completion effect; any other call, a new helper included, fails until it is classified.
  const effectFree = new Set([
    "cancel",
    "owned",
    "sceneTimeMs",
    "mediaReports",
    "bridgeOf",
    "bridgeOf(shown).section",
    // The section's ticket: a type, with no state behind it.
    "mintClockTicket",
    "section.send",
    // The time and media read at the observation's turn.
    "now",
    "refusalCode",
    "endsQuietly",
    "whileLive",
  ]);
  const decided: string[] = [];
  const undecided: string[] = [];
  observing.body.forEachChild(function visit(node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      let inside = false;
      for (
        let at: ts.Node | undefined = node.parent;
        at !== undefined && at !== observing;
        at = at.parent
      )
        if (
          (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
          ts.isCallExpression(at.parent) &&
          at.parent.expression.getText(file) === "whileLive" &&
          at.parent.arguments[1] === at
        )
          inside = true;
      // The admitted observation's release re-derives the wake, owned by its token (`requested === admitted`), not by its
      // lifetime: publication and recovery stay under `whileLive`.
      let release = false;
      for (
        let at: ts.Node | undefined = node;
        at !== undefined && at !== observing;
        at = at.parent
      ) {
        if (ts.isTryStatement(at) && at.finallyBlock?.getText(file).includes(node.getText(file))) {
          release = true;
          assert.match(at.finallyBlock.getText(file), /if \(requested === admitted\)/);
        }
      }
      if (release)
        assert.ok(["scheduleWakeUp", "basisOf"].includes(callee), `${callee} in the release`);
      else (inside ? decided : undecided).push(callee);
    }
    node.forEachChild(visit);
  });
  assert.deepEqual(
    undecided.filter((callee) => !effectFree.has(callee)),
    [],
    "a call outside the decision that is not classified as effect-free",
  );
  // The effects are decided; a helper inside the decision is decided with them.
  for (const effect of ["publishLater", "recover"])
    assert.ok(decided.includes(effect), `${effect} is decided`);
});

for (const work of ["randomControl", "debugMode"] as const)
  test(`a setting change follows an observation of its time when a late opportunity comes behind a waiting one: ${work}`, async (context) => {
    const player = await mount(context, false);
    const bridge = await player.host.bridge;
    const shown = player.host.session.value!;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    const earlier = bridge.section(asShown(shown), clockTicket(), () => opened);
    const from = player.posts.length;
    window.dispatchEvent(new Event("pagehide"));
    player.late(1000);
    trigger(player, work);
    open();
    await earlier;
    await settle(60);
    const posts = player.posts.slice(from);
    assert.equal(
      posts.some((p) => p.op === "beginCatchUp"),
      false,
      "no catch-up begins behind the waiting observation",
    );
    const changed = posts.find((p) => p.op === OWN_OP[work]);
    assert.ok(changed && (changed.atMs ?? 0) >= 1000, "work follows observation of its time");
  });

test("a deadline that passes while an explicit observation waits is observed after that observation's reply fails", async (context) => {
  const player = await mount(context, false, 'wait 10 ms\nshowButton "Done"\nexit');
  player.gate.hold("observeTime");
  const observed = player.host.observe().catch(() => null);
  await settle();
  const from = player.posts.length;
  // An actual outstanding runtime deadline fires while the observation's reply waits.
  player.elapse(20);
  context.mock.timers.tick(20);
  await settle();
  player.gate.release(new Error("The reply failed."));
  await observed;
  await settle(60);
  player.elapse(1000);
  context.mock.timers.tick(1000);
  await settle(60);
  assert.ok(
    player.posts.slice(from).some((p) => p.op === "observeTime" || p.op === "beginCatchUp"),
    "the consumed opportunity is recovered after failure",
  );
});

test("a failed observation that no caller awaits leaves its passed deadline observed", async (context) => {
  const player = await mount(context, false);
  player.gate.hold("observeTime");
  window.dispatchEvent(new Event("pagehide"));
  await settle();
  context.mock.timers.tick(20);
  await settle();
  const armed = player.timeouts.armed;
  player.gate.release(new Error("The reply failed."));
  await settle();
  assert.ok(player.timeouts.armed > armed, "live recovery arms a wake-up");
});

test("an older observation's completion does not release the admission of a newer one that waits", async (context) => {
  const player = await mount(context, false);
  const bridge = await player.host.bridge;
  const raw = untypedBridge(bridge);
  const request = raw.request.bind(raw);
  let begins = 0;
  context.mock.method(
    raw,
    "request",
    (session: PlayerSession, op: string, args: unknown, options?: SessionRequestOptions) => {
      if (op === "beginCatchUp") begins++;
      return request(session, op, args, options);
    },
  );
  player.gate.hold("observeTime", 2);
  const first = player.host.observe();
  await settle();
  const second = player.host.observe();
  const from = player.posts.length;
  player.gate.releaseFirst();
  await first;
  await settle();
  player.late(1000);
  await settle();
  assert.equal(begins, 0, "successor still blocks opportunity admission before its queue turn");
  player.gate.release();
  await second;
  player.late(1000);
  await settle(60);
  assert.ok(
    player.posts.slice(from).some((p) => p.op === "beginCatchUp"),
    "settled token releases opportunity",
  );
});

test("an observation whose section is refused before its body releases its admission", async (context) => {
  const player = await mount(context, false);
  const bridge = await player.host.bridge;
  const original = bridge.section.bind(bridge);
  let reject = true;
  context.mock.method(bridge, "section", (...args: Parameters<typeof original>) => {
    if (reject) {
      reject = false;
      throw new Error("pre-body ownership rejection");
    }
    return original(...args);
  });
  window.dispatchEvent(new Event("pagehide"));
  await settle();
  const from = player.posts.length;
  player.late(1000);
  await settle(60);
  assert.ok(
    player.posts.slice(from).some((p) => p.op === "beginCatchUp"),
    "rejected token does not block later work",
  );
});

test("a deadline passed during a retired observation is observed after its successor fails", async (context) => {
  const player = await mount(context, false, 'wait 10 ms\nshowButton "Done"\nexit');
  player.gate.hold("observeTime", 2);
  window.dispatchEvent(new Event("pagehide"));
  await settle();
  const successor = player.host.observe().catch(() => null);
  player.gate.releaseFirst();
  await settle();
  player.elapse(20);
  context.mock.timers.tick(20);
  await settle();
  player.gate.release(new Error("successor failed"));
  await successor;
  await settle();
  player.elapse(1000);
  context.mock.timers.tick(1000);
  await settle(60);
  assert.equal(
    player.host.session.value?.state.foregroundAction?.kind,
    "interaction",
    "deadline progresses after retired observation and failed successor",
  );
});

test("an explicit observation's publication schedules the deadline that passed during it, without media", async (context) => {
  const player = await mount(context, false, 'wait 10 ms\nshowButton "Done"\nexit');
  player.gate.hold("observeTime");
  const observed = player.host.observe();
  await settle();
  player.elapse(20);
  context.mock.timers.tick(20);
  await settle();
  player.gate.release();
  await observed;
  await settle();
  context.mock.timers.tick(1);
  await settle(60);
  assert.equal(player.host.session.value?.state.foregroundAction?.kind, "interaction");
});

test("an observation reads time and media progress at its turn, and again for its basis retry", async (context) => {
  const player = await mount(context, false);
  const bridge = await player.host.bridge;
  const shown = player.host.session.value!;
  await bridge.request(asShown(shown), "reportMediaLoad", {
    mediaId: 1,
    report: { kind: "loaded", durationMs: 1000 },
  });
  const module = await loadPlayerModule("player/vue/src/session/useRuntimeSceneClock.ts");
  // EVIDENCE: validation: Vite loaded the real source module; this is the composable's own signature, its first two inputs.
  const useClock = module.useRuntimeSceneClock as (
    session: ShallowRef<unknown>,
    reports: () => readonly unknown[],
  ) => { observe(): Promise<PlayerSession | null> };
  let progress = 100;
  const scope = effectScope();
  context.after(() => scope.stop());
  const clock = scope.run(() =>
    useClock(shallowRef(bridge.latest(asShown(shown))), () => [
      { mediaId: 1, segment: 1, progressMs: progress },
    ]),
  )!;
  const section = untypedClient(bridge.client).section.bind(bridge.client);
  const argumentsSent: { atMs: number; media: { progressMs: number }[] }[] = [];
  context.mock.method(
    untypedClient(bridge.client),
    "section",
    (session: string, ticket: ClockTicket, body: Parameters<typeof section>[2]) =>
      section(session, ticket, (send) =>
        body((op, args, basis, onReply) => {
          if (op === "observeTime") {
            // EVIDENCE: fixture: `observeTime`'s arguments, as the clock sends them.
            argumentsSent.push(args as { atMs: number; media: { progressMs: number }[] });
            if (argumentsSent.length === 1) {
              progress = 400;
              player.elapse(100);
              return Promise.reject(refusal("basis"));
            }
          }
          return send(op, args, basis, onReply);
        }),
      ),
  );
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  const earlier = bridge.section(asShown(shown), clockTicket(), () => wait);
  const observed = clock.observe();
  progress = 200;
  player.elapse(200);
  open();
  await earlier;
  assert.notEqual(await observed, null);
  assert.equal(argumentsSent.length, 2);
  assert.deepEqual(
    argumentsSent.map((a) => a.media[0]!.progressMs),
    [200, 400],
  );
  assert.ok(
    argumentsSent[1]!.atMs >= argumentsSent[0]!.atMs + 100,
    "retry resamples monotonic time",
  );
});

/** A session the host shows, as the bridge's methods take it. */
function asShown(session: unknown): PlayerSession {
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
async function mountClock(context: TestContext, media: boolean, source?: string) {
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

const FIRST_COMPLETION_AXES = {
  outcome: [
    "success",
    "recovery",
    "explicit rejection",
    "basis refused twice",
    "retirement",
    "hold",
    "disposal",
    "loss",
  ],
  skipped: ["periodic", "joined"],
  deadline: ["yes", "no"],
  media: ["on", "off"],
} as const;
// Both admission classes can wait behind a real bridge section, for every completion and media/deadline state.
function firstCompletionInfeasible(_row: Readonly<Record<string, string>>): string | null {
  return null;
}
const firstCompletionRows = product(FIRST_COMPLETION_AXES).filter(
  (row) => firstCompletionInfeasible(row) === null,
);
const firstCompletionRegistered: Readonly<Record<string, string>>[] = [];
for (const row of firstCompletionRows) {
  firstCompletionRegistered.push(row);
  test(`a first completion of every outcome leaves the deadline observed: ${Object.values(row).join("; ")}`, async (context) => {
    const player = await mountClock(context, row.media === "on");
    let open!: () => void;
    const waiting = new Promise<void>((resolve) => (open = resolve));
    const earlier = player.bridge.section(asShown(player.initial), clockTicket(), () => waiting);
    let observed: Promise<unknown>;
    if (row.outcome === "recovery") {
      player.clock.before("pageHide");
      observed = Promise.resolve();
    } else observed = player.clock.observe().catch(() => null);
    if (row.skipped === "joined") player.clock.before("pageHide");
    else player.clock.catchUp();
    if (row.deadline === "yes") await player.advance(20);
    if (["recovery", "explicit rejection", "retirement"].includes(row.outcome!))
      player.gate.refuse("observeTime", row.outcome === "retirement" ? 2 : 1, "shape");
    if (row.outcome === "basis refused twice") player.gate.refuse("observeTime", 2, "basis");
    if (row.outcome === "retirement")
      observed = Promise.all([observed, player.clock.observe().catch(() => null)]);
    if (row.outcome === "hold") player.paused.value = true;
    if (row.outcome === "disposal") {
      player.clockScope.stop();
      player.stopSampling();
    }
    if (row.outcome === "loss") {
      untypedClient(player.bridge.client).terminate();
      player.stopSampling();
    }
    const from = player.attempts.length;
    open();
    await earlier;
    await observed;
    await settle(30);
    if (row.deadline === "no") {
      // No newly due work: C4 may re-arm the existing future deadline, but must not send now.
      const expectedInitialAttempts =
        row.outcome === "basis refused twice" || row.outcome === "retirement"
          ? 2
          : ["hold", "disposal"].includes(row.outcome!)
            ? 0
            : 1;
      assert.equal(player.attempts.length - from, expectedInitialAttempts);
      assert.equal(player.shown.value?.state.foregroundAction?.kind, "delay");
    }
    if (row.outcome === "hold") {
      const armed = player.timeouts.armed;
      await player.advance(50);
      assert.equal(player.timeouts.armed, armed, "held release does not re-arm repeatedly");
      assert.equal(player.shown.value?.state.foregroundAction?.kind, "delay");
      player.paused.value = false;
      await settle();
    }
    if (row.deadline === "yes") {
      await player.advance(30);
      if (["disposal", "loss"].includes(row.outcome!)) {
        assert.equal(
          player.shown.value?.state.foregroundAction?.kind,
          "delay",
          "no observation after disposal/loss",
        );
        const attempts = player.attempts.length;
        const armed = player.timeouts.armed;
        await player.advance(100);
        assert.equal(player.attempts.length, attempts, "no loss or disposal loop");
        assert.equal(player.timeouts.armed, armed, "no re-arm loop");
      } else {
        const action = player.shown.value?.state.foregroundAction;
        assert.equal(action?.kind, "interaction", "source work after the deadline is reached");
        assert.equal(
          action?.kind === "interaction"
            ? action.ui?.kind === "button"
              ? action.ui.buttonLabel
              : null
            : null,
          "Done",
        );
      }
    }
  });
}
test("the first-completion family covers every declared row", () => {
  assert.equal(firstCompletionRows.length, 64);
  assert.deepEqual(
    coverageGaps(firstCompletionRows, firstCompletionRegistered, { tuples: true }),
    [],
  );
});

test("an observation of a replaced session schedules nothing for the session that replaced it", async (context) => {
  const player = await mountClock(context, false);
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => (open = resolve));
  const earlier = player.bridge.section(asShown(player.initial), clockTicket(), () => waiting);
  const observed = player.clock.observe();
  player.clock.catchUp();
  const next = await player.bridge.start(player.shown.value!.planToken, {}, false);
  player.shown.value = next;
  await settle();
  const armed = player.timeouts.armed;
  open();
  await earlier;
  await observed;
  await settle();
  assert.equal(
    player.timeouts.armed,
    armed,
    "an old observation cannot schedule for the replacement",
  );
  await player.advance(20);
  assert.equal(player.shown.value?.state.foregroundAction?.kind, "interaction");
});

test("an older observation's release does not schedule again for a newer one", async (context) => {
  const player = await mountClock(context, false);
  player.gate.hold("observeTime", 2);
  const old = player.clock.observe();
  await settle();
  const latest = player.clock.observe().catch(() => null);
  await player.advance(20);
  const armed = player.timeouts.armed;
  player.gate.releaseFirst();
  await old;
  await settle();
  assert.equal(player.timeouts.armed, armed, "old release cannot serve the successor's wish");
  player.gate.release(new Error("failed successor"));
  await latest;
  await settle();
  assert.equal(player.timeouts.armed, armed + 1, "installed release arms once");
  await player.advance(2);
  assert.equal(player.shown.value?.state.foregroundAction?.kind, "interaction");
});

test("a joined barrier with no deadline left sends nothing more", async (context) => {
  const player = await mount(context, false, 'showButton "Done"\nexit');
  const bridge = await player.host.bridge;
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => (open = resolve));
  const earlier = bridge.section(asShown(player.host.session.value!), clockTicket(), () => waiting);
  window.dispatchEvent(new Event("pagehide"));
  window.dispatchEvent(new Event("pagehide"));
  open();
  await earlier;
  await settle();
  const observed = player.attempts.filter((op) => op === "observeTime").length;
  const armed = player.timeouts.armed;
  context.mock.timers.tick(1000);
  await settle();
  assert.equal(player.attempts.filter((op) => op === "observeTime").length, observed);
  assert.equal(player.timeouts.armed, armed, "and arms nothing");
});

for (const delayMs of [undefined, 0])
  test(`two barriers in one task behind a holder that spans scene time share one observation: ${delayMs === undefined ? "microtask" : "0 ms"} replies`, async (context) => {
    const player = await mount(context, false, 'wait 100 ms\nshowButton "Done"\nexit', delayMs);
    const bridge = await player.host.bridge;
    let open!: () => void;
    const waiting = new Promise<void>((resolve) => (open = resolve));
    const earlier = bridge.section(
      asShown(player.host.session.value!),
      clockTicket(),
      () => waiting,
    );
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pagehide"));
    player.elapse(200);
    // No transport delay: the trusted queue holder, rather than a late reply, spans scene time.
    open();
    await earlier;
    for (let n = 0; n < 10; n++) {
      if (delayMs === 0) context.mock.timers.tick(1);
      await settle();
    }
  });

test("with no deadline left, a release schedules nothing", async (context) => {
  const player = await mountClock(context, false);
  player.gate.hold("observeTime");
  const observed = player.clock.observe();
  await settle();
  await player.advance(20);
  player.gate.release();
  await observed;
  await settle();
  await player.advance(2);
  assert.equal(player.shown.value?.state.foregroundAction?.kind, "interaction");
  const armed = player.timeouts.armed;
  await player.clock.observe();
  await settle();
  assert.equal(
    player.timeouts.armed,
    armed,
    "a consumed wish is not retained for another admission",
  );
});

for (const refusals of [2, 4])
  test(`a passed deadline after ${refusals} basis refusals on the real host: observed, or parked until a publication`, async (context) => {
    const player = await mountClock(context, false);
    let open!: () => void;
    const waiting = new Promise<void>((resolve) => (open = resolve));
    const earlier = player.bridge.section(asShown(player.initial), clockTicket(), () => waiting);
    const client = untypedClient(player.bridge.client);
    const section = client.section.bind(client);
    let left = refusals;
    let rejected = 0;
    context.mock.method(
      client,
      "section",
      (id: string, ticket: ClockTicket, body: Parameters<typeof section>[2]) =>
        section(id, ticket, (send) =>
          body(async (op, args, basis, onReply) => {
            const refuse = op === "observeTime" && left > 0;
            if (refuse) left--;
            try {
              return await send(op, args, refuse ? (basis ?? 0) + 1000 : basis, onReply);
            } catch (error) {
              if (refuse) rejected++;
              throw error;
            }
          }),
        ),
    );
    const observed = player.clock.observe();
    await player.advance(20); // the real deadline is consumed while this token waits
    open();
    await earlier;
    await observed;
    await settle();
    await player.advance(1000);
    assert.equal(rejected, refusals, "every refusal traversed the real host");
    const reached = player.shown.value?.state.foregroundAction?.kind;
    if (refusals === 2) {
      assert.equal(
        reached,
        "interaction",
        "the clock's own observation after the refused one reaches the deadline",
      );
      return;
    }
    // The clock's own observation was refused twice on a basis no publication changed: it waits for one (#2263).
    assert.notEqual(reached, "interaction", "parked on the unchanged basis");
    const sent = player.posts.filter((post) => post.op === "observeTime").length;
    player.clock.catchUp();
    await player.advance(100);
    assert.equal(
      player.posts.filter((post) => post.op === "observeTime").length,
      sent,
      "nothing more is sent",
    );
    await player.clock.observe();
    await player.advance(100);
    assert.equal(
      player.shown.value?.state.foregroundAction?.kind,
      "interaction",
      "a publication lifts it",
    );
  });

// The completion chains: the first completion and its successor's both vary; later completions succeed.
const CHAIN_AXES = {
  first: [
    "publish",
    "recovery",
    "explicit rejection",
    "basis",
    "retirement",
    "hold",
    "disposal",
    "loss",
    "replacement",
  ],
  second: [
    "publish",
    "recovery",
    "basis",
    "retirement",
    "hold",
    "disposal",
    "loss",
    "replacement",
    "none",
  ],
  consumed: ["periodic", "joined"],
  deadline: ["due", "pending"],
  media: ["on", "off"],
} as const;
const chainTerminal = (outcome: string) => ["disposal", "loss", "replacement"].includes(outcome);
/** Whether the chain's second observation is the clock's own and fails with the session's basis unchanged. */
const chainParks = (row: Readonly<Record<string, string>>) =>
  !chainTerminal(row.first!) &&
  row.first !== "retirement" &&
  (row.second === "basis" || row.second === "recovery");
function chainInfeasible(row: Readonly<Record<string, string>>): string | null {
  if (chainTerminal(row.first!))
    return row.second === "none"
      ? null
      : "the first completion ends ownership; this chain has no second token";
  return row.second === "none"
    ? "the live two-wait source retains a due or future deadline, so the chain must continue"
    : null;
}
const chainRows = product(CHAIN_AXES).filter((row) => chainInfeasible(row) === null);
const chainRegistered: Readonly<Record<string, string>>[] = [];
for (const row of chainRows) {
  chainRegistered.push(row);
  test(`a chain of two completions leaves the deadline observed, parked or ended as written: ${Object.values(row).join("; ")}`, async (context) => {
    const player = await mountClock(
      context,
      row.media === "on",
      'wait 10 ms\nwait 30 ms\nshowButton "Done"\nexit',
    );
    player.stopSampling(); // Samples remain available; no interval can rescue a lost deadline.
    let next =
      row.first === "replacement" || row.second === "replacement"
        ? await player.bridge.start(player.shown.value!.planToken, {}, false)
        : null;
    if (next !== null && row.media === "on") {
      await player.bridge.request(next, "reportMediaLoad", {
        mediaId: 1,
        report: { kind: "loaded", durationMs: 10000 },
      });
      next = player.bridge.latest(next)!;
    }
    let open!: () => void;
    const held = new Promise<void>((resolve) => (open = resolve));
    const earlier = player.bridge.section(asShown(player.initial), clockTicket(), () => held);
    const client = untypedClient(player.bridge.client);
    const section = client.section.bind(client);
    let entered = 0,
      refusals = 0;
    let ended: string | null = null;
    const explicit: Promise<unknown>[] = [];
    context.mock.method(
      client,
      "section",
      (id: string, ticket: ClockTicket, body: Parameters<typeof section>[2]) =>
        section(id, ticket, async (send) => {
          if (id !== player.bridge.latest(asShown(player.initial))!.id) return body(send);
          const index = ++entered;
          const outcome = index === 1 ? row.first : index === 2 ? row.second : "publish";
          if (outcome === "retirement") explicit.push(player.clock.observe().catch(() => null));
          if (outcome === "hold") {
            player.paused.value = true;
            setTimeout(() => {
              player.paused.value = false;
            }, 1);
          }
          if (outcome === "disposal") {
            ended = outcome;
            player.clockScope.stop();
          }
          if (outcome === "loss") {
            ended = outcome;
            client.terminate();
          }
          if (outcome === "replacement") {
            ended = outcome;
            assert.ok(next);
            player.shown.value = next;
          }
          return body(async (op, args, basis, onReply) => {
            const refuseBasis = op === "observeTime" && outcome === "basis";
            const refuseArgs =
              op === "observeTime" && ["recovery", "explicit rejection"].includes(outcome!);
            try {
              return await send(
                op,
                refuseArgs ? { atMs: -1, media: [] } : args,
                refuseBasis ? (basis ?? 0) + 1000 : basis,
                onReply,
              );
            } catch (error) {
              if (refuseBasis || refuseArgs) refusals++;
              throw error;
            }
          });
        }),
    );
    const observed =
      row.first === "recovery"
        ? (player.clock.before("pageHide"), Promise.resolve(null))
        : player.clock.observe().catch(() => null);
    if (row.consumed === "joined") player.clock.before("pageHide");
    else player.clock.catchUp();
    if (row.deadline === "due") await player.advance(20);
    open();
    await earlier;
    await observed;
    await settle();
    await player.advance(80);
    await Promise.all(explicit);
    const expectedRefusals = (outcome: string) =>
      outcome === "basis" ? 2 : ["recovery", "explicit rejection"].includes(outcome) ? 1 : 0;
    assert.equal(
      refusals,
      expectedRefusals(row.first!) + expectedRefusals(row.second!),
      "the declared failures reached the real host",
    );
    const kind = player.shown.value?.state.foregroundAction?.kind;
    if (ended === "disposal" || ended === "loss") {
      assert.notEqual(kind, "interaction", "terminal completion leaves no further observation");
      const attempts = player.attempts.length,
        armed = player.timeouts.armed;
      await player.advance(100);
      assert.equal(player.attempts.length, attempts, "terminal chain sends nothing more");
      assert.equal(player.timeouts.armed, armed, "terminal chain arms nothing more");
    } else if (chainParks(row)) {
      // Written expectation: the second completion is the clock's own observation (unless a retirement queued an
      // explicit one), and it failed on a basis no publication changed, so the clock waits for a publication.
      assert.notEqual(kind, "interaction", "parked on the unchanged basis");
      const sent = player.attempts.length;
      await player.advance(100);
      assert.equal(
        player.attempts.length,
        sent,
        "nothing more is sent while the basis is unchanged",
      );
      await player.clock.observe().catch(() => null);
      await player.advance(100);
      assert.equal(
        player.shown.value?.state.foregroundAction?.kind,
        "interaction",
        "a publication lifts it",
      );
    } else {
      assert.equal(kind, "interaction", "the live owned session reaches both waits' successor");
      if (ended === "replacement") assert.equal(player.shown.value?.id, next!.id);
    }
    if (chainTerminal(row.first!)) assert.equal(entered, 1, "no second token of the old session");
    else assert.ok(entered >= 2, "the successor's completion was actually exercised");
  });
}
test("the completion-chain family covers every feasible row and states why each other is excluded", () => {
  assert.equal(product(CHAIN_AXES).length, 648);
  assert.equal(chainRows.length, 408);
  assert.deepEqual(coverageGaps(chainRows, chainRegistered, { tuples: true }), []);
  const excluded = product(CHAIN_AXES).filter((row) => chainInfeasible(row) !== null);
  assert.equal(excluded.length, 240);
  for (const row of excluded) assert.ok(chainInfeasible(row));
});

test("a basis refused on every attempt bounds the clock's own observations", async (context) => {
  const player = await mountClock(context, false);
  const client = untypedClient(player.bridge.client);
  const section = client.section.bind(client);
  let rejected = 0;
  context.mock.method(
    client,
    "section",
    (id: string, ticket: ClockTicket, body: Parameters<typeof section>[2]) =>
      section(id, ticket, (send) =>
        body(async (op, args, basis, onReply) => {
          try {
            return await send(
              op,
              args,
              op === "observeTime" ? (basis ?? 0) + 1000 : basis,
              onReply,
            );
          } catch (error) {
            rejected++;
            throw error;
          }
        }),
      ),
  );
  await player.advance(30);
  const at30 = rejected;
  await player.advance(100);
  assert.equal(rejected, at30, "with no new publication, the automatic refusal chain terminates");
});

test("a session the host halted gets no more of the clock's own observations", async (context) => {
  const player = await mountClock(context, false);
  await player.bridge.halt(asShown(player.initial));
  assert.equal(await player.clock.observe(), null);
  const attempts = player.attempts.length,
    armed = player.timeouts.armed;
  await player.advance(100);
  player.clock.catchUp();
  await settle();
  assert.equal(player.attempts.length, attempts);
  assert.equal(player.timeouts.armed, armed);
});

test("an explicit observation's publication lifts the wait on an unchanged basis", async (context) => {
  const player = await mountClock(
    context,
    false,
    'wait 10 ms\nwait 100 ms\nshowButton "Done"\nexit',
  );
  let open!: () => void;
  const earlier = player.bridge.section(
    asShown(player.initial),
    clockTicket(),
    () => new Promise<void>((resolve) => (open = resolve)),
  );
  const client = untypedClient(player.bridge.client);
  const section = client.section.bind(client);
  let left = 4,
    rejected = 0;
  context.mock.method(
    client,
    "section",
    (id: string, ticket: ClockTicket, body: Parameters<typeof section>[2]) =>
      section(id, ticket, (send) =>
        body(async (op, args, basis, onReply) => {
          const refusing = op === "observeTime" && left > 0;
          if (refusing) left--;
          try {
            return await send(op, args, refusing ? (basis ?? 0) + 1000 : basis, onReply);
          } catch (error) {
            if (refusing) rejected++;
            throw error;
          }
        }),
      ),
  );
  const observed = player.clock.observe();
  await player.advance(20);
  open();
  await earlier;
  await observed;
  await settle();
  await player.advance(20);
  assert.equal(rejected, 4);
  assert.equal(
    player.shown.value?.state.observedSessionTimeMs,
    0,
    "the automatic chain parked without progress",
  );
  await player.clock.observe();
  assert.ok(
    player.shown.value!.state.observedSessionTimeMs >= 40,
    "an external explicit observation establishes a fresh basis",
  );
  await player.advance(100);
  assert.equal(
    player.shown.value?.state.foregroundAction?.kind,
    "interaction",
    "the later deadline resumes automatically on the new basis",
  );
});
