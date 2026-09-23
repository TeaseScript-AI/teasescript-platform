import type {
  PlayerTranscriptEntryPresentation,
  PlayerSpeakerPresentation,
} from "../../../model.js";
import type { MessagePresentation } from "../../../../src/message-presentation.js";
import { parseMessageMarkup } from "../../../../src/message-markup.js";
import { normalizeColor } from "../../../../src/color.js";

export const transcriptFixtureSpeakers: Readonly<Record<string, PlayerSpeakerPresentation>> = {
  guide: { name: "Guide", accent: "inherit", avatar: "G", fontFamily: "inherit" },
  narrator: { name: "", accent: "inherit", avatar: "", fontFamily: "inherit" },
  keeper: { name: "Hanna", accent: "inherit", avatar: "H", fontFamily: "inherit" },
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

const markupSources: readonly (readonly [speaker: string, source: string])[] = [
  [
    "guide",
    "# The lighthouse\nThe path splits here. *Take your time* — the **tide** is still going out.\n## The keeper's stair\nSixty steps, and a rail on the seaward side.\n### Before you climb\nCheck that the beam is turning.",
  ],
  [
    "guide",
    "Keep to the `seaward` side. The full route is on [the harbour map](https://example.com/map).",
  ],
  ["guide", "> The sea is calm tonight.\n> The tide is full, the moon lies fair."],
  [
    "guide",
    "Watch for:\n- loose sand past the second dune\n- the marker posts\n- the light itself",
  ],
  ["guide", "In order:\n1. follow the posts\n2. cross the dune\n3. wait for the beam"],
  [
    "guide",
    "Authored colours: [color=#ffe066]pale yellow[/color], [color=#1a1a2e]near black[/color], [color=#8a8a8a]mid grey[/color], and [color=#c2185b]deep pink[/color].",
  ],
  [
    "guide",
    "Chosen together: [bg=#2b3a8f][color=#3344aa]blue on blue[/color][/bg] and [bg=#f2e9c9][color=#efe4c0]cream on cream[/color][/bg].",
  ],
  ["user", "Understood. I will follow the posts."],
];

export function transcriptMarkupFixtures(): PlayerTranscriptEntryPresentation[] {
  return markupSources.map(([speakerId, source], index) => {
    const content = parseMessageMarkup(source);
    return {
      id: `markup-${index}`,
      kind: "message",
      speakerId: speakerId!,
      text: content.visibleText,
      content,
    };
  });
}

const proseSources: readonly (readonly [speaker: string, source: string, prose?: true])[] = [
  ["guide", "There is something I want you to see before the light goes."],
  ["user", "Lead the way."],
  [
    "narrator",
    "The path leaves the harbour behind and climbs between the dunes. Marram grass leans all one way, combed flat by a wind that has not stopped since morning, and the sand underfoot gives a little at every step.\n\nBelow, the tide is going out. It uncovers a long grey shelf of rock that was not there an hour ago, and the water draining off it catches what is left of the sun.",
    true,
  ],
  ["guide", "Careful here. The second dune is looser than it looks."],
  [
    "narrator",
    "At the top the lighthouse stands closer than it seemed from the harbour, white against a sky that has begun to go green at the edges. Its lamp has not been lit yet.",
    true,
  ],
  [
    "keeper",
    "*My dear,*\n\nIf you are reading this you have walked further than I ever managed. The keeper's house is open; the key is where it has always been, under the third stone from the door.\n\nDo not wait for the lamp. It comes on when it comes on, and the waiting is the worst of it.\n\n**— H.**",
    true,
  ],
  ["user", "Who wrote that?"],
  ["guide", "Someone who knew the walk. Come on — the beam will start any moment."],
  [
    "system",
    "**Pacing** is now set to *slow*. Messages arrive with a pause between them, and the composer stays available while you wait.",
    true,
  ],
  ["guide", "Take your time, then."],
];

export function transcriptProseFixtures(): PlayerTranscriptEntryPresentation[] {
  return proseSources.map(([speakerId, source, prose], index) => {
    const content = parseMessageMarkup(source);
    return {
      id: `prose-${index}`,
      kind: "message",
      speakerId: speakerId!,
      text: content.visibleText,
      content,
      presentation: {
        kind: prose === undefined ? "bubble" : "prose",
        position: null,
        align: null,
        color: null,
        background: null,
        font: null,
      },
    };
  });
}

function authored(
  kind: "bubble" | "prose",
  color: string | null,
  background: string | null,
  font: string | null = null,
): MessagePresentation {
  return {
    kind,
    position: null,
    align: null,
    color: color === null ? null : normalizeColor(color),
    background: background === null ? null : normalizeColor(background),
    font,
  };
}

const authoredSources: readonly (readonly [
  speaker: string,
  source: string,
  presentation?: MessagePresentation,
])[] = [
  [
    "guide",
    "No colour was chosen for this one, so it keeps the theme's own bubble.",
    authored("bubble", null, null),
  ],
  [
    "guide",
    "A colour behind the words. What the words themselves become is measured against it, because the author never said.",
    authored("bubble", null, "#4a2d6b"),
  ],
  [
    "guide",
    "A colour on the words and none behind them. The bubble is the player's, so the player owes it.",
    authored("bubble", "#ffe066", null),
  ],
  [
    "guide",
    "Both colours written together. The author was looking straight at this pairing, so it stands exactly as written.",
    authored("bubble", "#cbb9e8", "#4a2d6b"),
  ],
  ["user", "And my own lines are authored by nobody, so they keep the theme's accent."],
  [
    "keeper",
    "*My dear,*\n\nThis one was given a surface of its own to sit on, so it reads as a page rather than as something said out loud.\n\n**— H.**",
    authored("prose", "#3b2f2a", "#efe4c8", "serif"),
  ],
  [
    "narrator",
    "And this passage was given nothing, so it sits straight on the page.",
    authored("prose", null, null),
  ],
  [
    "guide",
    "A colour on the words, and a [link](https://example.com) the page paints its own way.",
    authored("bubble", "#ffffff", null),
  ],
  [
    "narrator",
    "And this one was given a colour but nothing to sit on.",
    authored("prose", "#444444", null),
  ],
  [
    "guide",
    "Deep rose words against a Player-owned bubble. The two contrast methods can treat this colour differently.",
    authored("bubble", "#aa3355", null),
  ],
  [
    "guide",
    "This green remains clear on a light bubble, even when the contrast methods disagree. [color=#6e7777]Midtone grey near the contrast boundary.[/color]",
    authored("bubble", "#008000", null),
  ],
  [
    "guide",
    "Bright green on a dark bubble should not gain an opaque black strip.",
    authored("bubble", "#00c000", null),
  ],
  ["keeper", "Something said out loud.", authored("bubble", null, null)],
  ["keeper", "Then a passage that stands on its own.", authored("prose", null, null)],
  ["keeper", "And speaking again afterwards.", authored("bubble", null, null)],
];

export function transcriptAuthoredFixtures(): PlayerTranscriptEntryPresentation[] {
  return authoredSources.map(([speakerId, source, presentation], index) => {
    const content = parseMessageMarkup(source);
    return {
      id: `authored-${index}`,
      kind: "message",
      speakerId: speakerId!,
      text: content.visibleText,
      content,
      ...(presentation === undefined ? {} : { presentation }),
    };
  });
}

export function transcriptFixtures(
  start: number,
  count: number,
): PlayerTranscriptEntryPresentation[] {
  return Array.from({ length: count }, (_, index) => {
    const sequence = start + index;
    const variant = ((sequence % messages.length) + messages.length) % messages.length;
    const player = variant === 3 || variant === 5;
    return {
      id: `message-${sequence}`,
      kind: "message",
      speakerId: player ? "user" : "guide",
      text: messages[variant]!,
    };
  });
}
