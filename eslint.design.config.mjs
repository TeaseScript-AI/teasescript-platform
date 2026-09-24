import { plugin as shadcn } from "@shadcn/lint";
import tsParser from "@typescript-eslint/parser";
import vueParser from "vue-eslint-parser";
import design from "./tools/design-lint/plugin.mjs";

const sources = [
  "player/vue/src/components/ui/**/*.{vue,ts}",
  "player/vue/src/phase2c/**/*.{vue,ts}",
  "player/vue/src/components/PlayerActionButton.vue",
];
// Placement, containment and visibility belong to composition; padding and appearance do not.
const composition = ["layout", "min-w-0", "shrink-0", "self-start", "invisible", "group"];
const mechanics = [
  "layout",
  "rounded-[inherit]",
  "transition-[width]",
  "transition-[left,right,width]",
];
const restyle = (contracts = []) => ["error", { allow: composition, contracts }];
const localContract = (file, contracts) => ({
  files: [`player/vue/src/${file}`],
  rules: { "shadcn/no-restyle": restyle(contracts) },
});
const contract = (component, allow) => ({
  pattern: `^${component}$`,
  allow: [...composition, ...allow],
});

export default [
  {
    files: sources,
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
    languageOptions: { parser: tsParser },
    plugins: { shadcn, design },
    rules: {
      "shadcn/no-raw-colors": "error",
      "shadcn/no-arbitrary-values": ["error", { allow: mechanics }],
      "shadcn/no-unknown-classes": [
        "error",
        {
          // Selector/debug/semantic hooks without their own utility declarations.
          allow: [
            "debug-spacing",
            "player-center",
            "player-composition",
            "player-top-bar-theme",
            "player-top-bar-fullscreen",
            "markup-paragraph",
            "choice-marker",
          ],
        },
      ],
      "shadcn/no-restyle": restyle(),
      // Upstream rejects safe helper calls but misses native-element interpolation.
      "design/no-fragmented-classes": "error",
      // Authored appearance, virtualization and measured geometry are runtime values.
      "shadcn/no-inline-styles": "off",
    },
  },
  {
    files: sources.map((pattern) => pattern.replace("{vue,ts}", "vue")),
    languageOptions: { parser: vueParser, parserOptions: { parser: tsParser } },
  },
  {
    files: ["player/vue/src/components/ui/bubble/index.ts"],
    rules: {
      "shadcn/no-arbitrary-values": [
        "error",
        {
          allow: [
            ...mechanics,
            // Shared bubble variants derive interaction/tint colors from the active theme.
            "bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
            "bg-[color-mix(in_oklch,var(--muted),var(--foreground)_5%)]",
            "bg-[oklch(from_var(--primary)_0.93_calc(c*0.4)_h)]",
            "bg-[oklch(from_var(--primary)_0.3_calc(c*0.4)_h)]",
            "bg-[oklch(from_var(--primary)_0.88_calc(c*0.5)_h)]",
            "bg-[oklch(from_var(--primary)_0.35_calc(c*0.5)_h)]",
          ],
        },
      ],
    },
  },
  {
    files: ["player/vue/src/components/ui/sidebar/index.ts"],
    rules: {
      "shadcn/no-arbitrary-values": [
        "error",
        {
          allow: [
            ...mechanics,
            // The sidebar owns its animated dimensions and theme-derived inset outlines.
            "transition-[width,height,padding]",
            "shadow-[0_0_0_1px_var(--sidebar-border)]",
            "shadow-[0_0_0_1px_var(--sidebar-accent)]",
          ],
        },
      ],
    },
  },
  {
    files: ["player/vue/src/components/ui/toggle/index.ts"],
    rules: {
      "shadcn/no-arbitrary-values": [
        "error",
        { allow: [...mechanics, "transition-[color,box-shadow]"] },
      ],
    },
  },
  // Player-owned compositions may define their material or geometry here, not at arbitrary call sites.
  localContract("components/PlayerActionButton.vue", [
    contract("Button", ["player-action-button"]),
  ]),
  localContract("phase2c/Composer.vue", [
    contract("Textarea", ["composer-input"]),
    contract("Button", ["composer-send"]),
  ]),
  localContract("phase2c/PlayerToolsShell.vue", [contract("Button", ["player-control-square"])]),
  localContract("phase2c/PlayerTopBar.vue", [
    contract("Button", ["player-top-bar-theme", "player-top-bar-fullscreen"]),
  ]),
  localContract("phase2c/ToolPanelHeader.vue", [contract("Button", ["panel-settings-trigger"])]),
  localContract("phase2c/Transcript.vue", [contract("Button", ["return-to-latest"])]),
  localContract("phase2c/TranscriptMessage.vue", [
    // AvatarFallback has no typography of its own; the transcript defines initials.
    contract("AvatarFallback", ["text-xs", "font-semibold"]),
    // Speaker/authored material is resolved at the player boundary, outside shared UI.
    contract("BubbleContent", ["message-speaker", "message-authored"]),
  ]),
];
