// Builds the bridge page (`index.html`, `page.mjs`) and its engine Worker (`worker-entry.mjs`) as production builds the
// Player's: an ES module Worker, the compiler in a chunk only a source `prepare` loads. Served by the gate host under
// `/gate-bridge/`. OUT names the output folder: `OUT=<dir> npx vite build --config tools/player-gate/bridge/vite.config.mjs`.
import { fileURLToPath } from "node:url";

const out = process.env.OUT;
if (!out) throw new Error("OUT names no output folder for the bridge page");

export default {
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/gate-bridge/",
  logLevel: "warn",
  publicDir: false,
  define: {
    __PLAYER_BUILD__: JSON.stringify({
      commit: null,
      dirty: null,
      mode: "gate-bridge",
      appVersion: null,
    }),
  },
  worker: { format: "es" },
  build: { outDir: out, emptyOutDir: true, target: "es2025", sourcemap: false },
};
