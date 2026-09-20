import type {
  PlayerTranscriptEntryPresentation,
  PlayerSpeakerPresentation,
} from "../../../model.js";
import { parseMessageMarkup } from "../../../../src/message-markup.js";

export const transcriptFixtureSpeakers: Readonly<Record<string, PlayerSpeakerPresentation>> = {
  guide: { name: "Guide", accent: "inherit", avatar: "G", fontFamily: "inherit" },
  // Narration is given no name, so the transcript has to show a passage with nothing above
  // it; the keeper is named, so it has to show one with a name. Both cases come from the
  // fixture rather than from a switch, because the author decides this per speaker.
  narrator: { name: "", accent: "inherit", avatar: "", fontFamily: "inherit" },
  keeper: { name: "Hanna", accent: "inherit", avatar: "H", fontFamily: "inherit" },
  // A note about the interface rather than about the story. It stands outside the fiction,
  // so whether it can sit on a speaker's line at all is part of what is being judged.
  system: { name: "", accent: "inherit", avatar: "", fontFamily: "inherit" },
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

// Authored source rather than hand-built structures, so the presentation is judged
// against what the real parser produces. The colours are deliberately mixed: one that
// only survives on a dark bubble, one that only survives on a light one.
const markupSources: readonly (readonly [speaker: string, source: string])[] = [
  ["guide", "# The lighthouse\nThe path splits here. *Take your time* — the **tide** is still going out."],
  ["guide", "Keep to the `seaward` side. The full route is on [the harbour map](https://example.com/map)."],
  ["guide", "> The sea is calm tonight.\n> The tide is full, the moon lies fair."],
  ["guide", "Watch for:\n- loose sand past the second dune\n- the marker posts\n- the light itself"],
  ["guide", "In order:\n1. follow the posts\n2. cross the dune\n3. wait for the beam"],
  // The mid grey is the hard case: it falls on the light side of the divide and a dark
  // bubble on the dark side, so classifying each of them would call the pair safe, yet
  // measuring it gives about three to one.
  ["guide", "Authored colours: [color=#ffe066]pale yellow[/color], [color=#1a1a2e]near black[/color], [color=#8a8a8a]mid grey[/color], and [color=#c2185b]deep pink[/color]."],
  // An author is free to set the words and what is behind them, and free to set them to
  // nearly the same thing. Nobody chose that on purpose, so the pair still has to be
  // measured as painted; the last one is partly see-through on both sides, where reading
  // the colours as written would report a contrast the reader never gets.
  ["guide", "[bg=#2b3a8f][color=#3344aa]Blue on blue[/color][/bg], [bg=#f2e9c9][color=#efe4c0]cream on cream[/color][/bg], and [bg=rgb(0 0 0 / 0.15)][color=rgb(40 40 40 / 0.45)]a faint grey on a faint shade[/color][/bg]."],
  ["user", "Understood. I will follow the posts."],
];

/** One message per markup kind, for judging the presentation of authored content. */
export function transcriptMarkupFixtures(): PlayerTranscriptEntryPresentation[] {
  return markupSources.map(([speakerId, source], index) => {
    const content = parseMessageMarkup(source);
    return { id: `markup-${index}`, kind: "message", speakerId: speakerId!, text: content.visibleText, content };
  });
}

// Prose has to be judged in company, not on its own: what matters is whether the two
// readings can follow each other without the transcript looking like two interfaces.
// Narration, an overheard letter and ordinary dialogue are interleaved for that reason.
const proseSources: readonly (readonly [speaker: string, source: string])[] = [
  ["guide", "There is something I want you to see before the light goes."],
  ["user", "Lead the way."],
  ["narrator", "The path leaves the harbour behind and climbs between the dunes. Marram grass leans all one way, combed flat by a wind that has not stopped since morning, and the sand underfoot gives a little at every step.\n\nBelow, the tide is going out. It uncovers a long grey shelf of rock that was not there an hour ago, and the water draining off it catches what is left of the sun."],
  ["guide", "Careful here. The second dune is looser than it looks."],
  ["narrator", "At the top the lighthouse stands closer than it seemed from the harbour, white against a sky that has begun to go green at the edges. Its lamp has not been lit yet."],
  ["keeper", "*My dear,*\n\nIf you are reading this you have walked further than I ever managed. The keeper's house is open; the key is where it has always been, under the third stone from the door.\n\nDo not wait for the lamp. It comes on when it comes on, and the waiting is the worst of it.\n\n**— H.**"],
  ["user", "Who wrote that?"],
  ["guide", "Someone who knew the walk. Come on — the beam will start any moment."],
  ["system", "**Pacing** is now set to *slow*. Messages arrive with a pause between them, and the composer stays available while you wait."],
  ["guide", "Take your time, then."],
];

/** A mixed history for judging how prose and dialogue sit together. */
export function transcriptProseFixtures(): PlayerTranscriptEntryPresentation[] {
  return proseSources.map(([speakerId, source], index) => {
    const content = parseMessageMarkup(source);
    return { id: `prose-${index}`, kind: "message", speakerId: speakerId!, text: content.visibleText, content };
  });
}

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
