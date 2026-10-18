/*
 * What blocks and the host do about each kind of foreground action: whether a block interrupts it and how it resumes,
 * whether it waits for the host alone, and whether a block it holds back also holds scene time. Each decision is one
 * exhaustive switch, so a new kind must make every one of them.
 */
import type {
  RuntimeChatPacingGateActionSnapshot,
  RuntimeDelayActionSnapshot,
  RuntimeForegroundActionSnapshot,
  RuntimeInteractionActionSnapshot,
  RuntimeLockActionSnapshot,
  RuntimeMediaPlaybackActionSnapshot,
} from "./model.js";

/** A step of a lock whose dialog or password field asks the player. */
export type RuntimeLockAskActionSnapshot = RuntimeLockActionSnapshot & { readonly phase: "ask" };

/**
 * Foreground actions that an interrupt block can suspend, as `interruptibleAction` decides; of a lock, only a step whose
 * dialog asks the player.
 */
export type RuntimeInterruptibleActionSnapshot =
  | RuntimeDelayActionSnapshot
  | RuntimeInteractionActionSnapshot
  | RuntimeChatPacingGateActionSnapshot
  | RuntimeMediaPlaybackActionSnapshot
  | RuntimeLockAskActionSnapshot;

/**
 * The foreground action as one that a queued expiry, cue, or button block may interrupt, or `null` for a host step that
 * the Player performs without the player: a storage write, a capture, a file store, or a lock's `work` step. A block
 * waits until a host step settles. It interrupts a `wait`, an interaction, a media wait, and a message's reading time
 * alike (owner decision on #829, 2026-10-11), and a lock's dialog as an interaction.
 *
 * A kind that a block interrupts joins `RuntimeInterruptibleActionSnapshot`, and then needs its case in
 * `resumedAction`. Only the kind and a lock's phase are read, so checkpoint validation can ask before it validates the
 * rest of an action.
 */
export function interruptibleAction(
  action: RuntimeForegroundActionSnapshot,
): RuntimeInterruptibleActionSnapshot | null {
  switch (action.kind) {
    case "delay":
    case "interaction":
    case "chatPacingGate":
    case "mediaPlayback":
      return action;
    case "lock":
      return askingLock(action) ? action : null;
    case "storageWrite":
    case "capture":
    case "fileStore":
      return null;
    default:
      return unknownKind(action, null);
  }
}

/**
 * Whether the foreground action waits for the host alone, which neither time nor the player settles: a storage write, a
 * capture, a file store, or a lock's `work` step. A Player's development time jump stops at it. Today these are exactly
 * the host steps of `interruptibleAction`, but each kind decides this on its own.
 */
export function actionAwaitsHost(action: RuntimeForegroundActionSnapshot): boolean {
  switch (action.kind) {
    case "storageWrite":
    case "capture":
    case "fileStore":
      return true;
    // A lock's dialog waits for the player, as an interaction does.
    case "lock":
      return action.phase === "work";
    case "delay":
    case "interaction":
    case "chatPacingGate":
    case "mediaPlayback":
      return false;
    default:
      return unknownKind(action, false);
  }
}

/**
 * Whether a queued block that the foreground action holds back also holds scene time at the block's due time, so that
 * the host answers the action at that scene time and the block then runs at it. Only a storage write does: a block may
 * read the acknowledged value. Scene time runs on to the observed time behind any other host step, which the host
 * answers at the observed time. A block interrupts the other actions, so they hold none back.
 */
export function holdsCatchUp(action: RuntimeForegroundActionSnapshot): boolean {
  switch (action.kind) {
    case "storageWrite":
      return true;
    case "capture":
    case "fileStore":
    case "lock":
    case "delay":
    case "interaction":
    case "chatPacingGate":
    case "mediaPlayback":
      return false;
    default:
      return unknownKind(action, false);
  }
}

/**
 * `interruptibleAction` for a foreground action of checkpoint data that is not validated yet, from its kind and phase
 * alone. An action of no foreground kind is not interruptible; its own validation rejects it.
 */
export function interruptibleActionRecord(action: Record<string, unknown>): boolean {
  return interruptibleAction(recordView(action)) !== null;
}

/** `holdsCatchUp` for a foreground action of checkpoint data that is not validated yet, from its kind alone. */
export function holdsCatchUpRecord(action: Record<string, unknown>): boolean {
  return holdsCatchUp(recordView(action));
}

/**
 * An interrupted action as it resumes after a block that ran for `stoodStillMs`: its remaining time is what it had when
 * the block started (owner decision on #829, 2026-10-11).
 */
export function resumedAction(
  action: RuntimeInterruptibleActionSnapshot,
  stoodStillMs: number,
): RuntimeInterruptibleActionSnapshot {
  switch (action.kind) {
    case "delay":
    case "chatPacingGate":
      if (stoodStillMs === 0) return action;
      return Object.freeze({
        ...action,
        createdAtMs: action.createdAtMs + stoodStillMs,
        deadlineMs: action.deadlineMs + stoodStillMs,
      });
    case "interaction":
      // A password field is shown anew, also after a block that returned at once, and counts the time it stood still
      // as any interaction.
      if (action.interactionKind === "password")
        return Object.freeze({
          ...action,
          ...(stoodStillMs === 0 ? {} : { pausedMs: (action.pausedMs ?? 0) + stoodStillMs }),
          resumes: (action.resumes ?? 0) + 1,
        });
      if (stoodStillMs === 0) return action;
      return Object.freeze({ ...action, pausedMs: (action.pausedMs ?? 0) + stoodStillMs });
    // A media wait is not timed; it ends with its media.
    case "mediaPlayback":
      return action;
    // A lock's dialog asks again, shown anew; it has no time of its own.
    case "lock":
      return Object.freeze({ ...action, resumes: action.resumes + 1 });
    default: {
      const unhandled: never = action;
      throw new Error("An interrupted action has no resumption.", { cause: unhandled });
    }
  }
}

function askingLock(action: RuntimeLockActionSnapshot): action is RuntimeLockAskActionSnapshot {
  return action.phase === "ask";
}

/** The kind and phase of a record, which are all that `interruptibleAction` and `holdsCatchUp` read. */
function recordView(action: Record<string, unknown>): RuntimeForegroundActionSnapshot {
  const view = { kind: action.kind, phase: action.phase };
  // EVIDENCE: validation: these decisions read only the kind, answering for an unknown one, and a lock's phase.
  return view as RuntimeForegroundActionSnapshot;
}

/**
 * The answer for a kind that no foreground action has, which only checkpoint data that is not validated yet can name;
 * its own validation rejects it. The parameter has type `never`, so a kind without its case fails to compile.
 */
function unknownKind<T>(_action: never, answer: T): T {
  return answer;
}
