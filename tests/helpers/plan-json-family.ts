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
  // The page reserves the plan's JSON; its task writes it, unless a release cancels it first.
  preparePlanText: ["materialized", "cancelled"],
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
 * Where each producer's operation awaits on the main side, so that its page may move on meanwhile: the composable's
 * family (`player-session-keep.test.ts`) holds each one and retires the operation there. A producer's operation is its
 * caller: a keep for `captureKeep`, the kept session's restore for `restoreKept`, a session import for `planText`.
 */
export const SUSPENSIONS = {
  // Its own task: a retirement before it cancels the reservation.
  preparePlanText: ["task"],
  // The kept store's read, and the host's reply.
  restoreKept: ["storeRead", "reply"],
  // The saved values' replacement, the kept store's discard, the host's reply, the publish, and the final reload.
  planText: ["storageReplace", "discard", "reply", "publish", "reload"],
  // The host's reply, the kept store's discard (a first save), and the publish.
  captureKeep: ["reply", "discard", "publish"],
} as const satisfies Record<Producer, readonly string[]>;
export type Suspension<P extends Producer> = (typeof SUSPENSIONS)[P][number];

/**
 * Awaits no case holds, and why. They are awaits of the same operations, which the held ones bound on either side.
 */
export const UNHELD_AWAITS = {
  storageRoute: "a promise the page resolves once at mount, before any operation of these cases",
  bridgeReady: "the connection, ready before any operation of these cases",
  media: "a photo's store write; these sessions use no photo, so their operations never await it",
  pendingKeep: "an import waits for a keep under way; the keep's own suspensions are held instead",
} as const;

/** How an operation's page moves on while it waits: another plan, the same plan prepared anew, a room change, closing. */
export const MOVES = ["otherPlan", "samePlan", "room", "disposed"] as const;
export type Move = (typeof MOVES)[number];

/**
 * Whether `move` makes `producer`'s operation stale. A keep belongs to its room and plan tenure, not to a preparation:
 * the same plan prepared anew keeps its save. A room change waits for a keep under way (the debug room's drain), so a
 * keep never meets one. The restore and the import own their preparation, so every move retires them.
 */
export function stale(producer: Producer, move: Move): boolean | "unreachable" {
  if (producer === "captureKeep" && move === "room") return "unreachable";
  // A keep belongs to its room and tenure; a reservation to the page's plan, which neither a re-prepare nor a room
  // change replaces.
  if (move === "samePlan") return producer !== "captureKeep" && producer !== "preparePlanText";
  if (move === "room") return producer !== "preparePlanText";
  return true;
}
