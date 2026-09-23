import { plugin as shadcn } from "@shadcn/lint";
import tsParser from "@typescript-eslint/parser";
import vueParser from "vue-eslint-parser";

export default [
  {
    files: ["player/vue/src/components/ui/**/*.vue", "player/vue/src/phase2c/**/*.vue"],
    languageOptions: { parser: vueParser, parserOptions: { parser: tsParser } },
    plugins: { shadcn },
    rules: {
      "shadcn/no-raw-colors": "warn",
      "shadcn/no-unknown-classes": [
        "warn",
        {
          // Structural/debug hooks do not generate CSS utilities.
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
      "shadcn/require-static-classes": "warn",
    },
  },
];
