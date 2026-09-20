/** Where a block sits, or how its text is set inside it. */
export type Placement = "left" | "center" | "right";

/**
 * Prose is not one thing. A letter, a passage of context and a note about the interface
 * itself all read differently, and the runtime sends null when the author chose nothing.
 * Which of these the player should fill in is the open question in issue #421, so they are
 * kept apart here until it is answered.
 */
export type ProseKind = "letter" | "context" | "system";

export interface ProsePlacement {
  position: Placement;
  text: Placement;
}

/** Message presentation choices still open for review in issue #421. */
export interface TranscriptDesign {
  /** Stands in for a speaker's authored colour; "inherit" means the speaker sets none. */
  authoredAccent: string;
  /** What the player fills in per kind when the author chose nothing. */
  prose: Record<ProseKind, ProsePlacement>;
  /** The reading measure, in characters. */
  proseMeasure: number;
}

export const proseKinds: readonly ProseKind[] = ["letter", "context", "system"];
export const placements: readonly Placement[] = ["left", "center", "right"];

export const transcriptDesignDefaults: TranscriptDesign = {
  authoredAccent: "inherit",
  prose: {
    letter: { position: "left", text: "left" },
    context: { position: "left", text: "left" },
    system: { position: "center", text: "center" },
  },
  proseMeasure: 65,
};
