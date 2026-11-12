// The gate's variants of the production Player: the production config (`player/vue/vite.config.ts`) with one plugin
// that gives chosen importers a gate wrapper instead of a product module. No product file changes. Run from the
// tree's root: `GATE_VARIANT=<variant> OUT=<dir> npx vite build --config tools/player-gate/variants/vite.config.mjs`.
//
// - `instrumented`: every importer of `engine-bridge/client.js` gets `instrumented-client.mjs`, whose `openBridge` and
//   `connectBridge` wrap the port they are given and log each request's post and each reply's arrival, so both
//   backends have the same seam;
// - `delayed`: `session/useEngineConnection.ts` gets `delayed-in-process.mjs`, whose `createInProcessBackend` delivers replies
//   after GATE_DELAY_MS (the in-process backend's own `delayMs`); every other importer of `client.js` gets
//   `delayed-client.mjs`, which delivers what a Worker port receives after the same delay, in order. The in-process
//   backend's own `openBridge` call is left alone, so no reply is delayed twice; with GATE_LOG=1 it gets
//   `instrumented-client.mjs` instead, which logs each reply as it arrives after the delay (a diagnostic build).
// Both give the driver the Player's host object (`host-seam.mjs`).
import { fileURLToPath } from "node:url";
import productionConfig from "../../../player/vue/vite.config.ts";
import { hostSeam } from "./host-seam.mjs";

const variant = process.env.GATE_VARIANT;
const out = process.env.OUT;
const delayMs = Number(process.env.GATE_DELAY_MS ?? "0");
const log = process.env.GATE_LOG === "1";
if (variant !== "instrumented" && variant !== "delayed")
  throw new Error("GATE_VARIANT is neither instrumented nor delayed");
if (!out) throw new Error("OUT names no output folder for the variant");
if (variant === "delayed" && !(Number.isInteger(delayMs) && delayMs >= 0))
  throw new Error("GATE_DELAY_MS is no whole number of ms");

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const WRAPPERS = new Set([
  here("instrumented-client.mjs"),
  here("delayed-client.mjs"),
  here("delayed-in-process.mjs"),
]);
const IN_PROCESS = fileURLToPath(
  new URL("../../../player/engine-bridge/in-process.ts", import.meta.url),
);

/** The Player module that creates the in-process backend, whose import the `delayed` variant swaps. */
const SESSION = "/player/vue/src/session/useEngineConnection.ts";

function gateSwap() {
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
    // the production Player under the variant's name.
    buildEnd() {
      const needed = variant === "delayed" ? ["in-process", "client"] : ["client"];
      const missing = needed.filter((swap) => !swapped.has(swap));
      if (missing.length > 0)
        throw new Error(`the ${variant} variant swapped no ${missing.join(" or ")} import`);
    },
  };
}

export default async (environment) => {
  const base = await productionConfig(environment);
  return {
    ...base,
    define: { ...base.define, __GATE_DELAY_MS__: JSON.stringify(delayMs) },
    plugins: [hostSeam(), gateSwap(), ...base.plugins],
    build: { ...base.build, outDir: out, emptyOutDir: true },
  };
};
