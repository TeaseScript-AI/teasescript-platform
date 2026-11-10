import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { effectScope, type EffectScope } from "vue";
import type { DebugHistoryView } from "../../player/debug/debug-history.js";
import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import type { BridgeResult } from "../../player/engine-bridge/client.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import { playerRuntimeForeground, type PlayerSession } from "../../player/runtime/runtime-view.js";
import { coverageGaps, product, type Coordinates } from "../helpers/family-coverage.js";
import {
  backTo,
  createHost,
  heldInHost,
  memoryStorage,
  reportsInto,
  script,
  selectPlayerRuntimeChoice,
  settle,
  shownView,
  start,
  choose,
  holdRead,
  useDebugRewind,
  type Rewind,
  type RewindHost,
} from "../helpers/player/rewind-host.js";
import { interceptSends } from "../helpers/bridge/sends.js";
import { untypedClient } from "../helpers/bridge/untyped.js";

/*
 * The lifetimes of what the Player's rewind owner holds (`player/vue/src/session/rewindOwner.ts`), through the real
 * Player and its in-process host: each resource, made by each operation that makes one, meets each end in each
 * inspection state it can meet it in, and then the page goes on as the after-axis says. The oracle is the owner's
 * public surface (`view`, `problem`, `busy`, `inspecting`, `reinstatement`, `state`, `showing`), the sessions the host
 * holds (`heldInHost`), the rewind requests the bridge was sent, and the host failures the Player reported. What each
 * end decides is `advanceLifecycle`'s (`player/debug/rewind-lifecycle.ts`) and DEBUGGER.md "Rewind"'s; this family
 * reads whether the owner held and let go of each resource as decided, also in the next history.
 *
 * Residuals no row can see through that surface, each with its bound: a candidate reference kept past `clearView` or
 * its drop (one session reference, overwritten by the next step's candidate, never shown); early deltas kept past
 * `clearView` (`install` applies only its own history's deltas); the parked reference kept past a loss (a lost owner
 * decides nothing more, and `returnToSession` settles `false`); an answered renewal's timeline kept (one map entry per
 * renewal, for the Player's life); and a close the loss rejects reported and blocking.
 *
 * A close in flight (#2150): the maker's close, or the renewal that carries a retirement's close, is posted at its
 * decision, and a replacement's renewal right after it at its session's follow; the host runs them in that order. Their
 * replies are held until the end has come. A close settlement is the host's own: a close of a history it does not hold
 * (`close refused`), or a success reply that cannot cross (`close rejected live`), each failing the close there. Its rows show the close's request
 * rejected by the loss (`closeSettled`), so the owner's handler runs; the loss reported first, a lost Player drops
 * every later report (`activationRun.revoke()`), and a lost owner decides nothing more.
 */

const AXES = {
  resource: [
    "parked",
    "candidate",
    "reinstated",
    "view",
    "early deltas",
    "pending ask",
    "problem",
    "close in flight",
  ],
  maker: [
    "first Back",
    "Back",
    "Forward",
    "Return",
    "Debug off",
    "Debug on",
    "new session",
    "retirement",
    "publication while opening",
    "step refused",
    "step read failure",
    "step gate failure",
    "commit refused",
    "replacement",
    "clear",
    "import",
    "disposal",
  ],
  end: [
    "replace",
    "Debug off",
    "disposal by the Player",
    "disposal by Debug's scope",
    "clear",
    "import",
    "loss",
    "drop",
    "commit",
    "Return",
    "adoption success",
    "adoption failure",
    "open failure",
    "close refused",
    "close rejected live",
    "close rejected by loss",
    "stop",
  ],
  inspection: ["not inspecting", "inspecting"],
  after: ["quiescent", "next Back then Return", "next step", "next Debug on"],
} as const;
type Case = { readonly [Axis in keyof typeof AXES]: (typeof AXES)[Axis][number] };

const MAKERS: Readonly<Record<Case["resource"], readonly Case["maker"][]>> = {
  parked: ["first Back"],
  candidate: ["Back", "Forward"],
  reinstated: ["Return", "Debug off"],
  view: ["Debug on", "new session", "retirement"],
  "early deltas": ["publication while opening"],
  "pending ask": ["Back", "Forward", "Return"],
  problem: ["step refused", "step read failure", "step gate failure", "commit refused"],
  "close in flight": ["Debug off", "replacement", "clear", "import", "disposal"],
};

/** The ends that end the open history, and its view with it (`clearView`). */
const HISTORY_ENDS: readonly Case["end"][] = [
  "replace",
  "Debug off",
  "disposal by the Player",
  "disposal by Debug's scope",
  "clear",
  "import",
];
const STEP_ENDS: readonly Case["end"][] = [
  "drop",
  "commit",
  "Return",
  "adoption success",
  "adoption failure",
];
const CLOSE_SETTLEMENTS: readonly Case["end"][] = [
  "close refused",
  "close rejected live",
  "close rejected by loss",
];
const SEALING: readonly Case["end"][] = [
  "disposal by the Player",
  "disposal by Debug's scope",
  "loss",
  "close rejected by loss",
];
/** Whether the case's resource is an open or a close the maker holds. */
const opensAndCloses = ({ resource }: Case) =>
  resource === "early deltas" || resource === "close in flight";
/** Whether Debug's features run when the end comes. */
const debugAtEnd = ({ resource, maker }: Case) =>
  !(maker === "Debug off" && (resource === "reinstated" || resource === "close in flight"));

