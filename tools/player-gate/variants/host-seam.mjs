// The gate variants' host seam (`vite.config.mjs`): `main.ts` gets `observed-host.mjs` for `hostedScript.ts`, which gives
// the driver the Player's host object. A build whose swap did not happen fails.
import { fileURLToPath } from "node:url";

/** The plugin that swaps the Player entry's import of the hosted script. */
export function hostSeam() {
  let swapped = false;
  return {
    name: "player-gate-host",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer === undefined || !importer.endsWith("/player/vue/src/main.ts")) return null;
      if (source !== "./hostedScript") return null;
      swapped = true;
      return fileURLToPath(new URL("observed-host.mjs", import.meta.url));
    },
    buildEnd() {
      if (!swapped) throw new Error("the gate's host seam swapped no hosted script import");
    },
  };
}
