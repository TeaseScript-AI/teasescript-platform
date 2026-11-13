import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, watch, type Ref } from "vue";

import type * as CompileProject from "../../player/runtime/compile-project.js";
import type * as InProcess from "../helpers/bridge/in-process.js";
import type * as ClientModule from "../../player/engine-bridge/client.js";
import type { BridgeResult, ReplyHook } from "../../player/engine-bridge/client.js";
import type { UntypedSend } from "../helpers/bridge/untyped.js";
import type { DebugViewRequest } from "../../player/debug/debug-view.js";
import type { ScriptStorageProvider } from "../../player/persistence/script-storage.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import type { StartOptions } from "../../player/engine-bridge/ops/session.js";
import type { InstructionPlan } from "../../src/index.js";
import { coverageGaps, product, type Coordinates } from "../helpers/family-coverage.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import { preparedPlan, type PlanStart } from "../helpers/prepared-plan.js";
import { clockTicket } from "../helpers/clock-ticket.js";
import { untypedClient } from "../helpers/bridge/untyped.js";
import { hostIntroduced, loadHostFacade } from "../helpers/player/host-sessions.js";
import { reportsInto } from "../helpers/player/rewind-host.js";

/*
 * Session split S2's runtime family (its HEAD 0): an activation's completions act only while it lives. Each case is a
 * full tuple of the axes below, on the Player's composable and its in-process engine: an operation the activation (or
 * the page, for it) issued, whose reply is held; an ownership transition while it is held; where the reply is let go
 * relative to that transition and its successor; how it settles; and the successor that follows.
 *
 * The oracle is the schedule itself. A case runs twice: once letting the held reply go, once never letting it go. For
 * a completion whose activation retired (or whose begin a preparation or stop replaced), the two must end alike: the
 * page shows, reports, posts and holds nothing the second does not. For a completion whose activation lives, they must
 * differ by the operation's own effect. A same-lineage Continue keeps the lineage-owned successes of the three
 * captured-origin reporters (Q1 B), which therefore still show. A coordinate counts only once its assertions and
 * cleanup ran (`completed`); the feasible tuples are derived from the axes alone, each excluded one with its reason.
 *
 * What this does not show: branches these schedules do not reach, and what a trusted adapter does beyond the effects
 * observed here, remain unverified (HEAD 0's claim).
 */

const AXES = {
  handle: [
    "startReply",
    "lateStartStop",
    "continueRecording",
    "continueDebugMode",
    "continueReply",
    "adoption",
    "haltAck",
    "captureReply",
    "debugMode",
    "debugModePublish",
    "debugModeKeep",
    "draw",
    "drawQueued",
    "export",
    "exportWaiting",
    "debugView",
    "callView",
    "mediaLoad",
  ],
  transition: [
    "none",
    "replacement",
    "sameLineage",
    "disposal",
    "loss",
    "preparation",
    "errorStop",
    "cancellation",
  ],
  window: ["inFlight", "settled", "afterSuccessor"],
  settlement: ["success", "rejection"],
  successor: ["none", "start", "continue", "newPlayer"],
} as const;
type Case = { readonly [A in keyof typeof AXES]: (typeof AXES)[A][number] };
type Handle = Case["handle"];

/** The begins: a later activation begins only once these settled (`begunInFlight`). */
const BEGINS: readonly Handle[] = [
  "startReply",
  "lateStartStop",
  "continueRecording",
  "continueDebugMode",
  "continueReply",
];
/** The error stop's own work, which its stop token authorizes. */
const STOPS: readonly Handle[] = ["haltAck", "captureReply"];
/** The three captured-origin reporters (Q1 B), whose success stays the lineage's. */
const REPORTERS: readonly Handle[] = ["debugView", "callView", "mediaLoad"];
/** The operations sent in a section of the session, which holds the session's other requests until it ends. */
const SECTIONS: readonly Handle[] = ["draw", "mediaLoad"];
// `drawQueued` holds no reply of its own: another section of the session holds the draw's from beginning.
/** The operations whose entry gives a result its caller takes: the draw's outcome, the candidate, the view. */
const RESULTS: readonly Handle[] = ["draw", "drawQueued", "export", "exportWaiting", "debugView"];

/** Why a tuple is no case, or `null` for a feasible one. */
function infeasible(c: Case): string | null {
  const begin = BEGINS.includes(c.handle);
  const stop = STOPS.includes(c.handle);
  const successors: Record<Case["transition"], readonly Case["successor"][]> = {
    none: ["none"],
    replacement: ["start"],
    sameLineage: ["continue"],
    disposal: ["none", "newPlayer"],
    loss: ["none"],
    preparation: ["none"],
    errorStop: ["none"],
    cancellation: ["none"],
  };
  if (!successors[c.transition].includes(c.successor))
    return "the successor is the transition's own: a replacement's Start, a Continue's, a new Player only after disposal, none else";
  if (c.transition === "none" && c.window !== "inFlight")
    return "nothing retires the activation: there is no transition to order the reply against";
  if (c.window === "afterSuccessor" && c.successor === "none") return "no successor begins";
  if (
    c.window === "afterSuccessor" &&
    c.transition === "sameLineage" &&
    SECTIONS.includes(c.handle)
  )
    return "the Continue's requests for the session wait for the section the held reply is in";
  if (
    begin &&
    (c.transition === "replacement" || c.transition === "sameLineage") &&
    c.window !== "settled"
  )
    return "a later activation begins only once the one in flight settled (`begunInFlight`)";
  if (begin && c.transition === "sameLineage")
    return "a same-lineage Continue continues the shown session, which a begin in flight has not shown yet";
  if (c.transition === "cancellation" && c.handle !== "export" && c.handle !== "exportWaiting")
    return "only the export has a cancellation of its own: its dialog's";
  if (c.transition === "preparation" && !begin && !stop)
    return "a preparation invalidates the begin and stop tokens only, which this completion does not carry";
  if (c.transition === "errorStop" && !begin)
    return "an error stop retires nothing: what completes after it is the stop-ownership tests' (`player-stop-ownership`)";
  if (c.transition === "loss" && c.window === "inFlight" && c.settlement === "success")
    return "the loss rejects every reply in transit";
  if (c.handle === "drawQueued" && c.settlement === "rejection")
    return "what the draw waits for is another section's end, which has no failure of the draw's";
  if (c.handle === "drawQueued" && c.transition === "sameLineage" && c.window !== "inFlight")
    return "the Continue's requests wait for the section that holds the draw: it goes on only once that ends";
  if (c.handle === "haltAck" && c.settlement === "rejection")
    return "a halt's failed acknowledgement freezes the store as its success does (`PlayerBridge.halt`)";
  return null;
}

