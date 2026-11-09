import type { InjectionKey } from "vue";

/**
 * Debug's **Explain values** entry point on chat messages (DEBUGGER.md "Player Debug"), which the Player provides to its
 * transcript while Debug runs. A message is identified by its transcript entry ID, never by its text.
 */
export interface ExplainValues {
  /** Whether a message offers Explain values now: Debug runs and the entry came from a runtime event. Reactive. */
  offers(entryId: string): boolean;
  /** Opens Debug's Variables tab on the message's recorded values. */
  explain(entryId: string): void;
}

export const explainValues: InjectionKey<ExplainValues> = Symbol("explainValues");