/** Why a tuple is no case, or `null` for a feasible one. */
function infeasible(c: Case): string | null {
  const { resource, maker, end, inspection, after } = c;
  const inspecting = inspection === "inspecting";
  if (!MAKERS[resource].includes(maker)) return `${maker} makes no ${resource}`;
  if (resource === "parked" && !inspecting)
    return "the parked session is held only while a restored state is inspected";
  if ((maker === "Forward" || (maker === "Return" && resource === "pending ask")) && !inspecting)
    return "Forward and Return act only on an inspected state";
  if (resource === "early deltas" && inspecting) return "an opening history has no inspection";
  if (maker === "commit refused" && !inspecting)
    return "a refused commit's candidate shows already, so a restored state is inspected";
  if (maker === "retirement" && inspecting)
    return "a retirement by clear follows an ended session, which presents no point to go Back to (DEBUGGER.md)";
  if (!debugAtEnd(c) && inspecting)
    return "Debug off ended the features: nothing is inspected after it";
  if (maker === "Debug off" && resource === "close in flight" && inspecting)
    return "Debug off while inspecting first reinstates through its gate: its close is that row's";
  if ((end === "clear" || maker === "clear") && inspecting)
    return "a clear is offered only while nothing is inspected (`useSavedValues.ts`)";
  if (end === "clear" && maker === "replacement")
    return "a replacement's new session runs, and a clear needs an ended one";
  if (end === "clear" && resource === "pending ask" && maker !== "Back")
    return "a clear is offered only while nothing is inspected (`useSavedValues.ts`)";
  if (CLOSE_SETTLEMENTS.includes(end) && resource !== "close in flight")
    return "a close's settlement ends only the close in flight; each closing end's resources are that end's rows";
  if (end === "loss" && resource === "close in flight")
    return "a loss while a close is in flight is that close's rejection by loss";
  if (end === "open failure" && resource !== "early deltas" && resource !== "close in flight")
    return "an open fails only before its history is held: the resources a history held are its ends' rows";
  if (end === "open failure" && !debugAtEnd(c)) return "Debug off asks for no open";
  if (maker === "disposal" && !CLOSE_SETTLEMENTS.includes(end))
    return "the Player is unmounted: only its close's settlement comes after its disposal";
  if (maker === "import" && resource === "close in flight" && end === "open failure")
    return "an import's own renewal replaces the one its ended session's follow posted: the held one is obsolete";
  if (maker === "disposal" && end === "close refused")
    return "the host refuses no disposal of its current Player: it closes every history there is";
  if (!debugAtEnd(c) && (end === "Debug off" || end === "disposal by Debug's scope"))
    return "Debug off already ended Debug's scope";
  if (!debugAtEnd(c) && STEP_ENDS.includes(end))
    return "Debug off ended the features: no step, Return or adoption runs after it";
  if (STEP_ENDS.includes(end)) {
    if (resource === "early deltas" || resource === "close in flight")
      return "no step, Return or adoption runs while a history opens or closes: there is no view";
    if (maker === "retirement")
      return "a retirement by clear follows an ended session: its history has no point to step to";
    if ((end === "Return" || end.startsWith("adoption")) && !inspecting)
      return "Return and an adoption act only on an inspected state";
    if (resource === "problem" && end !== "drop" && end !== "commit")
      return "a problem ends at the next step or with its history: Return and an adoption leave it";
    if (
      (resource === "candidate" || resource === "pending ask") &&
      (end === "Return" || end.startsWith("adoption")) &&
      !(resource === "pending ask" && maker === "Return" && end === "Return")
    )
      return "a step or Return under way refuses Return and adoption (DEBUGGER.md): they end nothing it holds";
    if (resource === "pending ask" && maker === "Return" && (end === "drop" || end === "commit"))
      return "a Return holds no step to drop or commit";
  }
  if (resource === "problem" && !STEP_ENDS.includes(end) && !HISTORY_ENDS.includes(end))
    return "a problem ends at the next step or with its history: the loss and a stop leave it";
  if ((SEALING.includes(end) || maker === "disposal") && after !== "quiescent")
    return "a sealed owner decides nothing more, so quiescence stands for every later request";
  return null;
}

function asCase(coordinates: Coordinates): Case {
  // EVIDENCE: invariant: `product` gives the declared axes' values.
  return coordinates as Case;
}
const FEASIBLE = product(AXES).filter((coordinates) => infeasible(asCase(coordinates)) === null);

/**
 * How a request is answered: by the host, by a rejection or a refusal the host never sees, or by a refusal after the
 * host answered it.
 */
type Settlement = "pass" | "reject" | "refuse" | "refuse after";
/** How a held step, Return or close goes on: as asked, through a failing restart gate, rejected, or refused. */
type Release = Settlement | "fail gate";

/**
 * The bridge's rewind requests: each op sent, in order; the next request of an op held before it is posted, or with
 * its answer held, until its release; and an op's answers replaced.
 */
type Reply = Promise<BridgeResult>;

