/* global self */
// The bridge page's engine Worker: the product's host (`engine-host.ts`) behind the gate's Worker-side log
// (`lib/worker-log.mjs`), read by the driver with Playwright's `worker.evaluate`. Like `engine.worker.ts`, it only loads
// the host, and a host that fails to load is rethrown as an uncaught error, so the page sees a startup failure.
import { wrapWorkerScope } from "../lib/worker-log.mjs";

wrapWorkerScope(self);
import("../../../player/engine-bridge/engine-host.ts").catch((error) => {
  setTimeout(() => {
    throw error;
  });
});
