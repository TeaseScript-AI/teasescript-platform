import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

/** The Player browser-source modules that compiled Node tests load through `tests/helpers/player-modules.ts`. */
const modules = [
  "player/runtime-adapter.ts",
  "player/saved-data.ts",
  "player/vue/src/randomDrawPresentation.ts",
  "player/vue/src/useDebugRandom.ts",
  "player/vue/src/useDebugRewind.ts",
  "player/vue/src/useDevelopmentTime.ts",
  "player/vue/src/useImageCapture.ts",
  "player/vue/src/useMessageUpdateAnnouncements.ts",
  "player/vue/src/usePlayerDebug.ts",
  "player/vue/src/usePlayerNotifications.ts",
  "player/vue/src/usePlayerSession.ts",
  "player/vue/src/usePlayerToasts.ts",
];

// One server-side bundle for all test processes, built with the other UI builds, instead of every test file
// transforming the Player and the engine sources again. Shared modules become shared chunks, so the entries keep one
// module graph; dependencies such as `vue` stay external, so tests and composables share one Vue instance.
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  logLevel: "warn",
  publicDir: false,
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