const FEASIBLE = product(AXES).filter((coordinates) => infeasible(asCase(coordinates)) === null);

function asCase(coordinates: Coordinates): Case {
  // EVIDENCE: invariant: `product` gives the declared axes' values.
  return coordinates as Case;
}

interface FamilyHost {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly hostError: Readonly<Ref<string | null>>;
  readonly stopped: Readonly<Ref<boolean>>;
  observe(): Promise<PlayerSession | null>;
  readonly randomRevision: Readonly<Ref<number>>;
  readonly bridge: Promise<PlayerBridge>;
  prepare(create: PlanStart): void;
  prepareRestore(restored: PlayerSession): void;
  activate(): Promise<void>;
  setDebugMode(enabled: boolean): void;
  setDebugTracing(on: boolean): void;
  setRandomControl(control: { readonly sites: readonly [] } | null): void;
  resolveRandomDraw(
    drawId: number,
    outcome: "natural" | { readonly kind: "number"; readonly value: number },
  ): Promise<{ readonly kind: string } | null>;
  debugView(request: DebugViewRequest): Promise<object | null>;
  demandCallView(): { release(): void };
  debugExportCandidate(
    details: () => { readonly player: object; readonly host: object },
    wanted: AbortSignal,
  ): Promise<{ release(): void } | null>;
  loadScriptStorage(): Promise<void>;
  prepareScript(
    token: string,
    create: { readonly plan: string; readonly options: () => StartOptions },
  ): Promise<void>;
  reportHostError(error: unknown): void;
}

let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly resolveAsset?: (path: string) => string | null;
  readonly room?: "debug";
  readonly scriptStorage?: ScriptStorageProvider;
}) => FamilyHost;
let facade: typeof InProcess;
let compiler: typeof CompileProject;
let client: typeof ClientModule;

