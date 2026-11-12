import assert from "node:assert/strict";

import {
  INITIAL_LIFECYCLE,
  advanceLifecycle,
  type LifecycleAction,
  type LifecycleEvent,
  type LifecycleOutcome,
  type LifecycleState,
} from "../../../player/debug/rewind-lifecycle.js";

/*
 * L5i.6: the page side's deciding function (`player/debug/rewind-lifecycle.ts`), driven over every schedule of its event
 * grammar to a fixed depth. A driver plays the Player and the host: it answers only what was sent, the host's replies
 * in the order the renewals were posted, and follows a new session as `rewindOwner.ts` does, while a renewal waits for
 * it. The oracle keeps its own ledgers of histories, tokens, gates and adoptions from the actions alone, and checks the
 * rules of DEBUGGER.md "Rewind" and of the page side's handoff (`player/debug/rewind-lifecycle.ts`) on them,
 * independently of how the function decides:
 *
 * - at most one history is held; a renewed history is installed or closed at once unless a newer renewal replaced it in
 *   the host; none is installed with Debug off, none closed twice, and none is left held by a new session, a
 *   retirement, the disposal, or Debug off unless Debug off still waits for its adoption or gate;
 * - no renewal while a history is held (unless it carries that history's close), after a failed close, with Debug off,
 *   or after the Player was sealed; a new session's renewal waits for its session and is posted at its first follow;
 * - a prepared token ends at most once, to its own history: dropped when its step does not reach its commit, unless its
 *   history closed meanwhile; committed only at its gate's success, followed at once by its show;
 * - a current reinstatement gate closes the history and shows the parked session, whether it opens or fails; a failed
 *   one is reported once (#2230); the parked session shows only from that gate or a successful Return gate;
 * - a Debug-off close of a history whose adoption was under way waits for it and carries its outcome;
 * - a step and Return are refused while a step, Return, an adoption, or Debug off's close is under way, and go
 *   otherwise when a history is held (and, for Return, a restored state shows);
 * - the failure of a renewal still wanted is reported, and an obsolete one's is not; a failed close is reported once;
 * - after the disposal only `disposal` closes are sent; after a loss nothing is.
 *
 * Each renewal and close the function decides is posted, or cannot be posted, in the turn it is decided (`post`,
 * `unpost`), as `rewindControls.ts` reports it; nothing else happens in between. The driver keeps the host's open
 * histories: a renewal run there closes every earlier one (carried closes included) and opens its own, or, refused
 * after its closes, opens none; a close run there ends its history; a refused close ends none. On that ledger:
 *
 * - while the Player is live, at quiescence (every posted control answered, nothing left to post), a history open on
 *   the host is one the page owns (its history, or its opening's, which then has none yet), or one whose close was
 *   refused or could not be posted, reported once, with the Player blocked. Nothing else: a renewal that could not be
 *   posted replaced nothing, and a close it carried is still owed. A sealed Player is outside this rule: its disposal's
 *   close, when posted, takes every history on the host, and a lost connection takes them with it.
 */

export type Move =
  | "debugOn"
  | "debugOff"
  | "follow"
  | "renewed"
  | "renewFailedOpen"
  | "renewFailedClose"
  | "newSession"
  | "retiredClear"
  | "retiredImport"
  | "lost"
  | "disposal"
  | "stepAsked"
  | "stepPrepared"
  | "stepPreparedUnready"
  | "stepFailed"
  | "gateOk"
  | "gateUnready"
  | "gateRejected"
  | "commitAcknowledged"
  | "adoptionBegun"
  | "adoptionSucceeds"
  | "adoptionFails"
  | "return"
  | "returnGateOk"
  | "returnGateRejected"
  | "returnGateOkNewest"
  | "returnGateRejectedNewest"
  | "reinstateGateOk"
  | "reinstateGateRejected"
  | "reinstateGateOkNewest"
  | "reinstateGateRejectedNewest"
  | "closeOk"
  | "closeFails"
  | "post"
  | "unpost";
const MOVES: readonly Move[] = [
  "debugOn",
  "debugOff",
  "follow",
  "renewed",
  "renewFailedOpen",
  "renewFailedClose",
  "newSession",
  "retiredClear",
  "retiredImport",
  "lost",
  "disposal",
  "stepAsked",
  "stepPrepared",
  "stepPreparedUnready",
  "stepFailed",
  "gateOk",
  "gateUnready",
  "gateRejected",
  "commitAcknowledged",
  "adoptionBegun",
  "adoptionSucceeds",
  "adoptionFails",
  "return",
  "returnGateOk",
  "returnGateRejected",
  "returnGateOkNewest",
  "returnGateRejectedNewest",
  "reinstateGateOk",
  "reinstateGateRejected",
  "reinstateGateOkNewest",
  "reinstateGateRejectedNewest",
  "closeOk",
  "closeFails",
  "post",
  "unpost",
];

