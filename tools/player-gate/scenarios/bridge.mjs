// The bridge page (`bridge/page.mjs`), the diagnostic cohort's bridge-level numbers: on either backend and route, the
// Worker's start, `prepare`'s round trip and the Worker's own handling of it (from the gate Worker entry's log),
// Start, and Continue (keep capture, restore, continue). On a Worker the page's post of `prepare` and its receipt in
// the Worker are both on the epoch-based clock, so their difference is the delivery latency, queueing included.

const RUN_MS = 180_000;

/** The bridge page's URL for one case. */
export const bridgeUrl = (origin, { script, route, backend }, hold = false) =>
  `${origin}/gate-bridge/index.html?script=${encodeURIComponent(script)}&route=${route}&backend=${backend === "main" ? "inprocess" : "worker"}${hold ? "&hold" : ""}`;

/** The Worker side of the case's `prepare`, read from the gate Worker entry's log: receipt → reply, post, delivery. */
export async function workerSide(page, result) {
  const worker = page.workers().find((candidate) => candidate.url().includes("worker-entry"));
  if (worker === undefined) return {};
  const [log, origin] = await Promise.all([
    worker.evaluate(() => globalThis.__gateWorker),
    page.evaluate(() => performance.timeOrigin),
  ]);
  const request = log.find((entry) => entry.dir === "request" && entry.op === "prepare");
  const reply =
    request === undefined
      ? undefined
      : log.find((entry) => entry.dir === "reply" && entry.id === request.id);
  const post = (result.posts ?? []).find((entry) => entry.op === "prepare");
  return {
    prepareInWorkerMs: request && reply ? reply.at - request.at : null,
    preparePostMs: post?.postMs ?? null,
    prepareDeliveryMs: request && post ? request.at - (origin + post.at) : null,
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
