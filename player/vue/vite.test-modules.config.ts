import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { testModulesSources } from "./test-modules-sources.ts";

/**
 * The Player browser-source modules that compiled Node tests load through `tests/helpers/player-modules.ts`. Knip cannot
 * follow that loader, so `knip.json` lists the same modules as entries, and by default Knip reports none of their exports
 * as unused. `tools/knip-entries.test.mjs` checks that the two lists match.
 */
const modules = [
  "player/media/captured-media.ts",
  "player/runtime/compile-project.ts",
  "player/engine-bridge/client.ts",
  "player/engine-bridge/in-process.ts",
  "player/runtime/player-bridge.ts",
  "player/runtime/runtime-adapter.ts",
  "player/runtime/runtime-view.ts",
  "player/persistence/saved-data.ts",
  "player/theme/palette.ts",
  "player/theme/photo-theme.ts",
  "player/vue/src/debug/debugStageImage.ts",
  "player/vue/src/debug/random/randomDrawPresentation.ts",
  "player/vue/src/session/runtime-input.ts",
  "player/vue/src/hostedScript.ts",
  "player/vue/src/development/scenarioStart.ts",
  "player/vue/src/stage/stagePhotos.ts",
  "player/vue/src/transcript/transcriptPresentation.ts",
  "player/vue/src/debug/random/useDebugRandom.ts",
  "player/vue/src/debug/random/useRandomDrawPickerState.ts",
  "player/vue/src/session/useRuntimeSceneClock.ts",
  "player/vue/src/debug/history/useDebugRewind.ts",
  "player/vue/src/debug/useDebugView.ts",
  "player/vue/src/debug/useDevelopmentTime.ts",
  "player/vue/src/stage/useImageCapture.ts",
  "player/vue/src/interaction/useAnswerSubmission.ts",
  "player/vue/src/interaction/useComposerState.ts",
  "player/vue/src/interaction/useFormUpdates.ts",
  "player/vue/src/transcript/useMessageUpdateAnnouncements.ts",
  "player/vue/src/debug/usePlayerDebug.ts",
  "player/vue/src/notifications/usePlayerNotifications.ts",
  "player/vue/src/shell/usePlayerPreference.ts",
  "player/vue/src/session/usePlayerSession.ts",
  "player/vue/src/session/usePlayerSessionServices.ts",
  "player/vue/src/shell/usePlayerTheme.ts",
  "player/vue/src/notifications/usePlayerToasts.ts",
  "player/vue/src/stage/useStagePhoto.ts",
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