/** The posting moves: forced in the deciding turn, so they take no depth of a schedule (`explore`). */
const POSTING: ReadonlySet<Move> = new Set(["post", "unpost"]);

/**
 * A control decided and not yet posted, with the row of R3-01's table that decided it: a renewal, a close, or the open's
 * failure that follows an unposted renewal's carried closes.
 */
type Posting =
  | {
      readonly kind: "renew";
      readonly intent: number;
      readonly closes: Extract<LifecycleAction, { kind: "renew" }>["closes"];
      readonly row: string;
    }
  | {
      readonly kind: "close";
      readonly history: number;
      readonly disposal: boolean;
      readonly row: string;
      /** The row of the unposted renewal that carried it, when it did. */
      readonly carriedBy: string | null;
    }
  | { readonly kind: "failOpen"; readonly intent: number };

export type Decide = (state: LifecycleState, event: LifecycleEvent) => LifecycleOutcome;

/** The driver's and the oracle's state of one schedule. */
export interface World {
  readonly state: LifecycleState;
  readonly moves: readonly Move[];
  // The driver: what was posted and is unanswered, renewals by their intents and closes posted alone, in posting order,
  // which is the order the host runs them and its replies come back in; and whether a close failed there, after which
  // the host refuses every later renewal (its close admission).
  readonly serial: number;
  readonly posting: readonly Posting[];
  readonly sent: readonly (number | { readonly close: number; readonly disposal: boolean })[];
  /** The histories open on the host. */
  readonly host: ReadonlySet<number>;
  /** The histories whose close the host refused, or that could not be posted. */
  readonly owed: ReadonlySet<number>;
  /** R3-01's rows met at their posting: see `postingRow`. */
  readonly met: readonly string[];
  readonly latched: boolean;
  readonly newestSent: number;
  readonly newestOpen: number;
  readonly stepSent: number | null;
  /** The gates asked and unanswered, by their identities, oldest first. */
  readonly gates: {
    readonly step: readonly number[];
    readonly return: readonly number[];
    readonly reinstate: readonly number[];
  };
  /** The Return and reinstatement gate still current, by identity: the oracle's own account of supersession. */
  readonly current: { readonly return: number | null; readonly reinstate: number | null };
  readonly commits: number;
  readonly adopting: boolean;
  // The oracle's ledgers.
  readonly debug: boolean;
  readonly sealed: "disposal" | "loss" | null;
  readonly closeFailed: boolean;
  readonly held: number | null;
  readonly inspecting: boolean;
  readonly tokens: ReadonlyMap<
    number,
    { readonly history: number; readonly ended: "drop" | "commit" | null }
  >;
  readonly closed: ReadonlySet<number>;
  readonly stepPhase: "sent" | "gate" | "committed" | null;
  readonly gateToken: number | null;
  readonly returnBusy: boolean;
  readonly adoption: {
    readonly history: number;
    readonly outcome: boolean | null;
    readonly offDuring: boolean;
  } | null;
  /** Debug off's close is under way: waiting for an adoption or for its gate. */
  readonly offHold: boolean;
}

export function start(): World {
  return {
    state: INITIAL_LIFECYCLE,
    moves: [],
    serial: 10,
    posting: [],
    sent: [],
    host: new Set(),
    owed: new Set(),
    met: [],
    latched: false,
    newestSent: 0,
    newestOpen: 0,
    stepSent: null,
    gates: { step: [], return: [], reinstate: [] },
    current: { return: null, reinstate: null },
    commits: 0,
    adopting: false,
    debug: false,
    sealed: null,
    closeFailed: false,
    held: null,
    inspecting: false,
    tokens: new Map(),
    closed: new Set(),
    stepPhase: null,
    gateToken: null,
    returnBusy: false,
    adoption: null,
    offHold: false,
  };
}

/** Mutable working copy of a world for one move. */
type Draft = {
  -readonly [
    K in Exclude<
      keyof World,
      "tokens" | "closed" | "gates" | "current" | "sent" | "posting" | "host" | "owed" | "met"
    >
  ]: World[K];
} & {
  posting: Posting[];
  host: Set<number>;
  owed: Set<number>;
  met: string[];
  tokens: Map<number, { history: number; ended: "drop" | "commit" | null }>;
  closed: Set<number>;
  gates: { step: number[]; return: number[]; reinstate: number[] };
  current: { return: number | null; reinstate: number | null };
  sent: (number | { close: number; disposal: boolean })[];
};

