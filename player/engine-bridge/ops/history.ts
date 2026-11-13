import type { RuntimeScriptStorageEntrySnapshot } from "../../../src/index.js";
import type { InterpreterEvent } from "../../../src/runtime/events.js";
import type { HistoryMarks } from "../../debug/debug-history-marks.js";
import {
  playerRuntimeSnapshot,
  playerRuntimeSnapshotJson,
  restorePlayerRuntimeSessionAt,
} from "../../runtime/runtime-adapter.js";
import type { Delivery } from "../delivery.js";
import { exactly, isEventLog, isRecord } from "../argument-checks.js";
import type {
  HistoryDelta,
  HistoryOutcome,
  HistoryPosition,
  HistoryTimeline,
} from "../history/core.js";
import type { PlayerOpsContext } from "../player-ops.js";
import type { Introduction } from "../session-protocol.js";
import type { BridgeOp, BridgeOps, HostSessions, OpOutcome } from "../worker-host.js";
import { heldSession } from "./persistence.js";
import { HeldSession, beginRecordingAt, introduction } from "./session.js";

/** What a rewind adoption replaces the saved values with: the shown state's script storage, at its revision. */
export interface StorageCapture {
  readonly revision: number;
  readonly entries: readonly RuntimeScriptStorageEntrySnapshot[];
  /** Whether the state's saved values are persistent: only then does an adoption write them. */
  readonly persistent: boolean;
}

/**
 * The result of a rewind or history op: the delta of the history's timeline, a step prepared for the page to commit
 * or drop (with its candidate session's introduction), or why it was refused.
 */
export type HistoryOpResult =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "prepared"; readonly history: number; readonly step: number }
  | {
      readonly kind: "done";
      readonly delta: HistoryDelta | null;
      /** The host session made live (Return, an adoption, Debug off's reinstatement), or `null`. */
      readonly live: string | null;
      /** The host sessions the change released. */
      readonly released: readonly string[];
    };

/**
 * What `historyRenew` replies: the new history's whole timeline, after its enrollment; that its owner or its intent is
 * no longer current (`stale`); that a close failed, now or earlier for this Player (`closeFailed`: nothing opened); or
 * why it did not open after its closes (`refused`). Each but `stale` names the host sessions its closes released.
 */
export type HistoryRenewed =
  | { readonly kind: "stale" }
  | {
      readonly kind: "renewed";
      readonly timeline: HistoryTimeline;
      readonly released: readonly string[];
    }
  | {
      readonly kind: "closeFailed" | "refused";
      readonly reason: string;
      readonly released: readonly string[];
    };

const CLOSE_REASONS: readonly string[] = ["debugOff", "replacement", "import", "clear", "disposal"];
const OBLIGATION_REASONS: readonly string[] = ["debugOff", "import", "clear"];
const isSerial = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isOwner = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/*
 * A close a renewal carries: a retirement's, or Debug off's after an adoption that succeeded. Neither reinstates the
 * parked session, so no carried close begins the recording anew; that stays with the gated controls (`restartAt`).
 */
const isObligation = (value: unknown): value is HistoryCloseObligation =>
  isRecord(value) &&
  exactly(value, ["history", "by"], ["adoptionSucceeded"]) &&
  isSerial(value.history) &&
  typeof value.by === "string" &&
  OBLIGATION_REASONS.includes(value.by) &&
  (value.by === "debugOff"
    ? value.adoptionSucceeded === true
    : value.adoptionSucceeded === undefined);

/** A close a renewal carries: the history, why it closes, and the outcome of an adoption Debug off waited for. */
export interface HistoryCloseObligation {
  readonly history: number;
  readonly by: "debugOff" | "import" | "clear";
  readonly adoptionSucceeded?: boolean | undefined;
}

/**
 * What `historyClose`'s check admits: the history, why it closes, an adoption's outcome, and the Player claim generation
 * that sends it (`PlayerBridge.claim`). A close by `disposal` closes every history of the connection.
 */