before(async () => {
  await loadHostFacade();
  const session = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  assert.equal(typeof session.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its host API.
  usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: the bundle the composable runs in, whose facade reaches its sessions.
  facade = (await loadPlayerModule("tests/helpers/bridge/in-process.ts")) as typeof facade;
  // EVIDENCE: validation: the bundle's compiler module, from the same module graph.
  compiler = (await loadPlayerModule("player/runtime/compile-project.ts")) as typeof compiler;
  // EVIDENCE: validation: the bundle's client module, whose loss error the composable recognizes.
  client = (await loadPlayerModule("player/engine-bridge/client.ts")) as typeof client;
});

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const SCRIPT = [
  "let r = randomInteger(1..=6)",
  'say "rolled", instant',
  'let pick = askChoice "One", "Two"',
  'say "picked ${pick}", instant',
  "exit",
].join("\n");

async function settle() {
  for (let round = 0; round < 6; round += 1) {
    for (let turn = 0; turn < 4; turn += 1) await nextTick();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function until(done: () => boolean, what: string) {
  for (let round = 0; round < 2_000 && !done(); round += 1)
    await new Promise((resolve) => setTimeout(resolve, round < 100 ? 0 : 1));
  assert.ok(done(), what);
}

// Each script compiles once: its cases start sessions of the same plan.
const plans = new Map<string, InstructionPlan>();
function planOf(script: string): InstructionPlan {
  let plan = plans.get(script);
  if (plan === undefined) plans.set(script, (plan = compiler.compilePlayerProject(script).plan!));
  return plan;
}

/** A Start of `script`'s cached plan with the clock at 0, prepared in `player`'s host as plan text. */
const startOf = async (player: { readonly bridge: Promise<PlayerBridge> }, script: string) => ({
  plan: await preparedPlan(player.bridge, planOf(script)),
  options: () => ({ wallClockMs: 0 }),
});

/** A browser surface with event targets, and audio elements the test can find. */
function browser(context: TestContext) {
  const elements: (EventTarget & { readonly src: string })[] = [];
  const surface = {
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    Audio: class extends EventTarget {
      src = "";
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
  return elements;
}

/**
 * A Player on `bridge` in its own scope; `keeping`, in the debug room with saved data of its own, so that what it shows
 * is kept as it goes.
 */
function playerOn(bridge: PlayerBridge, keeping = false) {
  const scope = effectScope();
  const player = scope.run(() =>
    usePlayerSession({
      bridge: Promise.resolve(bridge),
      resolveAsset: (path) => path,
      ...(keeping && {
        room: "debug" as const,
        scriptStorage: {
          scope: "family",
          load: async () => [],
          write: async () => {},
          replace: async () => {},
          clear: async () => {},
        },
      }),
    }),
  )!;
  return { player, stop: () => scope.stop() };
}

interface Post {
  readonly op: string;
  readonly phase: number;
}

/** A reply `wire` holds once armed: `release` lets it go (its answer, marked, or `error`), `held` says it arrived. */
interface Hold {
  held(): boolean;
  /** `then` runs once the reply settled, before what consumes it. */
  release(error: Error | null, then?: () => void): Promise<void>;
  /** Applies only what the host's reply does to its session's store, as a held hook would, and nothing of the page's. */
  applyHost(): Promise<void>;
}

/**
 * The host's part of a held reply hook: what the session's store does with the reply (`PlayerBridge`'s `#send`,
 * `viewCalls` and `halt`), apart from the publication the page shows. A capture's delivery is all the page's.
 */
function hostPart(bridge: PlayerBridge, op: string, session: string, result: BridgeResult) {
  const store = bridge.store(session);
  if (store === null) return;
  // EVIDENCE: fixture: these ops' replies carry the session's publication as their view.
  const view = result.view as Parameters<typeof store.apply>[0];
  // EVIDENCE: fixture: a `viewCalls` reply's result and a `halt` acknowledgement's are a call view or a stop.
  const final = result.result as Parameters<typeof store.freeze>[0];
  if (op === "halt") store.freeze(final);
  else if (op === "setDebugMode") store.apply(view);
  else if (op === "viewCalls" && final !== null) {
    store.apply(view);
    // EVIDENCE: fixture: as above, a `viewCalls` reply's result is its call view.
    store.mergeCallView(final as Parameters<typeof store.mergeCallView>[0]);
  }
}

/**
 * The page's traffic on `bridge`, with replies held: each `arm` holds the reply of the next `op` posted; with `hook`, its
 * reply hook (the store's application and publication, a capture's delivery) waits with it; `mark` changes the answer
 * it gives, so that what takes it shows.
 */
function wire(bridge: PlayerBridge) {
  const posts: Post[] = [];
  const state = { phase: 0 };
  interface Armed {
    readonly op: string;
    readonly hook: boolean;
    readonly mark: (result: BridgeResult) => BridgeResult;
    session: string | null;
    reply: {
      readonly answered: Promise<BridgeResult>;
      readonly hook: ReplyHook | undefined;
      open(result: BridgeResult): void;
      fail(error: unknown): void;
    } | null;
  }
  const armed: Armed[] = [];
  const hold = (
    op: string,
    args: unknown,
    session: string | null,
    answer: (hook: ReplyHook | undefined) => Promise<BridgeResult>,
    hook?: ReplyHook,
  ) => {
    // A halt that stops nothing but a superseded session (no stop) is an end, as a release is. A post that carries a
    // run names it: the carrier's origin.
    const run = typeof args === "object" && args !== null && "run" in args ? args.run : undefined;
    // A draw's resolution names whether it was a chosen outcome, as only the queued draw's case asks for one.
    const outcome =
      op === "resolveDraw" && typeof args === "object" && args !== null && "outcome" in args
        ? typeof args.outcome === "string"
          ? `:${args.outcome}`
          : ":chosen"
        : "";
    const label = op === "halt" && args === null ? "halt:plain" : `${op}${outcome}`;
    posts.push({ op: typeof run === "number" ? `${label}@${run}` : label, phase: state.phase });
    const each = armed.find((candidate) => candidate.op === op && candidate.reply === null);
    if (each === undefined) return answer(hook);
    each.session = session;
    const deferred = each.hook && hook !== undefined;
    let open!: (result: BridgeResult) => void;
    let fail!: (error: unknown) => void;
    const outward = new Promise<BridgeResult>((resolve, reject) => {
      open = resolve;
      fail = reject;
    });
    const answered = answer(deferred ? undefined : hook);
    // A held reply that is never let go stays pending; its own rejection is the host's, settled here.
    answered.catch(() => {});
    each.reply = { answered, hook: deferred ? hook : undefined, open, fail };
    return outward;
  };
  // The wrappers forward each op as it is sent, whatever it is: the client as its transport carries requests.
  const client = untypedClient(bridge.client);
  const request = client.request.bind(client);
  client.request = (op, args, options) =>
    hold(
      op,
      args,
      options?.session ?? null,
      (hook) => {
        const { onReply: _held, ...rest } = options ?? {};
        return request(op, args, { ...rest, ...(hook && { onReply: hook }) });
      },
      options?.onReply,
    );
  const signal = client.signal.bind(client);
  client.signal = (op, args, session, onReply) =>
    hold(op, args, session, (hook) => signal(op, args, session, hook), onReply);
  const section = client.section.bind(client);
  client.section = (session, ticket, body) =>
    section(session, ticket, (send) => {
      const wrapped: UntypedSend = (op, args, basis, onReply) =>
        hold(op, args, session, (hook) => send(op, args, basis, hook), onReply);
      return body(wrapped);
    });
  return {
    posts,
    /** Holds the reply of the next `op` posted. */
    arm(op: string, { hook = false, mark = (result: BridgeResult) => result } = {}): Hold {
      const each: Armed = { op, hook, mark, session: null, reply: null };
      armed.push(each);
      return {
        held: () => each.reply !== null,
        async release(error, then) {
          const reply = each.reply!;
          const result = await reply.answered.then(
            (value) => ({ value }),
            (thrown: unknown) => ({ thrown }),
          );
          if (then !== undefined) queueMicrotask(then);
          if (error !== null) return reply.fail(error);
          if ("thrown" in result) return reply.fail(result.thrown);
          const answer = each.mark(result.value);
          reply.hook?.(answer);
          reply.open(answer);
        },
        async applyHost() {
          const reply = each.reply!;
          const result = await reply.answered.then(
            (value) => value,
            () => null,
          );
          if (result === null || reply.hook === undefined || each.session === null) return;
          hostPart(bridge, each.op, each.session, result);
        },
      };
    },
    /** Marks what is posted from now on as after the transition. */
    next: () => void (state.phase += 1),
  };
}

/** An answer whose history revision is one no earlier answer had: what takes it shows it. */
const REVISED = 999;
function revised(result: BridgeResult): BridgeResult {
  // EVIDENCE: fixture: `adoptRandom` and `resolveDraw` answer with the history's revision in their result.
  const value = result.result as Record<string, unknown>;
  return { ...result, result: { ...value, revision: REVISED } };
}

// The posts any end of an activation makes, whichever completions came: releases, a plain halt, a run's retirement, and
// the random control's teardown.
const RELEASES = new Set([
  "release",
  "releaseRecording",
  "releaseRandom",
  "retireRun",
  "randomControl",
  "halt:plain",
]);

/**
 * What `c`'s completion may change, against the same schedule without it: `nothing`; its own `effect`; or, for a
 * captured-origin reporter's success after a same-lineage Continue (Q1 B), what its lineage keeps (`lineage`): no
 * error stop, and no post, of its own.
 */
function expected(c: Case): "nothing" | "effect" | "lineage" {
  if (c.transition === "none") return "effect";
  // An error stop while a Start is in flight takes its late session as its stop target; one while a Continue begins
  // stops at once at the session it continues, so the Continue's later reply has nothing left to do.
  // A preparation retires nothing: the failure capture stays its run's, which still lives.
  if (c.transition === "preparation" && c.handle === "captureReply") return "effect";
  if (c.transition === "errorStop")
    return c.handle === "startReply" || c.handle === "lateStartStop" ? "effect" : "nothing";
  if (c.transition === "sameLineage" && REPORTERS.includes(c.handle) && c.settlement === "success")
    return "lineage";
  return "nothing";
}

/** The page's view of a session, as the two runs compare it. */
function shown(session: PlayerSession | null): string {
  if (session === null) return "none";
  const texts = session.transcriptEntries.map((entry) => entry.text).join("|");
  const marks = [
    session.state.randomDraw === null ? "" : " draw",
    session.state.debugMode ? " debug" : "",
    session.callView === null ? "" : " calls",
  ].join("");
  // The scene clock's time, which a draw's rebase moves on.
  return `${session.state.status}${marks} @${session.state.currentSessionTimeMs} [${texts}]`;
}

const FAILED = () => new TypeError("The held reply failed.");

/** How a run ends the held reply: lets it go, never does (`drop`), or refuses it quietly (`quiet`). */
type Mode = "release" | "drop" | "quiet";

/** The reference run of `c`: never letting the reply go, unless the successor waits for the section it is in. */
const reference = (c: Case): Mode =>
  c.transition === "sameLineage" && SECTIONS.includes(c.handle) ? "quiet" : "drop";

async function bounded(pending: Promise<unknown> | null, what: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: not within 3 s`)), 3_000);
  });
  try {
    await Promise.race([pending, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** What an entry gave, as it settles: `pending`, `null`, `undefined`, `value` or its rejection; a candidate's release. */
function observe(pending: Promise<unknown> | null) {
  const outcome: { value: string; release: (() => void) | null } = {
    value: "pending",
    release: null,
  };
  void pending?.then(
    (value) => {
      outcome.value = value === null || value === undefined ? String(value) : "value";
      if (typeof value === "object" && value !== null && "release" in value) {
        const { release } = value;
        if (typeof release === "function") outcome.release = () => void release.call(value);
      }
    },
    (error: unknown) => (outcome.value = `rejected ${nameOf(error)}`),
  );
  return outcome;
}

const nameOf = (error: unknown) => (error instanceof Error ? error.name : String(error));

/** What a run of a case saw, from its transition on. */
interface Seen {
  readonly shows: readonly string[];
  readonly errors: readonly string[];
  /** Whether the last Player's session shows Debug mode on, at the end. */
  readonly debug: boolean;
  /** The scene time the last Player's next observation reads, a second of browser time after the end. */
  readonly clock: string;
  /** The random history's revisions each Player took. */
  readonly revisions: readonly number[];
  readonly posts: readonly string[];
  /** What the operation's entry gave: `pending`, `null`, `value` or its rejection. */
  readonly result: string;
  /** The recordings the page released once its Players went. */
  readonly teardown: number;
  readonly unhandled: number;
  /** Whether the host held nothing of the Players once they went (a released, answered, unlost run). */
  readonly cleaned: boolean;
}

/** A debug view of the recent chat. */
const VIEW: DebugViewRequest = {
  messages: { limit: 10, openNewest: true },
  selected: null,
  variables: null,
  image: false,
  trees: {},
};

const SUCCESSOR = 'say "successor", instant\nlet next = askChoice "Go"\nexit';

/**
 * The host errors one run of `c` reports, ending its held reply as `mode` says, as `<name>: <message>`: those its own
 * schedule raises, each as often as the run reports it.
 * - The held reply's rejection, once it is let go, with no transition: an activation that is stopped, replaced or gone
 *   reports nothing of its own, and the Player's own error stop (`lateStartStop`, `captureReply`, `exportWaiting`) and
 *   the export's caller, which takes its failure, report it instead.
 * - The injected loss, the Player errors the schedule reports, and the error stop's error.
 * - A same-lineage Continue (the composable's `prepareRestore` of the session it shows, which no page does: a page
 *   continues a kept session restored fresh) of a session a Player error stopped is refused. So is one after a Debug
 *   mode publication that had not succeeded before it: the Debug request changed the host without publishing its
 *   revision to the bridge, so the Continue's `beginRecording` is refused `basis`. That refusal is right, as for any
 *   foreign change; the Player reports both.
 */
function runErrors(c: Case, mode: Mode): readonly string[] {
  const playerError = ["haltAck", "captureReply", "exportWaiting"].includes(c.handle);
  const ownStop = ["lateStartStop", "captureReply", "exportWaiting", "export"].includes(c.handle);
  return [
    ...(mode === "release" && c.settlement === "rejection" && c.transition === "none" && !ownStop
      ? ["TypeError: The held reply failed."]
      : []),
    ...(c.transition === "loss" ? ["BridgeLostError: The engine Worker failed: injected."] : []),
    ...(c.handle === "lateStartStop" ? ["TypeError: The Player failed while it began."] : []),
    ...(playerError ? ["TypeError: The Player failed."] : []),
    ...(c.transition === "errorStop" ? ["RangeError: The Player failed while it began."] : []),
    ...(playerError && c.transition === "sameLineage"
      ? ["BridgeRefusal: The Player stopped this session."]
      : []),
    ...(c.handle === "debugModePublish" &&
    c.transition === "sameLineage" &&
    !(c.window === "settled" && c.settlement === "success")
      ? ["BridgeRefusal: The request was made from a revision the session no longer accepts."]
      : []),
  ];
}

/** That `reported` is exactly the host errors of `c`'s runs, ended as `runs` say, each as often. */
function assertOwnErrors(c: Case, runs: readonly Mode[], reported: readonly unknown[]) {
  assert.deepEqual(
    reported
      .map((error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)))
      .sort(),
    runs.flatMap((mode) => runErrors(c, mode)).sort(),
    "the host errors the case's schedule raises, each as often",
  );
}

/** Runs `c` on a page of its own, ending the held reply as `mode` says. */
async function run(context: TestContext, c: Case, mode: Mode): Promise<Seen> {
  const elements = browser(context);
  // The page's clock moves only where the case moves it, so that both runs observe the same times.
  const page = { now: 1_000 };
  context.mock.method(performance, "now", () => page.now);
  const bridge = facade.createInProcessBackend(BUILD);
  const listeners: ((error: ClientModule.BridgeLostError) => void)[] = [];
  bridge.client.onLoss = (listener) => void listeners.push(listener);
  const lose = () => {
    bridge.client.terminate();
    const lost = new client.BridgeLostError("The engine Worker failed: injected.");
    for (const listener of listeners) listener(lost);
  };
  const traffic = wire(bridge);
  const first = playerOn(bridge, c.handle === "debugModeKeep");
  const players = [first];
  context.after(() => players.forEach((each) => each.stop()));
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", record);
  context.after(() => void process.off("unhandledRejection", record));
  const host = first.player;
  await host.bridge;
  const tokenOf = async (script: string) => preparedPlan(Promise.resolve(bridge), planOf(script));
  // A replacement Start of a held plan, whose begin posts `start`.
  const successorPlan = c.transition === "replacement" ? await tokenOf(SUCCESSOR) : null;
  // The other Starts of the case, prepared before anything is timed.
  const preparedAgain =
    c.transition === "preparation" ? await tokenOf('say "prepared", instant\nexit') : null;
  const nextPlayerPlan =
    c.successor === "newPlayer"
      ? await tokenOf('say "next Player", instant\nlet next = askChoice "Go"\nexit')
      : null;

  // Up to the held reply.
  let pending: Promise<unknown> | null = null;
  let demand: { release(): void } | null = null;
  const wanted = new AbortController();
  let held: Hold;
  const script = c.handle === "mediaLoad" ? `playAudio async "bell.mp3"\n${SCRIPT}` : SCRIPT;
  const begin = async () => {
    host.prepare({ plan: await tokenOf(script), options: () => ({ wallClockMs: 0 }) });
    await host.activate();
    await settle();
  };
  switch (c.handle) {
    case "startReply":
    case "lateStartStop": {
      const token = await tokenOf(script);
      held = traffic.arm("start");
      host.prepare({ plan: token, options: () => ({ wallClockMs: 0 }) });
      pending = host.activate();
      // The error stop waits for the Start's session, to stop at it.
      if (c.handle === "lateStartStop") {
        await until(() => held.held(), "the Start is in the host");
        host.reportHostError(new TypeError("The Player failed while it began."));
      }
      break;
    }
    case "continueRecording":
    case "continueReply":
      await begin();
      held = traffic.arm(c.handle === "continueRecording" ? "beginRecording" : "continue");
      host.prepareRestore(host.session.value!);
      pending = host.activate();
      break;
    case "continueDebugMode":
      await begin();
      host.setDebugMode(true);
      await settle();
      held = traffic.arm("setDebugMode");
      // A session kept with Debug off: Continue tells it Debug is on.
      host.prepareRestore(
        hostIntroduced(
          bridge,
          compiler.createPlayerRuntimeSession(planOf(script), { wallClockMs: 0 }),
        ),
      );
      pending = host.activate();
      break;
    case "adoption":
      host.setRandomControl({ sites: [] });
      await begin();
      held = traffic.arm("adoptRandom", { mark: revised });
      host.prepareRestore(host.session.value!);
      pending = host.activate();
      break;
    case "haltAck":
    case "captureReply":
      await begin();
      held =
        // The in-process host acknowledges a halt at once: its acknowledgement waits only with its hook held.
        c.handle === "haltAck"
          ? traffic.arm("halt", { hook: true })
          : traffic.arm("captureRecording");
      host.reportHostError(new TypeError("The Player failed."));
      break;
    case "debugModeKeep": {
      // A prepared script in the debug room keeps what it shows: Debug mode's success keeps the session.
      await host.loadScriptStorage();
      const token = await tokenOf(script);
      await host.prepareScript(token, { plan: token, options: () => ({ wallClockMs: 0 }) });
      await host.activate();
      await settle();
      held = traffic.arm("setDebugMode");
      host.setDebugMode(true);
      break;
    }
    case "debugMode":
    case "debugModePublish":
      await begin();
      held = traffic.arm("setDebugMode", { hook: c.handle === "debugModePublish" });
      host.setDebugMode(true);
      break;
    case "draw": {
      host.setRandomControl({ sites: [] });
      await begin();
      const draw = host.session.value!.state.randomDraw;
      assert.ok(draw !== null, "the session waits at its draw");
      held = traffic.arm("resolveDraw", { mark: revised });
      pending = host.resolveRandomDraw(draw.drawId, "natural");
      break;
    }
    case "drawQueued": {
      host.setRandomControl({ sites: [] });
      await begin();
      const session = host.session.value!;
      const draw = session.state.randomDraw;
      assert.ok(draw !== null, "the session waits at its draw");
      // Another section of the session holds it: the draw's section waits until that one ends.
      let unblock!: () => void;
      let blocking = false;
      void bridge.section(session, clockTicket(), async () => {
        blocking = true;
        await new Promise<void>((resolve) => (unblock = resolve));
      });
      await until(() => blocking, "another section holds the session");
      // A chosen outcome, which a Continue's own natural resolution of the kept draw is not.
      pending = host.resolveRandomDraw(draw.drawId, { kind: "number", value: 3 });
      held = {
        held: () => blocking,
        release: async (_error, then) => {
          unblock();
          if (then !== undefined) queueMicrotask(then);
        },
        applyHost: async () => {},
      };
      break;
    }
    case "exportWaiting":
      // The export waits for a Player error's failure capture before it captures anything itself.
      await begin();
      held = traffic.arm("captureRecording");
      host.reportHostError(new TypeError("The Player failed."));
      await until(() => held.held(), "the failure capture is in the host");
      pending = host.debugExportCandidate(() => ({ player: {}, host: {} }), wanted.signal);
      break;
    case "export":
      await begin();
      held = traffic.arm("captureExport", { hook: true });
      pending = host.debugExportCandidate(() => ({ player: {}, host: {} }), wanted.signal);
      break;
    case "debugView":
      host.setDebugTracing(true);
      await begin();
      held = traffic.arm("debugView");
      pending = host.debugView(VIEW);
      break;
    case "callView":
      await begin();
      held = traffic.arm("viewCalls", { hook: true });
      demand = host.demandCallView();
      break;
    case "mediaLoad": {
      await begin();
      held = traffic.arm("reportMediaLoad");
      const element = elements.find((each) => each.src.endsWith("bell.mp3"));
      assert.ok(element !== undefined, "the session plays its audio");
      element.dispatchEvent(new Event("loadedmetadata"));
      break;
    }
  }
  const outcome = observe(pending);
  await until(() => held.held(), `${c.handle}'s reply is held`);
  // Browser time goes on while the reply is held: a session paused at its draw goes on from its draw once resolved,
  // as the scene clock's rebase sets it, not from where the browser's time went meanwhile.
  page.now += 5_000;
  // The adoption's Continue does not wait for the adoption's reply: it shows its session first.
  if (c.handle === "adoption") {
    await bounded(pending, "the adoption's Continue");
    await settle();
  }

  // What each Player shows and reports from the transition on.
  const shows: string[] = [];
  const errors: string[] = [];
  const revisions: number[] = [];
  const recording = { on: false };
  const watchOn = (player: FamilyHost, name: string) => {
    const stops = [
      watch(
        player.session,
        (session) => void (recording.on && shows.push(`${name} ${shown(session)}`)),
        { flush: "sync" },
      ),
      watch(
        player.stopped,
        (stopped) => void (recording.on && shows.push(`${name} stopped ${stopped}`)),
        { flush: "sync" },
      ),
      watch(player.randomRevision, (revision) => void (recording.on && revisions.push(revision)), {
        flush: "sync",
      }),
      watch(player.hostError, (error) => void (recording.on && errors.push(`${name} ${error}`)), {
        flush: "sync",
      }),
    ];
    context.after(() => stops.forEach((each) => each()));
  };
  watchOn(host, "first");
  // A Start or Continue retires its predecessor at its begin, before its first post, which is held until the reply let
  // go in flight arrived.
  const begun =
    c.window === "inFlight" && c.transition === "replacement"
      ? traffic.arm("start")
      : c.window === "inFlight" && c.transition === "sameLineage"
        ? traffic.arm("beginRecording")
        : null;
  // What the transition itself does in its turn (a loss's stop, a disposal) is the same in both runs; what each Player
  // shows and reports is recorded after it.
  const transition = () => {
    traffic.next();
    const began = transitionTurn();
    recording.on = true;
    return began;
  };
  const transitionTurn = () => {
    switch (c.transition) {
      case "none":
        return null;
      case "replacement":
        host.prepare({ plan: successorPlan!, options: () => ({ wallClockMs: 0 }) });
        return host.activate();
      case "sameLineage":
        host.prepareRestore(host.session.value!);
        return host.activate();
      case "disposal":
        first.stop();
        return null;
      case "loss":
        lose();
        return null;
      case "preparation":
        host.prepare({ plan: preparedAgain!, options: () => ({ wallClockMs: 0 }) });
        return null;
      case "errorStop":
        host.reportHostError(new RangeError("The Player failed while it began."));
        return null;
      case "cancellation":
        wanted.abort();
        return null;
    }
  };
  const successor = async (began: Promise<void> | null) => {
    await bounded(began, "the successor begins");
    if (c.successor === "newPlayer") {
      const second = playerOn(bridge);
      players.push(second);
      watchOn(second.player, "second");
      await second.player.bridge;
      second.player.prepare({ plan: nextPlayerPlan!, options: () => ({ wallClockMs: 0 }) });
      await bounded(second.player.activate(), "the new Player's Start begins");
    }
    await settle();
  };
  // The reference run lets nothing go, or, where the successor waits for the held section, a refusal that ends quietly.
  const error =
    mode === "quiet"
      ? new client.BridgeLostError("The reply is refused quietly.")
      : c.settlement === "rejection"
        ? FAILED()
        : null;
  // Lets the held reply go; the reference run applies only its host part (a success's store application), so that
  // both runs differ by the page's completion alone.
  const letGo = async (then?: () => void) => {
    page.now += 700;
    if (mode !== "drop") return held.release(error, then);
    if (c.settlement === "success") await held.applyHost();
    then?.();
  };
  if (c.window === "settled") {
    let began: Promise<void> | null = null;
    await letGo(() => void (began = transition()));
    await settle();
    await successor(began);
  } else if (c.window === "inFlight") {
    const began = transition();
    if (begun !== null) {
      await until(() => begun.held(), "the successor began");
      await letGo();
      await settle();
      await begun.release(null);
    } else await letGo();
    await successor(began);
  } else {
    await successor(transition());
    await letGo();
  }
  await settle();
  const posts = traffic.posts.filter((post) => post.phase > 0).length;
  const debug = players.at(-1)!.player.session.value?.state.debugMode === true;
  // The scene clock, as the last Player's next observation reads it a second later. A held media report's section
  // holds the session's observations too, so its cases read none.
  page.now += 1_000;
  const observed =
    c.handle === "mediaLoad"
      ? "held"
      : await players
          .at(-1)!
          .player.observe()
          .then(
            (next) => (next === null ? "none" : String(next.state.observedSessionTimeMs)),
            (thrown: unknown) => `rejected ${nameOf(thrown)}`,
          );
  // The stop's own work shows in an export of the Player, which waits for the stop to commit and for its failure
  // capture.
  if (STOPS.includes(c.handle) && c.transition !== "disposal") {
    const exported = observe(
      host.debugExportCandidate(() => ({ player: {}, host: {} }), new AbortController().signal),
    );
    await settle();
    Object.assign(outcome, exported);
  }
  // The end: every Player goes, and with a connection that lives, the host holds nothing of theirs.
  demand?.release();
  outcome.release?.();
  players.forEach((each) => each.stop());
  await settle();
  // A failure put in place of the host's answer leaves what the host made unknown to the page; a loss leaves the host's
  // cleanup to the transport's close.
  const cleaned =
    mode !== "release" ||
    c.settlement === "rejection" ||
    c.transition === "loss" ||
    (facade.heldRuns(bridge).length === 0 && facade.heldTickets(bridge).length === 0);
  const after = traffic.posts.filter((post) => post.phase > 0);
  return {
    shows,
    errors,
    revisions,
    debug,
    clock: observed,
    posts: after
      .slice(0, posts)
      .filter((post) => !RELEASES.has(post.op))
      .map((post) => post.op),
    result: outcome.value,
    teardown: after.slice(posts).filter((post) => post.op === "releaseRecording").length,
    unhandled: unhandled.length,
    cleaned,
  };
}

/** What both runs of a case compare: what shows, is reported and posted, and the random history's revision. */
const effects = ({ shows, errors, revisions, posts, clock }: Seen) => ({
  shows,
  errors,
  revisions,
  posts,
  clock,
});

const completed: Coordinates[] = [];

for (const coordinates of FEASIBLE) {
  const c = asCase(coordinates);
  test(`activation family: ${Object.values(c).join(" ")}`, async (context) => {
    // Every host error the test's Players report, both runs' and their teardown's: one capture for the test, compared
    // with the runs' own however the case ends, in a hook registered after the runs' own teardown hooks, so it runs
    // after them.
    const reported: unknown[] = [];
    reportsInto(context, reported);
    const runs: Mode[] = ["release"];
    try {
      const released = await run(context, c, "release");
      // A begin whose reply settled before its successor began: the successor waits for the begin's own reaction
      // (`begunInFlight`), so the completion acts while its activation lives, and only then the successor replaces it.
      // No run without the reply begins the successor; the oracle is the order of their effects.
      if (BEGINS.includes(c.handle) && c.transition === "replacement" && c.window === "settled") {
        assert.equal(released.unhandled, 0, "no rejection is left unhandled");
        assert.ok(
          released.cleaned,
          "the host holds no run or ticket of the Players once they went",
        );
        const last = released.shows.at(-1) ?? "";
        assert.ok(last.includes("[successor]"), `the replacement shows last: ${last}`);
        completed.push(coordinates);
        return;
      }
      // A Continue of the same lineage waits for the section that holds a queued draw, so no run without letting it go
      // continues: the draw's own effects are what this case checks.
      if (c.handle === "drawQueued" && c.transition === "sameLineage") {
        assert.equal(released.unhandled, 0, "no rejection is left unhandled");
        assert.ok(
          released.cleaned,
          "the host holds no run or ticket of the Players once they went",
        );
        assert.equal(released.result, "null", "the retired draw gives nothing");
        assert.deepEqual(
          released.posts.filter((post) => post === "resolveDraw:chosen"),
          [],
          "the retired draw's body sends nothing",
        );
        assert.deepEqual(released.revisions, [], "nor writes a revision");
        completed.push(coordinates);
        return;
      }
      runs.push(reference(c));
      const dropped = await run(context, c, reference(c));
      assert.equal(released.unhandled, 0, "no rejection is left unhandled");
      assert.ok(released.cleaned, "the host holds no run or ticket of the Players once they went");
      const outcome = expected(c);
      // Two errors wait for one late Start: one stop, the current one, acts on its session, with the first error.
      if (c.handle === "lateStartStop" && c.transition === "errorStop") {
        const diagnostic = (seen: Seen) =>
          seen.posts.filter(
            (post) => post.startsWith("halt@") || post.startsWith("commitIncident@"),
          );
        assert.deepEqual(
          diagnostic(released),
          [c.settlement === "success" ? "halt@1" : "commitIncident@1"],
          "one stop of the late Start",
        );
        assert.equal(released.errors.at(-1), "first TypeError", "the first error stays");
      }
      if (outcome === "lineage") {
        // What the lineage keeps is its publication; its success stops, posts and revises nothing of its own.
        const kept = ({ errors, revisions, posts }: Seen) => ({ errors, revisions, posts });
        assert.deepEqual(kept(released), kept(dropped), "the lineage's success stops nothing");
      } else if (outcome === "nothing") {
        assert.deepEqual(effects(released), effects(dropped), "the completion changes nothing");
        // The debug view's success stays its lineage's (Q1 B): its caller still gets the view.
        if (
          c.handle === "draw" ||
          c.handle === "drawQueued" ||
          c.handle === "export" ||
          c.handle === "exportWaiting" ||
          (c.handle === "debugView" && c.settlement === "rejection")
        )
          assert.equal(released.result, "null", "a retired activation's operation gives nothing");
      } else if (c.handle === "debugMode" && c.settlement === "success")
        // Its publication shows as the host's reply applies, which this case does not hold (`debugModePublish` does).
        assert.equal(released.debug, true, "Debug mode shows");
      else if ((c.handle === "draw" || c.handle === "drawQueued") && c.settlement === "success") {
        // The resolved draw's session goes on from its draw (at scene time 0), not from where the browser's time went
        // while it waited: the clock's rebase. A second later it observes a second.
        assert.equal(released.result, "value", "the draw gives its outcome");
        assert.equal(released.clock, "1000", "the scene clock goes on from the draw");
      } else if (
        RESULTS.includes(c.handle) &&
        (c.settlement === "success" || c.handle === "export" || c.handle === "exportWaiting")
      )
        // Its effect is what its caller takes: its result, or the export's failure (the others' failure is the stop's);
        // an export waiting for a failure capture gives its candidate whether the capture succeeded or failed.
        assert.equal(
          released.result,
          c.settlement === "success" || c.handle === "exportWaiting"
            ? "value"
            : "rejected TypeError",
          "the operation gives its result",
        );
      else if (STOPS.includes(c.handle) && c.transition === "none")
        // The stop's commit and its failure capture are what an export waits for: it gives its candidate only after
        // them.
        assert.deepEqual(
          [released.result, dropped.result === "value"],
          ["value", false],
          "only the stop's own work lets the export through",
        );
      else
        // Its own effect shows, is reported, posted or released: a promise that only settled is none.
        assert.notDeepEqual(
          { ...effects(released), teardown: released.teardown },
          { ...effects(dropped), teardown: dropped.teardown },
          "the completion has its own effect",
        );
      completed.push(coordinates);
    } finally {
      context.after(() => assertOwnErrors(c, runs, reported));
    }
  });
}

test("the activation family completed every feasible full tuple, and nothing else", () => {
  assert.deepEqual(coverageGaps(FEASIBLE, completed, { tuples: true }), []);
});

/*
 * The reaction ledger (session split S2's HEAD 0): each entry's settlement and effects, in order, against peers queued before and after
 * it (a microtask and a host reply). S2 changes no entry's reactions but the declared differences: the loss's stop
 * commits in the loss listener's own turn (it did a reaction after the lost signal's rejection), and Q1 B's same-lineage
 * reporters, whose plain order here is unchanged. Since #2262 a request of no session posts when it is made, behind no
 * earlier reply: the later peer's reply (`reply after`) comes before the effects of an entry's session work in `draw`,
 * `export` and `mediaLoad`, an order the bridge does not promise; and a lost request rejects with no hop through the
 * connection's queue, so `reply before lost` comes before the later microtask in `loss`. Since every Start takes the plan
 * form (L5i.7), `start` shows on the host's reply, as `heldStart` does, and no longer before its peers. With `ACTIVATION_LEDGER_OUT` set, the ledgers are written there as
 * JSON, so that another head's run can be compared with this one's.
 */

const ENTRIES = [
  "start",
  "heldStart",
  "continue",
  "errorStop",
  "draw",
  "export",
  "initialExport",
  "debugMode",
  "adoption",
  "debugView",
  "callView",
  "mediaLoad",
  "loss",
] as const;
type Entry = (typeof ENTRIES)[number];

async function ledgerOf(context: TestContext, entry: Entry): Promise<string[]> {
  const reported: unknown[] = [];
  reportsInto(context, reported);
  const elements = browser(context);
  context.mock.method(performance, "now", () => 1_000);
  const bridge = facade.createInProcessBackend(BUILD);
  const listeners: ((error: ClientModule.BridgeLostError) => void)[] = [];
  bridge.client.onLoss = (listener) => void listeners.push(listener);
  const made = playerOn(bridge);
  context.after(made.stop);
  const host = made.player;
  await host.bridge;
  const script = entry === "mediaLoad" ? `playAudio async "bell.mp3"\n${SCRIPT}` : SCRIPT;
  if (entry === "draw" || entry === "adoption") host.setRandomControl({ sites: [] });
  if (entry === "debugView") host.setDebugTracing(true);
  // A Start of a held plan, prepared in the host first.
  const token =
    entry === "heldStart" || entry === "start"
      ? await preparedPlan(host.bridge, planOf(script))
      : null;
  if (entry !== "start" && entry !== "heldStart" && entry !== "initialExport") {
    host.prepare(await startOf(host, script));
    await host.activate();
    await settle();
  }
  const log: string[] = [];
  const stops = [
    watch(host.session, (session) => void log.push(`show ${shown(session)}`), { flush: "sync" }),
    watch(host.hostError, (error) => void log.push(`error ${error}`), { flush: "sync" }),
    watch(host.randomRevision, () => void log.push("revision"), { flush: "sync" }),
  ];
  context.after(() => stops.forEach((each) => each()));
  const peer = (when: string) => {
    queueMicrotask(() => void log.push(`microtask ${when}`));
    void bridge.client.request("prepare", { source: { kind: "source", script: "exit" } }).then(
      () => void log.push(`reply ${when}`),
      () => void log.push(`reply ${when} lost`),
    );
  };
  const settled = (pending: Promise<unknown>) =>
    void pending.then(
      (value) =>
        void log.push(`settled ${value === null || value === undefined ? String(value) : "value"}`),
      (error: unknown) => void log.push(`rejected ${nameOf(error)}`),
    );
  peer("before");
  switch (entry) {
    case "start":
      host.prepare({ plan: token!, options: () => ({ wallClockMs: 0 }) });
      settled(host.activate());
      break;
    case "heldStart":
      host.prepare({ plan: token!, options: () => ({ wallClockMs: 0 }) });
      settled(host.activate());
      break;
    case "continue":
    case "adoption":
      host.prepareRestore(host.session.value!);
      settled(host.activate());
      break;
    case "errorStop":
      host.reportHostError(new TypeError("The Player failed."));
      break;
    case "draw":
      settled(host.resolveRandomDraw(host.session.value!.state.randomDraw!.drawId, "natural"));
      break;
    case "export":
    // Before any activation, the initial record's export selects the current recording at once.
    case "initialExport":
      settled(
        host.debugExportCandidate(() => ({ player: {}, host: {} }), new AbortController().signal),
      );
      break;
    case "debugMode":
      host.setDebugMode(true);
      break;
    case "debugView":
      settled(host.debugView(VIEW));
      break;
    case "callView":
      context.after(host.demandCallView().release);
      break;
    case "mediaLoad":
      elements
        .find((each) => each.src.endsWith("bell.mp3"))!
        .dispatchEvent(new Event("loadedmetadata"));
      break;
    case "loss": {
      bridge.client.terminate();
      const lost = new client.BridgeLostError("The engine Worker failed: injected.");
      for (const listener of listeners) listener(lost);
      break;
    }
  }
  // Registered after the entry's own hooks, so that it also sees what the Player's stop reports.
  context.after(() =>
    assert.deepEqual(
      reported.map((error) =>
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      ),
      entry === "errorStop"
        ? ["TypeError: The Player failed."]
        : entry === "loss"
          ? ["BridgeLostError: The engine Worker failed: injected."]
          : [],
      "the entry's own host errors",
    ),
  );
  peer("after");
  await settle();
  return log;
}

const LEDGER: Readonly<Record<Entry, readonly string[]>> = {
  start: [
    "microtask before",
    "microtask after",
    "reply before",
    "show waiting @0 [rolled]",
    "settled undefined",
    "reply after",
  ],
  heldStart: [
    "microtask before",
    "microtask after",
    "reply before",
    "show waiting @0 [rolled]",
    "settled undefined",
    "reply after",
  ],
  continue: [
    "show none",
    "microtask before",
    "microtask after",
    "reply before",
    "reply after",
    "show waiting @0 [rolled]",
    "settled undefined",
  ],
  errorStop: [
    "show waiting calls @0 [rolled]",
    "error TypeError",
    "microtask before",
    "microtask after",
    "reply before",
    "reply after",
  ],
  draw: [
    "microtask before",
    "microtask after",
    "reply before",
    "reply after",
    "show waiting @0 [rolled]",
    "settled value",
  ],
  export: ["microtask before", "microtask after", "reply before", "reply after", "settled value"],
  initialExport: [
    "microtask before",
    "microtask after",
    "reply before",
    "settled value",
    "reply after",
  ],
  debugMode: [
    "microtask before",
    "microtask after",
    "reply before",
    "show waiting debug @0 [rolled]",
    "reply after",
  ],
  adoption: [
    "show none",
    "microtask before",
    "microtask after",
    "reply before",
    "reply after",
    "show waiting @0 [rolled]",
    "settled undefined",
  ],
  debugView: [
    "microtask before",
    "microtask after",
    "reply before",
    "settled value",
    "reply after",
  ],
  callView: [
    "microtask before",
    "microtask after",
    "reply before",
    "show waiting calls @0 [rolled]",
    "reply after",
  ],
  mediaLoad: [
    "microtask before",
    "microtask after",
    "reply before",
    "reply after",
    "show waiting @0 []",
    "show waiting @0 [rolled]",
  ],
  loss: [
    "error BridgeLostError",
    "microtask before",
    "reply before lost",
    "microtask after",
    "reply after lost",
  ],
};

test("activation ledger: each entry settles and acts in the order it did, but for the declared differences", async (context) => {
  const ledgers: Record<string, string[]> = {};
  for (const entry of ENTRIES)
    await context.test(entry, async (subtest) => {
      ledgers[entry] = await ledgerOf(subtest, entry);
    });
  const out = process.env.ACTIVATION_LEDGER_OUT;
  if (out !== undefined) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(out, `${JSON.stringify(ledgers, null, 1)}\n`);
  }
  assert.deepEqual(ledgers, LEDGER);
});

// Debug mode's request clears only its own marker (session split S2's HEAD 0, cleanup): a reply to an earlier request leaves a later
// one's, so a third change still goes to the host, which a cleared marker would take for done.
test("a Debug mode reply clears only its own request's marker, so a later change is still sent", async (context) => {
  browser(context);
  const bridge = facade.createInProcessBackend(BUILD);
  const traffic = wire(bridge);
  const made = playerOn(bridge);
  context.after(made.stop);
  const host = made.player;
  await host.bridge;
  host.prepare(await startOf(host, SCRIPT));
  await host.activate();
  await settle();
  // The second change's reply waits with its application: what shows meanwhile is the first's.
  const [on, off] = [traffic.arm("setDebugMode"), traffic.arm("setDebugMode", { hook: true })];
  host.setDebugMode(true);
  host.setDebugMode(false);
  await until(() => on.held() && off.held(), "both changes are in the host");
  await on.release(null);
  await settle();
  host.setDebugMode(true);
  await off.release(null);
  await settle();
  assert.equal(traffic.posts.filter((post) => post.op === "setDebugMode").length, 3);
  assert.equal(host.session.value?.state.debugMode, true, "the session ends as last asked");
});