function draftOf(world: World): Draft {
  return {
    ...world,
    tokens: new Map([...world.tokens].map(([token, entry]) => [token, { ...entry }])),
    closed: new Set(world.closed),
    gates: {
      step: [...world.gates.step],
      return: [...world.gates.return],
      reinstate: [...world.gates.reinstate],
    },
    current: { ...world.current },
    sent: [...world.sent],
    posting: [...world.posting],
    host: new Set(world.host),
    owed: new Set(world.owed),
    met: [],
  };
}

/** The event `move` is in `world`, or `null` when nothing the Player or the host would do produces it now. */
function eventOf(world: Draft, move: Move): LifecycleEvent | "posted" | null {
  const next = () => (world.serial += 1);
  // A control decided is posted, or not, before anything else happens.
  if (POSTING.has(move) !== world.posting.length > 0) return null;
  if (POSTING.has(move)) {
    const head = world.posting.shift()!;
    const posted = move === "post";
    switch (head.kind) {
      case "renew": {
        const held = world.sent.some((each) => typeof each === "number");
        world.met.push(`${head.row}:${move}`);
        if (held) world.met.push(`${head.row}:${move}, an earlier reply held`);
        if (!posted) return { kind: "renewUnposted", intent: head.intent, closes: head.closes };
        world.sent.push(head.intent);
        world.newestSent = head.intent;
        return { kind: "renewPosted", intent: head.intent };
      }
      case "close":
        world.met.push(`${head.row}:${move}`);
        if (head.carriedBy !== null) world.met.push(`${head.carriedBy}'s carried close:${move}`);
        if (!posted) {
          world.owed.add(head.history);
          return { kind: "closeSettled", ok: false };
        }
        world.sent.push({ close: head.history, disposal: head.disposal });
        return "posted";
      case "failOpen":
        return posted ? { kind: "renewFailed", intent: head.intent, stage: "open" } : null;
    }
  }
  switch (move) {
    case "debugOn":
    case "newSession":
      return { kind: move, intent: next() };
    case "retiredClear":
    case "retiredImport":
      return { kind: "retired", by: move === "retiredClear" ? "clear" : "import", intent: next() };
    case "follow":
      // The Player follows its session at every publication; the owner reports it while a renewal waits for one.
      return world.state.awaiting ? { kind: "follow" } : null;
    case "renewed":
    case "renewFailedOpen":
    case "renewFailedClose": {
      const intent = world.sent[0];
      if (typeof intent !== "number") return null;
      // After a failed close the host refuses it at its close admission.
      if (world.latched && move !== "renewFailedClose") return null;
      world.sent.shift();
      // The host runs it: its closes and every earlier history's, then its own history opens; or, refused after its
      // closes, none opens; or a close was refused, and what it would have closed stays, owed.
      if (move === "renewFailedClose") for (const history of world.host) world.owed.add(history);
      else world.host.clear();
      if (move === "renewed") {
        const history = next();
        world.host.add(history);
        return { kind: "renewed", intent, history };
      }
      return { kind: "renewFailed", intent, stage: move === "renewFailedOpen" ? "open" : "close" };
    }
    case "stepPrepared":
    case "stepPreparedUnready":
    case "stepFailed": {
      if (world.stepSent === null) return null;
      const history = world.stepSent;
      world.stepSent = null;
      if (move === "stepFailed") return { kind: "stepFailed" };
      const token = next();
      world.tokens.set(token, { history, ended: null });
      return { kind: "stepPrepared", token, mayShow: move === "stepPrepared" };
    }
    case "gateOk":
    case "gateUnready":
    case "gateRejected":
      if (world.gates.step.length === 0) return null;
      return {
        kind: "gateSettled",
        gate: "step",
        id: world.gates.step.shift()!,
        ok: move !== "gateRejected",
        mayShow: move !== "gateUnready",
      };
    // The oldest unanswered gate of its kind settles, or with `Newest` the newest: both orders of an obsolete and a
    // current gate.
    case "returnGateOk":
    case "returnGateRejected":
    case "returnGateOkNewest":
    case "returnGateRejectedNewest":
    case "reinstateGateOk":
    case "reinstateGateRejected":
    case "reinstateGateOkNewest":
    case "reinstateGateRejectedNewest": {
      const gate = move.startsWith("return") ? "return" : "reinstate";
      const asked = world.gates[gate];
      if (asked.length === 0) return null;
      return {
        kind: "gateSettled",
        gate,
        id: move.endsWith("Newest") ? asked.pop()! : asked.shift()!,
        ok: move.includes("Ok"),
        mayShow: true,
      };
    }
    case "commitAcknowledged":
      if (world.commits === 0) return null;
      world.commits -= 1;
      return { kind: "commitAcknowledged" };
    case "adoptionBegun":
      // An attempt: the Player's adoption runs, and later settles, only once the function admitted it (`advance`).
      if (world.adopting) return null;
      return { kind: "adoptionBegun" };
    case "adoptionSucceeds":
    case "adoptionFails":
      if (!world.adopting) return null;
      world.adopting = false;
      return { kind: "adoptionSettled", succeeded: move === "adoptionSucceeds" };
    case "closeOk":
    case "closeFails": {
      const close = world.sent[0];
      if (close === undefined || typeof close === "number") return null;
      world.sent.shift();
      if (move === "closeFails") world.owed.add(close.close);
      else if (close.disposal) world.host.clear();
      else world.host.delete(close.close);
      return { kind: "closeSettled", ok: move === "closeOk" };
    }
    // Decided above, while a control waits for its posting.
    case "post":
    case "unpost":
      return null;
    default:
      return { kind: move };
  }
}

