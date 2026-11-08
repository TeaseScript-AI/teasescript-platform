/* global __GATE_DELAY_MS__ */
// The `delayed` variant's `engine-bridge/client.ts` for a Worker port: the product module, with `openBridge` and
// `connectBridge` delivering everything the port receives (replies, stop acknowledgements, `ready`) after
// `__GATE_DELAY_MS__`, in the order received; requests are not delayed. Terminating the port cancels what is still
// waiting. The in-process backend's own port is not wrapped (`vite.config.mjs`): its `delayMs` delays it instead.
import * as client from "../../../player/engine-bridge/client.ts";

export * from "../../../player/engine-bridge/client.ts";

function delayed(port) {
  const waiting = new Set();
  return {
    ...port,
    listen(listener) {
      port.listen((data) => {
        const timer = setTimeout(() => {
          waiting.delete(timer);
          listener(data);
        }, __GATE_DELAY_MS__);
        waiting.add(timer);
      });
    },
    terminate() {
      for (const timer of waiting) clearTimeout(timer);
      waiting.clear();
      port.terminate();
    },
  };
}

export function openBridge(port, build) {
  return client.openBridge(delayed(port), build);
}

export function connectBridge(port, build) {
  return client.connectBridge(delayed(port), build);
}