function traffic(context: TestContext, bridge: PlayerBridge) {
  // The client's own post, taken before `interceptSends` routes it, for a request the host is to refuse.
  const raw = untypedClient(bridge.client);
  const realPost = raw.post.bind(raw);
  /** The host failure the next request of an op meets (`hostFails`). */
  const failing = new Map<string, "refuse" | "reject">();
  // A request whose success reply is not to cross, by its ID, which the outgoing request names.
  const failingReplies = new Set<number>();
  const clone = globalThis.structuredClone;
  context.mock.method(
    globalThis,
    "structuredClone",
    (value: unknown, options?: StructuredSerializeOptions) => {
      if (typeof value === "object" && value !== null && "kind" in value && "id" in value) {
        const { kind, id } = value;
        const op = "op" in value ? value.op : null;
        if (kind === "request" && typeof op === "string" && failing.get(op) === "reject") {
          failing.delete(op);
          if (typeof id === "number") failingReplies.add(id);
        }
        const ok = "ok" in value && value.ok === true;
        if (kind === "reply" && ok && typeof id === "number" && failingReplies.delete(id))
          throw new Error("injected: the success reply cannot cross");
      }
      return clone(value, options);
    },
  );
  /** The request of `op` as the host is to meet it: a close of a history it does not hold, when it is to refuse. */
  const sending = (op: string, args: unknown, send: () => Reply): (() => Reply) => {
    if (failing.get(op) !== "refuse") return send;
    failing.delete(op);
    // EVIDENCE: fixture: the Player sends these two ops with these fields.
    const each = args as { readonly closes?: readonly object[] };
    const missing = { history: 999_999 };
    const mutated =
      op === "historyRenew"
        ? { ...each, closes: (each.closes ?? []).map((close) => ({ ...close, ...missing })) }
        : { ...each, ...missing };
    return () => {
      const posted = realPost(op, mutated);
      return posted.posted ? posted.reply : Promise.reject(posted.error);
    };
  };
  const sent: string[] = [];
  const candidates: string[] = [];
  const answers = new Map<string, Settlement>();
  const once = new Map<string, Settlement>();
  const holds = new Map<
    string,
    {
      readonly at: "request" | "reply";
      reached(): void;
      readonly gate: Promise<Settlement>;
      settled(outcome: string): void;
    }
  >();
  const post = (op: string, send: () => Reply): Reply =>
    send().then((reply) => {
      if ((op === "rewindBack" || op === "rewindForward") && typeof reply.session === "string")
        candidates.push(reply.session);
      return reply;
    });
  const answer = (op: string, how: Settlement, send: () => Reply, posted?: Reply): Reply => {
    if (how === "pass") return posted ?? post(op, send);
    // A history op's refusal (`HistoryOpResult`), in the bridge's reply.
    const refused = (): Awaited<Reply> => ({
      session: null,
      revision: null,
      eventsThrough: null,
      result: { kind: "refused", reason: `${op} refused` },
      view: null,
    });
    if (how === "refuse after") return (posted ?? post(op, send)).then(refused);
    const fail = () =>
      how === "reject"
        ? Promise.reject(new Error(`A host failure of ${op}.`))
        : Promise.resolve(refused());
    return posted === undefined ? fail() : posted.then(fail);
  };
  interceptSends(context, bridge.client, (op, args, given) => {
    const send = sending(op, args, given);
    if (/^(history|rewind)/.test(op)) sent.push(op);
    const hold = holds.get(op);
    const next = once.get(op);
    once.delete(op);
    if (hold === undefined) return answer(op, next ?? answers.get(op) ?? "pass", send);
    holds.delete(op);
    const posted = hold.at === "reply" ? post(op, send) : undefined;
    if (posted === undefined) hold.reached();
    else void posted.then(hold.reached, hold.reached);
    const answered = hold.gate.then((how) => answer(op, how, send, posted));
    answered.then(
      () => hold.settled("answered"),
      (error: unknown) => hold.settled(error instanceof Error ? error.name : String(error)),
    );
    return answered;
  });
  return {
    sent,
    candidates,
    answer: (op: string, how: Settlement) => void answers.set(op, how),
    /** Answers the next request of `op` as `how`, and later ones as the host does. */
    answerNext: (op: string, how: Settlement) => void once.set(op, how),
    /** Has the host fail the next request of `op`: refuse it, or abort its delivery as its success reply cannot cross. */
    hostFails: (op: string, how: "refuse" | "reject") => void failing.set(op, how),
    /**
     * Holds the next request of `op`, before it is posted or with the host's answer, until `release`, which says how it
     * is answered; `outcome` is how the page's request settled.
     */
    hold(op: string, at: "request" | "reply" = "request") {
      let reached!: () => void;
      const arrived = new Promise<void>((resolve) => (reached = resolve));
      let release!: (how: Settlement) => void;
      const gate = new Promise<Settlement>((resolve) => (release = resolve));
      let settled!: (outcome: string) => void;
      const outcome = new Promise<string>((resolve) => (settled = resolve));
      holds.set(op, { at, reached, gate, settled });
      return { arrived, release, outcome };
    },
  };
}

/** Holds the next restart gate (`rewind.beforeRestart`) until `release`, which opens or fails it. */
function holdGate(host: RewindHost) {
  const original = host.rewind.beforeRestart.bind(host.rewind);
  let reached!: () => void;
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  let release!: (opens: boolean) => void;
  const gate = new Promise<boolean>((resolve) => (release = resolve));
  let first = true;
  host.rewind.beforeRestart = () => {
    if (!first) return original();
    first = false;
    reached();
    return gate.then((opens) =>
      opens ? undefined : Promise.reject(new Error("The gate failed.")),
    );
  };
  return { arrived, release };
}

