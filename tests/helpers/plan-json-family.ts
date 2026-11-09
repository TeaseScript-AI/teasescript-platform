import type { CapturedMediaRepository } from "../../player/media/captured-media.js";
import type { KeptRoomStore, KeptSessionStore } from "../../player/persistence/kept-sessions.js";
import type { ScriptStorageProvider } from "../../player/persistence/script-storage.js";
import { HOST_OPS } from "./host-ops.js";

/*
 * The plan JSON's lifetime family (`player/persistence/plan-json-lease.ts`), declared once for both of its witness layers: the
 * pure family (`player-plan-json-lease.test.ts`) and the composable's (`player-keep-producers.test.ts`). A producer is an
 * op of the host that reads or writes a plan's canonical JSON. Every op of the composed host is classified once, in
 * `host-ops.ts`; the producers' outcomes are declared here, and the coverage check compares both with the ops
 * themselves, so a new op fails until it is classified, and a producer until both layers drive it.
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
  // A session import's review compares the plans with the held plan's JSON, also where it then refuses the session; a
  // ticket let go of reads nothing.
  reviewTransfer: ["reviewed", "refused", "released"],
} as const;
export type Producer = keyof typeof PRODUCERS;

/** Every other op of the composed host, and why it touches no plan JSON a reader could keep (`HOST_OPS`). */
export const NOT_PRODUCERS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(HOST_OPS).flatMap(([op, { planJson }]) =>
    planJson === "producer" ? [] : [[op, planJson]],
  ),
);

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

/**
 * The persistence operations of the composable, each with its ownership: the callers of the plan JSON's producers but
 * those `UNOPERATED` names, and the saved-data import, which reads no plan JSON (L5h.2, #1933).
 */
export const OPERATED = ["restoreKept", "planText", "captureKeep", "savedDataImport"] as const;
export type Operated = (typeof OPERATED)[number];

/** Producers whose callers in the composable are no persistence operation, and why. */
export const UNOPERATED = {
  preparePlanText: "the page's own reservation, which the lease settles (`settlePlanJson`)",
  reviewTransfer:
    "a session import's review, before the player confirms it: it writes no store, and the dialog's ticket holds what it restored; the import that follows is `planText`'s",
} as const satisfies Partial<Record<Producer, string>>;

/**
 * What an operation's ownership holds on to besides its room and kept store (`persistenceOwnership` in the composable):
 * a preparation of its own, which every later preparation retires, or the page's plan tenure alone.
 */
const OWNERSHIPS = ["preparation", "tenure"] as const;
export type Ownership = (typeof OWNERSHIPS)[number];
/**
 * The ownerships each operation takes; the source check (`player-persistence-operations-source.test.ts`) reads them from
 * each ownership the composable makes, and the family drives each.
 */
export const OWNERSHIP_MODES = {
  restoreKept: ["preparation"],
  planText: ["preparation"],
  captureKeep: ["tenure"],
  // A preparation when the import replaces the shown script's saved data; else, in the debug room or for other scripts
  // alone, the page's tenure.
  savedDataImport: ["preparation", "tenure"],
} as const satisfies Record<Operated, readonly Ownership[]>;