/** R3-01's table: the row of a renewal or a close, by the event that decided it. */
function postingRow(
  kind: "renew" | "close",
  event: LifecycleEvent,
  closes: readonly unknown[] = [],
): string {
  const rows: Partial<Record<LifecycleEvent["kind"], string>> =
    kind === "renew"
      ? {
          debugOn: "R1",
          follow: "R2",
          adoptionSettled: closes.length === 0 ? "R3" : "R4",
          retired: "R5",
          gateSettled: "R6",
        }
      : {
          debugOff: "C1",
          adoptionSettled: "C2",
          renewed: "C3",
          newSession: "C4",
          retired: "C5",
          disposal: "C6",
          gateSettled: "C7",
          renewUnposted: "carried",
        };
  return rows[event.kind] ?? `a ${kind} decided at ${event.kind}`;
}

/**
 * The ledger's rule at quiescence, while the Player is live (the header's last rule): every history open on the host is
 * the page's, or owed with the Player blocked. `null`, or the rule broken.
 */
function unowned(world: Draft): string | null {
  if (world.sealed !== null || world.sent.length > 0 || world.posting.length > 0) return null;
  for (const history of world.host) {
    if (history === world.held) continue;
    if (world.owed.has(history) && world.state.blocked) continue;
    return "a history open on the host that the page neither owns nor failed to close";
  }
  return null;
}