export interface HistoryCloseArguments {
  readonly history: number;
  readonly by: "debugOff" | "replacement" | "import" | "clear" | "disposal";
  readonly adoptionSucceeded?: boolean | undefined;
  readonly owner: number;
}

/**
 * What `historyRenew`'s check admits: the new history's intent, the Player claim generation that sends it, the session
 * it enrolls (or none), and the closes it carries.
 */
export interface HistoryRenewArguments {
  readonly intent: number;
  readonly owner: number;
  readonly session: string | null;
  readonly closes: readonly HistoryCloseObligation[];
}

/** What `rewindBack`'s check admits: the history, its point, the live session, and the point's events. */
export interface RewindBackArguments {
  readonly history: number;
  readonly point: number;
  readonly live: string;
  readonly events: readonly InterpreterEvent[];
}

/** What `rewindAdopt`'s check admits: an adoption begun, or ended as it succeeded or failed. */
type RewindAdoptArguments = { readonly history: number } & (
  | { readonly phase: "begin"; readonly succeeded?: undefined }
  | { readonly phase: "end"; readonly succeeded: boolean }
);

function releaseAll(sessions: HostSessions, ids: readonly string[]): void {
  for (const id of ids) sessions.delete(id);
}

function done(
  outcome: HistoryOutcome,
  applied: { readonly live: string | null; readonly released: readonly string[] },
): HistoryOpResult {
  return outcome.kind === "refused"
    ? outcome
    : { kind: "done", delta: outcome.delta, live: applied.live, released: applied.released };
}

const refused = (reason: string): { readonly result: HistoryOpResult } => ({
  result: { kind: "refused", reason },
});

/**
 * Restores `position`'s state (`json`) of `planToken`'s plan in a new held session, a step's candidate. It runs from
 * the position's events (`events`, the main side's log up to its boundary, each event validated by `isEventLog`) with
 * `marks`, and with no recorder or trace reset: the connection's recording begins there only at the step's commit.
 */
function restored(
  context: PlayerOpsContext,
  sessions: HostSessions,
  planToken: string,
  json: string,
  events: readonly InterpreterEvent[],
  marks: HistoryMarks,
  delivery: Delivery,
): { readonly held: HeldSession; readonly id: string } {
  const plan = context.plans.get(planToken);
  if (plan === undefined) throw new Error(`No plan '${planToken}' is held.`);
  const session = restorePlayerRuntimeSessionAt(plan, json, events, null, null);
  const held = new HeldSession(session, planToken, context, marks);
  return { held, id: sessions.add(held, delivery) };
}

/** A step's reply: its result, and the restored session's introduction when it made one. */
function stepped(
  result: HistoryOpResult,
  made?: { readonly id: string; readonly view: Introduction },
): OpOutcome<HistoryOpResult> {
  return made === undefined || result.kind === "refused"
    ? { result }
    : { result, session: made.id, eventsThrough: made.view.eventsThrough, view: made.view };
}

/**
 * Begins the connection's recording and the trace's epoch anew where the deciding function says
 * (`HistoryEffects.recording`): a committed restore, or the parked session reinstated. Nothing else restarts them.
 */
function restartAt(
  context: PlayerOpsContext,
  sessions: HostSessions,
  applied: { readonly recording: string | null },
): void {
  if (applied.recording === null) return;
  beginRecordingAt(heldSession(sessions, applied.recording), context);
  context.trace?.reset("restore");
}

/**
 * Debug's rewind in the host (docs/DEBUGGER.md "Rewind"): the history's control and steps, each through its core
 * (`advanceHistory`), and the session-free reads of a held session that rewind and adoption take.
 */
export function historyOps(context: PlayerOpsContext) {
  return {
    ...historyControlOps(context),
    ...rewindStepOps(context),
    ...rewindSettleOps(context),
  } satisfies BridgeOps;
}

