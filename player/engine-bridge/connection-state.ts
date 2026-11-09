import type {
  RandomControlOptions,
  RandomDecision,
  RandomDrawView,
} from "../../src/runtime/random/random-control.js";
import { RuntimeDebugContext } from "../../src/runtime/debug/debug-trace.js";
import { decideDraw, RandomHistory, type RandomNext } from "../debug/random-decisions.js";
import { everyItem, exactly, isRecord } from "./argument-checks.js";
import type { PlayerOpsContext } from "./player-ops.js";

/*
 * The connection's random and trace state, as the ops read and change it: Debug's random control (`alignRandom`,
 * `ownedRandom`) and its value trace (`alignTrace`), with the intents that set them. A leaf of the engine bridge: the ops
 * and the context's composition (`player-ops.ts`) import it, and it imports no value from them, only
 * `PlayerOpsContext`'s type.
 */

/**
 * Debug's random control as the newest random intent set it: its Player (`owner`), which draws it decides, and the
 * history of what each site took, which belongs to that Player and lasts until it asks for a reset.
 */
export interface RandomState {
  /** The serial of the newest random intent the host applied; `0` before any. */
  intent: number;
  /** The Player that sent it (`PlayerBridge.claim`); `0` before any. */
  owner: number;
  /** The control the owner's sessions run with, or `null` while Choose outcomes is off. */
  control: RandomControlOptions | null;
  settings: ReadonlyMap<string, RandomNext>;
  readonly history: RandomHistory;
  /** The serial of the newest reset applied (`RandomIntent.resetAt`). */
  forgotAt: number;
}

/**
 * One random change a live Player sent: its control (the sites set to go on by themselves), or none; the serial of the
 * newest reset of its history it asked for; and its own serial, which the connection counts up across the Players that
 * use it (`PlayerBridge.nextRandomIntent`). Every op that sets the connection's control carries one.
 */
export interface RandomIntent {
  readonly owner: number;
  readonly control: { readonly sites: readonly (readonly [string, RandomNext])[] } | null;
  readonly resetAt: number;
  readonly intent: number;
}

const isSerial = (value: unknown, least: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= least;
const isRandomNext = (value: unknown): value is RandomNext =>
  value === "random" || value === "untried";

/** Whether `value` is a `RandomIntent`. */
export const isRandomIntent = (value: unknown): value is RandomIntent =>
  isRecord(value) &&
  exactly(value, ["owner", "control", "resetAt", "intent"]) &&
  isSerial(value.owner, 1) &&
  isSerial(value.resetAt, 0) &&
  isSerial(value.intent, 1) &&
  value.resetAt <= value.intent &&
  (value.control === null ||
    (isRecord(value.control) &&
      exactly(value.control, ["sites"]) &&
      everyItem(
        value.control.sites,
        (site) =>
          Array.isArray(site) &&
          site.length === 2 &&
          typeof site[0] === "string" &&
          isRandomNext(site[1]),
      )));

/**
 * Makes the connection's random control follow the newest random intent; one older than the newest applied does
 * nothing. Another owner's intent, or a reset newer than the last applied, forgets the history first, before its
 * control can decide a draw: a reset an intent overtook still applies, as every later intent carries it.
 */
export function alignRandom(context: PlayerOpsContext, intent: RandomIntent): void {
  const random = context.random;
  if (intent.intent <= random.intent) return;
  random.intent = intent.intent;
  if (intent.owner !== random.owner || intent.resetAt > random.forgotAt) random.history.clear();
  random.forgotAt = intent.resetAt;
  random.settings = new Map(intent.control?.sites ?? []);
  if (intent.control === null) random.control = null;
  else if (random.owner !== intent.owner || random.control === null)
    random.control = ownerControl(context, intent.owner);
  random.owner = intent.owner;
}

/**
 * The control of `owner`'s sessions: it decides by the connection's settings and records into its history while
 * `owner` still holds them and Choose outcomes is on; otherwise every draw goes on naturally and nothing is recorded,
 * as for a session of a Player that ended.
 */
function ownerControl(context: PlayerOpsContext, owner: number): RandomControlOptions {
  const natural: RandomDecision = { kind: "natural" };
  return Object.freeze({
    decide: (draw: RandomDrawView): RandomDecision => {
      // Through the one gate to the random state, as every other access is.
      const owned = ownedRandom(context, owner);
      return owned !== null && owned.control !== null
        ? decideDraw(owned.settings, owned.history, draw)
        : natural;
    },
  });
}

/** The random state `owner`'s sessions may use: the connection's while `owner` holds it, else none. */
export function ownedRandom(context: PlayerOpsContext, owner: number | null): RandomState | null {
  return owner !== null && owner === context.random.owner ? context.random : null;
}

/**
 * One tracing change a live Player sent: on or off, with its serial, which the connection counts up across the Players
 * that use it (`PlayerBridge.nextTracingIntent`). Every op that sets the connection's trace carries one, through
 * whichever channel it arrives.
 */
export interface TracingIntent {
  readonly on: boolean;
  readonly intent: number;
}

/** Whether `value` is a `TracingIntent`. */
export const isTracingIntent = (value: unknown): value is TracingIntent =>
  isRecord(value) &&
  exactly(value, ["on", "intent"]) &&
  typeof value.on === "boolean" &&
  typeof value.intent === "number" &&
  Number.isSafeInteger(value.intent) &&
  value.intent >= 1;

/**
 * Makes the connection's value trace follow the Player's newest tracing intent: a new trace with no history, or none.
 * The intent arrives through the connection's queue (`debugTracing`) or with the work that begins an epoch (a Start in
 * the host, Continue's `restartTrace`), in any order; one older than the newest applied does nothing, so a change still
 * queued never undoes a newer one. Returns the trace's ID now, or `null`.
 */
export function alignTrace(
  context: PlayerOpsContext,
  { on, intent }: TracingIntent,
): number | null {
  if (intent > context.traceIntent) {
    context.traceIntent = intent;
    if (on !== (context.trace !== null)) {
      context.trace = on ? new RuntimeDebugContext() : null;
      if (on) context.traceId += 1;
    }
  }
  return context.trace === null ? null : context.traceId;
}
