import type { BubbleVariants } from "@/components/ui/bubble";

/** Reviewable message presentation choices for issue #421. */
export interface TranscriptDesign {
  speakerFill: NonNullable<BubbleVariants["variant"]>;
  playerFill: NonNullable<BubbleVariants["variant"]>;
  speakerName: "none" | "group" | "always";
  avatar: "none" | "first" | "last";
  groupedCorners: boolean;
}

export const transcriptDesignDefaults: TranscriptDesign = {
  speakerFill: "secondary",
  playerFill: "default",
  speakerName: "group",
  avatar: "first",
  groupedCorners: false,
};

export const bubbleFills = [
  "secondary",
  "muted",
  "tinted",
  "outline",
  "ghost",
  "default",
] as const satisfies readonly NonNullable<BubbleVariants["variant"]>[];

export const speakerNameOptions = [
  { value: "group", label: "At the start of a run" },
  { value: "always", label: "Above every message" },
  { value: "none", label: "No name" },
] as const;

export const avatarOptions = [
  { value: "first", label: "At the first message" },
  { value: "last", label: "At the last message" },
  { value: "none", label: "No avatar" },
] as const;
