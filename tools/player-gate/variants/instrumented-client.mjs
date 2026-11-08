/* global performance */
// The `instrumented` variant's `engine-bridge/client.ts`: the product module, with `openBridge` and `connectBridge`
// wrapping the port they are given so that each request's post (its start and how long `post` took) and each reply's
// arrival are logged, by request ID and op, on the page clock, in `globalThis.__gateBridgeLog`; a `captureKeep`
// reply also logs its size (UTF-16 units of its JSON). The calls go through unchanged and in the same order. The bridge
// page uses it on both backends too.
import * as client from "../../../player/engine-bridge/client.ts";

export * from "../../../player/engine-bridge/client.ts";

const log = (globalThis.__gateBridgeLog ??= []);

function logged(port) {
  const ops = new Map();
  return {
    ...port,
    post(message) {
      const at = performance.now();
      if (message?.id !== undefined) ops.set(message.id, message?.op ?? null);
      port.post(message);
      log.push({
        dir: "post",
        at,
        postMs: performance.now() - at,
        id: message?.id ?? null,
        op: message?.op ?? null,
        session: message?.session ?? null,
        // A time observation's scene time, so a reader can see whether time moves.
        atMs: message?.args?.atMs ?? null,
      });
    },
    listen(listener) {
      port.listen((data) => {
        const at = performance.now();
        const op = ops.get(data?.id) ?? null;
        log.push({
          dir: "reply",
          at,
          id: data?.id ?? null,
          op,
          kind: data?.kind ?? null,
          ok: data?.ok ?? null,
          ...(op === "captureKeep" ? { size: JSON.stringify(data).length } : {}),
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
