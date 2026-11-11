// The gate variants' import swap (`vite.config.mjs`): the plugin that gives chosen importers a gate wrapper instead of
// a product module, and refuses a build whose swap did not happen.
import { fileURLToPath } from "node:url";

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const WRAPPERS = new Set([
  here("instrumented-client.mjs"),
  here("delayed-client.mjs"),
  here("delayed-in-process.mjs"),
]);
export const IN_PROCESS = fileURLToPath(
  new URL("../../../player/engine-bridge/in-process.ts", import.meta.url),
);

/** The Player module that creates an in-process backend, on a Player from before the activation (#2321). */
const SESSION = "/player/vue/src/session/useEngineConnection.ts";

/** The swap for `variant` (`instrumented` or `delayed`); `log`: a `delayed` build's in-process port logged too. */
export function gateSwap({ variant, log = false }) {
  const swapped = new Set();
  return {
    name: "player-gate-variant",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer === undefined || WRAPPERS.has(importer)) return null;
      if (
        variant === "delayed" &&
        importer.endsWith(SESSION) &&
        source.endsWith("engine-bridge/in-process.js")
      ) {
        swapped.add("in-process");
        return here("delayed-in-process.mjs");
      }
      const client =
        source.endsWith("engine-bridge/client.js") ||
        (source === "./client.js" && importer.includes("/player/engine-bridge/"));
      if (!client) return null;
      swapped.add("client");
      if (variant === "instrumented") return here("instrumented-client.mjs");
      // With GATE_LOG, the in-process backend's own port is logged too, after its delay: when each reply arrives.
      if (importer === IN_PROCESS) return log ? here("instrumented-client.mjs") : null;
      return here("delayed-client.mjs");
    },
    // A variant whose swap never happened (a moved product file) is no variant: the build fails instead of measuring
    // the production Player under the variant's name. Whether the build holds an in-process backend, which `delayed`
    // must then delay too, is read from the module graph, not inferred from the swap: a Worker Player has none.
    buildEnd() {
      const needed = ["client"];
      if (variant === "delayed" && [...this.getModuleIds()].includes(IN_PROCESS))
        needed.push("in-process");
      const missing = needed.filter((swap) => !swapped.has(swap));
      if (missing.length > 0)
        throw new Error(`the ${variant} variant swapped no ${missing.join(" or ")} import`);
    },
  };
}
