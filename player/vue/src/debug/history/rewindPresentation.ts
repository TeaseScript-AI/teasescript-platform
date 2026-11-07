import type { InjectionKey } from "vue";

/**
 * Debug's **Back to here** on the player's own answers in the transcript, which the Player provides while Debug runs. An
 * answer is identified by its transcript entry ID, never by its text.
 */
export interface RewindRows {
  /** Whether the answer offers Back to here now: it answered a rewind point before the state shown. Reactive. */
  offers(entryId: string): boolean;
  /** Restores the state in which the answered interaction was presented. */
  back(entryId: string): void;
}

export const rewindRows: InjectionKey<RewindRows> = Symbol("rewindRows");
