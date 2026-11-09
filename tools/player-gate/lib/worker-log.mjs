/* global performance */
// The gate's Worker-side log: wraps a Worker scope's message I/O so that each request's arrival and each reply's post
// is logged, by request ID, on the epoch-based clock (`timeOrigin + now()`), in `globalThis.__gateWorker`. The bridge
// page's Worker entry calls it before importing the host; the full Player's engine Worker gets it injected through CDP
// (`cdp.mjs`), so it uses nothing outside its own body.
export function wrapWorkerScope(scope) {
  const log = [];
  globalThis.__gateWorker = log;
  const stamp = () => performance.timeOrigin + performance.now();
  const post = scope.postMessage.bind(scope);
  scope.postMessage = (message, ...rest) => {
    log.push({ dir: "reply", at: stamp(), id: message?.id ?? null, kind: message?.kind ?? null });
    return post(message, ...rest);
  };
  const listen = scope.addEventListener.bind(scope);
  scope.addEventListener = (type, listener, ...rest) =>
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
}
