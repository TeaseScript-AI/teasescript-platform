import type {
  PlayerPresentation,
  PlayerToolColumnState,
  PlayerToolDefinition,
  PlayerVisualPreferences,
} from "./model.js";

export const DEMO_PRESENTATION: PlayerPresentation = {
  package: {
    accentColor: "#8f3048",
  },

  media: {
    id: "demo-media-unavailable",
    src: "",
    fit: "contain",
    title: "Demo media unavailable",
    ambientColor: "#5a2737",
  },

  timer: {
    remainingSeconds: 161,
    totalSeconds: 300,
  },

  speakers: {
    eva: {
      name: "Mistress Eva",
      accent: "#c96b7f",
      avatar: "E",
      fontFamily: "Georgia, 'Times New Roman', serif",
    },
    nora: {
      name: "Nora",
      accent: "#b6aa97",
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

  messages: [
    {
      id: "message-1",
      speakerId: "eva",
      text: "You have plenty of time. I am interested in whether you can follow the instruction exactly.",
    },
    {
      id: "message-2",
      speakerId: "nora",
      text: "The clean prototype keeps Speaker presentation separate from Player layout.",
    },
    {
      id: "message-3",
      speakerId: "user",
      text: "That makes it easier to test visual ideas without changing how the interface fits together.",
    },
    {
      id: "message-4",
      speakerId: "eva",
      text: "Good. The important rule is simple: cosmetic switches are not allowed to change layout geometry.",
    },
  ],

  actions: [
    { id: "continue", label: "Continue" },
    { id: "clarify", label: "Ask for clarification" },
    { id: "confirm", label: "Confirm" },
    { id: "strict", label: "Choose the stricter option" },
    { id: "rules", label: "Show current rules" },
    { id: "scene-options", label: "Open scene options" },
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
];

export const INITIAL_TOOL_COLUMNS: readonly PlayerToolColumnState[] = [
  { id: "tool-column-1", toolId: "visuals" },
];
