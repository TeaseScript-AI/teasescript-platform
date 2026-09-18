import type {
  PlayerTranscriptEntryPresentation,
  PlayerSpeakerPresentation,
} from "../../../model.js";

export const transcriptFixtureSpeakers: Readonly<Record<string, PlayerSpeakerPresentation>> = {
  guide: { name: "Guide", accent: "inherit", avatar: "G", fontFamily: "inherit" },
  user: { name: "You", accent: "inherit", avatar: "Y", fontFamily: "inherit" },
};

const messages = [
  "Take a moment to look around. The path follows the coast from here.",
  "Keep to the seaward side while the light lasts. The sand there stays firm enough to walk on, and you will not lose the path even once the dunes close in behind us.",
  "Beyond the harbour, a narrow path winds between the dunes. You can hear the waves before you see them, and the evening light turns the water silver. There is no need to hurry; we have time to notice the small things along the way.",
  "I would like to stop by the water first.\nThen we can follow the path toward the lighthouse.\nDoes that sound good?",
  "Of course. Listen to the sea for a moment, and watch how the light changes as the clouds pass over the water. The tide is turning now, so the sound will shift while we stand here. When you are ready, we can continue along the path.",
  "Yes, let's continue.",
];

export function transcriptFixtures(
  start: number,
  count: number,
): PlayerTranscriptEntryPresentation[] {
  return Array.from({ length: count }, (_, index) => {
    const sequence = start + index;
    const variant = ((sequence % messages.length) + messages.length) % messages.length;
    // Runs of consecutive speaker messages, so grouping is visible in the fixtures.
    const player = variant === 3 || variant === 5;
    return {
      id: `message-${sequence}`,
      kind: "message",
      speakerId: player ? "user" : "guide",
      text: messages[variant]!,
    };
  });
}
