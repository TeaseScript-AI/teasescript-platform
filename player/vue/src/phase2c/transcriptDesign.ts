import type { BubbleVariants } from "@/components/ui/bubble";

/** Message presentation choices still open for review in issue #421. */
export interface TranscriptDesign {
  speakerFill: NonNullable<BubbleVariants["variant"]>;
  playerFill: NonNullable<BubbleVariants["variant"]>;
  /** Stands in for a speaker's authored colour; "inherit" means the speaker sets none. */
  authoredAccent: string;
  /** OKLCH lightness, as a percentage, that each mode realizes an authored colour at. */
  lightTone: number;
  darkTone: number;
}

export const transcriptDesignDefaults: TranscriptDesign = {
  speakerFill: "secondary",
  playerFill: "default",
  authoredAccent: "inherit",
  // Material pairs tone 40 with white text and tone 80 with black; these are their
  // OKLCH equivalents, still to be judged against real authored colours.
  lightTone: 52,
  darkTone: 83,
};

export const bubbleFills = [
  "secondary",
  "muted",
  "tinted",
  "outline",
  "ghost",
  "default",
] as const satisfies readonly NonNullable<BubbleVariants["variant"]>[];
