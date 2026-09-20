/** Message presentation choices still open for review in issue #421. */
export interface TranscriptDesign {
  /** Stands in for a speaker's authored colour; "inherit" means the speaker sets none. */
  authoredAccent: string;
  /** Where a prose block sits across the transcript. Stands in for an authored choice. */
  proseAlign: "start" | "center" | "end";
  /** How the text is set inside that block. Stands in for an authored choice. */
  proseText: "start" | "center" | "end";
  /** The reading measure, in characters. */
  proseMeasure: number;
}

export const transcriptDesignDefaults: TranscriptDesign = {
  authoredAccent: "inherit",
  proseAlign: "start",
  proseText: "start",
  proseMeasure: 65,
};