/** Fails the next restart gate only. */
function failNextGate(host: RewindHost) {
  const original = host.rewind.beforeRestart.bind(host.rewind);
  let first = true;
  host.rewind.beforeRestart = () => {
    if (!first) return original();
    first = false;
    return Promise.reject(new Error("The gate failed."));
  };
}

/** The Player, its Debug features, and what the row holds. */
interface World {
  readonly context: TestContext;
  readonly host: RewindHost;
  readonly owner: RewindHost["rewind"]["owner"];
  readonly storage: ReturnType<typeof memoryStorage>;
  readonly scope: EffectScope;
  readonly lose: (() => void) | undefined;
  readonly bridge: PlayerBridge;
  readonly traffic: ReturnType<typeof traffic>;
  readonly reported: unknown[];
  debug: EffectScope;
  rewind: Rewind;
  /** The session the next Return shows: the one the first Back of this inspection left. */
  tip: PlayerSession | null;
  /** The resource's session, whose holding in the host the row reads. */
  session: string | null;
  /** The pending ask's settlement. */
  ask: Promise<boolean> | null;
  /** The hold the maker left, released after the end. */
  release: ((how: Release) => void) | null;
  /** How the held close's request settled. */
  closeOutcome: Promise<string> | null;
  /** Where the maker's history controls begin in the traffic, for a close in flight. */
  postedFrom: number | null;
}

async function replace(world: World) {
  const { host, context } = world;
  await host.loadScriptStorage();
  host.prepare((recording) =>
    createPlayerRuntimeSession(script, { ...host.scriptStorageOptions(), ...recording }),
  );
  host.activate();
  await settle(context);
}

/** Answers the shown choice with its first option, as the Player's interaction does. */
async function answerFirst(world: World) {
  const { host, context } = world;
  if (await host.prepareInput()) {
    const session = host.session.value!;
    const foreground = playerRuntimeForeground(session);
    assert.ok(foreground?.kind === "choose", "a choice to answer");
    host.update(selectPlayerRuntimeChoice(session, foreground.options[0]!.id)!.session);
  }
  await settle(context);
}

/** Plays the session on: two answers, three with `halted`, which ends it. */
async function play(world: World, halted: boolean) {
  for (let answered = 0; answered < (halted ? 3 : 2); answered += 1) await answerFirst(world);
  if (halted) assert.equal(world.host.session.value?.state.status, "halted");
}

async function importOwn(world: World) {
  const { host } = world;
  const review = await host.reviewSavedDataImport({
    scripts: [{ scope: "test", name: null, photos: [], entries: [{ key: "imported", value: 9 }] }],
    images: [],
  });
  await host.importSavedData(review, new Set(["test"]));
  await settle(world.context);
}

async function clear(world: World) {
  assert.equal(await world.host.clearScriptStorage(), true, "the clear");
  await settle(world.context);
}

/** Inspects the third point's state: the first Back, which parks the session it leaves. */
async function inspect(world: World) {
  world.tip = shownView(world.host);
  assert.equal(await backTo(world.rewind, 2), true, "the first Back");
  await settle(world.context);
}

/** The host failure a close settlement end has the maker's `op` meet, before it is posted. */
function hostFailure(world: World, c: Case, op: string) {
  if (c.end === "close refused") world.traffic.hostFails(op, "refuse");
  if (c.end === "close rejected live") world.traffic.hostFails(op, "reject");
}

/** The host's answer that fails each problem's step, but for the restart gate's failure. */
const FAILURES: Partial<Record<Case["maker"], readonly [string, Settlement]>> = {
  "step refused": ["rewindBack", "refuse"],
  "step read failure": ["rewindBack", "reject"],
  "commit refused": ["rewindCommit", "refuse after"],
};

