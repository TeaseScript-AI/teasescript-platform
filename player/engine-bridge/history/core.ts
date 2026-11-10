import type { InterpreterEvent } from "../../../src/runtime/events.js";
import { CheckpointError } from "../../../src/runtime/snapshot/checkpoint-json.js";
import type { HistoryMarks } from "../../debug/debug-history-marks.js";
import type { PlayerForegroundPresentation } from "../../presentation/model.js";
import type { PlayerRuntimeSession } from "../../runtime/runtime-adapter.js";
import {
  activePlayerRuntimeInteraction,
  playerRuntimeForeground,
} from "../../runtime/runtime-view.js";
import { SnapshotStore, type DebugHistorySpill } from "./snapshots.js";

/*
 * Debug's rewind history in the engine's host (docs/DEBUGGER.md "Rewind"): one core per history, beside the held
 * sessions. It takes each point at its own publication, so a point's state and its position come from one value; it
 * owns the points, their snapshots and spill, the response links, the inspection and the parked and restored lineages.
 * The lineage it follows is the registry's (`Entry.bound`, `registry.ts`), which gives it to the close.
 * Its state changes only in `advance` (`advanceHistory`); each change returns the timeline's delta and the effects on
 * the lineages, which the op adapter applies. The main side receives the deltas and never captures a point.
 */

/**
 * A state Debug can restore: its snapshot under `id`, and the events that led to it, named by the event log of its
 * lineage and the fixed count of that log's events.
 */
export interface HistoryPosition {
  readonly id: number;
  readonly log: string;
  readonly eventCount: number;
  readonly sceneTimeMs: number;
  readonly marks: HistoryMarks;
}

/** How the session answered a point's interaction: its transcript row (`null` for a timed-out button) and its text. */
export interface HistoryResponse {
  readonly rowId: string | null;
  readonly text: string | null;
}

/** A rewind point: the state when an interaction was newly presented, under its stable ID. */
export interface HistoryPoint extends HistoryPosition {
  readonly actionId: number;
  readonly foreground: PlayerForegroundPresentation;
  readonly response: HistoryResponse | null;
}

/** While a restored state is shown: how many points lead to it, the state shown, and Forward's states. */
export interface HistoryInspection {
  readonly points: number;
  readonly shown: HistoryPosition;
  readonly future: HistoryPosition | null;
  readonly canForward: boolean;
  readonly adopting: boolean;
}

/** The whole timeline, as `historyRenew` and a resync send it. */
export interface HistoryTimeline {
  readonly history: number;
  readonly enrollment: number;
  readonly revision: number;
  readonly points: readonly HistoryPoint[];
  readonly inspection: HistoryInspection | null;
  readonly complete: boolean;
  readonly memoryChars: number;
  readonly spilledCount: number;
}

/** A change of the timeline from revision `from` to `to`; the main side applies it only at its own revision. */
export interface HistoryDelta {
  readonly history: number;
  readonly enrollment: number;
  readonly from: number;
  readonly to: number;
  readonly appended: readonly HistoryPoint[];
  readonly responses: readonly { readonly point: number; readonly response: HistoryResponse }[];
  /** How many points remain after a truncation (an adoption), or `null` when none were removed. */
  readonly retained: number | null;
  readonly inspection: HistoryInspection | null;
  readonly complete: boolean;
  readonly memoryChars: number;
  readonly spilledCount: number;
}

/** The inspection states a lineage transfer meets (`transferLineages`). */
export type InspectionState =
  "not inspecting" | "inspecting with a future" | "inspecting without a future" | "adopting";

/** What happens to the parked lineage, and to the one shown, in a transfer. */
export type ParkedFate = "parked" | "kept" | "live" | "released";
export type ShownFate = "target" | "future" | "adopting" | "live" | "inspecting" | "released";

/** What a transfer does: refused (changes no ownership), nothing to transfer, or the two lineages' fates. */
export type TransferCase =
  | { readonly kind: "refused" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "transfer"; readonly parked: ParkedFate; readonly shown: ShownFate };

/** The transitions that move lineages, each with its variant. */
export type LineageTransition =
  | { readonly transition: "back" }
  | { readonly transition: "forward" }
  | { readonly transition: "return" }
  | { readonly transition: "adopt begun" }
  | { readonly transition: "adopt ended"; readonly succeeded: boolean }
  | {
      readonly transition: "close";
      readonly by: CloseReason;
      readonly adoptionSucceeded?: boolean;
    };

