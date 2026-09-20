/** Message presentation choices still open for review in issue #421. */
export interface TranscriptDesign {
  /** Stands in for a speaker's authored colour; "inherit" means the speaker sets none. */
  authoredAccent: string;
  /** How an entry meant to be read rather than heard is set apart from the dialogue. */
  prose: "bubble" | "quiet" | "column";
}

export const transcriptDesignDefaults: TranscriptDesign = {
  authoredAccent: "inherit",
  prose: "quiet",
};
