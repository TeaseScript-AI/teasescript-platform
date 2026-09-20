/** Where a block sits, or how its text is set inside it. */
export type Placement = "left" | "center" | "right";

/** Message presentation choices still open for review in issue #421. */
export interface TranscriptDesign {
  /** Stands in for a speaker's authored colour; "inherit" means the speaker sets none. */
  authoredAccent: string;
  /**
   * What a prose message is given when the author chose nothing. A letter and a note about
   * the interface read differently, but the author is the one who says so, by giving his
   * speakers different presentation; there is one thing to fill in here, not one per
   * reading. Where it lands is the open question in issue #421.
   */
  prosePosition: Placement;
  proseAlign: Placement;
  /** The reading measure, in characters. */
  proseMeasure: number;
}

export const placements: readonly Placement[] = ["left", "center", "right"];

export const transcriptDesignDefaults: TranscriptDesign = {
  authoredAccent: "inherit",
  prosePosition: "left",
  proseAlign: "left",
  proseMeasure: 65,
};