export type CloseReason = "debugOff" | "replacement" | "import" | "clear" | "disposal";

const REFUSED = Object.freeze({ kind: "refused" } as const);
/** Why a first Back is refused when the history cannot keep the state it would leave. */
export const CANNOT_KEEP =
  "This state cannot be kept within Debug's rewind history, so Back cannot leave it now.";
const UNCHANGED = Object.freeze({ kind: "unchanged" } as const);
const fates = (parked: ParkedFate, shown: ShownFate): TransferCase =>
  Object.freeze({ kind: "transfer", parked, shown });

/**
 * The lineage transfers of Debug's rewind, decided in one place (docs/DEBUGGER.md "Rewind"):
 * Back parks the live lineage or keeps the one shown for Forward; Forward needs a future; Return reinstates the parked
 * lineage; an adoption makes the shown lineage live on success; Debug off reinstates the parked lineage, after an
 * adoption under way only when it failed; a replacement, an import and disposal retire everything; clear is refused
 * while a restored state is inspected. Any other combination, an unknown transition or close reason included, is
 * refused, which changes no ownership.
 */
export function transferLineages(
  move: LineageTransition,
  inspection: InspectionState,
): TransferCase {
  const inspecting =
    inspection === "inspecting with a future" || inspection === "inspecting without a future";
  switch (move.transition) {
    case "back":
      if (inspection === "not inspecting") return fates("parked", "target");
      return inspecting ? fates("kept", "target") : REFUSED;
    case "forward":
      return inspection === "inspecting with a future" ? fates("kept", "future") : REFUSED;
    case "return":
      return inspecting ? fates("live", "released") : REFUSED;
    case "adopt begun":
      return inspecting ? fates("kept", "adopting") : REFUSED;
    case "adopt ended":
      if (inspection !== "adopting") return REFUSED;
      return move.succeeded ? fates("released", "live") : fates("kept", "inspecting");
    case "close":
      switch (move.by) {
        case "disposal":
          return fates("released", "released");
        case "clear":
          return inspection === "not inspecting" ? UNCHANGED : REFUSED;
        case "replacement":
        case "import":
          return inspection === "not inspecting" ? UNCHANGED : fates("released", "released");
        case "debugOff":
          if (inspection === "not inspecting") return UNCHANGED;
          // An adoption under way decides by its outcome; with none known, nothing transfers.
          if (inspection === "adopting")
            return move.adoptionSucceeded === undefined
              ? REFUSED
              : move.adoptionSucceeded
                ? fates("released", "live")
                : fates("live", "released");
          return fates("live", "released");
        default:
          return REFUSED;
      }
    default:
      return REFUSED;
  }
}

/** A publication the core may take a point at: the session as published, its lineage's log, and its marks. */
export interface PublicationCandidate {
  readonly session: PlayerRuntimeSession;
  readonly log: string;
  readonly marks: HistoryMarks;
  /** The session's state as JSON; it throws `TSK004` when the state is too large to save. */
  readonly snapshotJson: () => string;
}

/** Whether a publication's interaction becomes a point, is skipped, or stops collection. */
export type AdmissionDecision =
  | { readonly kind: "admit"; readonly point: Omit<HistoryPoint, "id">; readonly json: string }
  | { readonly kind: "skip" }
  | { readonly kind: "stop"; readonly reason: string };

/**
 * The newest action ID among `points`, or -1 for none. A fold, not a spread into `Math.max`: a spread passes each point
 * as an argument, and past the engine's argument limit (125,237 points on Node 26) it throws.
 */
export function newestActionId(points: readonly Pick<HistoryPoint, "actionId">[]): number {
  return points.reduce((newest, point) => Math.max(newest, point.actionId), -1);
}

/**
 * The history's one admission and stop policy: a point is taken while the history collects and inspects nothing, for
 * a newly presented interaction (an action ID past the retained branch's newest) that has a foreground, from that same
 * publication's state. A state too large to save, or one the store cannot admit, stops collection; the points taken
 * stay.
 */