/**
 * One way an operation runs, as the composable's family (`player-keep-producers.test.ts`) drives it: its producer, its
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
  readonly ownership: Ownership;
  readonly trace: readonly string[];
}

export const VARIANTS = {
  // A Continue of a session kept with a photo only it uses: the store's read, the host's restore, the photo.
  "restoreKept captured sessionPhoto": {
    producer: "restoreKept",
    route: "captured",
    ownership: "preparation",
    trace: ["host.preparePlanText", "kept.session", "host.restoreKept", "kept.media.get"],
  },
  // The same on a page whose saved values keep no captured media.
  "restoreKept plain sessionPhoto": {
    producer: "restoreKept",
    route: "plain",
    ownership: "preparation",
    trace: ["host.preparePlanText", "kept.session", "host.restoreKept", "kept.media.get"],
  },
  // The debug room's session, whose photos the room holds: no photo read.
  "restoreKept debug sessionPhoto": {
    producer: "restoreKept",
    route: "debug",
    ownership: "preparation",
    trace: ["host.preparePlanText", "rooms.session", "host.restoreKept"],
  },
  // An import of a session whose photo only it uses, into a browser of its own.
  "planText captured sessionPhoto": {
    producer: "planText",
    route: "captured",
    ownership: "preparation",
    trace: [
      "provider.replace",
      "kept.discard",
      "host.transferCommit",
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
    ownership: "preparation",
    trace: [
      "provider.replace",
      "kept.discard",
      "host.transferCommit",
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
    ownership: "preparation",
    trace: [
      "repository.add",
      "provider.replace",
      "kept.discard",
      "host.transferCommit",
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
    ownership: "preparation",
    trace: [
      "repository.add",
      "repository.add",
      "provider.replace",
      "kept.discard",
      "host.transferCommit",
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
    ownership: "preparation",
    trace: [
      "repository.add",
      "repository.get",
      "provider.replace",
      "kept.discard",
      "host.transferCommit",
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
    ownership: "preparation",
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
    ownership: "preparation",
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
    ownership: "preparation",
    trace: [
      "provider.replace",
      "kept.discard",
      "host.transferCommit",
      "kept.media.add",
      "provider.load",
      "kept.session",
    ],
  },
  // The host's plan JSON does not arrive: Start is offered.
  "planText captured planTextFails": {
    producer: "planText",
    route: "captured",
    ownership: "preparation",
    trace: [
      "provider.replace",
      "kept.discard",
      "host.transferCommit",
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
    ownership: "preparation",
    trace: [
      "provider.replace",
      "kept.discard",
      "host.transferCommit",
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
    ownership: "tenure",
    trace: ["host.captureKeep", "kept.discard", "kept.media.add", "kept.publish"],
  },
  // A later save: the photo, kept already, is confirmed.
  "captureKeep captured incremental": {
    producer: "captureKeep",
    route: "captured",
    ownership: "tenure",
    trace: ["host.captureKeep", "kept.media.add", "kept.media.get", "kept.publish"],
  },
  // A state this browser cannot write: the kept session is discarded.
  "captureKeep captured forget": {
    producer: "captureKeep",
    route: "captured",
    ownership: "tenure",
    trace: ["host.captureKeep", "kept.discard"],
  },
  // A first save in the debug room: its session discarded alone, the photo stored in the room.
  // Two photos only the session uses, promoted into the debug room one after the other.
  "captureKeep debug twoPhotos": {
    producer: "captureKeep",
    route: "debug",
    ownership: "tenure",
    trace: [
      "host.captureKeep",
      "rooms.discardSession",
      "rooms.media.add",
      "rooms.media.add",
      "rooms.publish",
    ],
  },
  "captureKeep debug first": {
    producer: "captureKeep",
    route: "debug",
    ownership: "tenure",
    trace: ["host.captureKeep", "rooms.discardSession", "rooms.media.add", "rooms.publish"],
  },
  // A saved-data import of the shown script, its photo stored before its values, then its final read.
  "savedDataImport captured shown": {
    producer: "savedDataImport",
    route: "captured",
    ownership: "preparation",
    trace: ["kept.discard", "repository.add", "provider.replace", "provider.load"],
  },
  // The shown script and another, whose writes this page does not own.
  "savedDataImport captured shownAndOther": {
    producer: "savedDataImport",
    route: "captured",
    ownership: "preparation",
    trace: ["kept.discard", "repository.add", "provider.replace", "kept.discard", "provider.load"],
  },
  // The shown script's own saved data imported while the debug room is shown.
  "savedDataImport debug ownScript": {
    producer: "savedDataImport",
    route: "debug",
    ownership: "tenure",
    trace: ["kept.discard", "repository.add", "provider.replace"],
  },
  // Another script alone, in the normal room: no preparation of the page's; its one call is that script's kept-session
  // discard, which this page does not own.
  "savedDataImport captured otherOnly": {
    producer: "savedDataImport",
    route: "captured",
    ownership: "tenure",
    trace: ["kept.discard"],
  },
  // A photo a Player without durable media cannot keep: nothing is written, Start is offered again.
  "savedDataImport plain photoNotStored": {
    producer: "savedDataImport",
    route: "plain",
    ownership: "preparation",
    trace: ["provider.load"],
  },
} as const satisfies Record<string, Variant>;
export type VariantName = keyof typeof VARIANTS;

/** A script of a saved-data import: the one the page shows, or another. */
export type ImportedScript = "shown" | "other";
type SavedDataVariant = {
  [K in VariantName]: (typeof VARIANTS)[K]["producer"] extends "savedDataImport" ? K : never;
}[VariantName];
/**
 * Each saved-data import's scripts: those its bundle holds, all chosen, and those whose saved data it writes when it runs
 * to its end, none included. Another script's are written also after the page moved on (`OTHER_SCRIPT_WRITES`).
 */
export const SAVED_DATA_SCRIPTS = {
  "savedDataImport captured shown": { imports: ["shown"], writes: ["shown"] },
  "savedDataImport captured shownAndOther": {
    imports: ["shown", "other"],
    writes: ["shown", "other"],
  },
  "savedDataImport debug ownScript": { imports: ["shown"], writes: ["shown"] },
  "savedDataImport captured otherOnly": { imports: ["other"], writes: ["other"] },
  "savedDataImport plain photoNotStored": { imports: ["shown"], writes: [] },
} as const satisfies Record<
  SavedDataVariant,
  { readonly imports: readonly ImportedScript[]; readonly writes: readonly ImportedScript[] }
>;

/**
 * Each operation's route and ownership no variant drives (`producer route ownership`, for each ownership of
 * `OWNERSHIP_MODES`), and why: a supported path cannot go undriven unless named here.
 */