/** The history's control (open, enroll, close) and its session-free reads (the timeline, a state's saved values). */
function historyControlOps(context: PlayerOpsContext) {
  const { history } = context;
  return {
    // The session's saved values as its state holds them, for an adoption.
    captureStorage: {
      session: "none",
      checkArguments: (args): args is { readonly session: string } =>
        isRecord(args) && exactly(args, ["session"]) && typeof args.session === "string",
      run: (args, sessions) => {
        const held = heldSession(sessions, args.session);
        const current = held.sessionForOperation();
        const snapshot = playerRuntimeSnapshot(current);
        const result: StorageCapture = {
          revision: current.revision,
          entries: snapshot.scriptStorage,
          persistent: snapshot.scriptStoragePersistent,
        };
        return { result };
      },
    } satisfies BridgeOp<{ readonly session: string }, StorageCapture, "none">,
    /*
     * Renews the Player's rewind history in one delivery: the closes it carries, with their reasons, then every older
     * history as replaced, then the new history, which enrolls `session` as it is now, when one is given. Nothing opens
     * for an older owner or intent (`stale`), or after a failed close of this Player, now or earlier (`closeFailed`); and
     * nothing has an effect before those checks. The closes are releases, never undone; the new history is its
     * delivery's (`HistoryRegistry.entries`), so one whose reply is never posted closes again.
     */
    historyRenew: {
      session: "none",
      checkArguments: (args): args is HistoryRenewArguments =>
        isRecord(args) &&
        exactly(args, ["intent", "owner", "session", "closes"]) &&
        isSerial(args.intent) &&
        isOwner(args.owner) &&
        (args.session === null || typeof args.session === "string") &&
        Array.isArray(args.closes) &&
        args.closes.every(isObligation),
      run: (args, sessions) => {
        const { intent, owner, session, closes } = args;
        const renewed = (result: HistoryRenewed) => ({ result });
        if (!history.admits(owner) || !history.fresh(intent)) return renewed({ kind: "stale" });
        const released: string[] = [];
        if (history.refusesOpen())
          return renewed({
            kind: "closeFailed",
            reason: "an earlier close of the rewind history failed",
            released,
          });
        const holds = () => session === null || sessions.get(session) instanceof HeldSession;
        if (!holds())
          return renewed({
            kind: "refused",
            reason: "the session to enroll is not held",
            released,
          });
        const closing: readonly {
          readonly history: number;
          readonly by: HistoryCloseArguments["by"];
          readonly adoptionSucceeded?: boolean | undefined;
        }[] = [
          ...closes,
          ...[...history.entries.keys()]
            .filter((id) => !closes.some((each) => each.history === id))
            .map((id) => ({ history: id, by: "replacement" as const })),
        ];
        for (const { history: id, by, adoptionSucceeded } of closing) {
          let closed;
          try {
            closed = history.close(owner, id, {
              kind: "close",
              by,
              ...(adoptionSucceeded === undefined ? {} : { adoptionSucceeded }),
            });
          } catch (error) {
            // A close that threw failed: nothing opens, now or later for this Player.
            history.failClose(owner);
            const reason = error instanceof Error ? error.message : String(error);
            return renewed({
              kind: "closeFailed",
              reason: `history ${id} could not close: ${reason}`,
              released,
            });
          }
          const { outcome, applied } = closed;
          if (outcome.kind === "refused")
            return renewed({
              kind: "closeFailed",
              reason: `history ${id} could not close: ${outcome.reason}`,
              released,
            });
          // EVIDENCE: invariant: no close a renewal admits reinstates the parked session (`isObligation`).
          if (applied.recording !== null)
            throw new Error("A renewal's close reinstated a session.");
          releaseAll(sessions, applied.released);
          released.push(...applied.released);
        }
        if (!holds())
          return renewed({
            kind: "refused",
            reason: "a close released the session to enroll",
            released,
          });
        const opened = history.open(intent);
        // EVIDENCE: invariant: `fresh` admitted `intent`, and every earlier history closed above.
        if (opened === null || opened.released.length > 0)
          throw new Error("The rewind history could not open after its closes.");
        if (session !== null) {
          const held = heldSession(sessions, session);
          if (!history.follow(intent, held.historyKey, session))
            throw new Error("The new rewind history could not follow its session.");
          const current = held.sessionForOperation();
          history.advance(intent, {
            kind: "enrollCurrent",
            candidate: {
              session: current,
              log: held.historyKey,
              marks: held.marks,
              snapshotJson: () => playerRuntimeSnapshotJson(current),
            },
          });
        }
        return renewed({ kind: "renewed", timeline: history.core(intent)!.timeline(), released });
      },
    } satisfies BridgeOp<HistoryRenewArguments, HistoryRenewed, "none">,
    // Closes the history: Debug off reinstates a parked session; a replacement, an import and disposal retire them.
    historyClose: {
      session: "none",
      checkArguments: (args): args is HistoryCloseArguments =>
        isRecord(args) &&
        exactly(args, ["history", "by", "owner"], ["adoptionSucceeded"]) &&
        isSerial(args.history) &&
        typeof args.by === "string" &&
        CLOSE_REASONS.includes(args.by) &&
        (args.adoptionSucceeded === undefined || typeof args.adoptionSucceeded === "boolean") &&
        isOwner(args.owner),
      run: (args, sessions) => {
        const { history: id, by, adoptionSucceeded, owner } = args;
        // An older or a disposed Player's late close changes nothing; its history closed with its disposal.
        if (!history.admits(owner)) return refused("the Player that sent the close is gone");
        // The Player's disposal: every history goes, an unacknowledged one's included, and its admission ends.
        if (by === "disposal") {
          const released = history.dispose(owner);
          releaseAll(sessions, released);
          return { result: { kind: "done", delta: null, live: null, released } };
        }
        history.closeUnlessDelivered(owner);
        const { outcome, applied } = history.close(owner, id, {
          kind: "close",
          by,
          ...(adoptionSucceeded === undefined ? {} : { adoptionSucceeded }),
        });
        if (outcome.kind === "refused") return { result: outcome };
        releaseAll(sessions, applied.released);
        restartAt(context, sessions, applied);
        return { result: done(outcome, applied) };
      },
    } satisfies BridgeOp<HistoryCloseArguments, HistoryOpResult, "none">,
    // The history's whole timeline, for a main side whose deltas did not continue its revision.
    historyTimeline: {
      session: "none",
      checkArguments: (args): args is { readonly history: number } =>
        isRecord(args) && exactly(args, ["history"]) && isSerial(args.history),
      run: (args) => {
        const { history: id } = args;
        const core = history.core(id);
        return { result: core === null ? null : core.timeline() };
      },
    } satisfies BridgeOp<{ readonly history: number }, HistoryTimeline | null, "none">,
  } satisfies BridgeOps;
}

