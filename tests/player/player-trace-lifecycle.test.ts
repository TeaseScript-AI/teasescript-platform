import assert from "node:assert/strict";
import test, { after, before, type TestContext } from "node:test";
import { effectScope, watch, type Ref } from "vue";

import type * as Client from "../../player/engine-bridge/client.js";
import type * as CompileProject from "../../player/runtime/compile-project.js";
import type * as InProcess from "../../player/engine-bridge/in-process.js";
import type { DebugView, DebugViewRequest } from "../../player/debug/debug-view.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import type { RuntimeDebugContext } from "../../src/runtime/debug/debug-trace.js";
import { listRandomSites } from "../../src/playback.js";
import { coverageGaps, product, type Coordinates } from "../helpers/family-coverage.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import { decodeMessage } from "../../player/engine-bridge/transport.js";
import { preparedSource, type PlanStart } from "../helpers/prepared-plan.js";

/*
 * L5i.3, the trace-ordering family (Sol r1 R2, r2 R2.1, r3 R2.2, r4 R2.3) over the Player's lifetime, and L5i.4's random
 * control under the same rule (Sol plan P8). The connection's value trace, and its random control, follow the newest
 * intent a live Player sent; a setting made before the host is reachable waits as the Player's, and only its latest
 * goes, once the host is reachable and while the Player lives. One live Player per bridge; a later one reuses it. The
 * host's side of the tracing rule, every carrier in every delivery order, is `player-trace-intent.test.ts`'s; random
 * control's is `player-random-control.test.ts`'s.
 */

interface TracingPlayer {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly bridge: Promise<PlayerBridge>;
  readonly debugTracing: Readonly<Ref<boolean>>;
  readonly traceId: Readonly<Ref<number | null>>;
  prepare(create: PlanStart): void;
  activate(): Promise<void>;
  setDebugTracing(on: boolean): void;
  setRandomControl(
    control: { readonly sites: readonly (readonly [string, "random" | "untried"])[] } | null,
  ): void;
  debugView(request: DebugViewRequest): Promise<DebugView | null>;
}
let usePlayerSession: (options: { readonly bridge: Promise<PlayerBridge> }) => TracingPlayer;
let facade: typeof InProcess;
let compiler: typeof CompileProject;
let BridgeLostError: typeof Client.BridgeLostError;
// The random fixture's sites: the first draw goes on by itself and is recorded; the second asks, so the session pauses.
let hitSite = "";
let rollSite = "";

