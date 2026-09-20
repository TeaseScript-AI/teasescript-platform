/** Message presentation choices still open for review in issue #421. */
export interface TranscriptDesign {
  /** Stands in for a speaker's authored colour; "inherit" means the speaker sets none. */
  authoredAccent: string;
}

export const transcriptDesignDefaults: TranscriptDesign = {
  authoredAccent: "inherit",
};
