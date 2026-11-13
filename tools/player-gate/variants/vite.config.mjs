// The gate's variants of the production Player: the production config (`player/vue/vite.config.ts`) with one plugin
// that gives chosen importers a gate wrapper instead of a product module. No product file changes. Run from the
// tree's root: `GATE_VARIANT=<variant> OUT=<dir> npx vite build --config tools/player-gate/variants/vite.config.mjs`.
//
// - `instrumented`: every importer of `engine-bridge/client.js` gets `instrumented-client.mjs`, whose `openBridge` and
//   `connectBridge` wrap the port they are given and log each request's post and each reply's arrival;
// - `delayed`: every importer of `client.js` gets `delayed-client.mjs`, which delivers what the Worker's port receives
//   after GATE_DELAY_MS, in order.
// The swap and its refusal of a variant whose swap did not happen are `swap.mjs`'s. Both variants give the driver the
// Player's host object (`host-seam.mjs`).
import productionConfig from "../../../player/vue/vite.config.ts";
import { hostSeam } from "./host-seam.mjs";
import { gateSwap } from "./swap.mjs";

const variant = process.env.GATE_VARIANT;
const out = process.env.OUT;
const delayMs = Number(process.env.GATE_DELAY_MS ?? "0");
if (variant !== "instrumented" && variant !== "delayed")
  throw new Error("GATE_VARIANT is neither instrumented nor delayed");
if (!out) throw new Error("OUT names no output folder for the variant");
if (variant === "delayed" && !(Number.isInteger(delayMs) && delayMs >= 0))
  throw new Error("GATE_DELAY_MS is no whole number of ms");

export default async (environment) => {
  const base = await productionConfig(environment);
  return {
    ...base,
    define: { ...base.define, __GATE_DELAY_MS__: JSON.stringify(delayMs) },
    plugins: [hostSeam(), gateSwap({ variant }), ...base.plugins],
    build: { ...base.build, outDir: out, emptyOutDir: true },
  };
};
