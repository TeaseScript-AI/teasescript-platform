import type { BubbleVariants } from "@/components/ui/bubble";

/** Message presentation choices still open for review in issue #421. */
export interface TranscriptDesign {
  speakerFill: NonNullable<BubbleVariants["variant"]>;
  playerFill: NonNullable<BubbleVariants["variant"]>;
}

export const transcriptDesignDefaults: TranscriptDesign = {
  speakerFill: "secondary",
  playerFill: "default",
};

export const bubbleFills = [
  "secondary",
  "muted",
  "tinted",
  "outline",
  "ghost",
  "default",
] as const satisfies readonly NonNullable<BubbleVariants["variant"]>[];