const restore: (() => void)[] = [];
before(async () => {
  const module = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: the bundle the composable runs in, whose facade reaches its host.
  facade = (await loadPlayerModule("player/engine-bridge/in-process.ts")) as typeof facade;
  // EVIDENCE: validation: the bundle's compiler module, from the same module graph.
  compiler = (await loadPlayerModule("player/runtime/compile-project.ts")) as typeof compiler;
  const client = await loadPlayerModule("player/engine-bridge/client.ts");
  // EVIDENCE: validation: the bundle's client module, whose loss error the client's listeners receive.
  BridgeLostError = client.BridgeLostError as typeof BridgeLostError;
  const sites = listRandomSites(compiler.compilePlayerProject(RANDOM_SCRIPT).plan!);
  const ofKind = (kind: string) =>
    sites.find((site) => site.kinds.some((each) => each === kind))?.id ?? "";
  [hitSite, rollSite] = [ofKind("chance"), ofKind("randomInteger")];
  // A browser surface with event targets and silent audio.
  const surface = {
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    Audio: class {
      src = "";
      play = async () => {};
      pause() {}
      load() {}
      removeAttribute() {}
    },
  };
  for (const [name, value] of Object.entries(surface)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restore.push(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
after(() => {
  for (const undo of restore) undo();
});

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
// A declaration, an interpolated message and an input: the source the trace records from its first statement.
const SCRIPT = 'let mood = "calm"\nsay "${mood} now", instant\nlet answer = askText "Ready?"\nexit';
const OBSOLETE = 'say "obsolete", instant\nlet answer = askText "Old?"\nexit';
// The same, with two draws after the message: the Start decides the first and pauses at the second under control.
const RANDOM_SCRIPT =
  'let mood = "calm"\nsay "${mood} now", instant\nlet hit = chance(50)\nlet roll = randomInteger(1..=6)\nlet answer = askText "Ready?"\nexit';
const RECENT: DebugViewRequest = {
  messages: { limit: 20, openNewest: false },
  selected: null,
  variables: null,
  image: false,
  trees: {},
};
const ONE_PLAYER = /One live Player per engine bridge/u;

// The family's axes, declared once.
/** The Player before this one on the same connection: its tracing changes; it ends at once after the last. */
const HISTORIES = {
  fresh: [],
  "ended on": [true],
  "ended off": [true, false],
  "ended on-off-on": [true, false, true],
} as const;
const HISTORY_NAMES = ["fresh", "ended on", "ended off", "ended on-off-on"] as const;
/** This Player's tracing changes; a Start goes before the change at its place, or after the last. */
const SEQUENCES = {
  untouched: [],
  on: [true],
  "on-off": [true, false],
  "on-off-on": [true, false, true],
} as const;
const SEQUENCE_NAMES = ["untouched", "on", "on-off", "on-off-on"] as const;
/**
 * The Player's lifetime around its changes and Start. `waiting`: its bridge becomes ready after them; `ready` and
 * `issued`: before them, with the connection's queue held by a compile. `dispose`: it ends before its bridge is ready;
 * `handover`: it ends, and a next Player on the bridge asks the opposite and starts; `replaced`: a second Start
 * replaces the first.
 */
const LIFECYCLES = [
  "ready/live",
  "waiting/live",
  "waiting/dispose",
  "waiting/handover",
  "waiting/replaced",
  "issued/replaced",
  "issued/handover",
] as const;
/** What the Player changes: Debug's value trace, or its random control (Choose outcomes). */
const SETTING_NAMES = ["tracing", "random"] as const;
type SettingName = (typeof SETTING_NAMES)[number];
type History = (typeof HISTORY_NAMES)[number];
type Sequence = (typeof SEQUENCE_NAMES)[number];
type Lifecycle = (typeof LIFECYCLES)[number];
interface Case {
  readonly setting: SettingName;
  readonly history: History;
  readonly sequence: Sequence;
  readonly start: number;
  readonly lifecycle: Lifecycle;
  readonly name: string;
}

const places = (sequence: Sequence) => [...Array(SEQUENCES[sequence].length + 1).keys()];
const CASES: readonly Case[] = SETTING_NAMES.flatMap((setting) =>
  HISTORY_NAMES.flatMap((history) =>
    SEQUENCE_NAMES.flatMap((sequence) =>
      places(sequence).flatMap((start) =>
        LIFECYCLES.map((lifecycle) => ({
          setting,
          history,
          sequence,
          start,
          lifecycle,
          name: `${setting}: ${history}; ${sequence}, Start at ${start}; ${lifecycle}`,
        })),
      ),
    ),
  ),
);
/** The cases each sibling of the family was found by, as the family names them. */
const WITNESSES: Readonly<Record<string, string>> = Object.fromEntries(
  SETTING_NAMES.flatMap((setting) =>
    [
      ["fresh; on, Start at 1; ready/live", "R2"],
      ["fresh; on-off-on, Start at 3; ready/live", "R2.1"],
      ["ended on-off-on; on, Start at 1; ready/live", "R2.2"],
      ["fresh; on, Start at 0; waiting/dispose", "R2.3"],
      ["ended off; on-off-on, Start at 3; waiting/handover", "R2.3"],
    ].map(([name, sibling]): [string, string] => [`${setting}: ${name!}`, sibling!]),
  ),
);

const coordinates = (each: Case): Coordinates => ({
  setting: each.setting,
  history: each.history,
  sequence: each.sequence,
  start: String(each.start),
  lifecycle: each.lifecycle,
});
/** The feasible cases, enumerated apart from `CASES`: a Start's place is at most the sequence's length. */
const FEASIBLE = product({
  setting: [...SETTING_NAMES],
  history: [...HISTORY_NAMES],
  sequence: [...SEQUENCE_NAMES],
  start: ["0", "1", "2", "3"],
  lifecycle: [...LIFECYCLES],
}).filter((tuple) => {
  // EVIDENCE: invariant: `product` takes each `sequence` from `SEQUENCE_NAMES`.
  const sequence = tuple.sequence as Sequence;
  return Number(tuple.start) <= SEQUENCES[sequence].length;
});

test("the lifecycle cases are each feasible case once, named by their axes", () => {
  assert.equal(new Set(CASES.map((each) => each.name)).size, CASES.length, "names are unique");
  const observed = CASES.map(coordinates);
  assert.deepEqual(coverageGaps(FEASIBLE, observed, { tuples: true }), []);
  assert.equal(CASES.length, 2 * 4 * (1 + 2 + 3 + 4) * 7);
  for (const name of Object.keys(WITNESSES))
    assert.ok(
      CASES.some((each) => each.name === name),
      `the witness ${name} is a case`,
    );
  // The check fails a family that lacks a slice of history × lifecycle.
  const lacking = observed.filter(
    (tuple) => !(tuple.history === "ended on" && tuple.lifecycle === "waiting/dispose"),
  );
  assert.ok(coverageGaps(FEASIBLE, lacking).some((gap) => gap.startsWith("missing pair")));
});

const turn = () => new Promise((resolve) => setImmediate(resolve));

// The sessions the test's Players showed, by ID: their turns hold work sent `after` them, as random intents are.
const shownSessions = new Map<string, PlayerSession>();

/**
 * Drains the fixture's queues: the connection's, and each shown session's turn (where random intents travel, `after`
 * it), twice, as work that drains may send more; then the replies' continuations ran. It drains nothing else.
 */
async function settleFixtureQueues(bridge: PlayerBridge) {
  for (let round = 0; round < 2; round += 1) {
    await bridge.client.request("prepare", { source: { kind: "source", script: "exit" } });
    for (const session of shownSessions.values())
      if (session.connection === bridge)
        await bridge.read(session, "randomTried", { site: hitSite }).catch(() => null);
  }
  await turn();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Each test's Players' names of a trace given while their Debug was off: a reply of an older change names none.
const staleNames = new WeakMap<TestContext, number[]>();

/** A Player on `bridge`, unmounted at the test's end at the latest. */
function mounted(context: TestContext, bridge: Promise<PlayerBridge>) {
  const scope = effectScope();
  const player = scope.run(() => {
    const made = usePlayerSession({ bridge });
    const named = staleNames.get(context) ?? [];
    staleNames.set(context, named);
    watch(
      () => made.traceId.value,
      (id) => {
        if (id !== null && !made.debugTracing.value) named.push(id);
      },
      { flush: "sync" },
    );
    watch(
      () => made.session.value,
      (shown) => void (shown !== null && shownSessions.set(shown.id, shown)),
      { flush: "sync" },
    );
    return made;
  })!;
  context.after(() => {
    scope.stop();
    shownSessions.clear();
  });
  return { player, end: () => scope.stop() };
}

/** No Player of the test named a trace while its Debug was off. */
const namedNoStaleTrace = (context: TestContext, name: string) =>
  assert.deepEqual(staleNames.get(context) ?? [], [], `${name}: no older reply names a trace`);

/** The Starts a test began, in order: whose, their script, and the trace and random control each began with. */
type Starts = {
  readonly by: TracingPlayer;
  readonly script: string;
  readonly trace: RuntimeDebugContext | null;
  readonly controlled: boolean;
}[];
/** Begins a Start of `script` for `by`: `starting`'s mark, given by `recordStarts`. */
type MarkStart = (by: TracingPlayer, script: string) => void;

/**
 * Records in `starts` each Start the host makes on `bridge`: the trace its session began with and whether its Player's
 * random control decides its draws, read from the host as it posts `start`'s reply, which it does at the end of the op's
 * own dispatch, before any later request runs. Whose Start and which script come from its `MarkStart`, given as its
 * begin reads its options, just before it posts `start`.
 */
function recordStarts(context: TestContext, bridge: PlayerBridge, starts: Starts): MarkStart {
  let next: { readonly by: TracingPlayer; readonly script: string } | null = null;
  const begun = new Map<
    number,
    { readonly by: TracingPlayer; readonly script: string; readonly owner: number | null }
  >();
  const clone = globalThis.structuredClone;
  context.mock.method(
    globalThis,
    "structuredClone",
    (value: unknown, options?: StructuredSerializeOptions) => {
      const data = decodeMessage(value);
      if (isRecord(data) && data.kind === "request" && data.op === "start" && next !== null) {
        const random =
          isRecord(data.args) && isRecord(data.args.random) ? data.args.random.owner : null;
        begun.set(Number(data.id), { ...next, owner: typeof random === "number" ? random : null });
        next = null;
      } else if (isRecord(data) && data.kind === "reply" && begun.has(Number(data.id))) {
        const start = begun.get(Number(data.id))!;
        begun.delete(Number(data.id));
        const random = facade.heldRandom(bridge);
        starts.push({
          by: start.by,
          script: start.script,
          trace: facade.heldTrace(bridge),
          controlled:
            start.owner !== null && random.owner === start.owner && random.control !== null,
        });
      }
      return clone(value, options);
    },
  );
  return (by, script) => void (next = { by, script });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A Start of the plan `tokens` holds for `script`, which marks itself as its begin reads its options. */
const starting = (
  mark: MarkStart,
  tokens: ReadonlyMap<string, string>,
  by: TracingPlayer,
  script: string,
) => ({
  plan: tokens.get(script)!,
  options: () => {
    mark(by, script);
    return { wallClockMs: 0 };
  },
});

/** The plans of the test's scripts, prepared in the host of `bridge` from source before anything is timed. */
async function preparedScripts(bridge: PlayerBridge): Promise<ReadonlyMap<string, string>> {
  const tokens = new Map<string, string>();
  for (const script of [SCRIPT, OBSOLETE, RANDOM_SCRIPT])
    tokens.set(script, await preparedSource(Promise.resolve(bridge), script));
  return tokens;
}

/** The host's state of a setting, as a next Player's ended predecessor must leave it. */
type Snapshot =
  | {
      readonly trace: RuntimeDebugContext | null;
      readonly status: ReturnType<RuntimeDebugContext["status"]> | null;
    }
  | { readonly owner: number; readonly on: boolean; readonly revision: number };

/** What the case's Player changes, and how the family reads it. */
interface Setting {
  /** The fixture the Starts run. */
  readonly script: string;
  /** The serial counter its intents take (`PlayerBridge`). */
  readonly mint: "nextTracingIntent" | "nextRandomIntent";
  set(player: TracingPlayer, on: boolean): void;
  /** Whether a Start began with the setting on, as its factory saw it. */
  began(start: Starts[number]): boolean;
  /** How many serials a waiting Player's readiness takes: the latest change, or a used bridge's alignment. */
  readyMints(changes: readonly boolean[], history: History): number;
  /** What a next Player's ended predecessor must leave unchanged once its bridge became ready. */
  snapshot(bridge: PlayerBridge): Snapshot;
  /** The oracle once settled, for the live Player `owner` (`null` for none) and its Starts. */
  holds(
    name: string,
    bridge: PlayerBridge,
    owner: { readonly player: TracingPlayer; readonly asked: boolean } | null,
    last: Starts[number] | null,
    starts: Starts,
  ): Promise<void>;
}

/** The Player shows its own Start only. */
function showsItsStart(name: string, player: TracingPlayer) {
  const shown = player.session.value!.transcriptEntries.map((entry) => entry.text);
  assert.ok(shown.includes("calm now"), `${name}: its Start shows`);
  assert.ok(!shown.includes("obsolete"), `${name}: a replaced Start shows nothing`);
}

const SETTINGS: Readonly<Record<SettingName, Setting>> = {
  tracing: {
    script: SCRIPT,
    mint: "nextTracingIntent",
    set: (player, on) => player.setDebugTracing(on),
    began: (start) => start.trace !== null,
    // A bridge no Player traced on needs no setting until one changes.
    readyMints: (changes, history) => (changes.length > 0 || history !== "fresh" ? 1 : 0),
    snapshot: (bridge) => {
      const trace = facade.heldTrace(bridge);
      return { trace, status: trace?.status() ?? null };
    },
    /**
     * The host traces as its live Player last asked, the Player names the host's trace, and a Start that began with the
     * trace that stays keeps its history.
     */
    holds: async (name, bridge, owner, last) => {
      const want = owner?.asked ?? false;
      const trace = facade.heldTrace(bridge);
      assert.equal(trace !== null, want, `${name}: the host traces as its live Player asked last`);
      if (owner === null) return;
      const { player } = owner;
      assert.equal(player.debugTracing.value, want, `${name}: the Player shows what it asked`);
      const view = await player.debugView(RECENT);
      assert.equal(player.traceId.value, want ? view!.traceId : null, `${name}: names the trace`);
      showsItsStart(name, player);
      const kept = last?.trace ?? null;
      if (want && kept !== null) {
        assert.equal(trace, kept, `${name}: the trace its Start began with stays`);
        const status = trace!.status();
        assert.equal(status.origin, "start", name);
        assert.ok(status.records >= 2, `${name}: ${status.records} records`);
        assert.ok(
          (view!.messages?.count ?? 0) >= 1,
          `${name}: recent chat holds the Start's message`,
        );
      }
    },
  },
  random: {
    script: RANDOM_SCRIPT,
    mint: "nextRandomIntent",
    set: (player, on) => player.setRandomControl(on ? { sites: [[hitSite, "random"]] } : null),
    began: (start) => start.controlled,
    // A next Player's history and control are its own from its first intent: no alignment.
    readyMints: (changes) => (changes.length > 0 ? 1 : 0),
    snapshot: (bridge) => {
      const random = facade.heldRandom(bridge);
      return {
        owner: random.owner,
        on: random.control !== null,
        revision: random.history.revision,
      };
    },
    /**
     * The host's control is on as its live Player last asked; a Start that began under it decided the first draw and
     * waits at the second; the history holds the live Player's own decided draws only.
     */
    holds: async (name, bridge, owner, last, starts) => {
      const want = owner?.asked ?? false;
      const random = facade.heldRandom(bridge);
      if (owner === null) {
        assert.equal(random.control, null, `${name}: an ended Player's control ended with it`);
        return;
      }
      const { player } = owner;
      // Control is the live Player's only while the host's random state is its own (`ownedRandom`).
      const shownNow = player.session.value!;
      const owned = (await bridge.read(shownNow, "randomTried", { site: hitSite })) !== null;
      assert.equal(owned && random.control !== null, want, `${name}: control as it asked last`);
      showsItsStart(name, player);
      if (want && last !== null && last.controlled)
        assert.equal(player.session.value!.state.randomDraw?.site, rollSite, `${name}: it waits`);
      const decided = starts.filter(
        (start) => start.by === player && start.controlled && start.script === RANDOM_SCRIPT,
      ).length;
      assert.equal(
        random.history.tried(hitSite).history.length,
        decided,
        `${name}: the history holds the live Player's own draws only`,
      );
    },
  },
};

/** A host whose replies take a millisecond, with the count of the setting's serials minted on it. */
function backend(context: TestContext, setting: Setting) {
  const bridge = facade.createInProcessBackend(BUILD, { delayMs: 1 });
  context.after(() => bridge.client.terminate());
  const minted = context.mock.method(bridge, setting.mint);
  return { bridge, minted: () => minted.mock.callCount() };
}

/** The Player before this one on the connection, as `history` says: its changes reach the host, then it ends. */
async function lived(
  context: TestContext,
  bridge: PlayerBridge,
  history: History,
  setting: Setting,
) {
  const changes = HISTORIES[history];
  if (changes.length === 0) return;
  const { player, end } = mounted(context, Promise.resolve(bridge));
  await player.bridge;
  for (const on of changes) setting.set(player, on);
  await settleFixtureQueues(bridge);
  end();
}

/** Plays one case, and checks every Start's setting as it began, and the oracle once settled. */
async function play(context: TestContext, each: Case) {
  const setting = SETTINGS[each.setting];
  const { bridge, minted } = backend(context, setting);
  await lived(context, bridge, each.history, setting);
  const tokens = await preparedScripts(bridge);
  const { lifecycle } = each;
  const waiting = lifecycle.startsWith("waiting");
  const handover = lifecycle.endsWith("handover");
  const replaced = lifecycle.endsWith("replaced");
  const changes = SEQUENCES[each.sequence];
  const asked = changes.at(-1) ?? false;
  const gate = deferred<PlayerBridge>();
  const current = mounted(context, waiting ? gate.promise : Promise.resolve(bridge));
  const holding = waiting
    ? null
    : current.player.bridge.then(() =>
        bridge.client.request("prepare", { source: { kind: "source", script: "exit" } }),
      );
  if (!waiting) await current.player.bridge;
  // The Starts expected, each with whether it begins with the setting on: as the Player's latest change sent then,
  // while its bridge is ready; else once ready, as its latest change; an ended or replaced Player's waiting Start never
  // begins.
  const starts: Starts = [];
  const mark = recordStarts(context, bridge, starts);
  const expected: { script: string; on: boolean }[] = [];
  const activations: Promise<void>[] = [];
  const start = (script: string, on: boolean) => {
    current.player.prepare(starting(mark, tokens, current.player, script));
    activations.push(current.player.activate());
    if (!waiting) expected.push({ script, on });
  };
  const first = replaced ? OBSOLETE : setting.script;
  changes.forEach((on, index) => {
    if (index === each.start) start(first, changes[index - 1] ?? false);
    setting.set(current.player, on);
  });
  if (each.start === changes.length) start(first, asked);
  if (replaced) start(setting.script, asked);
  if (waiting && (lifecycle === "waiting/live" || replaced))
    expected.push({ script: setting.script, on: asked });
  let owner: { readonly player: TracingPlayer; readonly asked: boolean } | null = {
    player: current.player,
    asked,
  };
  if (lifecycle === "waiting/dispose" || handover) {
    current.end();
    owner = null;
  }
  let handedOver: Promise<void> | null = null;
  if (handover) {
    const next = mounted(context, Promise.resolve(bridge));
    await next.player.bridge;
    setting.set(next.player, !asked);
    next.player.prepare(starting(mark, tokens, next.player, setting.script));
    expected.push({ script: setting.script, on: !asked });
    handedOver = next.player.activate();
    activations.push(handedOver);
    owner = { player: next.player, asked: !asked };
  }
  // The Player's bridge becomes ready, after what a next one did has settled.
  let before: { readonly value: Snapshot } | null = null;
  const mintedBefore = minted();
  if (waiting) {
    if (handedOver !== null) {
      // The ended Player's Start still waits for its bridge.
      await handedOver;
      await settleFixtureQueues(bridge);
      before = { value: setting.snapshot(bridge) };
    }
    const ready = minted();
    gate.resolve(bridge);
    await current.player.bridge;
    if (owner?.player === current.player)
      assert.equal(
        minted() - ready,
        setting.readyMints(changes, each.history),
        `${each.name}: only the latest setting goes, once`,
      );
  }
  await Promise.all(activations);
  await holding;
  await settleFixtureQueues(bridge);
  if (lifecycle === "waiting/dispose" || lifecycle === "waiting/handover")
    assert.equal(minted(), mintedBefore, `${each.name}: a Player that ended sends nothing`);
  assert.deepEqual(
    starts.map((each) => ({ script: each.script, on: setting.began(each) })),
    expected,
    `${each.name}: each Start begins as its Player's newest intent says`,
  );
  if (before !== null)
    assert.deepEqual(
      setting.snapshot(bridge),
      before.value,
      `${each.name}: the ended Player's work leaves the next one's state`,
    );
  // The last Start keeps what it began with when no change came after it.
  const last = starts.at(-1);
  const afterChanges = waiting || handover || replaced || each.start === changes.length;
  await setting.holds(
    each.name,
    bridge,
    owner,
    afterChanges && last !== undefined ? last : null,
    starts,
  );
  namedNoStaleTrace(context, each.name);
}

for (const each of CASES) {
  const witness = WITNESSES[each.name];
  test(`over the Player's lifetime: ${each.name}${witness === undefined ? "" : ` (${witness})`}`, (context) =>
    play(context, each));
}

// The ends of a connection: a bridge that never became ready, and one lost after it was.
for (const name of SETTING_NAMES)
  for (const sequence of SEQUENCE_NAMES) {
    const setting = SETTINGS[name];
    // Tracing only: a Player whose bridge never became ready names no trace. Random control has no Player-side state to
    // check there, so it has no case (final review F8).
    if (name === "tracing")
      test(`${name} on a bridge that never becomes ready: ${sequence}`, async (context) => {
        const gate = deferred<PlayerBridge>();
        const { player } = mounted(context, gate.promise);
        const changes = SEQUENCES[sequence];
        for (const on of changes) setting.set(player, on);
        gate.reject(new Error("No engine host."));
        await assert.rejects(player.bridge, /No engine host/u);
        setting.set(player, !(changes.at(-1) ?? false));
        await turn();
        assert.equal(player.traceId.value, null, sequence);
      });

    test(`${name} on a bridge lost after it was ready: ${sequence}`, async (context) => {
      const { bridge, minted } = backend(context, setting);
      // The client's loss, as a real loss: its listeners hear a `BridgeLostError`.
      const listeners: ((error: Client.BridgeLostError) => void)[] = [];
      bridge.client.onLoss = (listener) => void listeners.push(listener);
      const reports = context.mock.method(console, "error", () => {});
      // A Player that ended before its bridge was ready observes no loss; one that ended after it was ready observes
      // the loss, and ignores it.
      const gate = deferred<PlayerBridge>();
      const ended = mounted(context, gate.promise);
      const before = mounted(context, Promise.resolve(bridge));
      await before.player.bridge;
      setting.set(before.player, true);
      await settleFixtureQueues(bridge);
      before.end();
      const { player } = mounted(context, Promise.resolve(bridge));
      await player.bridge;
      ended.end();
      gate.resolve(bridge);
      await ended.player.bridge;
      const changes = SEQUENCES[sequence];
      for (const on of changes) setting.set(player, on);
      await settleFixtureQueues(bridge);
      if (name === "tracing")
        assert.equal(player.traceId.value !== null, changes.at(-1) ?? false, sequence);
      bridge.client.terminate();
      for (const listener of listeners)
        listener(new BridgeLostError("The engine Worker failed: injected."));
      assert.equal(player.traceId.value, null, `${sequence}: the trace went with the host`);
      const sent = minted();
      setting.set(player, !(changes.at(-1) ?? false));
      for (let index = 0; index < 3; index += 1) await turn();
      assert.equal(player.traceId.value, null, `${sequence}: a lost host names no trace`);
      assert.ok(minted() - sent <= 1, `${sequence}: no retry`);
      const hostErrors = reports.mock.calls.filter(
        (call) => call.arguments[0] === "[player] host error",
      );
      assert.equal(hostErrors.length, 1, `${sequence}: only the live Player reports the loss`);
    });
  }

// One live Player per bridge: a second one is refused before it sends anything, and a later one reuses the bridge.
for (const settingName of SETTING_NAMES)
  for (const history of HISTORY_NAMES)
    for (const sequence of SEQUENCE_NAMES)
      for (const order of ["refused while live", "ready after another"] as const)
        test(`one live Player per bridge, ${settingName}: ${history}; ${sequence}; ${order}`, async (context) => {
          const setting = SETTINGS[settingName];
          const name = `${settingName}: ${history}; ${sequence}; ${order}`;
          const { bridge, minted } = backend(context, setting);
          await lived(context, bridge, history, setting);
          const tokens = await preparedScripts(bridge);
          const changes = SEQUENCES[sequence];
          const asked = changes.at(-1) ?? false;
          const starts: Starts = [];
          const mark = recordStarts(context, bridge, starts);
          if (order === "refused while live") {
            const live = mounted(context, Promise.resolve(bridge));
            await live.player.bridge;
            for (const on of changes) setting.set(live.player, on);
            live.player.prepare(starting(mark, tokens, live.player, setting.script));
            await live.player.activate();
            await settleFixtureQueues(bridge);
            const sent = minted();
            const second = mounted(context, Promise.resolve(bridge));
            await assert.rejects(second.player.bridge, ONE_PLAYER);
            setting.set(second.player, !asked);
            second.end();
            await settleFixtureQueues(bridge);
            assert.equal(minted(), sent, `${name}: the refused Player sends nothing`);
            await setting.holds(
              name,
              bridge,
              { player: live.player, asked },
              starts.at(-1)!,
              starts,
            );
            // Once the live Player ended, a next one takes the bridge.
            live.end();
            const next = mounted(context, Promise.resolve(bridge));
            await next.player.bridge;
            await settleFixtureQueues(bridge);
            await setting.holds(name, bridge, null, null, starts);
          } else {
            const gate = deferred<PlayerBridge>();
            const late = mounted(context, gate.promise);
            for (const on of changes) setting.set(late.player, on);
            const live = mounted(context, Promise.resolve(bridge));
            await live.player.bridge;
            setting.set(live.player, !asked);
            live.player.prepare(starting(mark, tokens, live.player, setting.script));
            await live.player.activate();
            await settleFixtureQueues(bridge);
            const sent = minted();
            gate.resolve(bridge);
            await assert.rejects(late.player.bridge, ONE_PLAYER);
            await settleFixtureQueues(bridge);
            assert.equal(minted(), sent, `${name}: the refused Player sends nothing`);
            await setting.holds(
              name,
              bridge,
              { player: live.player, asked: !asked },
              starts.at(-1)!,
              starts,
            );
          }
        });