/** Makes the case's resource, in the case's inspection state; a held one stays held until its end. */
async function make(world: World, c: Case) {
  const { host, rewind, traffic: requests, context } = world;
  const inspecting = c.inspection === "inspecting";
  const halted = c.end === "clear" || c.maker === "retirement" || c.maker === "clear";
  if (c.resource === "early deltas") {
    // A replacement's new history, whose open the host answered: the page has its reply only after the session
    // published deltas of that history.
    const held = requests.hold("historyRenew", "reply");
    await replace(world);
    await held.arrived;
    await play(world, halted);
    world.release = (how) => held.release(how === "fail gate" ? "pass" : how);
    return;
  }
  if (c.maker === "new session") await replace(world);
  if (c.maker === "Debug off" && c.resource === "close in flight") {
    await play(world, halted);
    hostFailure(world, c, "historyClose");
    const held = requests.hold(
      "historyClose",
      c.end === "close rejected by loss" ? "request" : "reply",
    );
    world.postedFrom = requests.sent.length;
    world.debug.stop();
    await held.arrived;
    world.release = (how) => held.release(how === "fail gate" ? "pass" : how);
    world.closeOutcome = held.outcome;
    return;
  }
  await play(world, halted);
  if (c.resource === "close in flight") {
    if (inspecting) await inspect(world);
    // A clear's close rides on its renewal. A replacement's, or an import's that ends the running session, is posted at
    // the new generation, and its renewal follows at that generation's follow; an import then renews once more.
    // An import over an ended session (the clear end's rows play the session to its end) does not end it: its close
    // rides on its renewal, as a clear's does.
    const carried = c.maker === "clear" || (c.maker === "import" && c.end === "clear");
    const op = carried ? "historyRenew" : "historyClose";
    hostFailure(world, c, op);
    // A close the loss rejects has not reached the host: its request waits; any other is posted, its reply held.
    const held = requests.hold(op, c.end === "close rejected by loss" ? "request" : "reply");
    const renewal =
      c.maker === "replacement" || (c.maker === "import" && !carried)
        ? requests.hold("historyRenew", "reply")
        : null;
    world.postedFrom = requests.sent.length;
    if (c.maker === "replacement") await replace(world);
    else if (c.maker === "clear") await clear(world);
    else if (c.maker === "import") await importOwn(world);
    else world.scope.stop();
    await held.arrived;
    await renewal?.arrived;
    world.release = (how) => {
      const answer = how === "fail gate" ? "pass" : how;
      // The close goes first, as the host ran it; a renewal's own failure is its reply's.
      if (renewal === null) return held.release(answer);
      held.release("pass");
      renewal.release(answer);
    };
    world.closeOutcome = held.outcome;
    return;
  }
  if (c.maker === "retirement") {
    await clear(world);
    return;
  }
  // A refused commit's step is the first Back, which shows its candidate; a Return-made session's is the first Back
  // whose parked session the Return reinstates.
  const firstBack =
    c.maker !== "commit refused" &&
    (c.resource === "parked" ||
      inspecting ||
      (c.resource === "reinstated" && c.maker === "Return"));
  if (firstBack) await inspect(world);
  switch (c.maker) {
    case "Return":
      if (c.resource === "pending ask") {
        const gate = holdGate(host);
        world.ask = rewind.returnToSession();
        await gate.arrived;
        world.release = (how) => gate.release(how === "pass");
        return;
      }
      assert.equal(await rewind.returnToSession(), true, "Return");
      await settle(context);
      world.session = world.tip!.id;
      world.tip = null;
      // A Back again inspects the reinstated session's state, which it parks.
      if (inspecting) await inspect(world);
      return;
    case "Debug off":
      // Debug off while a restored state is inspected reinstates the session the first Back left.
      await inspect(world);
      world.debug.stop();
      await settle(context);
      world.session = world.tip!.id;
      world.tip = null;
      return;
    case "first Back":
      world.session = world.tip!.id;
      return;
    case "Back":
    case "Forward": {
      const step = () => (c.maker === "Back" ? backTo(rewind, 1) : rewind.forward());
      // A first Back leaves the shown session, which the next Return shows once it commits.
      if (!inspecting) world.tip = shownView(host);
      if (c.resource === "candidate") {
        const gate = holdGate(host);
        world.ask = step();
        await gate.arrived;
        world.session = requests.candidates.at(-1)!;
        world.release = (how) => gate.release(how === "pass");
        return;
      }
      const held = requests.hold(c.maker === "Back" ? "rewindBack" : "rewindForward");
      world.ask = step();
      await held.arrived;
      world.release = (how) => {
        if (how === "fail gate") failNextGate(host);
        held.release(how === "fail gate" ? "pass" : how);
      };
      return;
    }
    case "step refused":
    case "step read failure":
    case "step gate failure":
    case "commit refused": {
      const failing = FAILURES[c.maker];
      if (failing === undefined) failNextGate(host);
      else requests.answer(...failing);
      // A refused commit's candidate shows before its refusal arrives, as its first Back's; every other failure shows
      // nothing.
      if (c.maker === "commit refused") world.tip = shownView(host);
      const refusedCommit = c.maker === "commit refused";
      assert.equal(await backTo(rewind, refusedCommit ? 2 : 1), refusedCommit, "the failed step");
      await settle(context);
      if (failing !== undefined) requests.answer(failing[0], "pass");
      return;
    }
  }
}

/** The case's end; a hold the maker left goes after it, answered as the end says. */
async function end(world: World, c: Case) {
  const { host, context } = world;
  const release = (how: Release) => {
    const held = world.release;
    world.release = null;
    held?.(how);
  };
  switch (c.end) {
    case "replace":
      await replace(world);
      break;
    case "Debug off":
      world.debug.stop();
      break;
    case "disposal by the Player":
      world.scope.stop();
      break;
    case "disposal by Debug's scope":
      world.rewind.endWithPlayer();
      world.debug.stop();
      world.scope.stop();
      break;
    case "clear":
      await clear(world);
      break;
    case "import":
      await importOwn(world);
      break;
    case "loss":
    case "close rejected by loss":
      world.lose!();
      break;
    case "drop":
      if (world.release !== null) release("fail gate");
      else {
        failNextGate(host);
        assert.equal(await backTo(world.rewind, 1), false, "the dropped step");
      }
      break;
    case "commit":
      if (world.release !== null) release("pass");
      else {
        if (!world.owner.inspecting.value) world.tip = shownView(host);
        assert.equal(await backTo(world.rewind, 1), true, "the committed step");
      }
      break;
    case "Return":
      if (world.release !== null) release("pass");
      else assert.equal(await world.rewind.returnToSession(), true, "Return");
      break;
    case "adoption success":
      assert.equal(await world.rewind.resume(), true, "the adoption");
      break;
    case "adoption failure":
      world.storage.failNextReplace();
      assert.equal(await world.rewind.resume(), false, "the failed adoption");
      break;
    case "open failure":
      release("reject");
      break;
    case "close refused":
    case "close rejected live":
      // The host failed the close already; its reply carries that.
      release("pass");
      break;
    case "stop":
      host.reportHostError(new Error("A Player error."));
      break;
  }
  await settle(context);
}