export function decideAdmission(
  core: {
    readonly collecting: boolean;
    readonly newestActionId: number;
    readonly fits: (units: number) => boolean;
  },
  candidate: PublicationCandidate,
): AdmissionDecision {
  if (!core.collecting) return { kind: "skip" };
  const interaction = activePlayerRuntimeInteraction(candidate.session.state);
  if (interaction === null || interaction.actionId <= core.newestActionId) return { kind: "skip" };
  const foreground = playerRuntimeForeground(candidate.session);
  if (foreground === null) return { kind: "skip" };
  let json: string;
  try {
    json = candidate.snapshotJson();
  } catch (error) {
    return {
      kind: "stop",
      reason:
        error instanceof CheckpointError && error.info.code === "TSK004"
          ? "a state too large to save (TSK004)"
          : `the state could not be saved: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!core.fits(json.length)) return { kind: "stop", reason: "the snapshot budget is full" };
  return {
    kind: "admit",
    json,
    point: {
      log: candidate.log,
      eventCount: candidate.session.events.length,
      sceneTimeMs: candidate.session.state.observedSessionTimeMs,
      marks: candidate.marks,
      actionId: interaction.actionId,
      foreground,
      response: null,
    },
  };
}

/** Everything that changes the history, decided in `advance`. */
export type HistoryObservation =
  | { readonly kind: "publication"; readonly candidate: PublicationCandidate }
  | {
      /**
       * A publication whose op's delivery failed, which changed the fields from `before` to the mutation count `after`
       * (`HistoryCore.undoPublication`).
       */
      readonly kind: "undoPublication";
      readonly before: PublicationRecord;
      readonly after: number;
    }
  | { readonly kind: "enrollCurrent"; readonly candidate: PublicationCandidate }
  | {
      /** A step's preparation: admitted with a step token and the marks its restored state carries, or refused. */
      readonly kind: "prepare";
      readonly move: "back" | "forward";
      /** Back's target point; Forward takes the last state Back left. */
      readonly point?: number;
      /**
       * The first Back's parked state, captured from the live lineage as it is now and reserved within the admission
       * bound: the lineage, its log and event count, its marks, and its JSON.
       */
      readonly parked?: {
        readonly lineage: string;
        readonly position: Omit<HistoryPosition, "id">;
        readonly json: string;
        /** The sequence of the last event the parked state follows, or -1. */
        readonly lastSequence: number;
      };
    }
  | {
      /** The page shows the prepared step's state: the transfer applies, with `candidate` the lineage it runs in. */
      readonly kind: "commit";
      readonly step: number;
      readonly candidate: string;
    }
  | {
      /** The page leaves the prepared step: its candidate, `null` before one was restored, and reservation go. */
      readonly kind: "drop";
      readonly step: number;
      readonly candidate: string | null;
    }
  | { readonly kind: "return" }
  | { readonly kind: "adoptBegun" }
  | { readonly kind: "adoptEnded"; readonly succeeded: boolean }
  | { readonly kind: "stopCollection"; readonly reason: string }
  | {
      readonly kind: "close";
      readonly by: CloseReason;
      readonly adoptionSucceeded?: boolean;
      /** A pending step's candidate lineage, which goes with its history. */
      readonly candidate?: string;
      /**
       * The lineage the history follows (the registry's `Entry.bound`), or `null`: not the one shown while inspecting,
       * and not `HistoryEffects.live`, the lineage a transition makes live. A disposal while nothing is inspected
       * releases it.
       */
      readonly bound: string | null;
    };

/** What the op adapter does after a change: the lineage to show, to make live, and those to release. */
export interface HistoryEffects {
  readonly show: string | null;
  readonly live: string | null;
  readonly release: readonly string[];
  /** The marks the shown or live state carries after a restore, Return or adoption, or `null` when unchanged. */
  readonly marks: HistoryMarks | null;
  /**
   * The lineage the connection's recording and the trace's epoch begin anew at: a committed restore's, or the parked
   * session's when Return or Debug off reinstates it; `null` for every other change, a successful adoption's included.
   */
  readonly recording: string | null;
}

/** The outcome of one observation: refused, or the delta and effects of the change (a `null` delta when none). */
export type HistoryOutcome =
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "advanced";
      readonly delta: HistoryDelta | null;
      readonly effects: HistoryEffects;
      /** A prepared step's token, which its commit or drop names. */
      readonly step?: number;
    };

const NO_EFFECTS: HistoryEffects = Object.freeze({
  show: null,
  live: null,
  release: [],
  marks: null,
  recording: null,
});

/** A refused observation's outcome. */
type Refusal = Extract<HistoryOutcome, { kind: "refused" }>;

/** What a kind's change does to the timeline, which `#delta` turns into the delta, and its effects. */
interface Change {
  readonly appended: readonly HistoryPoint[];
  readonly responses: readonly { readonly point: number; readonly response: HistoryResponse }[];
  /** How many points remain after a truncation, or `null`. */
  readonly retained: number | null;
  readonly effects: HistoryEffects;
}

const changeOf = (effects: HistoryEffects, retained: number | null = null): Change => ({
  appended: [],
  responses: [],
  retained,
  effects,
});

interface Inspecting {
  readonly parked: { readonly lineage: string; readonly marks: HistoryMarks };
  readonly parkedScanned: number;
  shown: HistoryPosition;
  shownLineage: string;
  points: number;
  /** The states Forward returns to, the last first; each is restored anew from its snapshot. */
  readonly forward: { readonly position: HistoryPosition; readonly points: number }[];
  adopting: boolean;
}

/**
 * A prepared step: its token and move, Back's target point with its index and the point count then, and the first
 * Back's reserved parked state (its snapshot under `id`).
 */
interface PendingStep {
  readonly step: number;
  readonly move: "back" | "forward";
  readonly point: HistoryPoint | null;
  readonly index: number;
  readonly points: number;
  readonly parked: {
    readonly id: number;
    readonly lineage: string;
    readonly position: Omit<HistoryPosition, "id">;
  } | null;
}

/** The fields a publication changes, as they were, and the core's mutation count then. */
export interface PublicationRecord {
  readonly points: readonly HistoryPoint[];
  readonly newestActionId: number;
  readonly scanned: number;
  readonly complete: boolean;
  readonly mutations: number;
}

/** One history: its identity, collection state, points, snapshots, inspection and lineages. */
export class HistoryCore {
  readonly #store: SnapshotStore;
  #points: readonly HistoryPoint[] = [];
  #nextId = 1;
  // Action IDs grow along one line; a restored state counts again from its own, so a watermark holds per branch.
  #newestActionId = -1;
  // The sequence of the last event whose answer was looked for.
  #scanned = -1;
  // Each position's last event sequence, from which an adoption links answers on.
  readonly #lastSequence = new Map<number, number>();
  #inspecting: Inspecting | null = null;
  #complete = true;
  #closed = false;
  // The step prepared and not yet committed or dropped, at most one; tokens are never taken again.
  #pending: PendingStep | null = null;
  #nextStep = 1;
  #revision = 0;
  // Raised by every observation the core takes, so a publication's undo can tell that nothing changed it since.
  #mutations = 0;

  constructor(
    readonly history: number,
    readonly enrollment: number,
    /** Opens the history's spill store, at its first point. */
    spill: () => Promise<DebugHistorySpill | null>,
    budget?: number,
    /** Called with the delta of a change that happened outside an observation: a spill write's failure. */
    readonly notify: (delta: HistoryDelta | null) => void = () => {},
  ) {
    this.#store = new SnapshotStore(spill, budget, () => {
      const outcome = advanceHistory(this, {
        kind: "stopCollection",
        reason: "a spill write failed",
      });
      this.notify(outcome.kind === "advanced" ? outcome.delta : null);
    });
  }

  get closed(): boolean {
    return this.#closed;
  }
  get revision(): number {
    return this.#revision;
  }

  /** The whole timeline now. */
  timeline(): HistoryTimeline {
    return Object.freeze({
      history: this.history,
      enrollment: this.enrollment,
      revision: this.#revision,
      points: this.#points,
      inspection: this.#inspectionView(),
      complete: this.#complete,
      memoryChars: this.#store.memoryChars,
      spilledCount: this.#store.spilledCount,
    });
  }

  /** The snapshot of the point or position `id`, from memory or the spill. */
  snapshot(id: number): Promise<string> {
    return this.#store.get(id);
  }

  /** The point with `id` among the points that lead to the state shown, or `null`. */
  pointBefore(id: number): HistoryPoint | null {
    const leading = this.#inspecting?.points ?? this.#points.length;
    const index = this.#points.findIndex((point) => point.id === id);
    return index === -1 || index >= leading || this.#points[index] === this.#inspecting?.shown
      ? null
      : this.#points[index]!;
  }

  /** The token of the step prepared and not yet committed or dropped, or `null`. */
  get pendingStep(): number | null {
    return this.#pending?.step ?? null;
  }

  /** The lineage of the restored state shown, or `null` while none is. */
  get shownLineage(): string | null {
    return this.#inspecting?.shownLineage ?? null;
  }

  /** The state Forward restores, or `null`. */
  get forwardTarget(): HistoryPosition | null {
    return this.#inspecting?.forward.at(-1)?.position ?? null;
  }

  /** The inspection state a transfer meets now. */
  get inspectionState(): InspectionState {
    const inspecting = this.#inspecting;
    if (inspecting === null) return "not inspecting";
    if (inspecting.adopting) return "adopting";
    return inspecting.forward.length > 0
      ? "inspecting with a future"
      : "inspecting without a future";
  }

  /** The fields a publication changes, as they are now, with the mutation count (`undoPublication`). */
  publicationRecord(): PublicationRecord {
    return Object.freeze({
      points: this.#points,
      newestActionId: this.#newestActionId,
      scanned: this.#scanned,
      complete: this.#complete,
      mutations: this.#mutations,
    });
  }

  /** Whether nothing changed the publication's fields since the mutation count `after`. */
  unchangedSince(after: number): boolean {
    return !this.#closed && this.#mutations === after;
  }

  /** The one path the core's state changes by: `#advance` gives each observation to its kind's method. */
  advance(observation: HistoryObservation): HistoryOutcome {
    if (this.#closed) return { kind: "refused", reason: "the history is closed" };
    const outcome = this.#advance(observation);
    // Every observation it takes may change the core, a step's preparation or commit as much as a publication.
    if (outcome.kind !== "refused") this.#mutations += 1;
    return outcome;
  }

  /** The mutation count now (`undoPublication`). */
  get mutations(): number {
    return this.#mutations;
  }

  #advance(observation: HistoryObservation): HistoryOutcome {
    const from = this.#revision;
    const wasComplete = this.#complete;
    // Six kinds return their change of the timeline, which `#delta` turns into the delta; the others decide their own
    // outcome.
    let change: Change | Refusal;
    switch (observation.kind) {
      case "undoPublication":
        return this.#undoPublication(observation);
      case "publication":
      case "enrollCurrent":
        change = this.#publish(observation.candidate);
        break;
      case "prepare":
        return this.#prepare(observation);
      case "commit":
        change = this.#commit(observation);
        break;
      case "drop":
        return this.#drop(observation);
      case "return":
        change = this.#return();
        break;
      case "adoptBegun":
        change = this.#adoptBegun();
        break;
      case "adoptEnded":
        change = this.#adoptEnded(observation);
        break;
      case "stopCollection":
        change = this.#stopCollection();
        break;
      case "close":
        return this.#close(observation);
      default:
        return this.#refuseUnknown(observation);
    }
    if ("kind" in change) return change;
    const inspectionChanged =
      observation.kind === "commit" ||
      observation.kind === "return" ||
      observation.kind === "adoptBegun" ||
      observation.kind === "adoptEnded";
    return this.#delta(from, wasComplete, inspectionChanged, change);
  }

  #undoPublication({
    before,
    after,
  }: Extract<HistoryObservation, { kind: "undoPublication" }>): HistoryOutcome {
    // The publication's fields restored as one unit, and the points it added forgotten with their snapshots, only
    // if nothing changed them since: one history core restoring its own state whole, guarded by its mutation
    // count. No precedent for an owned registry's entry, whose undo never restores (`delivery.ts`). Point IDs are
    // not taken again, and the delta already sent is not withdrawn: the page, which never received it, resyncs.
    if (!this.unchangedSince(after))
      return { kind: "refused", reason: "the history changed since that publication" };
    const kept = new Set(before.points.map((point) => point.id));
    const added = this.#points.filter((point) => !kept.has(point.id)).map((point) => point.id);
    this.#points = before.points;
    this.#newestActionId = before.newestActionId;
    this.#scanned = before.scanned;
    this.#complete = before.complete;
    this.#forget(added);
    return { kind: "advanced", delta: null, effects: NO_EFFECTS };
  }

  #publish(candidate: PublicationCandidate): Change {
    const appended: HistoryPoint[] = [];
    const responses: { point: number; response: HistoryResponse }[] = [];
    const change: Change = { appended, responses, retained: null, effects: NO_EFFECTS };
    if (this.#inspecting !== null) return change;
    this.#linkResponses(candidate.session.events, responses);
    const decision = decideAdmission(
      {
        collecting: this.#complete,
        newestActionId: this.#newestActionId,
        fits: (units) => this.#store.memoryChars + units <= this.#store.budget,
      },
      candidate,
    );
    if (decision.kind === "stop") this.#stop();
    if (decision.kind !== "admit") return change;
    const id = this.#nextId++;
    if (!this.#store.add(id, decision.json)) {
      this.#stop();
      return change;
    }
    const point: HistoryPoint = Object.freeze({ id, ...decision.point });
    const events = candidate.session.events;
    this.#lastSequence.set(id, events[events.length - 1]?.sequence ?? -1);
    this.#newestActionId = point.actionId;
    this.#points = [...this.#points, point];
    appended.push(point);
    return change;
  }

  #prepare(observation: Extract<HistoryObservation, { kind: "prepare" }>): HistoryOutcome {
    if (this.#pending !== null) return { kind: "refused", reason: "another step is pending" };
    const decided = transferLineages({ transition: observation.move }, this.inspectionState);
    if (decided.kind !== "transfer")
      return { kind: "refused", reason: `${observation.move} is refused now` };
    const inspecting = this.#inspecting;
    let point: HistoryPoint | null = null;
    let parked: PendingStep["parked"] = null;
    let marks: HistoryMarks;
    if (observation.move === "forward") {
      marks = restoredMarks(inspecting!.parked.marks, inspecting!.forward.at(-1)!.position);
    } else {
      point = observation.point === undefined ? null : this.pointBefore(observation.point);
      if (point === null)
        return { kind: "refused", reason: "Back needs a point before the state shown" };
      if (inspecting === null) {
        const given = observation.parked;
        if (given === undefined)
          return { kind: "refused", reason: "the first Back needs the parked state" };
        // The state Back leaves is reserved as any point is: within the admission bound, written through to the
        // spill, before anything restores.
        const id = this.#nextId;
        if (!this.#store.add(id, given.json)) return { kind: "refused", reason: CANNOT_KEEP };
        this.#nextId += 1;
        this.#lastSequence.set(id, given.lastSequence);
        parked = { id, lineage: given.lineage, position: given.position };
      }
      marks = restoredMarks(inspecting?.parked.marks ?? parked!.position.marks, point);
    }
    const step = this.#nextStep++;
    this.#pending = {
      step,
      move: observation.move,
      point,
      index: point === null ? -1 : this.#points.indexOf(point),
      points: this.#points.length,
      parked,
    };
    // Nothing shows, nothing is released and the timeline is as it was, until the page commits.
    return { kind: "advanced", delta: null, effects: { ...NO_EFFECTS, marks }, step };
  }

  #commit(observation: Extract<HistoryObservation, { kind: "commit" }>): Change | Refusal {
    const pending = this.#pending;
    if (pending === null || pending.step !== observation.step)
      return { kind: "refused", reason: "no such step is pending" };
    this.#pending = null;
    const restored = observation.candidate;
    const inspecting = this.#inspecting;
    if (pending.move === "forward") {
      const next = inspecting!.forward.pop()!;
      // The restored lineage shown until now goes: every state Forward or Back shows is restored anew.
      const left = inspecting!.shownLineage;
      inspecting!.shown = next.position;
      inspecting!.shownLineage = restored;
      inspecting!.points = next.points;
      return changeOf({
        show: restored,
        live: null,
        release: [left],
        marks: this.#restoredMarks(inspecting!, next.position),
        recording: restored,
      });
    }
    const point = pending.point!;
    if (inspecting === null) {
      const parked = pending.parked!;
      this.#inspecting = {
        parked: { lineage: parked.lineage, marks: parked.position.marks },
        parkedScanned: this.#scanned,
        shown: point,
        shownLineage: restored,
        points: pending.index + 1,
        forward: [
          {
            position: Object.freeze({ id: parked.id, ...parked.position }),
            points: pending.points,
          },
        ],
        adopting: false,
      };
    }
    // A later Back leaves the restored lineage shown until now, which goes.
    const left = inspecting === null ? [] : [inspecting.shownLineage];
    if (inspecting !== null) {
      inspecting.forward.push({ position: inspecting.shown, points: inspecting.points });
      inspecting.shown = point;
      inspecting.shownLineage = restored;
      inspecting.points = pending.index + 1;
    }
    return changeOf({
      show: restored,
      live: null,
      release: left,
      marks: this.#restoredMarks(this.#inspecting!, point),
      recording: restored,
    });
  }

  #drop(observation: Extract<HistoryObservation, { kind: "drop" }>): HistoryOutcome {
    const pending = this.#pending;
    // A consumed or foreign token drops nothing: a drop of a step already settled is harmless.
    if (pending === null || pending.step !== observation.step)
      return { kind: "advanced", delta: null, effects: NO_EFFECTS };
    this.#pending = null;
    if (pending.parked !== null) this.#forget([pending.parked.id]);
    return {
      kind: "advanced",
      delta: null,
      effects: {
        ...NO_EFFECTS,
        release: observation.candidate === null ? [] : [observation.candidate],
      },
    };
  }

  #return(): Change | Refusal {
    if (this.#pending !== null) return { kind: "refused", reason: "a step is pending" };
    const decided = transferLineages({ transition: "return" }, this.inspectionState);
    if (decided.kind !== "transfer")
      return { kind: "refused", reason: "Return needs a parked session" };
    const inspecting = this.#inspecting!;
    this.#inspecting = null;
    this.#scanned = inspecting.parkedScanned;
    this.#forget(this.#unkeptIds(inspecting, this.#points));
    return changeOf({
      show: null,
      live: inspecting.parked.lineage,
      release: [inspecting.shownLineage],
      marks: inspecting.parked.marks,
      recording: inspecting.parked.lineage,
    });
  }

  #adoptBegun(): Change | Refusal {
    if (this.#pending !== null) return { kind: "refused", reason: "a step is pending" };
    const decided = transferLineages({ transition: "adopt begun" }, this.inspectionState);
    if (decided.kind !== "transfer")
      return { kind: "refused", reason: "no restored state to adopt" };
    this.#inspecting!.adopting = true;
    return changeOf(NO_EFFECTS);
  }

  #adoptEnded(observation: Extract<HistoryObservation, { kind: "adoptEnded" }>): Change | Refusal {
    if (this.#pending !== null) return { kind: "refused", reason: "a step is pending" };
    const decided = transferLineages(
      { transition: "adopt ended", succeeded: observation.succeeded },
      this.inspectionState,
    );
    if (decided.kind !== "transfer") return { kind: "refused", reason: "no adoption under way" };
    const inspecting = this.#inspecting!;
    if (!observation.succeeded) {
      inspecting.adopting = false;
      return changeOf(NO_EFFECTS);
    }
    this.#inspecting = null;
    const kept = this.#points.slice(0, inspecting.points);
    this.#forget(this.#unkeptIds(inspecting, kept));
    const retained = kept.length !== this.#points.length ? kept.length : null;
    this.#points = kept;
    this.#newestActionId = newestActionId(kept);
    this.#scanned = this.#lastSequence.get(inspecting.shown.id) ?? -1;
    return changeOf(
      {
        show: null,
        live: inspecting.shownLineage,
        release: [inspecting.parked.lineage],
        marks: null,
        // An adoption keeps the recording: the adopted state's began at its commit.
        recording: null,
      },
      retained,
    );
  }

  #stopCollection(): Change {
    if (this.#complete) this.#stop();
    return changeOf(NO_EFFECTS);
  }

  #close(observation: Extract<HistoryObservation, { kind: "close" }>): HistoryOutcome {
    const decided = transferLineages(
      {
        transition: "close",
        by: observation.by,
        ...(observation.adoptionSucceeded === undefined
          ? {}
          : { adoptionSucceeded: observation.adoptionSucceeded }),
      },
      this.inspectionState,
    );
    if (decided.kind === "refused")
      return { kind: "refused", reason: `closing by ${observation.by} is refused now` };
    const inspecting = this.#inspecting;
    const release: string[] = [];
    let live: string | null = null;
    // A pending step goes with its history: its candidate is released, and its reservation with the store.
    if (this.#pending !== null && observation.candidate !== undefined)
      release.push(observation.candidate);
    this.#pending = null;
    if (inspecting !== null && decided.kind === "transfer") {
      if (decided.parked === "live") live = inspecting.parked.lineage;
      else release.push(inspecting.parked.lineage);
      if (decided.shown === "live") live = inspecting.shownLineage;
      else release.push(inspecting.shownLineage);
    } else if (
      decided.kind === "transfer" &&
      decided.parked === "released" &&
      observation.bound !== null
    )
      release.push(observation.bound);
    this.#closed = true;
    this.#inspecting = null;
    this.#points = [];
    void this.#store.destroy();
    this.#revision += 1;
    return {
      kind: "advanced",
      delta: null,
      effects: {
        show: null,
        live,
        release: [...new Set(release)],
        marks:
          live !== null && live === inspecting?.parked.lineage ? inspecting.parked.marks : null,
        // Only the parked session's reinstatement begins the recording anew; an adoption's success keeps it.
        recording: live !== null && live === inspecting?.parked.lineage ? live : null,
      },
    };
  }

  #refuseUnknown(observation: unknown): HistoryOutcome {
    // An observation outside the closed set: collection stops with the prefix kept, and it is refused with its
    // kind; the view sees the stop at its next delta's gap.
    // EVIDENCE: validation: every observation is a record with a kind; this one names no kind of the union.
    const { kind } = observation as { readonly kind: unknown };
    if (this.#complete) {
      this.#stop();
      this.#revision += 1;
    }
    return {
      kind: "refused",
      reason: `an unknown observation (${String(kind)}) stopped collection`,
    };
  }

  /** The delta of a change, from revision `from`, or `null` when the timeline is as it was. */
  #delta(
    from: number,
    wasComplete: boolean,
    inspectionChanged: boolean,
    { appended, responses, retained, effects }: Change,
  ): HistoryOutcome {
    if (
      appended.length === 0 &&
      responses.length === 0 &&
      retained === null &&
      !inspectionChanged &&
      this.#complete === wasComplete
    )
      return { kind: "advanced", delta: null, effects };
    this.#revision += 1;
    const delta: HistoryDelta = Object.freeze({
      history: this.history,
      enrollment: this.enrollment,
      from,
      to: this.#revision,
      appended,
      responses,
      retained,
      inspection: this.#inspectionView(),
      complete: this.#complete,
      memoryChars: this.#store.memoryChars,
      spilledCount: this.#store.spilledCount,
    });
    return { kind: "advanced", delta, effects };
  }

  #stop() {
    this.#complete = false;
  }

  #forget(ids: readonly number[]) {
    this.#store.delete(ids);
    for (const id of ids) this.#lastSequence.delete(id);
  }

  #inspectionView(): HistoryInspection | null {
    const inspecting = this.#inspecting;
    if (inspecting === null) return null;
    return Object.freeze({
      points: inspecting.points,
      shown: inspecting.shown,
      future: inspecting.forward.at(-1)?.position ?? null,
      canForward: inspecting.forward.length > 0,
      adopting: inspecting.adopting,
    });
  }

  #restoredMarks(inspecting: Inspecting, position: HistoryPosition): HistoryMarks {
    return restoredMarks(inspecting.parked.marks, position);
  }

  // The IDs of positions the history no longer needs once only `kept` points remain.
  #unkeptIds(inspecting: Inspecting, kept: readonly HistoryPoint[]): number[] {
    const keep = new Set(kept.map((point) => point.id));
    const ids = new Set([
      ...this.#points.map((point) => point.id),
      ...inspecting.forward.map((state) => state.position.id),
      inspecting.shown.id,
    ]);
    return [...ids].filter((id) => !keep.has(id));
  }

  // Records each newly settled interaction's answer on its retained point, by action ID, never by text.
  #linkResponses(
    events: readonly InterpreterEvent[],
    responses: { point: number; response: HistoryResponse }[],
  ) {
    let first = events.length;
    while (first > 0 && events[first - 1]!.sequence > this.#scanned) first -= 1;
    for (let index = first; index < events.length; index += 1) {
      const event = events[index]!;
      this.#scanned = event.sequence;
      if (event.kind !== "actionCompleted" || event.settlement.actionKind !== "interaction")
        continue;
      const { actionId, transcriptEventSequence, transcriptText } = event.settlement;
      let at = this.#points.length - 1;
      while (at >= 0 && this.#points[at]!.actionId !== actionId) at -= 1;
      if (at === -1) continue;
      const response = Object.freeze({
        rowId: transcriptEventSequence === null ? null : `runtime-event-${transcriptEventSequence}`,
        text: transcriptText,
      });
      const points = [...this.#points];
      points[at] = Object.freeze({ ...points[at]!, response });
      this.#points = points;
      responses.push({ point: points[at]!.id, response });
    }
  }
}

/**
 * The marks a restored state carries: its own storage-edit mark, and one more rewind of the session Back first left,
 * whose marks are `parked`.
 */
function restoredMarks(parked: HistoryMarks, position: HistoryPosition): HistoryMarks {
  return Object.freeze({
    editedWhileDebugging: position.marks.editedWhileDebugging,
    rewoundWhileDebugging: Object.freeze({
      restoredSceneTimeMs: position.sceneTimeMs,
      rewindCount: (parked.rewoundWhileDebugging?.rewindCount ?? 0) + 1,
    }),
  });
}

/** Every change of a history, decided by its core (`HistoryCore.advance`): the one path its state changes by. */
export function advanceHistory(core: HistoryCore, observation: HistoryObservation): HistoryOutcome {
  return core.advance(observation);
}
