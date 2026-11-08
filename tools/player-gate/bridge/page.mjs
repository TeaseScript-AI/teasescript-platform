/* global window, location, fetch, performance, Worker */
// The bridge page: the product's bridge below the Player, on either backend, for the bridge-level numbers (Worker
// start, plan transfer, `prepare` per route, Start and Continue) and the taps on the main thread while a script is
// prepared. `?script=<name>&route=plan|source&backend=worker|inprocess` picks the case; its input is
// `/gate-inputs/<name>.<route>.json` (`inputs.mjs`). With `hold`, the page waits for `window.__gateRun()`, which the
// taps cohort calls once its taps are flowing, and stops after `prepare`'s reply; otherwise it runs at once, to
// Continue. The result is `window.__gateBridge`: each request with its reply on both backends, by ID and op, from the
// instrumented client (the build swaps it in, `vite.config.mjs`), and on a Worker its construction and `ready`.
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

/** A Worker port, recording into `at` when the Worker was constructed and when its `ready` arrived. */
function workerPort(at) {
  at.workerConstructed = now();
  const worker = new Worker(new URL("./worker-entry.mjs", import.meta.url), { type: "module" });
  return {
    post: (message) => worker.postMessage(message),
    listen: (listener) =>
      worker.addEventListener("message", (event) => {
        if (at.workerReady === undefined && event.data?.kind === "ready") at.workerReady = now();
        listener(event.data);
      }),
    onFailure: (listener) => {
      worker.addEventListener("error", listener);
      worker.addEventListener("messageerror", listener);
    },
    terminate: () => worker.terminate(),
  };
}

/** Each request the instrumented client logged, with its reply: op, ID, post and reply times, post duration. */
function requests() {
  const log = globalThis.__gateBridgeLog ?? [];
  const replies = new Map(
    log.filter((entry) => entry.dir === "reply").map((entry) => [entry.id, entry]),
  );
  return log
    .filter((entry) => entry.dir === "post")
    .map((post) => ({
      op: post.op,
      id: post.id,
      postAt: post.at,
      postMs: post.postMs,
      replyAt: replies.get(post.id)?.at ?? null,
    }));
}

async function run() {
  const result = { script, route, backend, ok: false, at: {} };
  window.__gateBridge = result;
  try {
    const input = await (await fetch(`/gate-inputs/${script}.${route}.json`)).text();
    const source =
      route === "plan"
        ? { kind: "plan", text: input }
        : { kind: "source", script: JSON.parse(input) };
    result.inputUnits = input.length;
    result.inputBytes = new TextEncoder().encode(input).length;
    let bridge;
    if (backend === "worker") {
      const client = await connectBridge(workerPort(result.at), playerBuildIdentity);
      bridge = new PlayerBridge(client);
    } else bridge = createInProcessBackend(playerBuildIdentity);
    const client = bridge.client;
    const prepared = await client.request("prepare", { source });
    const plan = prepared.result.plan;
    if (prepared.result.kind !== "prepared") throw new Error(`prepare: ${prepared.result.kind}`);
    // The taps cohort's window ends at `prepare`'s reply: nothing after it runs while taps are sent.
    if (query.has("hold")) {
      result.ok = true;
      return result;
    }
    const session = await bridge.start(
      plan,
      { ...capture(), playerProfile: DEMO_PLAYER_PROFILE },
      true,
    );
    // Continue as the Player continues a kept session: the kept state captured, restored, then continued.
    await client.request("preparePlanText", { plan });
    const kept = await bridge.read(session, "captureKeep", { plan });
    if (kept.kind !== "captured") throw new Error(`captureKeep: ${kept.kind}`);
    const shown = bridge.latest(session) ?? session;
    const restored = await bridge.restoreKept(
      plan,
      kept.planJson,
      kept.snapshotJson,
      shown.events,
      shown.marks,
    );
    if (typeof restored === "string") throw new Error(`restoreKept: ${restored}`);
    await client.request("continue", { capture: capture() }, { session: restored.id });
    result.ok = true;
  } catch (error) {
    result.error = String(error?.stack ?? error);
  } finally {
    result.requests = requests();
  }
  return result;
}

if (query.has("hold")) window.__gateRun = run;
else void run();
