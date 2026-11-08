/* global self, performance */
// The bridge page's engine Worker: the product's host (`engine-host.ts`) behind a wrapper of the scope's message I/O,
// which logs when each request arrives and each reply leaves, on the epoch-based clock (`timeOrigin + now()`), in
// `globalThis.__gateWorker`; the driver reads it with Playwright's `worker.evaluate`. Like `engine.worker.ts`, it only
// loads the host, and a host that fails to load is rethrown as an uncaught error, so the page sees a startup failure.
const log = [];
globalThis.__gateWorker = log;
const stamp = () => performance.timeOrigin + performance.now();
const post = self.postMessage.bind(self);
self.postMessage = (message, ...rest) => {
  log.push({ dir: "reply", at: stamp(), id: message?.id ?? null, kind: message?.kind ?? null });
  return post(message, ...rest);
};
const listen = self.addEventListener.bind(self);
self.addEventListener = (type, listener, ...rest) =>
  listen(
    type,
    type === "message"
      ? (event) => {
          log.push({
            dir: "request",
            at: stamp(),
            id: event.data?.id ?? null,
            op: event.data?.op ?? null,
          });
          return listener(event);
        }
      : listener,
    ...rest,
  );
import("../../../player/engine-bridge/engine-host.ts").catch((error) => {
  setTimeout(() => {
    throw error;
  });
});
