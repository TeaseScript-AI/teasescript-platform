import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { testModulesSources } from "./test-modules-sources.ts";

/**
 * The Player browser-source modules that compiled Node tests load through `tests/helpers/player-modules.ts`. Knip cannot
 * follow that loader, so `knip.json` lists the same modules as entries, and by default Knip reports none of their exports
 * as unused. `tools/knip-entries.test.mjs` checks that the two lists match.
 */
const modules = [
  "player/runtime-adapter.ts",
  "player/saved-data.ts",
  "player/theme/palette.ts",
  "player/theme/photo-theme.ts",
  "player/vue/src/randomDrawPresentation.ts",
  "player/vue/src/stagePhotos.ts",
  "player/vue/src/transcriptPresentation.ts",
  "player/vue/src/useDebugRandom.ts",
  "player/vue/src/useDebugRewind.ts",
  "player/vue/src/useDevelopmentTime.ts",
  "player/vue/src/useImageCapture.ts",
  "player/vue/src/useMessageUpdateAnnouncements.ts",
  "player/vue/src/usePlayerDebug.ts",
  "player/vue/src/usePlayerNotifications.ts",
  "player/vue/src/usePlayerPreference.ts",
  "player/vue/src/usePlayerSession.ts",
  "player/vue/src/usePlayerTheme.ts",
  "player/vue/src/usePlayerToasts.ts",
  "player/vue/src/useStagePhoto.ts",
];

// One server-side bundle for all test processes, built with the other UI builds, instead of every test file
// transforming the Player and the engine sources again. Shared modules become shared chunks, so the entries keep one
// module graph; dependencies such as `vue` stay external, so tests and composables share one Vue instance. MCU is
// bundled: its extensionless internal imports do not load in Node. `sources.json` stamps the bundle with its sources.
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  logLevel: "warn",
  publicDir: false,
  plugins: [testModulesSources()],
  ssr: { noExternal: ["@material/material-color-utilities"] },
  build: {
    ssr: true,
    outDir: "dist/player-test-modules",
    emptyOutDir: true,
    sourcemap: process.env.BUILD_SOURCEMAPS !== "0",
    rolldownOptions: {
      input: Object.fromEntries(modules.map((source) => [source.replace(/\.ts$/u, ""), source])),
      output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js" },
    },
  },
});
