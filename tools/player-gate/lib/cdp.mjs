// CDP reads the gate takes in Chromium and on the Pixel, on one page CDP session: the page's dedicated Workers through
// `Target.setAutoAttach` (paused at their start until set up) and `Target.sendMessageToTarget`, as the research's V3/V4
// profiles did; the served bytes of the page and of each Worker (`Network`); the heap of each (`Runtime.getHeapUsage`);
// optionally the gate's Worker-side log injected into the engine Worker; the page's `Performance.getMetrics`; and
// clearing an origin's data for a cold sample in the phone's own profile.
import { wrapWorkerScope } from "./worker-log.mjs";

const ENGINE_WORKER = /engine/u;

/**
 * Sets up the reads on `cdp`, a page CDP session, before the page navigates. With `network`, every request of the page
 * and its Workers is recorded; with `inject`, the engine Worker gets the gate's Worker-side log before its script runs.
 * Either pauses each Worker at its start until it is set up (`waitForDebuggerOnStart`), so neither belongs in a headline
 * sample. Returns:
 * - `heap(gc)`: the page's heap and each Worker's, by script URL, after a forced collection in each with `gc`;
 * - `requests()`: every request of the page and its Workers so far: target, URL, start (`wallTimeMs`, epoch), status,
 *   encoded and decoded bytes, and whether it finished, failed or came from a cache;
 * - `workers()`: the Workers attached so far, with any setup error;
 * - `workerLog()`: the engine Worker's injected log (with `inject`);
 * - `metrics()`: the page's `Performance.getMetrics` (page only);
 * - `dispose()`: removes every listener and turns auto-attach off.
 */
