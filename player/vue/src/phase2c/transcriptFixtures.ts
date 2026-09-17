import type { TranscriptEntry } from "./transcriptEntries";

const messages = [
  "Take a moment to look around. The path follows the coast from here.",
  "I am ready. Where do we go next?",
  "Beyond the harbour, a narrow path winds between the dunes. You can hear the waves before you see them, and the evening light turns the water silver. There is no need to hurry; we have time to notice the small things along the way.",
  "I would like to stop by the water first.\nThen we can follow the path toward the lighthouse.\nDoes that sound good?",
  "Of course.\n\nListen to the sea for a moment.\nWatch how the light changes as the clouds pass.\n\nWhen you are ready, we can continue.",
  "Yes, let's continue.",
];

export function transcriptFixtures(start: number, count: number): TranscriptEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const sequence = start + index;
    const variant = ((sequence % messages.length) + messages.length) % messages.length;
    const player = variant % 2 === 1;
    return {
      id: `message-${sequence}`,
      author: player ? "player" : "speaker",
      name: player ? "You" : "Guide",
      text: messages[variant]!,
    };
  });
}