export const UNDRIVEN_ROUTES = {
  "planText debug preparation": "the debug room refuses a session import",
  "captureKeep plain tenure":
    "a keep reaches no saved values: the route of the values does not change its calls, which `captured` drives",
  "savedDataImport debug preparation":
    "in the debug room an import replaces the script's own saved data, which the room does not use: it takes no preparation",
  "savedDataImport plain tenure":
    "other scripts alone: this page's route changes none of the calls, which `captured` drives",
} as const;

/**
 * Calls an operation makes without its ownership, by the scope they name, and why: a saved-data import writes another
 * script's saved data, which this page does not show, as the player confirmed. No move of this page retires them, and
 * they finish after it (L5h.2, orchestrator 2's decision (a)).
 */
export const OTHER_SCRIPT_WRITES = {
  "development-package:other":
    "another script's saved data and kept session, the player's confirmed writes for a script this page does not show",
} as const;

/** Calls these operations post without awaiting them, and why. */
export const POSTED = {
  "host.preparePlanText": "the lease's reservation (`settlePlanJson`)",
  "host.releasePlanText": "the lease's release of a replaced plan (`settlePlanJson`)",
  "host.release": "a stale restore's session, which nothing shows",
} as const;

/**
 * The store writes a move makes itself, in its own context: none but those of the session it starts (its keep, in the
 * room it plays in) and, for a room change, the debug room it makes. A write of a stale operation that went on in the
 * move's context shows as one the table does not name.
 */
export const MOVE_WRITES = {
  otherPlan: { still: [], starting: ["kept", "rooms"] },
  samePlan: { still: [], starting: ["kept", "rooms"] },
  room: { still: ["rooms.create"], starting: ["rooms"] },
  disposed: { still: [], starting: [] },
} as const satisfies Record<
  Move,
  { readonly still: readonly string[]; readonly starting: readonly string[] }
>;
/** The writes of a started session's keep, by the store it plays in. */
export const KEEP_WRITES = {
  kept: ["kept.discard", "kept.media.add", "kept.publish"],
  rooms: ["rooms.create", "rooms.discardSession", "rooms.media.add", "rooms.publish"],
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
const KEPT_METHODS = {
  session: "read",
  publish: "write",
  discard: "write",
  media: "store",
} as const satisfies Record<keyof KeptSessionStore, MethodClass>;
const ROOM_METHODS = {
  ...KEPT_METHODS,
  read: "read",
  create: "write",
  values: "store",
  discardSession: "write",
} as const satisfies Record<keyof KeptRoomStore, MethodClass>;
const PROVIDER_METHODS = {
  scope: "field",
  load: "read",
  write: "write",
  replace: "write",
  clear: "write",
} as const satisfies Record<keyof ScriptStorageProvider, MethodClass>;
const REPOSITORY_METHODS = {
  get: "read",
  add: "write",
  delete: "write",
  listReferences: "read",
} as const satisfies Record<keyof CapturedMediaRepository, MethodClass>;
type MethodClass = "read" | "write" | "store" | "field";

/**
 * Every surface the family records, with its methods' classes: the four stores the recorder installs, and each store
 * within one (a `store` method's result, recorded as `<surface>.<method>`). A surface not named here fails the run.
 */
export const SURFACES = {
  kept: KEPT_METHODS,
  "kept.media": REPOSITORY_METHODS,
  rooms: ROOM_METHODS,
  "rooms.media": REPOSITORY_METHODS,
  "rooms.values": PROVIDER_METHODS,
  provider: PROVIDER_METHODS,
  repository: REPOSITORY_METHODS,
} as const satisfies Record<string, Readonly<Record<string, MethodClass>>>;
/** The surfaces the recorder installs; every other one is a store within one of them. */
export const RECORDED_STORES = ["kept", "provider", "repository", "rooms"] as const;

/** How an operation's page moves on while it waits: another plan, the same plan prepared anew, a room change, closing. */
export const MOVES = ["otherPlan", "samePlan", "room", "disposed"] as const;
export type Move = (typeof MOVES)[number];

/**
 * Whether `move` makes `producer`'s operation stale, on `route` with `ownership` (by default the producer's own). Every
 * ownership belongs to its room and plan tenure; one with a preparation of its own also to that preparation, which the
 * same plan prepared anew retires. A room change waits for a keep under way (the debug room's drain), so a keep never
 * meets one; a page in the debug room has no room to change to. The reservation belongs to the page's plan, which
 * neither a re-prepare nor a room change replaces.
 */
export function stale(
  producer: Producer | Operated,
  move: Move,
  route?: Route,
  ownership: Ownership = producer === "captureKeep" ? "tenure" : "preparation",
): boolean | "unreachable" {
  if (move === "room" && (producer === "captureKeep" || route === "debug")) return "unreachable";
  if (producer === "preparePlanText") return move === "otherPlan" || move === "disposed";
  if (move === "samePlan") return ownership === "preparation";
  return true;
}