/** A rewind step prepared and read: Back and Forward, through `prepareAt`. */
function rewindStepOps(context: PlayerOpsContext) {
  const { history } = context;
  /**
   * The rest of a prepared step to `position`: reads its snapshot and restores the candidate, with the marks the
   * preparation gave it. A read that fails, or a step abandoned while it read, keeps nothing: the step is dropped, and
   * the history, the shown session and the recording stay as they were.
   */
  const prepareAt = async (
    sessions: HostSessions,
    id: number,
    prepared: HistoryOutcome,
    position: HistoryPosition,
    events: readonly InterpreterEvent[],
    planToken: string,
  ): Promise<OpOutcome<HistoryOpResult>> => {
    if (prepared.kind === "refused") return { result: prepared };
    const step = prepared.step!;
    // The step's own delivery, taken before anything awaits: the candidate is that delivery's until its reply is
    // posted.
    const delivery = context.delivery.scope();
    let made: { readonly held: HeldSession; readonly id: string };
    try {
      const json = await history.core(id)!.snapshot(position.id);
      made = restored(
        context,
        sessions,
        planToken,
        json,
        events,
        prepared.effects.marks!,
        delivery,
      );
    } catch (error) {
      history.drop(id, step);
      throw error;
    }
    if (history.core(id)?.pendingStep !== step) {
      sessions.delete(made.id);
      return refused("the step was abandoned while it read");
    }
    history.prepared(id, step, made.held.historyKey, made.id, delivery);
    return stepped(
      { kind: "prepared", history: id, step },
      { id: made.id, view: introduction(made.held, context, false) },
    );
  };
  return {
    // Back to `point`, restored from its snapshot; the first Back parks the live session for Return.
    rewindBack: {
      session: "none",
      checkArguments: (args): args is RewindBackArguments =>
        isRecord(args) &&
        exactly(args, ["history", "point", "live", "events"]) &&
        isSerial(args.history) &&
        isSerial(args.point) &&
        typeof args.live === "string" &&
        isEventLog(args.events),
      run: async (args, sessions) => {
        const { history: id, point: pointId, live: liveId, events } = args;
        const core = history.core(id);
        if (core === null) return refused("no such history");
        const point = core.pointBefore(pointId);
        if (point === null) return refused("Back needs a point before the state shown");
        if (events.length !== point.eventCount) return refused("the events are not the point's");
        const first = core.inspectionState === "not inspecting";
        // The first Back leaves the history's live session; a later one names the parked session or the restored one
        // shown. Either way the plan is the parked session's, whose states the history holds.
        const bound = history.bound(id);
        const live = first ? heldSession(sessions, liveId) : null;
        const named = [bound, core.shownLineage].map((key) => history.idOf(id, key ?? ""));
        if (first ? live!.historyKey !== bound : !named.includes(liveId))
          return refused("the session is not the history's");
        const owner = live ?? heldSession(sessions, named[0]!);
        // The live state Back parks, read before the restore begins the connection's recording anew (a session whose
        // engine call threw rebuilds from that recording) and before anything awaits: the publication the Player shows,
        // made ready as for any op on it.
        const current = owner.sessionForOperation();
        const parked = first
          ? {
              lineage: owner.historyKey,
              position: {
                log: owner.historyKey,
                eventCount: owner.delivered,
                sceneTimeMs: current.state.observedSessionTimeMs,
                marks: owner.marks,
              },
              json: playerRuntimeSnapshotJson(current),
              lastSequence: current.events[owner.delivered - 1]?.sequence ?? -1,
            }
          : null;
        // The preparation reserves the state Back leaves within the admission bound, before anything restores.
        const { outcome } = history.advance(id, {
          kind: "prepare",
          move: "back",
          point: point.id,
          ...(parked === null ? {} : { parked }),
        });
        if (outcome.kind !== "refused" && first) history.name(id, owner.historyKey, liveId);
        return prepareAt(sessions, id, outcome, point, events, owner.planToken);
      },
    } satisfies BridgeOp<RewindBackArguments, HistoryOpResult, "none">,
    // Forward to the state the last Back left, restored from its snapshot.
    rewindForward: {
      session: "none",
      checkArguments: (
        args,
      ): args is { readonly history: number; readonly events: readonly InterpreterEvent[] } =>
        isRecord(args) &&
        exactly(args, ["history", "events"]) &&
        isSerial(args.history) &&
        isEventLog(args.events),
      run: async (args, sessions) => {
        const { history: id, events } = args;
        const core = history.core(id);
        const target = core?.forwardTarget ?? null;
        if (core === null || target === null) return refused("Forward needs a state Back left");
        if (events.length !== target.eventCount) return refused("the events are not the state's");
        const parkedId = history.idOf(id, history.bound(id) ?? "");
        if (parkedId === null) return refused("the parked session is gone");
        const parked = heldSession(sessions, parkedId);
        const { outcome } = history.advance(id, { kind: "prepare", move: "forward" });
        return prepareAt(sessions, id, outcome, target, events, parked.planToken);
      },
    } satisfies BridgeOp<
      { readonly history: number; readonly events: readonly InterpreterEvent[] },
      HistoryOpResult,
      "none"
    >,
  } satisfies BridgeOps;
}