/** What the end left, read once the page is quiescent. */
interface EndRecord {
  readonly view: "none" | "kept" | "kept, closed" | "new";
  readonly inspecting?: boolean;
  readonly sealed: "disposal" | "loss" | null;
  readonly blocked: boolean;
  readonly problem: string | null;
  readonly closes: number;
  readonly opens: number;
  /** The renewals sent while the maker's close or renewal was still held. */
  readonly opensWhileHeld?: number;
  /** The history controls the maker posted, in order, for a close in flight. */
  readonly posted?: readonly string[];
  readonly reports: number;
  readonly held?: boolean;
  readonly asked?: boolean;
  readonly closeSettled?: string;
}

/** What the after-axis did. */
type AfterRecord =
  | { readonly after: "quiescent" }
  | {
      readonly after: "next Back then Return";
      readonly back: boolean;
      readonly returned: boolean | null;
      readonly shows: "the session Back left" | "another" | null;
    }
  | { readonly after: "next step"; readonly went: boolean; readonly problem: string | null }
  | { readonly after: "next Debug on"; readonly opens: number; readonly view: boolean };

/** The end's record, by the lifecycle's decisions and DEBUGGER.md "Rewind". */
function expectedEnd(c: Case): EndRecord {
  const inspecting = c.inspection === "inspecting";
  const debug = debugAtEnd(c);
  // The unmounted Player reports nothing more, and no loss reaches its owner (`bridgeLost`).
  const disposed = c.maker === "disposal";
  const sealed =
    disposed || c.end.startsWith("disposal")
      ? "disposal"
      : c.end === "loss" || c.end === "close rejected by loss"
        ? "loss"
        : null;
  // The maker's close or renewal is in flight; a retirement's close rides on its renewal.
  const carried =
    c.resource === "close in flight" &&
    (c.maker === "clear" || (c.maker === "import" && c.end === "clear"));
  // An import ends a running or inspected session first (`useSavedDataTransfer.ts`); one that ended stays.
  const halted = c.end === "clear" || c.maker === "retirement" || c.maker === "clear";
  const importEnds = !halted || inspecting;
  const hostFailed = c.end === "close refused" || c.end === "close rejected live";
  // A sealed owner decides nothing on a close's settlement. A renewal whose reply cannot cross failed after its closes,
  // so its carried close blocks nothing.
  const blocked = hostFailed && sealed === null && !(carried && c.end === "close rejected live");
  // A history is open when the end comes: not while one opens or closes, nor after Debug off.
  const open = debug && c.resource !== "early deltas" && c.resource !== "close in flight";
  // The ends that close the open history and, with Debug on, open the next one.
  const closing =
    ["replace", "Debug off", "clear", "import"].includes(c.end) || sealed === "disposal";
  const reopens = debug && ["replace", "clear", "import"].includes(c.end);
  let view: EndRecord["view"] = open ? "kept" : "none";
  if (open && closing) view = "none";
  if (reopens) view = "new";
  if (open && sealed === "loss") view = "kept, closed";
  // A clear's close rides on the renewal that follows it, with Debug on, and so does an import's of an ended session. An
  // import that ends the session first closes the history as replaced at its new generation, whose `null` follow renews
  // an empty history, which the import's own renewal then replaces. The disposal closes every history once any renewal
  // was posted, which every row did.
  const endsFirst = c.end === "import" && importEnds;
  const carriedByRenewal = reopens && (c.end === "clear" || (c.end === "import" && !importEnds));
  let closes = (open && closing && !carriedByRenewal) || sealed === "disposal" ? 1 : 0;
  if (disposed) closes = 0;
  let opens = reopens ? (endsFirst ? 2 : 1) : 0;
  let reports = 0;
  if (sealed === "loss") reports += 1;
  if (c.end === "stop") reports += 1;
  let opensWhileHeld: number | undefined;
  let posted: readonly string[] | undefined;
  let closeSettled: string | undefined;
  if (c.resource === "close in flight") {
    // The maker's controls, in the order the host runs them: its close, or the renewal that carries it, then a
    // replacement's renewal, posted at its session's follow without waiting for the close's reply.
    posted =
      c.maker === "replacement"
        ? ["historyClose", "historyRenew"]
        : c.maker === "import" && !carried
          ? ["historyClose", "historyRenew", "historyRenew"]
          : carried
            ? ["historyRenew"]
            : ["historyClose"];
    const renews = c.maker !== "Debug off" && c.maker !== "disposal";
    // The maker's renewal went before the end; its reply, held, installs its history unless it failed.
    if (c.end === "stop") view = renews ? "new" : "none";
    if (c.end === "open failure") view = "none";
    // Debug off before that reply: the history it opened closes.
    if (c.end === "Debug off" && renews) closes = 1;
    if (hostFailed && !disposed) {
      reports += 1;
      view = "none";
    }
    if (sealed !== null) view = "none";
    if (c.maker === "import" && !carried && sealed === "loss") view = "kept, closed";
    if (c.maker === "import" && !carried && sealed === null) {
      // The import's own renewal is not held: its history shows before the end, or its host refusal blocked the page
      // then, already reported.
      if (hostFailed) reports -= 1;
      else if (c.end === "stop") view = "kept";
      else if (["replace", "Debug off", "clear", "import"].includes(c.end)) {
        // With no session shown, a clear's or an import's close rides on its renewal.
        closes = c.end === "clear" || c.end === "import" ? 0 : 1;
        if (c.end === "import") opens = 1;
        view = c.end === "Debug off" ? "none" : "new";
      }
    }
    opensWhileHeld = opens;
    closeSettled =
      c.end === "close rejected by loss"
        ? "BridgeLostError"
        : c.end === "close rejected live" || (carried && c.end === "open failure")
          ? "Error"
          : "answered";
  }
  if (c.resource === "early deltas") {
    // The held open is answered after the end: an open still asked for enrolls; a newer open replaced it, unanswered;
    // an obsolete one closes the history it opened.
    opensWhileHeld = opens;
    if (c.end === "stop") view = "new";
    if (c.end === "Debug off" || sealed === "disposal") closes = 1;
  }
  if (c.end === "open failure") reports += 1;
  let problem: string | null = null;
  if (c.end === "drop") problem = "The gate failed.";
  const record: EndRecord = {
    view,
    ...(sealed === null && { inspecting: inspectingAfter(c) }),
    sealed,
    blocked,
    problem,
    closes,
    opens,
    ...(opensWhileHeld !== undefined && { opensWhileHeld }),
    ...(posted !== undefined && { posted }),
    reports,
    ...(closeSettled !== undefined && { closeSettled }),
  };
  const held = heldAfter(c);
  const asked = askedAfter(c);
  return { ...record, ...(held !== undefined && { held }), ...(asked !== undefined && { asked }) };
  function inspectingAfter(each: Case): boolean {
    if (
      ["replace", "Debug off", "clear", "import", "Return", "adoption success"].includes(each.end)
    )
      return false;
    if (each.resource === "close in flight") return false;
    if (each.end === "commit") return true;
    // A step a stop meets goes on, and commits; so does a Return, which ends the inspection.
    if (each.end === "stop" && (each.resource === "candidate" || each.resource === "pending ask"))
      return each.maker !== "Return";
    return inspecting;
  }
}

