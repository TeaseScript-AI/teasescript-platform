import type { InterpreterEvent } from "../../src/runtime/events.js";
import type { InstructionFacts } from "./instruction-facts.js";
import type { PlanMetadata } from "./player-ops.js";
import type { PlayerRuntimeState } from "../runtime-adapter.js";

/*
 * What a session op's reply carries in `view` (the L5 reply contract). The host keeps one cursor per session: how many
 * of its events it has handed out, in replies or through the transition facade. Every publication carries the events
 * after that cursor, so the main side's store applies them contiguously; a publication's identity is its revision.
 */

/** One publication of a session: its state, its revision, and its events after the cursor `from`. */
export interface Publication {
  readonly revision: number;
  readonly state: PlayerRuntimeState;
  /** The cursor before this publication: how many of the session's events were handed out before. */
  readonly from: number;
  /** The cursor after it. */
  readonly eventsThrough: number;
  /** The session's events in `(from, eventsThrough]`, in order. */
  readonly events: readonly InterpreterEvent[];
  /** Where in the script each instruction the view names is, by instruction index: those owning its media. */
  readonly instructions: InstructionFacts;
}

/** The first publication of a session the host now holds, from cursor 0, with what stays fixed for its lifetime. */
export interface Introduction extends Publication {
  readonly from: 0;
  /** The host's token for the plan instance the session runs. */
  readonly planToken: string;
  /** What the Player reads from that plan, when the session brought a plan of its own (a restore or a transfer). */
  readonly metadata: PlanMetadata | null;
  /** The first event sequence the session's own runs emitted; the events before it are restored history. */
  readonly liveEventSequence: number;
}