/** A prepared step settled: committed, dropped, returned from, or adopted. */
function rewindSettleOps(context: PlayerOpsContext) {
  const { history } = context;
  return {
    // The page shows the prepared step's candidate: the transfer applies, and the recording begins there.
    rewindCommit: {
      session: "none",
      checkArguments: (args): args is { readonly history: number; readonly step: number } =>
        isRecord(args) &&
        exactly(args, ["history", "step"]) &&
        isSerial(args.history) &&
        isSerial(args.step),
      run: (args, sessions) => {
        const { history: id, step } = args;
        const { outcome, applied } = history.commit(id, step);
        if (outcome.kind === "refused") return { result: outcome };
        releaseAll(sessions, applied.released);
        restartAt(context, sessions, applied);
        return { result: done(outcome, applied) };
      },
    } satisfies BridgeOp<
      { readonly history: number; readonly step: number },
      HistoryOpResult,
      "none"
    >,
    // The page leaves the prepared step: only its candidate and reservation go; a repeated drop is harmless.
    rewindDrop: {
      session: "none",
      checkArguments: (args): args is { readonly history: number; readonly step: number } =>
        isRecord(args) &&
        exactly(args, ["history", "step"]) &&
        isSerial(args.history) &&
        isSerial(args.step),
      run: (args, sessions) => {
        const { history: id, step } = args;
        const { outcome, applied } = history.drop(id, step);
        if (outcome.kind === "advanced") releaseAll(sessions, applied.released);
        return { result: done(outcome, applied) };
      },
    } satisfies BridgeOp<
      { readonly history: number; readonly step: number },
      HistoryOpResult,
      "none"
    >,
    // Return to the parked session, as it was when Back first left it; the restored states go.
    rewindReturn: {
      session: "none",
      checkArguments: (args): args is { readonly history: number } =>
        isRecord(args) && exactly(args, ["history"]) && isSerial(args.history),
      run: (args, sessions) => {
        const { history: id } = args;
        const { outcome, applied } = history.advance(id, { kind: "return" });
        if (outcome.kind === "refused") return { result: outcome };
        releaseAll(sessions, applied.released);
        restartAt(context, sessions, applied);
        return { result: done(outcome, applied) };
      },
    } satisfies BridgeOp<{ readonly history: number }, HistoryOpResult, "none">,
    // An adoption of the inspected state: begun, then ended as it succeeded or failed.
    rewindAdopt: {
      session: "none",
      checkArguments: (args): args is RewindAdoptArguments =>
        isRecord(args) &&
        exactly(args, ["history", "phase"], ["succeeded"]) &&
        isSerial(args.history) &&
        (args.phase === "begin"
          ? args.succeeded === undefined
          : args.phase === "end" && typeof args.succeeded === "boolean"),
      run: (args, sessions) => {
        const { history: id, phase, succeeded } = args;
        const { outcome, applied } = history.advance(
          id,
          phase === "begin"
            ? { kind: "adoptBegun" }
            : { kind: "adoptEnded", succeeded: succeeded! },
        );
        if (outcome.kind === "advanced") releaseAll(sessions, applied.released);
        return { result: done(outcome, applied) };
      },
    } satisfies BridgeOp<RewindAdoptArguments, HistoryOpResult, "none">,
  } satisfies BridgeOps;
}