/** One move: the world after it and the first rule its batch broke, or `null` when the move cannot happen now. */
function advance(
  world: World,
  move: Move,
  decide: Decide = advanceLifecycle,
): {
  readonly world: World;
  readonly actions: readonly LifecycleAction[];
  readonly broken: string | null;
} | null {
  const w = draftOf(world);
  const event = eventOf(w, move);
  if (event === null) return null;
  w.moves = [...world.moves, move];
  // A close posted: the host runs it later, and the page decides nothing now.
  if (event === "posted") return { world: w, actions: [], broken: unowned(w) };
  const decision = decide(world.state, event);
  const { state, actions } = decision;
  if (event.kind === "adoptionBegun" && decision.admitted === true) w.adopting = true;
  w.state = state;
  const fail = (rule: string) => ({ world: w, actions, broken: rule });
  const sealedBefore = w.sealed;
  // The event's own facts.
  if (event.kind === "lost") w.sealed = "loss";
  if (event.kind === "disposal" && w.sealed === null) w.sealed = "disposal";
  if (event.kind === "debugOn" && w.sealed === null) w.debug = true;
  if (event.kind === "debugOff" || event.kind === "disposal") w.debug = false;
  if (event.kind === "debugOff" && w.adoption !== null && w.adoption.outcome === null)
    w.adoption = { ...w.adoption, offDuring: true };
  if (event.kind === "adoptionSettled" && w.adoption !== null && w.adoption.outcome === null)
    w.adoption = { ...w.adoption, outcome: event.succeeded };
  if (event.kind === "closeSettled" && !event.ok) w.closeFailed = true;
  if (event.kind === "renewFailed" && event.stage === "close") w.closeFailed = true;
  if (w.closeFailed) w.latched = true;
  // A renewal decided now supersedes every earlier one, posted or waiting for its session.
  const deciding =
    (event.kind === "debugOn" && !world.debug) ||
    ((event.kind === "newSession" || event.kind === "retired") && world.debug);
  if (deciding && w.sealed === null) w.newestOpen = event.intent;
  // A settlement of the current Return or reinstatement gate ends it; an obsolete one's changes nothing.
  const settling =
    event.kind !== "gateSettled" || event.gate === "step"
      ? null
      : { gate: event.gate, id: event.id, ok: event.ok };
  const currentGate = settling !== null && world.current[settling.gate] === settling.id;
  const failedCurrent = currentGate && settling.ok === false;
  if (currentGate) {
    w.current = { ...w.current, [settling.gate]: null };
    if (settling.gate === "return") w.returnBusy = false;
  }
  if (event.kind === "stepFailed" || event.kind === "commitAcknowledged") w.stepPhase = null;
  const opened = event.kind === "renewed" ? event.history : null;
  const obsolete =
    (event.kind === "renewed" || event.kind === "renewFailed") && w.newestSent > event.intent;
  const prepared = event.kind === "stepPrepared" ? event.token : null;
  const atGate = event.kind === "gateSettled" && event.gate === "step" ? world.gateToken : null;
  // Whether a step or Return may go now, as the rules say.
  const busy =
    w.stepPhase !== null ||
    w.returnBusy ||
    (w.adoption !== null && w.adoption.outcome === null) ||
    w.offHold;
  const asked = {
    step: !busy && w.debug && w.held !== null,
    ret: !busy && w.debug && w.held !== null && w.inspecting,
  };

  if (w.sealed === "loss") {
    // After a loss only the page's own view changes: read-only, and a new session's cleared view; nothing posts.
    const sent = actions.filter(
      (action) =>
        action.kind !== "readOnly" && !(event.kind === "newSession" && action.kind === "clearView"),
    );
    if (sent.length > 0) return fail("an action after a loss");
    if (sealedBefore !== "loss" && actions.length === 0 && sealedBefore === null)
      return fail("a loss without its read-only view");
    return { world: { ...w, stepPhase: null, offHold: false }, actions, broken: null };
  }

  // A request's decision, from the oracle's own ledgers: an adoption may begin only on a restored state Debug shows,
  // with nothing else under way; its completion is the page's only while that adoption is still the history's.
  if (event.kind === "adoptionBegun" && w.sealed === null) {
    const eligible = w.debug && w.held !== null && w.inspecting && !busy;
    const admitted = decision.admitted === true;
    if (admitted !== eligible)
      return fail(
        eligible ? "an adoption that may begin refused" : "an adoption admitted that may not begin",
      );
    if (admitted !== actions.some((action) => action.kind === "adoptBegin"))
      return fail("an admission without its adoption begun");
  }
  if (event.kind === "adoptionSettled" && w.sealed === null) {
    const current = world.adoption !== null && world.adoption.outcome === null;
    if ((decision.admitted === true) !== current)
      return fail(
        current
          ? "a current adoption's completion refused"
          : "a stale adoption's completion accepted",
      );
  }

  // An obsolete gate decides nothing: its success restarts nothing, and its failure is not reported.
  if (settling !== null && !currentGate && w.sealed === null && actions.length > 0)
    return fail("an obsolete gate decided something");
  let enrolled = false;
  let renewing = false;
  let closedOpened = false;
  /** A close, posted alone or carried by a renewal: the history it names ends; `null`, or the rule it broke. */
  const closing = (close: {
    readonly history: number;
    readonly by: string;
    readonly adoptionSucceeded?: boolean;
  }): string | null => {
    const { history } = close;
    if (w.sealed === "disposal" && close.by !== "disposal")
      return "a non-disposal close after disposal";
    // The disposal's close takes every history of the connection, one whose renewal is unanswered included.
    if (close.by === "disposal") w.held = null;
    else if (history === opened) {
      if (obsolete) return "a close of a replaced history";
      closedOpened = true;
    } else if (w.held !== history) return "a close of a history not held";
    else w.held = null;
    if (w.adoption !== null && (w.adoption.history === history || close.by === "disposal")) {
      if (close.by === "debugOff") {
        if (w.adoption.outcome === null) return "a Debug-off close before its adoption settled";
        if (w.adoption.offDuring && close.adoptionSucceeded !== w.adoption.outcome)
          return "a Debug-off close without its adoption's outcome";
      }
      w.adoption = null;
    }
    w.closed.add(history);
    if (w.held === null) {
      w.inspecting = false;
      w.offHold = false;
      // A Return or a reinstatement still waiting at its gate is obsolete with the history.
      w.current = { return: null, reinstate: null };
      w.returnBusy = false;
    }
    return null;
  };
  let reported = false;
  let gate = false;
  let committed = false;
  // The controls this batch decides, posted in its turn in this order, before any decided earlier and not yet posted.
  const emitted: Posting[] = [];
  const carriedBy =
    event.kind === "renewUnposted"
      ? (w.met.find((each) => each.endsWith(":unpost"))?.split(":")[0] ?? null)
      : null;
  for (const [index, action] of actions.entries()) {
    switch (action.kind) {
      case "renew": {
        if (w.sealed !== null) return fail("a renewal after the Player was sealed");
        if (w.closeFailed) return fail("a renewal after a failed close");
        if (!w.debug) return fail("a renewal with Debug off");
        for (const close of action.closes) {
          const broken = closing(close);
          if (broken !== null) return fail(broken);
        }
        if (w.held !== null) return fail("a renewal while a history is held");
        emitted.push({
          kind: "renew",
          intent: action.intent,
          closes: action.closes,
          row: postingRow("renew", event, action.closes),
        });
        w.newestOpen = action.intent;
        renewing = true;
        break;
      }
      case "install":
        if (action.history !== opened) return fail("an installation of a history not just renewed");
        if (obsolete) return fail("an installation of a replaced history");
        if (!w.debug || w.sealed !== null) return fail("an installation with Debug off");
        if (w.held !== null) return fail("two histories held");
        w.held = action.history;
        w.inspecting = false;
        enrolled = true;
        break;
      case "close": {
        // An unposted renewal's carried close was taken from the page at its decision; it is only posted now.
        if (event.kind === "renewUnposted") {
          if (
            !event.closes.some(
              (close) => close.history === action.history && close.by === action.by,
            )
          )
            return fail("a close the unposted renewal did not carry");
        } else {
          const broken = closing(action);
          if (broken !== null) return fail(broken);
        }
        emitted.push({
          kind: "close",
          history: action.history,
          disposal: action.by === "disposal",
          row: postingRow("close", event),
          carriedBy,
        });
        break;
      }
      case "sendStep":
        if (move !== "stepAsked" || !asked.step) return fail("a step sent while it may not go");
        w.stepSent = w.held;
        w.stepPhase = "sent";
        break;
      case "refuse":
        if (
          move !== "stepAsked" &&
          move !== "return" &&
          !(settling?.gate === "return" && currentGate)
        )
          return fail("a refusal no one asked for");
        break;
      case "gate":
        gate = true;
        if (action.gate === "step") {
          if (prepared === null) return fail("a step gate without its prepared step");
          if (move === "stepPreparedUnready") return fail("an unready step at its gate");
          w.gates.step.push(action.id);
          w.gateToken = prepared;
          w.stepPhase = "gate";
        } else if (action.gate === "return") {
          if (move !== "return" || !asked.ret) return fail("a Return gate while Return may not go");
          w.gates.return.push(action.id);
          w.current = { ...w.current, return: action.id };
          w.returnBusy = true;
        } else {
          if (move !== "debugOff" && move !== "adoptionFails")
            return fail("a reinstatement gate no Debug off asked for");
          w.gates.reinstate.push(action.id);
          w.current = { ...w.current, reinstate: action.id };
        }
        break;
      case "drop":
      case "commit": {
        const entry = w.tokens.get(action.token);
        if (entry === undefined) return fail(`a ${action.kind} of an unknown token`);
        if (entry.ended !== null)
          return fail(`token ${action.token} ended twice (${entry.ended}, ${action.kind})`);
        if (entry.history !== action.history)
          return fail(`a ${action.kind} sent to another history`);
        if (w.closed.has(entry.history)) return fail(`a ${action.kind} after its history closed`);
        entry.ended = action.kind;
        if (action.kind === "commit") {
          if (move !== "gateOk" || atGate !== action.token)
            return fail("a commit before its gate settled");
          if (!w.debug || w.held !== action.history)
            return fail("a commit without Debug's history");
          if (actions[index + 1]?.kind !== "showCandidate")
            return fail("a commit not followed by its show");
          w.commits += 1;
          w.stepPhase = "committed";
          w.inspecting = true;
          committed = true;
        }
        break;
      }
      case "showCandidate":
        if (actions[index - 1]?.kind !== "commit")
          return fail("a candidate shown without its commit");
        break;
      case "sendReturn":
        if (
          !(settling?.gate === "return" && currentGate && settling.ok) ||
          action.history !== w.held
        )
          return fail("a Return sent without its gate");
        w.inspecting = false;
        break;
      case "showParked":
        // From a successful Return gate, or Debug off's reinstatement gate, opened or failed (#2230).
        if (!(currentGate && (settling.ok || settling.gate === "reinstate")))
          return fail("the parked session shown without its gate");
        if (w.sealed !== null) return fail("the parked session shown after the Player was sealed");
        if (
          settling.gate === "reinstate" &&
          !actions.slice(0, index).some((each) => each.kind === "close")
        )
          return fail("the parked session reinstated before its history's close");
        break;
      case "adoptBegin":
        if (move !== "adoptionBegun" || action.history !== w.held || !w.inspecting)
          return fail("an adoption begun without its restored state");
        w.adoption = { history: action.history, outcome: null, offDuring: false };
        break;
      case "adoptEnd":
        if (w.adoption?.history !== action.history || w.adoption.outcome !== action.succeeded)
          return fail("an adoption ended without its outcome");
        if (action.succeeded) w.inspecting = false;
        w.adoption = null;
        break;
      case "reportFailure":
        // A step's failed gate is reported only for the step the page still asks for: Debug runs, and its history
        // is still open.
        if (
          event.kind !== "renewFailed" &&
          !(event.kind === "closeSettled" && !event.ok) &&
          !failedCurrent &&
          !(
            move === "gateRejected" &&
            atGate !== null &&
            w.debug &&
            !w.closed.has(w.tokens.get(atGate)!.history)
          )
        )
          return fail("a failure reported for no failed open or current gate");
        reported = true;
        break;
      case "clearView":
      case "readOnly":
        break;
    }
  }

  w.posting = [
    ...emitted,
    ...(event.kind === "renewUnposted"
      ? [{ kind: "failOpen", intent: event.intent } as const]
      : []),
    ...w.posting,
  ];
  // The batch's obligations.
  const wantsRenewal = w.debug && w.held === null && w.sealed === null && !w.closeFailed;
  if (move === "follow" && wantsRenewal && !renewing)
    return fail("a renewal waiting for its session not posted at its follow");
  if (event.kind === "debugOn" && !world.debug && !world.offHold && wantsRenewal && !renewing)
    return fail("a Debug on that renews nothing");
  if (event.kind === "newSession" && wantsRenewal && (!state.awaiting || renewing))
    return fail("a new session's renewal does not wait for its session");
  if (opened !== null && !obsolete && !enrolled && !closedOpened && w.sealed === null)
    return fail("a renewed history neither installed nor closed");
  if (event.kind === "renewFailed" && event.stage === "open") {
    if (reported && (obsolete || w.sealed !== null))
      return fail("an obsolete renewal's failure reported");
    // After a failed close, which was reported, a renewal's failure is its consequence: nothing more is reported.
    const wanted =
      !obsolete && event.intent === w.newestOpen && w.sealed === null && w.debug && !w.closeFailed;
    if (!reported && wanted) return fail("a wanted renewal's failure not reported");
    if (reported && world.closeFailed)
      return fail("a renewal's failure reported after a failed close");
  }
  const closeFailing =
    (event.kind === "renewFailed" && event.stage === "close") ||
    (event.kind === "closeSettled" && !event.ok);
  if (closeFailing && w.sealed === null) {
    if (reported && world.closeFailed) return fail("a failed close reported twice");
    if (!reported && !world.closeFailed) return fail("a failed close not reported");
  }

  if (
    move === "stepAsked" &&
    w.sealed === null &&
    asked.step !== (w.stepPhase === "sent" && world.stepPhase === null)
  )
    return fail(asked.step ? "a step that may go refused" : "a step that may not go sent");
  if (
    move === "stepAsked" &&
    !asked.step &&
    !actions.some((action) => action.kind === "refuse") &&
    w.sealed === null
  )
    return fail("a step that may not go not refused");
  if (move === "return" && w.sealed === null) {
    if (asked.ret && !gate) return fail("a Return that may go refused");
    if (!asked.ret && !actions.some((action) => action.kind === "refuse"))
      return fail("a busy Return not refused");
  }
  if (prepared !== null) {
    const entry = w.tokens.get(prepared)!;
    if (!gate && entry.ended === null && !w.closed.has(entry.history) && w.sealed === null)
      return fail("a prepared step left without its drop");
    if (!gate) w.stepPhase = null;
  }
  if (atGate !== null) {
    const entry = w.tokens.get(atGate)!;
    if (move !== "gateOk" && committed) return fail("a commit at a failed gate");
    if (entry.ended === null && !w.closed.has(entry.history) && w.sealed === null)
      return fail("a step's gate left its token");
    if (!committed) w.stepPhase = null;
  }
  // A current gate's failure is the Player's to report. A failed reinstatement gate is reported once and reinstates
  // (below); any other restarts nothing.
  if (failedCurrent && w.sealed === null) {
    if (!actions.some((a) => a.kind === "reportFailure"))
      return fail("a current gate's failure not reported");
    if (
      settling.gate === "reinstate" &&
      actions.filter((a) => a.kind === "reportFailure").length !== 1
    )
      return fail("a failed reinstatement gate not reported once");
    if (
      settling.gate !== "reinstate" &&
      actions.some((a) => a.kind === "showParked" || a.kind === "sendReturn")
    )
      return fail("a failed Return gate restarted the page");
  }
  // A successful gate still current transfers: Return reinstates the parked session. Debug off's reinstatement gate
  // still current, opened or failed, closes the history it holds, then shows the parked session.
  const succeeded = currentGate && settling.ok;
  if (succeeded && settling.gate === "return" && asked.ret) {
    if (
      !actions.some((a) => a.kind === "sendReturn") ||
      !actions.some((a) => a.kind === "showParked")
    )
      return fail("a successful Return gate did not return");
  } else if (
    succeeded &&
    settling.gate === "return" &&
    w.sealed === null &&
    !actions.some((a) => a.kind === "refuse")
  )
    return fail("a Return gate no longer current not refused");
  if (
    currentGate &&
    settling.gate === "reinstate" &&
    world.offHold &&
    world.held !== null &&
    w.sealed === null
  ) {
    const closed = actions.some(
      (a) => a.kind === "close" && a.history === world.held && a.by === "debugOff",
    );
    if (!closed || !actions.some((a) => a.kind === "showParked"))
      return fail(
        settling.ok
          ? "a successful reinstatement gate did not reinstate"
          : "a failed reinstatement gate did not reinstate",
      );
  }
  if (
    (event.kind === "newSession" || event.kind === "retired" || event.kind === "disposal") &&
    w.held !== null
  )
    return fail("a history left held by a new session, retirement, or disposal");
  if (event.kind === "debugOff" && w.sealed === null && w.held !== null) {
    const waits =
      (w.adoption !== null && w.adoption.outcome === null) ||
      actions.some((a) => a.kind === "gate" && a.gate === "reinstate") ||
      world.offHold;
    if (!waits) return fail("Debug off left its history held");
    w.offHold = true;
  }
  if (!w.debug && w.held !== null && !w.offHold && w.sealed === null)
    return fail("a history held with Debug off");
  // The page's inspection is the function's state: it says what the oracle's ledgers show.
  if (w.sealed === null && state.inspecting !== w.inspecting)
    return fail("the page's inspection is not what shows");
  if (w.sealed !== null) {
    w.stepPhase = null;
    w.offHold = false;
  }

  return { world: w, actions, broken: unowned(w) };
}

