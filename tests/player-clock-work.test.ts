import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { before, type TestContext } from "node:test";
import ts from "typescript";
import { effectScope, ref, shallowRef, type Ref, type ShallowRef } from "vue";

import { compilePlayerProject } from "../player/compile-project.js";
import type { BridgeClient } from "../player/engine-bridge/client.js";
import type { StartOptions } from "../player/engine-bridge/ops/session.js";
import type { PrepareResult } from "../player/engine-bridge/player-ops.js";
import type { PlayerBridge } from "../player/player-bridge.js";
import { observePlayerRuntimeTime, type PlayerRuntimeSession } from "../player/runtime-adapter.js";
import { memoryKeptSessionStore } from "../player/kept-sessions.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint-json.js";
import { coverageGaps, product } from "./helpers/family-coverage.js";
import { loadHostFacade, onHost } from "./helpers/host-sessions.js";
import { loadPlayerModule } from "./helpers/player-modules.js";
import type { ClockTicket } from "../player/clock-ticket.js";
import { clockTicket } from "./helpers/clock-ticket.js";

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
    "player/vue/src/usePlayerSession.ts",
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
  const path = new URL("../../player/vue/src/useRuntimeSceneClock.ts", import.meta.url);
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

test("the clock-work family covers every kind of work in every state of the clock", () => {
  // The axis is the clock's own domain: a kind of work the clock gains needs its row here.
  assert.deepEqual([...WORK].sort(), declaredWork().sort());
  const feasible = product({ work: [...WORK], state: [...STATES] });
  const observed = CASES.map(({ work, state }) => ({ work, state }));
  assert.deepEqual(coverageGaps(feasible, observed, { tuples: true }), []);
  const lacking = observed.filter(
    (each) => !(each.work === "keepCapture" && each.state === "held"),
  );
  assert.ok(coverageGaps(feasible, lacking, { tuples: true }).length > 0);
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
  const client: BridgeClient = bridge.client;
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
async function mount(context: TestContext, held: boolean) {
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
  const host = scope.run(() =>
    usePlayerSession({
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
      source: { kind: "plan", text: serializeValidatedRuntimeJson(script(draw)) },
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
  await start(held);
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

for (const { work, state, name } of CASES)
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
  const earlier = bridge.section(shown as never, clockTicket(), async (section) => {
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

test("an observation refused twice at its turn is no observation: null, nothing published, nothing scheduled", async (context) => {
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
  assert.equal(player.timeouts.armed, armed, "nothing scheduled");
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
  assert.equal(observed?.revision, bridge.latest(shown as never)?.revision);
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
    "player/vue/src/useRuntimeSceneClock.ts",
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

// #1983: the clock opens every section (`section`), under a row of `SECTION_WORK`, and observes what the row needs at
// the section's turn, before its body. Exclusions, decided where named: which row a sender names is visible at its call
// site and reviewed; that `runInput`'s target check, intent and tab run after the observation's reply is
// `player-runtime-input.test.ts` ("a blocked tab posts no answer…"); that a service's delivery settles its answer on a
// `null` observation is `player-session-camera.test.ts` ("a capture whose section finds its session retired…").

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
  const path = new URL("../../player/vue/src/useRuntimeSceneClock.ts", import.meta.url);
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

test("the section-work family covers every row in each state its turn can have", () => {
  assert.deepEqual([...SECTION_ROWS].sort(), declaredSectionWork().sort());
  const feasible = [
    ...product({ row: [...SECTION_ROWS], state: ["owned", "held", "retired"] }),
    ...product({ row: ["mediaLoadObserved", "mediaLoad"], state: ["basis refused"] }),
  ];
  const observed = SECTION_CASES.map(({ row, state }) => ({ row, state }));
  assert.deepEqual(coverageGaps(feasible, observed, { tuples: true }), []);
  const lacking = observed.filter((each) => !(each.row === "service" && each.state === "held"));
  assert.ok(coverageGaps(feasible, lacking, { tuples: true }).length > 0);
});

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
    "player/vue/src/useRuntimeSceneClock.ts",
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

for (const { row, state, name } of SECTION_CASES)
  test(`the clock opens a section under its row, observing at its turn: ${name}`, async (context) => {
    const player = await mount(context, false);
    const bridge = await player.host.bridge;
    const shown = player.host.session.value!;
    const { clock, paused, sampled } = await sectionClock(context, shown);
    // An earlier section holds the session's queue, so this one waits for its turn.
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    // EVIDENCE: fixture: the shown session is a publication of this bridge.
    const earlier = bridge.section(shown as never, clockTicket(), () => opened);
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
  const earlier = bridge.section(shown as never, clockTicket(), () => opened);
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
  const path = new URL("../../player/vue/src/useRuntimeSceneClock.ts", import.meta.url);
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
      (inside ? decided : undecided).push(callee);
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