/** Whether the host still holds the resource's session after the end, where it has one and the connection lives. */
function heldAfter(c: Case): boolean | undefined {
  if (c.end === "loss" || c.end === "close rejected by loss") return undefined;
  const closesIt = ["replace", "import"].includes(c.end) || c.end.startsWith("disposal");
  switch (c.resource) {
    case "parked":
      // Parked in the host until its history closes, a Return or Debug off shows it, or an adoption ends it.
      return !closesIt && c.end !== "adoption success";
    case "candidate":
      // A candidate's step shows it at its commit; any other end drops it, or its history's close takes it.
      return c.end === "commit" || c.end === "stop";
    case "reinstated":
      // Released by the Player's disposal while it shows; a Back again parks it, and an adoption then ends it. What
      // a new session or an import leaves of it is the Player's, not this owner's.
      if (c.end === "replace" || c.end === "import") return undefined;
      return (
        !c.end.startsWith("disposal") &&
        !(c.inspection === "inspecting" && c.end === "adoption success")
      );
    default:
      return undefined;
  }
}

/** The pending ask's settlement: whether its step or Return went. */
function askedAfter(c: Case): boolean | undefined {
  if (c.resource !== "pending ask" && c.resource !== "candidate") return undefined;
  // Debug off's reinstatement answers a Return; a step it abandons settles `false` at its own exit (#2232).
  if (c.maker === "Return") return c.end === "Return" || c.end === "Debug off" || c.end === "stop";
  return c.end === "commit" || c.end === "stop";
}

async function readEnd(
  world: World,
  c: Case,
  before: DebugHistoryView | null,
  from: number,
  reportsFrom: number,
  whileHeld: number | undefined,
): Promise<EndRecord> {
  const { owner, traffic: requests } = world;
  const view = owner.view.value;
  const sealed = owner.state.sealed;
  const held =
    world.session === null || sealed === "loss"
      ? undefined
      : await heldInHost(world.bridge, world.session);
  const since = requests.sent.slice(from);
  return {
    view: view === null ? "none" : view !== before ? "new" : view.closed ? "kept, closed" : "kept",
    ...(sealed === null && { inspecting: owner.inspecting.value }),
    sealed,
    blocked: owner.state.blocked,
    problem: owner.problem.value,
    closes: since.filter((op) => op === "historyClose").length,
    opens: since.filter((op) => op === "historyRenew").length,
    ...(whileHeld !== undefined && { opensWhileHeld: whileHeld }),
    ...(world.postedFrom !== null && {
      posted: requests.sent.slice(world.postedFrom, from).filter((op) => op.startsWith("history")),
    }),
    reports: world.reported.length - reportsFrom,
    ...(world.closeOutcome !== null && { closeSettled: await world.closeOutcome }),
    ...(held !== undefined && heldAfter(c) !== undefined && { held }),
    ...(world.ask !== null && askedAfter(c) !== undefined && { asked: await world.ask }),
  };
}

