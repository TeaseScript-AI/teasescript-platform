import type { HistoryMarks } from "../../debug-history-marks.js";
import { DeliveryRefusedError, OwnedMap, type Delivery, type DeliveryOwner } from "../delivery.js";
import { playerRuntimeSnapshotJson, type PlayerRuntimeSession } from "../../runtime-adapter.js";
import {
  HistoryCore,
  advanceHistory,
  type CloseReason,
  type HistoryDelta,
  type HistoryObservation,
  type HistoryOutcome,
  type HistoryTimeline,
  type PublicationRecord,
} from "./core.js";
import type { DebugHistorySpill } from "./snapshots.js";

/*
 * The connection's rewind histories (one per live Player): which history is open, the lineage it follows, the host
 * sessions its lineage keys name, and the deltas a spill failure left for the next publication. The rewind ops and
 * `HeldSession.publish` reach a history only through here.
 *
 * What it keeps is owned by the deliveries that made it (`delivery.ts`):
 * - a history, from its open's posted reply until it closes (Debug off, a replacement, a retirement, the Player's
 *   disposal, or the connection's end); one whose open's reply is never posted closes again;
 * - a prepared candidate, from its preparation's posted reply until its step's commit, which makes it the history's
 *   shown state, its drop, or its history's close; one whose preparation's reply is never posted is dropped with the
 *   reservation it made;
 * - a publication's point and snapshot, until its history closes or an adoption truncates it; one whose publishing
 *   reply is never posted goes again (`HistoryCore.undoPublication`), and the deltas it would have carried wait for the
 *   next publication.
 */

/** A held session as the history sees it: its lineage key, and its marks now. */
export interface HistoryLineage {
  readonly historyKey: string;
  readonly marks: HistoryMarks;
}

export interface Entry {
  readonly core: HistoryCore;
  /** The lineage the history follows: its first publication's, then the one Return or an adoption makes live. */
  bound: string | null;
  /** The host session IDs of the lineages the history names. */
  readonly ids: Map<string, string>;
  /** Deltas made outside a publication (a spill failure), which the next publication of the bound lineage carries. */
  readonly pending: HistoryDelta[];
}

/** A prepared step's restored candidate: its token and lineage key, until its commit, drop or close. */
export interface Candidate {
  readonly step: number;
  readonly key: string;
}

/** What a change did to the host's sessions: the session shown, the one made live, and the sessions to release. */
export interface AppliedEffects {
  readonly show: string | null;
  readonly live: string | null;
  readonly released: readonly string[];
  /** The session the recording begins anew at (`HistoryEffects.recording`), or `null`. */
  readonly recording: string | null;
}

const NOTHING: AppliedEffects = Object.freeze({
  show: null,
  live: null,
  released: [],
  recording: null,
});

export class HistoryRegistry {
  /**
   * The open histories; one that leaves unclosed (its open's delivery undone) closes as it goes. Visible for the
   * connection's censuses; only this registry changes it.
   */
  readonly entries: OwnedMap<number, Entry>;
  /**
   * Each history's prepared candidate; one that leaves with its step still pending (undone) drops that step. Visible as
   * `entries` is.
   */
  readonly candidates: OwnedMap<number, Candidate>;
  readonly #delivery: DeliveryOwner;
  readonly #spill: () => Promise<DebugHistorySpill | null>;
  readonly #budget: number | undefined;
  #intent = 0;

  constructor(
    delivery: DeliveryOwner,
    /** Opens a new spill store for a history; `null` where the host has none. */
    spill: () => Promise<DebugHistorySpill | null> = () => Promise.resolve(null),
    budget?: number,
  ) {
    this.#delivery = delivery;
    this.#spill = spill;
    this.#budget = budget;
    this.entries = new OwnedMap(delivery, (entry) => {
      if (!entry.core.closed) advanceHistory(entry.core, { kind: "close", by: "disposal" });
    });
    this.candidates = new OwnedMap(delivery, (candidate, history) => {
      if (this.entries.get(history)?.core.pendingStep === candidate.step)
        this.advance(history, { kind: "drop", step: candidate.step, candidate: candidate.key });
    });
  }

