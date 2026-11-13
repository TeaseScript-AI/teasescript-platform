// The gate variants' import swap (`vite.config.mjs`): the plugin that gives every importer of the Player's engine
// client a gate wrapper instead, and refuses a build whose swap did not happen.
import { fileURLToPath } from "node:url";

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const WRAPPERS = new Set([here("instrumented-client.mjs"), here("delayed-client.mjs")]);

/** The swap for `variant`: `instrumented` or `delayed`. */
export function gateSwap({ variant }) {
  let swapped = false;
  return {
    name: "player-gate-variant",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer === undefined || WRAPPERS.has(importer)) return null;
      const client =
        source.endsWith("engine-bridge/client.js") ||
        (source === "./client.js" && importer.includes("/player/engine-bridge/"));
      if (!client) return null;
      swapped = true;
      return here(variant === "instrumented" ? "instrumented-client.mjs" : "delayed-client.mjs");
    },
    // A variant whose swap never happened (a moved product file) is no variant: the build fails instead of measuring
    // the production Player under the variant's name.
    buildEnd() {
      if (!swapped) throw new Error(`the ${variant} variant swapped no client import`);
    },
  };
}