/** The after-axis on the page the end left; what it returns is compared with `expectedAfter`. */
async function runAfter(world: World, c: Case): Promise<AfterRecord> {
  const { context, owner, host } = world;
  switch (c.after) {
    case "quiescent":
      return { after: c.after };
    case "next Back then Return": {
      const leaves = owner.inspecting.value
        ? world.tip
        : host.session.value === null
          ? null
          : shownView(host);
      const back = await backTo(world.rewind, 0);
      await settle(context);
      if (!back) return { after: c.after, back, returned: null, shows: null };
      const returned = await world.rewind.returnToSession();
      await settle(context);
      return {
        after: c.after,
        back,
        returned,
        shows: shownView(host).lineage === leaves?.lineage ? "the session Back left" : "another",
      };
    }
    case "next step": {
      const went = await backTo(world.rewind, 0);
      await settle(context);
      return { after: c.after, went, problem: owner.problem.value };
    }
    case "next Debug on": {
      const from = world.traffic.sent.length;
      world.debug.stop();
      await settle(context);
      world.debug = effectScope();
      const rewind = world.debug.run(() => useDebugRewind(host));
      assert.ok(rewind);
      world.rewind = rewind;
      await settle(context);
      return {
        after: c.after,
        opens: world.traffic.sent.slice(from).filter((op) => op === "historyRenew").length,
        view: owner.view.value !== null,
      };
    }
  }
}

/** What the after-axis finds, by the end's record: a step goes on an open history with a point to go Back to. */
function expectedAfter(c: Case, ended: EndRecord): AfterRecord {
  // The points the next step can go Back to: the history's own, or a new session's first; an ended, stopped or
  // imported-over session presents none in a history opened after it.
  const points =
    c.end === "replace" ||
    (c.maker !== "retirement" &&
      !["clear", "import", "open failure"].includes(c.end) &&
      // A retirement's renewal enrolls an ended session, or none: no point to go Back to.
      !(c.resource === "close in flight" && c.end === "stop" && c.maker !== "replacement"));
  const steps =
    ended.sealed === null &&
    !ended.blocked &&
    (ended.view === "kept" || ended.view === "new") &&
    (c.resource !== "early deltas" || c.end === "stop" || c.end === "replace") &&
    points;
  switch (c.after) {
    case "quiescent":
      return { after: c.after };
    case "next Back then Return":
      return steps
        ? { after: c.after, back: true, returned: true, shows: "the session Back left" }
        : { after: c.after, back: false, returned: null, shows: null };
    case "next step":
      return { after: c.after, went: steps, problem: steps ? null : ended.problem };
    case "next Debug on": {
      const opens = ended.blocked ? 0 : 1;
      return { after: c.after, opens, view: opens === 1 };
    }
  }
}

const completed: Coordinates[] = [];
for (const coordinates of FEASIBLE) {
  const c = asCase(coordinates);
  test(`a rewind owner's resource: ${Object.values(c).join(", ")}`, async (context) => {
    const storage = memoryStorage();
    const lossy = c.end === "loss" || c.end === "close rejected by loss";
    const made = createHost(context, storage.provider, { lossy });
    const { host } = made;
    const reported: unknown[] = [];
    reportsInto(context, reported);
    await start(context, host);
    const bridge = await host.bridge;
    const world: World = {
      context,
      host,
      owner: host.rewind.owner,
      storage,
      scope: made.scope,
      lose: made.lose,
      bridge,
      traffic: traffic(context, bridge),
      reported,
      debug: made.debug,
      rewind: made.rewind,
      tip: null,
      session: null,
      ask: null,
      release: null,
      closeOutcome: null,
      postedFrom: null,
    };
    await make(world, c);
    const before = world.owner.view.value;
    const from = world.traffic.sent.length;
    const reportsFrom = reported.length;
    await end(world, c);
    // The opens sent while the maker's open or close still held.
    const whileHeld = world.traffic.sent.slice(from).filter((op) => op === "historyRenew").length;
    if (world.release !== null) {
      const held = world.release;
      world.release = null;
      held("pass");
      await settle(context);
    }
    const ended = await readEnd(
      world,
      c,
      before,
      from,
      reportsFrom,
      opensAndCloses(c) ? whileHeld : undefined,
    );
    assert.deepEqual(ended, expectedEnd(c), "the end");
    assert.equal(world.owner.busy.value, false, "no step runs at quiescence");
    assert.equal(world.owner.showing, false, "nothing shows at quiescence");
    assert.equal(world.owner.reinstatement.value, null, "no Return waits at quiescence");
    // A Debug-off reinstatement leaves no inspection; the next Return shows what the next Back leaves.
    if (!world.owner.inspecting.value) world.tip = null;
    assert.deepEqual(await runAfter(world, c), expectedAfter(c, ended), "the after");
    completed.push(coordinates);
  });
}

test("the rewind owner's lifetime family completed every feasible full tuple, and nothing else", () => {
  assert.deepEqual(coverageGaps(FEASIBLE, completed, { tuples: true }), []);
  // #2150 PR 2 took ten tuples out: an import's held renewal cannot fail as the one asked for (8), and the host refuses
  // no disposal of its current Player (2). #2229 added 110: a problem at each end that ends its history.
  assert.equal(FEASIBLE.length, 861);
});

test("#2232: a step committed before Debug off's reinstatement resolves true", async (context) => {
  const made = createHost(context, memoryStorage().provider);
  await start(context, made.host);
  await choose(context, made.host, "One");
  await choose(context, made.host, "Red");
  const bridge = await made.host.bridge;
  // The commit is sent, its acknowledgement held, when Debug off reinstates the parked session.
  const held = holdRead(context, bridge, "rewindCommit", "reply", false);
  const stepped = backTo(made.rewind, 0);
  await held.arrived;
  made.debug.stop();
  await settle(context);
  held.release();
  assert.equal(await stepped, true);
  assert.equal(made.host.rewind.inspecting.value, false, "the parked session is reinstated");
});