  /**
   * Opens history `intent`, unless a newer one was opened already (`null`). An earlier history still open closes as
   * replaced; the host sessions it released are returned, for the caller to release.
   */
  open(
    intent: number,
  ): { readonly timeline: HistoryTimeline; readonly released: readonly string[] } | null {
    if (intent <= this.#intent) return null;
    this.#intent = intent;
    const released = this.closeAll("replacement");
    const pending: HistoryDelta[] = [];
    const core = new HistoryCore(intent, intent, this.#spill, this.#budget, (delta) => {
      if (delta !== null) pending.push(delta);
    });
    this.entries.set(intent, { core, bound: null, ids: new Map(), pending });
    return { timeline: core.timeline(), released };
  }

  /** The open history `history`, or `null`. */
  core(history: number): HistoryCore | null {
    return this.entries.get(history)?.core ?? null;
  }

  /** The lineage key the history follows, or `null` before its first publication. */
  bound(history: number): string | null {
    return this.entries.get(history)?.bound ?? null;
  }

  /**
   * Makes history `history` follow lineage `key`, the host session `id`, as an enrollment does (`#binds`); returns
   * whether it follows `key`.
   */
  follow(history: number, key: string, id: string): boolean {
    const entry = this.entries.get(history);
    if (entry === undefined || !this.#binds(entry, key)) return false;
    entry.ids.set(key, id);
    return true;
  }

  /**
   * The one binding decision, for an enrollment and a publication alike: a history that follows no lineage and
   * inspects nothing follows `key` from now on; one that follows a lineage follows only that one, until a transition
   * of its core makes another live. Returns whether the history follows `key`.
   */
  #binds(entry: Entry, key: string): boolean {
    if (entry.bound === null && entry.core.inspectionState === "not inspecting") entry.bound = key;
    return entry.bound === key;
  }

  /** Records that the host session `id` is the lineage `key` of history `history`. */
  name(history: number, key: string, id: string): void {
    this.entries.get(history)?.ids.set(key, id);
  }

  /** The host session ID of lineage `key` in history `history`, or `null`. */
  idOf(history: number, key: string): string | null {
    return this.entries.get(history)?.ids.get(key) ?? null;
  }

  /**
   * Takes a publication of `held` into each open history that follows its lineage (`#binds`); returns the deltas the publication carries, with any a spill failure left.
   */
  observePublication(held: HistoryLineage, next: PlayerRuntimeSession): readonly HistoryDelta[] {
    const deltas: HistoryDelta[] = [];
    // The op publishing it, whose delivery owns what the publication changes in each history.
    const delivery = this.#scope();
    for (const [history, entry] of this.entries) {
      const bound = entry.bound;
      const before = entry.core.publicationRecord();
      if (!this.#binds(entry, held.historyKey)) continue;
      // The deltas a spill failure left go with this publication; its reply's failure leaves them for the next one.
      const owed = entry.pending.splice(0);
      deltas.push(...owed);
      if (delivery !== null && owed.length > 0)
        this.#delivery.own(delivery, () => this.returnPending(history, entry, owed));
      const outcome = advanceHistory(entry.core, {
        kind: "publication",
        candidate: {
          session: next,
          log: held.historyKey,
          marks: held.marks,
          snapshotJson: () => playerRuntimeSnapshotJson(next),
        },
      });
      if (outcome.kind === "advanced" && outcome.delta !== null) deltas.push(outcome.delta);
      if (delivery !== null) this.#ownPublication(delivery, entry, bound, before);
    }
    return deltas;
  }

  /**
   * Puts back, ahead of any queued since, the deltas `owed` a publication of history `history` took and whose reply was
   * never posted, while `entry` is still that history: the page never received them. A history that closed or was
   * replaced since takes nothing back.
   */
  returnPending(history: number, entry: Entry, owed: readonly HistoryDelta[]): void {
    if (this.entries.get(history) === entry) entry.pending.unshift(...owed);
  }

  /** The innermost open delivery, or `null` for a publication no op makes. */
  #scope(): Delivery | null {
    try {
      return this.#delivery.scope();
    } catch (error) {
      if (error instanceof DeliveryRefusedError) return null;
      throw error;
    }
  }

