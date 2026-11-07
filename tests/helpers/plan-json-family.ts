import type { CapturedMediaRepository } from "../../player/captured-media.js";
import type { KeptRoomStore, KeptSessionStore } from "../../player/kept-sessions.js";
import type { ScriptStorageProvider } from "../../player/script-storage.js";

/*
 * The plan JSON's lifetime family (`player/plan-json-lease.ts`), declared once for both of its witness layers: the
 * pure family (`player-plan-json-lease.test.ts`) and the composable's (`player-session-keep.test.ts`). A producer is an
 * op of the host that reads or writes a plan's canonical JSON. Every op of `persistenceOps` is either a producer, with
 * its outcomes, or classified here as not one; the coverage check compares this with the ops themselves, so a new op
 * fails until it is classified and both layers drive it.
 */

/**
 * The ops that read or write a plan's canonical JSON, and each one's outcomes. A request the Worker's loss ended is the
 * loss family's (`player-bridge-loss.test.ts`): the host and all it holds are gone.
 */
export const PRODUCERS = {
  // The page reserves the plan's JSON; its task writes it, unless a release cancels it first or the write fails, when
  // the first reader writes it.
  preparePlanText: ["materialized", "cancelled", "writeFailed"],
  // A Continue's comparison of the kept session's plan JSON, and its restore.
  restoreKept: ["restored", "otherPlan", "ended", "rejected"],
  // An import's save reads the plan's JSON.
  planText: ["published", "failed"],
  // A keep's capture reads the plan's JSON for a first save.
  captureKeep: ["captured", "unkeepable", "gone"],
} as const;
export type Producer = keyof typeof PRODUCERS;

/** The ops that touch no plan JSON a reader could keep, and why. */
const NOT_PRODUCERS = {
  releasePlanText: "cleanup: the one remover of a reserved plan JSON",
  captureCheckpoint: "a whole checkpoint, which holds the plan inside it; no plan JSON of its own",
} as const;

/** Where the page's plan stands when the producer's reply arrives: still current, replaced by another, or closed. */
export const RETIREMENTS = ["current", "replaced", "disposed"] as const;
export type Retirement = (typeof RETIREMENTS)[number];

/** A case of the family: a producer with one of its outcomes, and the retirement while its reply is out. */
export interface FamilyCase {
  readonly producer: Producer;
  readonly outcome: string;
  readonly retirement: Retirement;
}

/** Every case of the family, named by its values alone. */
export function familyCases(): FamilyCase[] {
  const cases: FamilyCase[] = [];
  // EVIDENCE: invariant: the keys of `PRODUCERS`, declared literally above.
  for (const producer of Object.keys(PRODUCERS) as Producer[])
    for (const outcome of PRODUCERS[producer])
      for (const retirement of RETIREMENTS) cases.push({ producer, outcome, retirement });
  return cases;
}

export const caseName = (c: FamilyCase) => `${c.producer} ${c.outcome} ${c.retirement}`;

/** Every key of `ops`, classified: each is a producer, or named as none, so a new op cannot go unclassified. */
export function unclassifiedOps(ops: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(ops).filter(
    (op) => !Object.hasOwn(PRODUCERS, op) && !Object.hasOwn(NOT_PRODUCERS, op),
  );
}

/**
 * The routes of the saved values a persistence operation reaches (`StorageRoute` in the composable): a provider used as
 * it is, one that keeps the values' captured media durable, and the debug room's, which always does.
 */
export const ROUTES = ["plain", "captured", "debug"] as const;
export type Route = (typeof ROUTES)[number];

/** A producer whose operation is a persistence operation of the composable, with its ownership. */
export type Operated = Exclude<Producer, "preparePlanText">;

/**
 * One way an operation runs, as the composable's family (`player-session-keep.test.ts`) drives it: its producer, its
 * route, and its trace, every call it makes in order when nothing retires it. The family records each call of the kept
 * store and its photos (`kept.`), the debug rooms (`rooms.`, with a room's saved values as `rooms.values.`), the saved
 * values' provider (`provider.`), the media store (`repository.`) and the host (`host.<op>`). It holds each call of the
 * trace that is not `POSTED` in turn and retires the operation there: every call up to the held one was admitted
 * before the retirement and may complete after it; no later one may be admitted. A run whose calls differ from its
 * trace fails, so a new call, branch or helper of an operation shows here. A producer's operation is its caller: a keep
 * for `captureKeep`, the kept session's restore for `restoreKept`, a session import for `planText`.
 */