/**
 * Plays `moves` from `world`; every move must be possible. Controls decided and not yet posted are posted before a move
 * that is not a posting move, and at the end.
 */
export function play(world: World, moves: readonly Move[], decide: Decide = advanceLifecycle) {
  let at = world;
  const batches: { readonly move: Move; readonly actions: readonly LifecycleAction[] }[] = [];
  const step = (move: Move) => {
    const next = advance(at, move, decide);
    assert.ok(next !== null, `${[...at.moves, move].join(" → ")}: not possible`);
    assert.equal(next.broken, null, `${next.world.moves.join(" → ")}`);
    at = next.world;
    batches.push({ move, actions: next.actions });
  };
  for (const move of moves) {
    if (!POSTING.has(move)) while (at.posting.length > 0) step("post");
    step(move);
  }
  while (at.posting.length > 0) step("post");
  return { world: at, batches };
}

/**
 * Every schedule of up to `depth` moves from `from`, the posting moves its controls take besides: the count, the first
 * breaches (or the first matching `stop`), and R3-01's rows each met.
 */
export function explore(
  from: World,
  depth: number,
  decide: Decide = advanceLifecycle,
  stop?: string,
) {
  let schedules = 0;
  const failures: string[] = [];
  const met = new Set<string>();
  const walk = (world: World, left: number): boolean => {
    if (left === 0 && world.posting.length === 0) return false;
    for (const move of MOVES) {
      const next = advance(world, move, decide);
      if (next === null) continue;
      schedules += 1;
      for (const row of next.world.met) met.add(row);
      if (next.broken !== null) {
        const line = `${next.world.moves.join(" → ")}: ${next.broken}`;
        if (stop === undefined) {
          if (failures.length < 5) failures.push(line);
        } else if (next.broken.startsWith(stop)) {
          failures.push(line);
          return true;
        }
        continue;
      }
      if (walk(next.world, POSTING.has(move) ? left : left - 1)) return true;
    }
    return false;
  };
  walk(from, depth);
  return { schedules, failures, met };
}