  /**
   * Registers the undo of a publication's change to `entry` with `delivery`, which made it: a failed reply takes back
   * its point, its snapshot, its answer's link and the lineage binding, so Back never restores a state the page was
   * never shown. The core restores its own fields whole, only while nothing changed them since
   * (`HistoryCore.undoPublication`); no owned registry's entry is restored this way.
   */
  #ownPublication(
    delivery: Delivery,
    entry: Entry,
    bound: string | null,
    before: PublicationRecord,
  ): void {
    const after = entry.core.mutations;
    const boundAfter = entry.bound;
    if (after === before.mutations && boundAfter === bound) return;
    this.#delivery.own(delivery, () => {
      if (entry.bound !== boundAfter) return;
      const undone = advanceHistory(entry.core, { kind: "undoPublication", before, after });
      // The binding that publication made goes with it, the one rebinding outside `#binds` and `#applied`.
      if (undone.kind !== "refused") entry.bound = bound;
    });
  }

  /**
   * Observes `observation` in history `history`, binding a live lineage the change makes, and returns its outcome and
   * the host session IDs its effects name.
   */
  advance(
    history: number,
    observation: HistoryObservation,
  ): { readonly outcome: HistoryOutcome; readonly applied: AppliedEffects } {
    const entry = this.entries.get(history);
    if (entry === undefined)
      return { outcome: { kind: "refused", reason: "no such history" }, applied: NOTHING };
    // A close takes the pending step's candidate with it.
    const candidate = this.candidates.get(history);
    const observed =
      observation.kind === "close" && candidate !== undefined
        ? { ...observation, candidate: candidate.key }
        : observation;
    const outcome = advanceHistory(entry.core, observed);
    const applied = this.#applied(entry, outcome);
    if (entry.core.pendingStep === null) this.candidates.delete(history);
    if (entry.core.closed) this.entries.delete(history);
    return { outcome, applied };
  }

  /**
   * Records the candidate session `id`, lineage `key`, that step `step` of history `history` restored, owned by the
   * preparation's `delivery` until its reply is posted.
   */
  prepared(history: number, step: number, key: string, id: string, delivery: Delivery): void {
    const entry = this.entries.get(history);
    if (entry === undefined) return;
    this.candidates.set(history, { step, key }, delivery);
    entry.ids.set(key, id);
  }

  /** Commits step `step` of history `history`, whose candidate the page shows (`commit`). */
  commit(history: number, step: number) {
    const candidate = this.candidates.get(history);
    if (candidate?.step !== step)
      return {
        outcome: { kind: "refused", reason: "no such step is prepared" } as const,
        applied: NOTHING,
      };
    return this.advance(history, { kind: "commit", step, candidate: candidate.key });
  }

  /** Drops step `step` of history `history`, with its candidate when it has one (`drop`). */
  drop(history: number, step: number) {
    const candidate = this.candidates.get(history);
    return this.advance(history, {
      kind: "drop",
      step,
      candidate: candidate?.step === step ? candidate.key : null,
    });
  }

  /** The sessions an outcome's effects name, by host session ID; the live one becomes the history's lineage. */
  #applied(entry: Entry, outcome: HistoryOutcome): AppliedEffects {
    if (outcome.kind !== "advanced") return NOTHING;
    const { effects } = outcome;
    if (effects.live !== null) entry.bound = effects.live;
    const released = effects.release
      .map((key) => entry.ids.get(key))
      .filter((id): id is string => id !== undefined);
    for (const key of effects.release) entry.ids.delete(key);
    const idOf = (key: string | null) => (key === null ? null : (entry.ids.get(key) ?? null));
    return {
      show: idOf(effects.show),
      live: idOf(effects.live),
      released,
      recording: idOf(effects.recording),
    };
  }

  /** Closes every history, as the connection ends; returns the host sessions to release. */
  closeAll(by: CloseReason): readonly string[] {
    const released: string[] = [];
    // A Map visits its entries in order also while its loop deletes them, which `advance` does as each closes.
    for (const history of this.entries.keys()) {
      const { applied } = this.advance(history, { kind: "close", by });
      released.push(...applied.released);
    }
    return released;
  }
}
