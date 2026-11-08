import assert from "node:assert/strict";
import test from "node:test";

import { connectBridge } from "../player/engine-bridge/client.js";
import { nodeWorkerPort } from "../player/engine-bridge/node-client.js";
import type { PrepareResult } from "../player/engine-bridge/player-ops.js";
import {
  assembleDebugExport,
  chooseDebugCategory,
  NO_PERSONAL_CONTENT,
  type DebugExportCandidate,
  type DebugExportChoices,
} from "../player/debug-export-assembly.js";
import { debugExportFile, parseDebugExport, replayDebugExport } from "../player/debug-export.js";
import { PlayerBridge } from "../player/player-bridge.js";
import { activePlayerRuntimeInteraction, type PlayerSession } from "../player/runtime-view.js";
import { inProcessBridge } from "./helpers/in-process-bridge.js";

/*
 * #1966's witness (L5h.3b, §21.4 family 6): a debug export of a recorded session in a Worker, from source through the
 * production capture, preparation and release ops, with replay and its prerequisites chosen. It has recorded calls and
 * a complete replay with its checkpoint, it crosses the real file format, it replays offline, and its file is the same
 * byte for byte as the in-process one's.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../player/engine-bridge/node-worker.js", import.meta.url);
const SCRIPT = 'let name = askText "Name?"\nsave "name" as name\nsay "Hi ${name}", instant\nexit';

/** The session's export, assembled from the host's capture with every category chosen, as its file's text. */
async function exportText(bridge: PlayerBridge): Promise<{ text: string; release: () => void }> {
  await bridge.beginRun(1, null);
  const prepared = await bridge.client.request("prepare", {
    source: { kind: "source", script: SCRIPT },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const result = prepared.result as PrepareResult;
  assert.equal(result.kind, "prepared");
  const plan = result.kind === "prepared" ? result.plan : "";
  const session: PlayerSession = await bridge.start(plan, { wallClockMs: 0 }, true);
  const actionId = activePlayerRuntimeInteraction(session.state)?.actionId;
  assert.ok(actionId !== undefined);
  await bridge.request(session, "submitComposer", { actionId, text: "Ann", input: null });
  const candidate = await bridge.captureExport(
    session,
    "current",
    (reply, view): Omit<DebugExportCandidate, "photos"> | null =>
      reply.kind !== "captured" || view === null
        ? null
        : {
            build: { commit: "abc", dirty: false, mode: "production", appVersion: "0.0.0" },
            package: { id: "development-package:witness", version: null },
            session: {
              snapshot: reply.snapshot,
              failure: reply.failure,
              events: [...view.events],
              transcriptEntries: [...view.transcriptEntries],
            },
            recording: reply.recording,
            prepare: (replay) => bridge.exportPrepare(reply.ticket, replay),
            release: () => void bridge.releaseRecording(reply.ticket),
            hostError: reply.incident?.errorName ?? null,
            editedWhileDebugging: reply.marks?.editedWhileDebugging ?? null,
            rewoundWhileDebugging: reply.marks?.rewoundWhileDebugging ?? null,
            player: {},
            host: {
              stage: { status: "hidden", path: null },
              media: [],
              notices: [],
              debugLog: null,
            },
          },
  );
  assert.ok(candidate !== null, "the capture is the candidate");
  const frozen: DebugExportCandidate = { ...candidate, photos: [] };
  let choices: DebugExportChoices = NO_PERSONAL_CONTENT;
  // Replay, after its prerequisites: saved values, answers and session text.
  for (const category of ["savedValues", "answers", "sessionText", "replay"] as const)
    choices = chooseDebugCategory(choices, frozen, category, true);
  const { exported } = await assembleDebugExport(frozen, choices);
  return { text: await (await debugExportFile(exported, false)).text(), release: frozen.release };
}

test("a Worker session's debug export holds a complete replay that replays offline, the same as in-process", async () => {
  const inProcess = await exportText(await inProcessBridge());
  const worker = new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));
  let remote: { text: string; release: () => void };
  try {
    remote = await exportText(worker);
    remote.release();
    // The release ran: preparing the released export is refused.
    await assert.rejects(worker.client.request("exportPrepare", { ticket: "r1", replay: true }));
  } finally {
    worker.client.terminate();
  }
  const exported = parseDebugExport(remote.text);
  assert.ok(exported.replay !== null && exported.replay.operations.length > 0, "recorded calls");
  assert.equal(exported.replay.complete, true);
  assert.equal(exported.checkpointRole, "current");
  assert.equal(replayDebugExport(exported).kind, "reproduced");
  assert.equal(remote.text, inProcess.text, "byte-equal to the in-process export");
});