export interface Variant {
  readonly producer: Operated;
  readonly route: Route;
  readonly trace: readonly string[];
}

export const VARIANTS = {
  // A Continue of a session kept with a photo only it uses: the store's read, the host's restore, the photo.
  "restoreKept captured sessionPhoto": {
    producer: "restoreKept",
    route: "captured",
    trace: ["host.preparePlanText", "kept.session", "host.restoreKept", "kept.media.get"],
  },
  // The same on a page whose saved values keep no captured media.
  "restoreKept plain sessionPhoto": {
    producer: "restoreKept",
    route: "plain",
    trace: ["host.preparePlanText", "kept.session", "host.restoreKept", "kept.media.get"],
  },
  // The debug room's session, whose photos the room holds: no photo read.
  "restoreKept debug sessionPhoto": {
    producer: "restoreKept",
    route: "debug",
    trace: ["host.preparePlanText", "rooms.session", "host.restoreKept"],
  },
  // An import of a session whose photo only it uses, into a browser of its own.
  "planText captured sessionPhoto": {
    producer: "planText",
    route: "captured",
    trace: [
      "provider.replace",
      "kept.discard",
      "kept.media.add",
      "host.planText",
      "kept.publish",
      "provider.load",
      "kept.session",
      "host.restoreKept",
      "kept.media.get",
    ],
  },
  // The same into saved values that keep no captured media.
  "planText plain sessionPhoto": {
    producer: "planText",
    route: "plain",
    trace: [
      "provider.replace",
      "kept.discard",
      "kept.media.add",
      "host.planText",
      "kept.publish",
      "provider.load",
      "kept.session",
      "host.restoreKept",
      "kept.media.get",
    ],
  },
  // A saved photo into a browser that has none: stored before the values that reference it.
  "planText captured savedPhoto": {
    producer: "planText",
    route: "captured",
    trace: [
      "repository.add",
      "provider.replace",
      "kept.discard",
      "host.planText",
      "kept.publish",
      "provider.load",
      "kept.session",
      "host.restoreKept",
      "kept.media.get",
    ],
  },
  // Two saved photos, each in a value of its own.
  "planText captured twoSavedPhotos": {
    producer: "planText",
    route: "captured",
    trace: [
      "repository.add",
      "repository.add",
      "provider.replace",
      "kept.discard",
      "host.planText",
      "kept.publish",
      "provider.load",
      "kept.session",
      "host.restoreKept",
      "kept.media.get",
      "kept.media.get",
    ],
  },
  // A saved photo another tab stored first: the add is refused, and a read confirms it.
  "planText captured confirmedPhoto": {
    producer: "planText",
    route: "captured",
    trace: [
      "repository.add",
      "repository.get",
      "provider.replace",
      "kept.discard",
      "host.planText",
      "kept.publish",
      "provider.load",
      "kept.session",
      "host.restoreKept",
      "kept.media.get",
    ],
  },
  // A replacement the storage refuses, over values whose photo the page does not hold: the final read looks it up.
  "planText captured failedReplace": {
    producer: "planText",
    route: "captured",
    trace: [
      "repository.add",
      "provider.replace",
      "provider.load",
      "repository.listReferences",
      "kept.session",
      "host.restoreKept",
      "kept.media.get",
    ],
  },
  // The kept session cannot be replaced: the earlier one stays, and Continue goes on with it.
  "planText captured discardFails": {
    producer: "planText",
    route: "captured",
    trace: [
      "provider.replace",
      "kept.discard",
      "provider.load",
      "kept.session",
      "host.restoreKept",
      "kept.media.get",
    ],
  },
  // The kept session's photo cannot be stored: Start is offered with the imported values.
  "planText captured photoAddFails": {
    producer: "planText",
    route: "captured",
    trace: ["provider.replace", "kept.discard", "kept.media.add", "provider.load", "kept.session"],
  },
  // The host's plan JSON does not arrive: Start is offered.
  "planText captured planTextFails": {
    producer: "planText",
    route: "captured",
    trace: [
      "provider.replace",
      "kept.discard",
      "kept.media.add",
      "host.planText",
      "provider.load",
      "kept.session",
    ],
  },
  // The kept session cannot be stored: Start is offered.
  "planText captured publishFails": {
    producer: "planText",
    route: "captured",
    trace: [
      "provider.replace",
      "kept.discard",
      "kept.media.add",
      "host.planText",
      "kept.publish",
      "provider.load",
      "kept.session",
    ],
  },
  // A first save, its earlier ones refused: the discard, the photo, the publish.
  "captureKeep captured first": {
    producer: "captureKeep",
    route: "captured",
    trace: ["host.captureKeep", "kept.discard", "kept.media.add", "kept.publish"],
  },
  // A later save: the photo, kept already, is confirmed.
  "captureKeep captured incremental": {
    producer: "captureKeep",
    route: "captured",
    trace: ["host.captureKeep", "kept.media.add", "kept.media.get", "kept.publish"],
  },
  // A state this browser cannot write: the kept session is discarded.
  "captureKeep captured forget": {
    producer: "captureKeep",
    route: "captured",
    trace: ["host.captureKeep", "kept.discard"],
  },
  // A first save in the debug room: its session discarded alone, the photo stored in the room.
  "captureKeep debug first": {
    producer: "captureKeep",
    route: "debug",
    trace: ["host.captureKeep", "rooms.discardSession", "rooms.media.add", "rooms.publish"],
  },
} as const satisfies Record<string, Variant>;
export type VariantName = keyof typeof VARIANTS;

