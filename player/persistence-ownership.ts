/*
 * The ownership of one persistence operation of the Player's session host (`vue/src/usePlayerSession.ts`): a keep, the
 * kept session's restore for Continue, a session import. The host makes one when an operation begins; `current` is the
 * one rule that says whether the operation still owns its room, store, plan tenure and preparation. A stale operation
 * issues nothing more: it calls `check` after each await, before its next request or store write, and puts every page
 * effect at its end through `commit` (L5h.1).
 */

export interface PersistenceOwnership {
  /** Whether the operation still owns the room, store, plan tenure and preparation it began in. */
  current(): boolean;
  /** Ends the operation without effect (`StaleOperation`) once it no longer owns them. */
  check(): void;
  /** Runs `effect` while the operation owns them; else nothing. */
  commit<T>(effect: () => T): T | undefined;
}

/** A stale persistence operation's end: whoever ran it catches it and does nothing more. */
export class StaleOperation extends Error {
  override readonly name = "StaleOperation";
  constructor() {
    super("The operation's room, plan or preparation moved on.");
  }
}
