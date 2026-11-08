/* global window, location, fetch, performance, Worker */
// The bridge page: the product's bridge below the Player, on either backend, for the bridge-level numbers (Worker
// start, plan transfer, `prepare` per route, Start and Continue) and the taps on the main thread while a script is
// prepared. `?script=<name>&route=plan|source&backend=worker|inprocess` picks the case; its input is
// `/gate-inputs/<name>.<route>.json` (`inputs.mjs`). With `hold`, the page waits for `window.__gateRun()`, which the
// taps cohort calls once its taps are flowing; otherwise it runs at once. The result is `window.__gateBridge`.
import { connectBridge } from "../../../player/engine-bridge/client.ts";
import { createInProcessBackend } from "../../../player/engine-bridge/in-process.ts";
import { playerBuildIdentity } from "../../../player/build-identity.ts";
import { PlayerBridge } from "../../../player/player-bridge.ts";
import { DEMO_PLAYER_PROFILE } from "../../../player/demo-player-profile.ts";
import { captureTemporalContext } from "../../../src/temporal-capture.ts";

const query = new URLSearchParams(location.search);
const script = query.get("script");
const route = query.get("route");
const backend = query.get("backend");
const now = () => performance.now();
// Start and Continue capture the same fixed moment, so every case starts the same session.
const capture = () => ({
  wallClockMs: Date.UTC(2026, 10, 8, 12),
  temporalContext: captureTemporalContext("UTC", "en-US"),
});

// Each post to the Worker: its op and ID, when it began and how long `postMessage` took, on the page clock.
const posts = [];

function workerPort() {
  const worker = new Worker(new URL("./worker-entry.mjs", import.meta.url), { type: "module" });
  return {
    post: (message) => {
      const at = now();
      worker.postMessage(message);
      posts.push({ op: message?.op ?? null, id: message?.id ?? null, at, postMs: now() - at });
    },
    listen: (listener) => worker.addEventListener("message", (event) => listener(event.data)),
    onFailure: (listener) => {
      worker.addEventListener("error", listener);
      worker.addEventListener("messageerror", listener);
    },
    terminate: () => worker.terminate(),
  };
}

async function run() {
  const result = { script, route, backend, ok: false, at: {}, posts };
  window.__gateBridge = result;
  try {
    const input = await (await fetch(`/gate-inputs/${script}.${route}.json`)).text();
    const source =
      route === "plan"
        ? { kind: "plan", text: input }
        : { kind: "source", script: JSON.parse(input) };
    result.inputUnits = input.length;
    result.at.start = now();
    let bridge;
    if (backend === "worker") {
      const client = await connectBridge(workerPort(), playerBuildIdentity);
      bridge = new PlayerBridge(client);
    } else bridge = createInProcessBackend(playerBuildIdentity);
    result.at.ready = now();
    const client = bridge.client;
    const prepared = await client.request("prepare", { source });
    result.at.prepared = now();
    const plan = prepared.result.plan;
    if (prepared.result.kind !== "prepared") throw new Error(`prepare: ${prepared.result.kind}`);
    const session = await bridge.start(
      plan,
      { ...capture(), playerProfile: DEMO_PLAYER_PROFILE },
      true,
    );
    result.at.started = now();
    // Continue as the Player continues a kept session: the kept state captured, restored, then continued.
    await client.request("preparePlanText", { plan });
    const kept = await bridge.read(session, "captureKeep", { plan });
    result.at.captured = now();
    if (kept.kind !== "captured") throw new Error(`captureKeep: ${kept.kind}`);
    const shown = bridge.latest(session) ?? session;
    const restored = await bridge.restoreKept(
      plan,
      kept.planJson,
      kept.snapshotJson,
      shown.events,
      shown.marks,
    );
    result.at.restored = now();
    if (typeof restored === "string") throw new Error(`restoreKept: ${restored}`);
    await client.request("continue", { capture: capture() }, { session: restored.id });
    result.at.continued = now();
    result.ok = true;
  } catch (error) {
    result.error = String(error?.stack ?? error);
  }
  return result;
}

if (query.has("hold")) window.__gateRun = run;
else void run();
