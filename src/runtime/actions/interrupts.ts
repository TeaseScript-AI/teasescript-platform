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
 * Every kind has its case, so a new kind must decide here; a kind that a block interrupts joins
 * `RuntimeInterruptibleActionSnapshot`, and then needs its case in `resumedAction`. Only the kind and a lock's phase are
 * read, so checkpoint validation can ask before it validates the rest of an action.
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
    // Only checkpoint data that is not validated yet can name another kind; its own validation rejects it.
    default:
      return noForegroundKind(action);
  }
}

/**
 * `interruptibleAction` for a foreground action of checkpoint data that is not validated yet, from its kind and phase
 * alone. An action of no foreground kind is not interruptible; its own validation rejects it.
 */
export function interruptibleActionRecord(action: Record<string, unknown>): boolean {
  const view = { kind: action.kind, phase: action.phase };
  // EVIDENCE: validation: interruptibleAction reads only the kind, null for an unknown one, and a lock's phase.
  return interruptibleAction(view as RuntimeForegroundActionSnapshot) !== null;
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

/**
 * Not interruptible. Its parameter has type `never`, so a kind without its case in `interruptibleAction` fails to
 * compile.
 */
function noForegroundKind(_action: never): null {
  return null;
}
