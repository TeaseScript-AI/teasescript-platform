// The bridge page (`bridge/page.mjs`), the diagnostic cohort's bridge-level numbers: on either backend and route, each
// request's round trip by ID (`prepare`, `start`, `preparePlanText`, `captureKeep`, the restore's, `continue`), and on a
// Worker its start and each request's handling and delivery latency in the Worker (the gate Worker entry's log).

const RUN_MS = 180_000;

/** The bridge page's URL for one case. */
export const bridgeUrl = (origin, { script, route, backend }, hold = false) =>
  `${origin}/gate-bridge/index.html?script=${encodeURIComponent(script)}&route=${route}&backend=${backend === "main" ? "inprocess" : "worker"}${hold ? "&hold" : ""}`;

/**
 * The Worker side of each request, read from the gate Worker entry's log: the Worker's handling (receipt → reply post)
 * and the delivery latency (receipt − the page's post, on the epoch-based clocks, queueing included).
 */
export async function workerSide(page, result) {
  const worker = page.workers().find((candidate) => candidate.url().includes("worker-entry"));
  if (worker === undefined) return { workerSide: null };
  const [log, origin] = await Promise.all([
    worker.evaluate(() => globalThis.__gateWorker),
    page.evaluate(() => performance.timeOrigin),
  ]);
  return {
    workerSide: (result.requests ?? []).map((request) => {
      const receipt = log.find((entry) => entry.dir === "request" && entry.id === request.id);
      const reply = log.find((entry) => entry.dir === "reply" && entry.id === request.id);
      return {
        op: request.op,
        id: request.id,
        handlingMs: receipt && reply ? reply.at - receipt.at : null,
        deliveryMs: receipt ? receipt.at - (origin + request.postAt) : null,
      };
    }),
  };
}

export async function bridge({ opened, origin, cell }) {
  const { page, close } = await opened.page();
  try {
    await page.goto(bridgeUrl(origin, cell));
    await page.waitForFunction(
      () => window.__gateBridge?.ok === true || window.__gateBridge?.error !== undefined,
      undefined,
      { timeout: RUN_MS },
    );
    const result = await page.evaluate(() => window.__gateBridge);
    return { ...result, ...(result.backend === "worker" ? await workerSide(page, result) : {}) };
  } finally {
    await close();
  }
}
