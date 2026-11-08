/* global performance */
// The `instrumented` variant's `engine-bridge/client.ts`: the product module, with `openBridge` and `connectBridge`
// wrapping the port they are given so that each request's post (its start and how long `post` took) and each reply's
// arrival are logged, by request ID, on the page clock, in `globalThis.__gateBridgeLog`. The calls go through
// unchanged and in the same order.
import * as client from "../../../player/engine-bridge/client.ts";

export * from "../../../player/engine-bridge/client.ts";

const log = (globalThis.__gateBridgeLog ??= []);

function logged(port) {
  return {
    ...port,
    post(message) {
      const at = performance.now();
      port.post(message);
      log.push({
        dir: "post",
        at,
        postMs: performance.now() - at,
        id: message?.id ?? null,
        op: message?.op ?? null,
        session: message?.session ?? null,
      });
    },
    listen(listener) {
      port.listen((data) => {
        log.push({
          dir: "reply",
          at: performance.now(),
          id: data?.id ?? null,
          kind: data?.kind ?? null,
          ok: data?.ok ?? null,
        });
        listener(data);
      });
    },
  };
}

export function openBridge(port, build) {
  return client.openBridge(logged(port), build);
}

export function connectBridge(port, build) {
  return client.connectBridge(logged(port), build);
}