/**
 * Pairs of a producer and a route no variant drives, and why: a supported path cannot go undriven unless named here.
 */
export const UNDRIVEN_ROUTES = {
  "planText debug": "the debug room refuses a session import",
  "captureKeep plain":
    "a keep reaches no saved values: the route of the values does not change its calls, which `captured` drives",
} as const;

/** Calls these operations post without awaiting them, and why. */
export const POSTED = {
  "host.preparePlanText": "the lease's reservation (`settlePlanJson`)",
  "host.releasePlanText": "the lease's release of a replaced plan (`settlePlanJson`)",
  "host.release": "a stale restore's session, which nothing shows",
} as const;

/** Calls the page makes in no async context while an operation runs, and why: none of them reaches a store. */
export const LIFECYCLE = {
  "host.release":
    "the bridge lets go of a session nothing refers to any more (its finalization registry)",
} as const;

/**
 * Awaits of these operations that are no call: promises of the page itself, and why no case holds them. The held calls
 * bound them on either side.
 */
export const UNHELD_AWAITS = {
  storageRoute: "a promise the page resolves once at mount, before any operation of these cases",
  bridgeReady: "the connection, ready before any operation of these cases",
  pendingKeep: "an import waits for a keep under way; the keep's own suspensions are held instead",
} as const;

/**
 * Every method of the stores the family records, as a read, a write, or a store within: an interface that gains a
 * method fails to type until it is classified here, and the recorder records each call by this class.
 */
export const KEPT_METHODS = {
  session: "read",
  publish: "write",
  discard: "write",
  media: "store",
} as const satisfies Record<keyof KeptSessionStore, MethodClass>;
export const ROOM_METHODS = {
  ...KEPT_METHODS,
  read: "read",
  create: "write",
  values: "store",
  discardSession: "write",
} as const satisfies Record<keyof KeptRoomStore, MethodClass>;
export const PROVIDER_METHODS = {
  scope: "field",
  load: "read",
  write: "write",
  replace: "write",
  clear: "write",
} as const satisfies Record<keyof ScriptStorageProvider, MethodClass>;
export const REPOSITORY_METHODS = {
  get: "read",
  add: "write",
  delete: "write",
  listReferences: "read",
} as const satisfies Record<keyof CapturedMediaRepository, MethodClass>;
type MethodClass = "read" | "write" | "store" | "field";

/** How an operation's page moves on while it waits: another plan, the same plan prepared anew, a room change, closing. */
export const MOVES = ["otherPlan", "samePlan", "room", "disposed"] as const;
export type Move = (typeof MOVES)[number];

/**
 * Whether `move` makes `producer`'s operation on `route` stale. A keep belongs to its room and plan tenure, not to a
 * preparation: the same plan prepared anew keeps its save. A room change waits for a keep under way (the debug room's
 * drain), so a keep never meets one; a page in the debug room has no room to change to. The restore and the import own
 * their preparation, so every move retires them.
 */
export function stale(producer: Producer, move: Move, route?: Route): boolean | "unreachable" {
  if (move === "room" && (producer === "captureKeep" || route === "debug")) return "unreachable";
  // A keep belongs to its room and tenure; a reservation to the page's plan, which neither a re-prepare nor a room
  // change replaces.
  if (move === "samePlan") return producer !== "captureKeep" && producer !== "preparePlanText";
  if (move === "room") return producer !== "preparePlanText";
  return true;
}
