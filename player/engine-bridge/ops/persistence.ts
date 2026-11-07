import { createPlayerRuntimeRestorePoint } from "../../runtime-adapter.js";
import { exactly, isRecord } from "../argument-checks.js";
import type { BridgeOps, HostSessions } from "../worker-host.js";
import { HeldSession } from "./session.js";

/*
 * The reads of family L5h (the L5 series), keeping and exporting a session: what the Player stores of a session, read
 * in the host. They read and change no session state.
 *
 * A read names its session in its arguments and works on no session of the envelope, so the stop fence, which refuses
 * a halted session's own ops, lets it read the state a Player error stop left: the stop line, which is what the main
 * side shows. The main side sends it after the session's earlier requests (`BridgeClient.request`'s `after`), so a
 * read follows what was posted before it.
 */

/** What a capture of a held session's checkpoint gives the Player. */
export interface CheckpointCapture {
  readonly revision: number;
  /** How many of the session's events the capture covers: the store's events up to here go with it. */
  readonly eventsThrough: number;
  readonly checkpointJson: string;
}

const isSessionId = (value: unknown): value is string => typeof value === "string";

/** A read of a session the host no longer holds, such as one released meanwhile: there is nothing to read. */
class SessionGoneError extends Error {
  override readonly name = "SessionGoneError";
}

/** The session the host holds under `id`. */
function heldSession(sessions: HostSessions, id: string): HeldSession {
  const held = sessions.get(id);
  if (!(held instanceof HeldSession)) throw new SessionGoneError("The host holds no such session.");
  return held;
}

export function persistenceOps(): BridgeOps {
  return {
    // The session's checkpoint, as an export of the session carries it.
    captureCheckpoint: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) && exactly(args, ["session"]) && isSessionId(args.session),
      run: (args, sessions) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const held = heldSession(sessions, (args as { readonly session: string }).session);
        const current = held.current;
        const result: CheckpointCapture = {
          revision: current.revision,
          eventsThrough: held.delivered,
          checkpointJson: createPlayerRuntimeRestorePoint(current).checkpointJson,
        };
        return { result };
      },
    },
  };
}
