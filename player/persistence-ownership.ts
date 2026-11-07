/*
 * The ownership of one persistence operation of the Player's session host (`vue/src/usePlayerSession.ts`): a keep, the
 * kept session's restore for Continue, a session import. The host makes one when an operation begins; `current` is the
 * one rule that says whether the operation still owns its room, store, plan tenure and preparation. Every operation has
 * one form: it awaits outside, calls `check` after each await before its next request or store write, and applies each
 * page effect synchronously through `commit`. Its helpers split the same way: an async read without page effects, and
 * a synchronous apply that runs only inside `commit` (L5h.1).
 */

export interface PersistenceOwnership {
  /** Whether the operation still owns the room, store, plan tenure and preparation it began in. */
  current(): boolean;
  /** Ends the operation without effect (`StaleOperation`) once it no longer owns them. */
  check(): void;
  /**
   * Runs `apply`, which is synchronous, while the operation owns them; else ends it like `check`. An `apply` that returns
   * a thenable is an error: what it would do after its first await would escape the ownership.
   */
  commit<T>(apply: () => T): T;
}

/** A stale persistence operation's end: whoever ran it catches it and does nothing more. */
export class StaleOperation extends Error {
  override readonly name = "StaleOperation";
  constructor() {
    super("The operation's room, plan or preparation moved on.");
  }
}

/** The ownership whose one rule is `current`. */
export function persistenceOwnership(current: () => boolean): PersistenceOwnership {
  const check = () => {
    if (!current()) throw new StaleOperation();
  };
  return {
    current,
    check,
    commit(apply) {
      check();
      const applied = apply();
      if (thenable(applied))
        throw new TypeError("A persistence operation's commit takes a synchronous apply.");
      return applied;
    },
  };
}

const thenable = (value: unknown): boolean =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";
