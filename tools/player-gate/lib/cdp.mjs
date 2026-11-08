// CDP reads the gate takes in Chromium and on the Pixel: the heap of the page and of each dedicated Worker
// (`Runtime.getHeapUsage`, with Workers reached through `Target.setAutoAttach` and `Target.sendMessageToTarget`, as the
// research's V3/V4 profiles did), and clearing an origin's data for a cold sample in the phone's own profile.

/**
 * Attaches to the page's dedicated Workers through `cdp` (a page CDP session) and returns `read(gc)`, which resolves
 * with the page's heap and each Worker's, by script URL; with `gc`, after a forced collection in each. A Worker that
 * does not answer within `timeoutMs` reads as `{ error }`.
 */
export async function heapReader(cdp, timeoutMs = 5000) {
  const workers = new Map();
  const pending = new Map();
  let nextId = 1;
  cdp.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
    if (targetInfo.type === "worker") workers.set(sessionId, targetInfo.url);
  });
  cdp.on("Target.detachedFromTarget", ({ sessionId }) => workers.delete(sessionId));
  cdp.on("Target.receivedMessageFromTarget", ({ message }) => {
    const reply = JSON.parse(message);
    const waiting = pending.get(reply.id);
    if (waiting === undefined) return;
    pending.delete(reply.id);
    if (reply.error) waiting.reject(new Error(reply.error.message));
    else waiting.resolve(reply.result);
  });
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: false,
  });
  const inWorker = (sessionId, method) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      void cdp
        .send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method }) })
        .catch(reject);
    });
  return async function read(gc = false) {
    if (gc) await cdp.send("HeapProfiler.collectGarbage");
    const page = await cdp.send("Runtime.getHeapUsage");
    const read = [];
    for (const [sessionId, url] of workers) {
      try {
        if (gc) await inWorker(sessionId, "HeapProfiler.collectGarbage");
        const heap = await inWorker(sessionId, "Runtime.getHeapUsage");
        read.push({ url, usedBytes: heap.usedSize, totalBytes: heap.totalSize });
      } catch (error) {
        read.push({ url, error: error.message });
      }
    }
    return { gc, page: { usedBytes: page.usedSize, totalBytes: page.totalSize }, workers: read };
  };
}

/** Removes every kind of site data of `origin` and the HTTP cache, through `cdp`, for a cold sample in a kept profile. */
export async function clearOrigin(cdp, origin) {
  await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
  await cdp.send("Network.clearBrowserCache");
}