export async function cdpReads(
  cdp,
  { network: account = false, inject = false, timeoutMs = 5000 } = {},
) {
  const pause = account || inject;
  const workers = new Map();
  const pending = new Map();
  const requests = new Map();
  const listeners = [];
  let nextId = 1;
  const on = (event, handler) => {
    cdp.on(event, handler);
    listeners.push([event, handler]);
  };
  // Request IDs are the browser's, one per request across targets: a Worker's script request starts on the page and
  // finishes on the Worker's own target (probe job 1109011128be03, Chromium), so it belongs to the Worker.
  const network = (target, method, params) => {
    const key = params.requestId;
    if (method === "Network.requestWillBeSent") {
      if (requests.has(key)) return;
      requests.set(key, {
        target,
        url: params.request.url,
        wallTimeMs: params.wallTime * 1000,
        status: null,
        encodedBytes: null,
        decodedBytes: 0,
        finished: false,
        failed: null,
        fromCache: false,
      });
      return;
    }
    const request = requests.get(key);
    if (request === undefined) return;
    if (target !== "page") request.target = target;
    if (method === "Network.responseReceived") {
      request.status = params.response.status;
      request.fromCache =
        params.response.fromDiskCache === true || params.response.fromServiceWorker === true;
    } else if (method === "Network.dataReceived") request.decodedBytes += params.dataLength;
    else if (method === "Network.loadingFinished") {
      request.finished = true;
      request.encodedBytes = params.encodedDataLength;
    } else if (method === "Network.loadingFailed") request.failed = params.errorText;
  };
  if (account)
    for (const method of [
      "Network.requestWillBeSent",
      "Network.responseReceived",
      "Network.dataReceived",
      "Network.loadingFinished",
      "Network.loadingFailed",
    ])
      on(method, (params) => network("page", method, params));
  const inWorker = (sessionId, method, params = {}) =>
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
      cdp
        .send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((error) => pending.get(id)?.reject(error));
    });
  on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
    const data = JSON.parse(message);
    if (data.id === undefined) {
      if (typeof data.method === "string" && data.method.startsWith("Network."))
        network(workers.get(sessionId)?.url ?? sessionId, data.method, data.params);
      return;
    }
    const waiting = pending.get(data.id);
    if (waiting === undefined) return;
    pending.delete(data.id);
    if (data.error) waiting.reject(new Error(data.error.message));
    else waiting.resolve(data.result);
  });
  on("Target.attachedToTarget", ({ sessionId, targetInfo, waitingForDebugger }) => {
    if (targetInfo.type !== "worker") {
      if (waitingForDebugger)
        void inWorker(sessionId, "Runtime.runIfWaitingForDebugger").catch(() => {});
      return;
    }
    const worker = { url: targetInfo.url, errors: [] };
    workers.set(sessionId, worker);
    void (async () => {
      if (account)
        try {
          await inWorker(sessionId, "Network.enable");
        } catch (error) {
          worker.errors.push(`Network.enable: ${error.message}`);
        }
      if (inject && ENGINE_WORKER.test(targetInfo.url))
        try {
          await inWorker(sessionId, "Runtime.evaluate", {
            expression: `(${wrapWorkerScope})(self)`,
          });
          worker.injected = true;
        } catch (error) {
          worker.errors.push(`injection: ${error.message}`);
        }
      if (waitingForDebugger)
        await inWorker(sessionId, "Runtime.runIfWaitingForDebugger").catch((error) =>
          worker.errors.push(`resume: ${error.message}`),
        );
    })();
  });
  on("Target.detachedFromTarget", ({ sessionId }) => {
    const worker = workers.get(sessionId);
    if (worker !== undefined) worker.detached = true;
  });
  if (account) await cdp.send("Network.enable");
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: pause,
    flatten: false,
  });
  const live = () => [...workers].filter(([, worker]) => !worker.detached);
  return {
    async heap(gc = false) {
      if (gc) await cdp.send("HeapProfiler.collectGarbage");
      const page = await cdp.send("Runtime.getHeapUsage");
      const read = [];
      for (const [sessionId, { url }] of live()) {
        try {
          if (gc) await inWorker(sessionId, "HeapProfiler.collectGarbage");
          const heap = await inWorker(sessionId, "Runtime.getHeapUsage");
          read.push({
            url,
            engine: ENGINE_WORKER.test(url),
            usedBytes: heap.usedSize,
            totalBytes: heap.totalSize,
          });
        } catch (error) {
          read.push({ url, engine: ENGINE_WORKER.test(url), error: error.message });
        }
      }
      return { gc, page: { usedBytes: page.usedSize, totalBytes: page.totalSize }, workers: read };
    },
    requests: () => [...requests.values()].map((request) => ({ ...request })),
    workers: () => [...workers.values()].map((worker) => ({ ...worker })),
    async workerLog() {
      const engine = live().find(([, worker]) => ENGINE_WORKER.test(worker.url));
      if (engine === undefined) return null;
      const result = await inWorker(engine[0], "Runtime.evaluate", {
        expression: "JSON.stringify(globalThis.__gateWorker ?? null)",
        returnByValue: true,
      });
      return JSON.parse(result.result.value);
    },
    async metrics() {
      await cdp.send("Performance.enable");
      const { metrics } = await cdp.send("Performance.getMetrics");
      return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
    },
    async dispose() {
      for (const [event, handler] of listeners) cdp.off(event, handler);
      for (const { reject } of pending.values()) reject(new Error("disposed"));
      pending.clear();
      await cdp
        .send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false })
        .catch(() => {});
    },
  };
}

/**
 * Clears each of `origins`' site data and then the HTTP cache through `cdp`, each attempted after an earlier one failed;
 * throws one error naming every failure once all were attempted.
 */
export async function clearOriginsThrough(cdp, origins) {
  const failures = [];
  const attempt = async (what, send) => {
    try {
      await send();
    } catch (error) {
      failures.push(`${what}: ${error?.message ?? error}`);
    }
  };
  for (const origin of origins)
    await attempt(origin, () =>
      cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" }),
    );
  await attempt("the HTTP cache", () => cdp.send("Network.clearBrowserCache"));
  if (failures.length > 0) throw new Error(`clearing failed for ${failures.join("; ")}`);
}

/** Removes every kind of site data of `origin` and the HTTP cache, through `cdp`, for a cold sample in a kept profile. */
export async function clearOrigin(cdp, origin) {
  await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
  await cdp.send("Network.clearBrowserCache");
}
