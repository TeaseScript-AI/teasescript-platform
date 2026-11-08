// The gate's variants of the production Player: the production config (`player/vue/vite.config.ts`) with one plugin
// that gives chosen importers a gate wrapper instead of a product module. No product file changes. Run from the
// tree's root: `GATE_VARIANT=<variant> OUT=<dir> npx vite build --config tools/player-gate/variants/vite.config.mjs`.
//
// - `instrumented`: every importer of `engine-bridge/client.js` gets `instrumented-client.mjs`, whose `openBridge` and
//   `connectBridge` wrap the port they are given and log each request's post and each reply's arrival, so both
//   backends have the same seam;
// - `delayed`: `usePlayerSession.ts` gets `delayed-in-process.mjs`, whose `createInProcessBackend` delivers replies
//   after GATE_DELAY_MS (the in-process backend's own `delayMs`); every other importer of `client.js` gets
//   `delayed-client.mjs`, which delivers what a Worker port receives after the same delay, in order. The in-process
//   backend's own `openBridge` call is left alone, so no reply is delayed twice.
import { fileURLToPath } from "node:url";
import productionConfig from "../../../player/vue/vite.config.ts";

const variant = process.env.GATE_VARIANT;
const out = process.env.OUT;
const delayMs = Number(process.env.GATE_DELAY_MS ?? "0");
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

function gateSwap() {
  return {
    name: "player-gate-variant",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer === undefined || WRAPPERS.has(importer)) return null;
      if (
        variant === "delayed" &&
        importer.endsWith("/player/vue/src/usePlayerSession.ts") &&
        source.endsWith("engine-bridge/in-process.js")
      )
        return here("delayed-in-process.mjs");
      const client =
        source.endsWith("engine-bridge/client.js") ||
        (source === "./client.js" && importer.includes("/player/engine-bridge/"));
      if (!client) return null;
      if (variant === "instrumented") return here("instrumented-client.mjs");
      return importer === IN_PROCESS ? null : here("delayed-client.mjs");
    },
  };
}

export default async (environment) => {
  const base = await productionConfig(environment);
  return {
    ...base,
    define: { ...base.define, __GATE_DELAY_MS__: JSON.stringify(delayMs) },
    plugins: [gateSwap(), ...base.plugins],
    build: { ...base.build, outDir: out, emptyOutDir: true },
  };
};
