import {
  interactionDeadlineMs,
  type RuntimeChatPacingGateActionSnapshot,
  type RuntimeDelayActionSnapshot,
  type RuntimeInteractionActionSnapshot,
  type RuntimeMediaActionSnapshot,
  type RuntimePendingActionSnapshot,
  type RuntimeTimerActionSnapshot,
} from "../actions/model.js";
import { nextMediaEvent, type MediaTimelineEvent } from "../background/media.js";
import type { RuntimeSessionView } from "../session.js";

// The timed work of a session's state: which actions come due by scene time alone, and when. The engine settles it
// (`observe-time.ts`); a host reads it to know when to observe time next, without the engine.

export type DueWork =
  | {
      readonly kind: "action";
      readonly action:
        | RuntimeDelayActionSnapshot
        | RuntimeChatPacingGateActionSnapshot
        | RuntimeInteractionActionSnapshot;
      readonly deadlineMs: number;
      readonly actionId: number;
    }
  | {
      readonly kind: "timer";
      readonly action: RuntimeTimerActionSnapshot;
      readonly deadlineMs: number;
      readonly actionId: number;
    }
  | {
      /** The next media timeline event that reported playback covers, due at its scene time. */
      readonly kind: "media";
      readonly action: RuntimeMediaActionSnapshot;
      readonly event: MediaTimelineEvent;
      readonly deadlineMs: number;
      readonly actionId: number;
    };

/**
 * Work that comes due by scene time alone, at `deadlineMs`, for the pending action `actionId` of kind `kind`: a `wait`
 * or blocking timer (`delay`), a reading time (`chatPacingGate`), the timeout of a presented button (`interaction`), the
 * end of a timer round (`timer`), or the next timeline event of media whose reported progress reached it (`media`).
 */
export interface RuntimeTimedWork {
  readonly kind: "delay" | "chatPacingGate" | "interaction" | "timer" | "media";
  readonly actionId: number;
  readonly deadlineMs: number;
  /**
   * A round of a repeating timer without an expiry block. It runs nothing, so an observation past it gives the result
   * of observing it on time.
   */
  readonly silent: boolean;
  /** A timer round that draws the next round's length from a range; catch-up settles each such round on its own. */
  readonly drawsNextRound: boolean;
}

/**
 * The timed work of a session, which `observeTime` settles once scene time reaches its deadline: where a host observes
 * time next. A foreground wait, reading time, or button timeout stands still while a queued block goes first, and a
 * failed session settles nothing further.
 */
export function runtimeTimedWork(
  view: Pick<
    RuntimeSessionView,
    "status" | "foregroundAction" | "backgroundActions" | "queuedBlocks" | "suspendedAtMs"
  >,
): readonly RuntimeTimedWork[] {
  if (view.status === "failed") return Object.freeze([]);
  // `suspendedAtMs` is when the running block started, so it is set exactly while a block runs.
  const blockRunning = view.suspendedAtMs !== null;
  return Object.freeze(
    timedWorkOf(view, blockRunning || view.queuedBlocks === 0).map((work) => {
      const timer = work.kind === "timer" ? work.action.timer : null;
      return Object.freeze({
        kind: work.action.kind,
        actionId: work.actionId,
        deadlineMs: work.deadlineMs,
        silent: timer !== null && timer.repeat && timer.handlerFunctionId === null,
        drawsNextRound: timer !== null && timer.range !== null,
      });
    }),
  );
}

export function timedWorkOf(
  state: Pick<RuntimeSessionView, "foregroundAction" | "backgroundActions">,
  noQueuedBlockFirst: boolean,
): DueWork[] {
  const candidates: DueWork[] = [];
  const foreground =
    state.foregroundAction === null ? null : dueWorkOf(state.foregroundAction, noQueuedBlockFirst);
  if (foreground !== null) candidates.push(foreground);
  for (const action of state.backgroundActions) {
    const work = dueWorkOf(action, noQueuedBlockFirst);
    if (work !== null) candidates.push(work);
  }
  return candidates;
}

/**
 * The timed work of an active action, or `null` when no deadline settles it. A wait or reading time is due at its
 * deadline, an interaction at a button's timeout or a form's time limit, a timer at the end of its round, and media at
 * its next timeline event that reported playback covers. A media wait ends with its media, a permanent button waits for
 * clicks, and the host answers its steps. A foreground action stands still while a queued block goes first. Every kind
 * has its case, so a new kind must decide.
 */
function dueWorkOf(
  action: RuntimePendingActionSnapshot,
  noQueuedBlockFirst: boolean,
): DueWork | null {
  switch (action.kind) {
    case "delay":
    case "chatPacingGate":
      if (!noQueuedBlockFirst) return null;
      return { kind: "action", action, deadlineMs: action.deadlineMs, actionId: action.actionId };
    case "interaction": {
      const deadlineMs = interactionDeadlineMs(action);
      if (deadlineMs === null || !noQueuedBlockFirst) return null;
      return { kind: "action", action, deadlineMs, actionId: action.actionId };
    }
    case "timer":
      if (action.timer.deadlineMs === null) return null;
      return {
        kind: "timer",
        action,
        deadlineMs: action.timer.deadlineMs,
        actionId: action.actionId,
      };
    case "media": {
      const event = nextMediaEvent(action.media);
      if (event?.dueAtMs === null || event?.dueAtMs === undefined) return null;
      return { kind: "media", action, event, deadlineMs: event.dueAtMs, actionId: action.actionId };
    }
    case "mediaPlayback":
    case "permanentButton":
    case "storageWrite":
    case "capture":
    case "fileStore":
    case "lock":
      return null;
    default: {
      const unhandled: never = action;
      throw new Error("An active action has no timing.", { cause: unhandled });
    }
  }
}
