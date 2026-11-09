/* global fetch */
// The bridge page's replay mode (`?tape=<file>&backend=worker|inprocess`): one fixed K/F tape, recorded in Node by
// `tapes/record.mjs`, sent request by request through one backend of this browser, each reply compared with the recorded
// one (`replayTape`, `tests/gate/tape.ts`: the same comparison the Node Worker replay makes). The tape is served under
// `/gate-tapes/` by `tapes/browser.mjs`, which reads the result from `window.__gateReplay`.
import { connectBridge } from "../../../player/engine-bridge/client.ts";
import { createInProcessBackend } from "../../../player/engine-bridge/in-process.ts";
import { playerBuildIdentity } from "../../../player/build-identity.ts";
import { replayTape } from "../../../tests/gate/tape.ts";

/**
 * Replays the tape file `tape` through `backend` (`worker`: a fresh engine Worker from `workerPort()`; otherwise the
 * in-process backend), and resolves with `{ tape, backend, entries, difference, error, done }`: `difference` is the
 * first entry whose reply differs (`null` when none does), `error` what stopped the replay before it compared.
 */
export async function replay(tape, backend, workerPort) {
  const result = { tape, backend, entries: null, difference: null, error: null, done: false };
  try {
    const response = await fetch(`/gate-tapes/${encodeURIComponent(tape)}`);
    if (!response.ok) throw new Error(`the tape ${tape} is not served: ${response.status}`);
    const recorded = await response.json();
    result.entries = recorded.entries.length;
    const client =
      backend === "worker"
        ? await connectBridge(workerPort(), playerBuildIdentity)
        : createInProcessBackend(playerBuildIdentity).client;
    try {
      result.difference = await replayTape(client, recorded.entries);
    } finally {
      client.terminate();
    }
  } catch (error) {
    result.error = String(error?.stack ?? error);
  }
  result.done = true;
  return result;
}
