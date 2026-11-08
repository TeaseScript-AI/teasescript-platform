// Builds the bridge page (`index.html`, `page.mjs`) and its engine Worker (`worker-entry.mjs`) as production builds the
// Player's: an ES module Worker, the compiler in a chunk only a source `prepare` loads. Served by the gate host under
// `/gate-bridge/`. OUT names the output folder: `OUT=<dir> npx vite build --config tools/player-gate/bridge/vite.config.mjs`.
// Every importer of the bridge client but the wrapper itself gets the instrumented variant's client
// (`variants/instrumented-client.mjs`), so both backends' requests and replies are logged at the same seam.
import { fileURLToPath } from "node:url";

const WRAPPER = fileURLToPath(new URL("../variants/instrumented-client.mjs", import.meta.url));

function instrumentedClient() {
  return {
    name: "player-gate-bridge-client",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer === undefined || importer === WRAPPER) return null;
      const client =
        /engine-bridge\/client\.[jt]s$/u.test(source) ||
        (source === "./client.js" && importer.includes("/player/engine-bridge/"));
      return client ? WRAPPER : null;
    },
  };
}

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
  plugins: [instrumentedClient()],
  worker: { format: "es" },
  build: { outDir: out, emptyOutDir: true, target: "es2025", sourcemap: false },
};
