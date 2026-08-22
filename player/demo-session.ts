import type {
  PlayerForegroundFixtureKind,
  PlayerForegroundPresentation,
  PlayerMessagePresentation,
  PlayerPresentation,
  PlayerToolColumnState,
  PlayerToolDefinition,
  PlayerVisualPreferences,
} from "./model.js";

const BASE_MESSAGES: readonly PlayerMessagePresentation[] = [
  {
    kind: "message",
    id: "message-1",
    speakerId: "eva",
    text: "You have plenty of time. I am interested in whether you can follow the instruction exactly.",
  },
  {
    kind: "message",
    id: "message-2",
    speakerId: "nora",
    text: "The clean prototype keeps Speaker presentation separate from Player layout.",
  },
  {
    kind: "message",
    id: "message-3",
    speakerId: "user",
    text: "That makes it easier to test visual ideas without changing how the interface fits together.",
  },
  {
    kind: "message",
    id: "message-4",
    speakerId: "eva",
    text: "Good. The important rule is simple: cosmetic switches are not allowed to change layout geometry.",
  },
];

export const MAX_DEMO_HISTORY_MESSAGES = 10_000;

export const DEMO_FOREGROUND_PRESENTATIONS: Readonly<
  Record<Exclude<PlayerForegroundFixtureKind, "none">, PlayerForegroundPresentation>
> = {
  "show-button": {
    kind: "show-button",
    accessibleName: "Ready button",
    label: "I am ready",
    authoredFill: "#8f3f5d",
  },
  choose: {
    kind: "choose",
    accessibleName: "Choose how to continue",
    options: [
      { id: "steady", label: "Continue steadily" },
      { id: "strict", label: "Choose the stricter option", authoredFill: "#8f3f5d" },
      { id: "clarify", label: "Ask for clarification before continuing" },
      { id: "rules", label: "Review the current rules first" },
    ],
  },
  "ask-text": {
    kind: "ask-text",
    accessibleName: "Text answer",
    hint: "Type your answer…",
  },
  "ask-number": {
    kind: "ask-number",
    accessibleName: "Number answer",
    hint: "Enter a number…",
  },
};

export const DEMO_PRESENTATION: PlayerPresentation = {
  package: {
    accentColor: "#e84c71",
  },

  media: {
    id: "demo-media-unavailable",
    src: "",
    fit: "contain",
    title: "Demo media unavailable",
    ambientColor: "#f7cdaf",
  },

  timer: {
    remainingSeconds: 161,
    totalSeconds: 300,
  },

  speakers: {
    eva: {
      name: "Mistress Eva",
      accent: "#c65b75",
      avatar: "E",
      fontFamily: "Georgia, 'Times New Roman', serif",
    },
    nora: {
      name: "Nora",
      accent: "#9a867d",
      avatar: "N",
      fontFamily: "ui-monospace, 'DejaVu Sans Mono', Consolas, monospace",
    },
    user: {
      name: "You",
      accent: "#8fa3ab",
      avatar: "Y",
      fontFamily: "Verdana, 'DejaVu Sans', system-ui, sans-serif",
    },
  },

  messages: BASE_MESSAGES,
  foreground: DEMO_FOREGROUND_PRESENTATIONS.choose,

  rightControls: [
    { kind: "action", id: "continue", label: "Continue", priority: 10 },
    {
      kind: "toggle",
      id: "strict-mode",
      label: "Strict mode",
      value: true,
      priority: 20,
      recordUserHistory: true,
    },
    {
      kind: "select",
      id: "intensity",
      label: "Intensity",
      value: "steady",
      options: [
        ["gentle", "Gentle"],
        ["steady", "Steady"],
        ["strict", "Strict"],
      ],
      recordUserHistory: false,
    },
    {
      kind: "action",
      id: "authored-action",
      label: "Use the authored-colour action",
      authoredFill: "#406f79",
    },
    {
      kind: "status",
      id: "scene-progress",
      label: "Scene progress",
      detail: "58%",
      progress: 0.58,
    },
  ],
};

export const DEFAULT_VISUAL_PREFERENCES: PlayerVisualPreferences = {
  accentColor: DEMO_PRESENTATION.package.accentColor,
  ambient: true,
  vignette: false,
};

export const DEMO_TOOL_DEFINITIONS: readonly PlayerToolDefinition[] = [
  { id: "visuals", label: "Visual Lab" },
  { id: "scene", label: "Scene" },
  { id: "layout-debug", label: "Layout Debug" },
];

export const INITIAL_TOOL_COLUMNS: readonly PlayerToolColumnState[] = [
  { id: "tool-column-1", toolId: "visuals" },
];

export function createDemoHistoryMessages(count: number): readonly PlayerMessagePresentation[] {
  const safeCount = Math.min(
    MAX_DEMO_HISTORY_MESSAGES,
    Math.max(0, Math.trunc(count)),
  );
  if (safeCount === 0) return [];
  if (safeCount === BASE_MESSAGES.length) return BASE_MESSAGES;

  const messages: PlayerMessagePresentation[] = [];
  for (let index = 0; index < safeCount; index += 1) {
    const source = BASE_MESSAGES[index % BASE_MESSAGES.length];
    if (source === undefined) throw new Error("Demo transcript source message is missing.");
    messages.push({
      ...source,
      id: `history-${index + 1}`,
      text: index < BASE_MESSAGES.length
        ? source.text
        : `${source.text} · retained history item ${index + 1}`,
    });
  }
  return messages;
}
