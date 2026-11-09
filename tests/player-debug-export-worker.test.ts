import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { connectBridge } from "../player/engine-bridge/client.js";
import { nodeWorkerPort } from "../player/engine-bridge/node-client.js";
import type { PrepareResult } from "../player/engine-bridge/player-ops.js";
import {
  assembleDebugExport,
  chooseDebugCategory,
  NO_PERSONAL_CONTENT,
  type DebugExportCandidate,
  type DebugExportChoices,
} from "../player/debug/debug-export-assembly.js";
import {
  debugExportFile,
  parseDebugExport,
  replayDebugExport,
} from "../player/debug/debug-export.js";
import { PlayerBridge } from "../player/runtime/player-bridge.js";
import {
  activePlayerRuntimeInteraction,
  type PlayerSession,
} from "../player/runtime/runtime-view.js";
import { inProcessBridge } from "./helpers/in-process-bridge.js";

/*
 * #1966's witness (L5h.3b, §21.4 family 6): a debug export of a recorded session in a Worker, from source through the
 * production capture, preparation and release ops, with replay and its prerequisites chosen. It has recorded calls and
 * a complete replay with its checkpoint, it crosses the real file format, it replays offline, and its file is the same
 * byte for byte as the in-process one's.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../player/engine-bridge/node-worker.js", import.meta.url);
const FOLDER = resolve(process.cwd(), "tests/fixtures/debug-export-equivalence");
// The equivalence family's scenarios (`scenarios.mjs`): the witness's script, and what its file is compared with.
const scenarios = await import(pathToFileURL(resolve(FOLDER, "scenarios.mjs")).href);
const SCRIPT: string = scenarios.WITNESS;

/** The session's export, assembled from the host's capture with replay and its prerequisites chosen, as its file's text. */
async function exportText(bridge: PlayerBridge): Promise<{ text: string; release: () => void }> {
  const prepared = await bridge.client.request("prepare", {
    source: { kind: "source", script: SCRIPT },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const result = prepared.result as PrepareResult;
  assert.equal(result.kind, "prepared");
  const plan = result.kind === "prepared" ? result.plan : "";
  const session: PlayerSession = await bridge.start(plan, { wallClockMs: 0 }, true, undefined, {
    run: 1,
    retires: null,
  });
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
            build: scenarios.BUILD,
            package: scenarios.PACKAGE,
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
            ...scenarios.SHOWN,
          },
  );
  assert.ok(candidate !== null, "the capture is the candidate");
  const frozen: DebugExportCandidate = { ...candidate, photos: [] };
  let choices: DebugExportChoices = NO_PERSONAL_CONTENT;
  // Replay, after its prerequisites: saved values, answers and session text.
  for (const category of ["savedValues", "answers", "sessionText", "replay"] as const)
    choices = chooseDebugCategory(choices, frozen, category, true);
  const { exported } = await assembleDebugExport(frozen, choices);
  const file = await debugExportFile(exported, false);
  return { text: await file.text(), release: frozen.release };
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
  // EVIDENCE: fixture: `generate.mjs` writes rows of this shape.
  const fixture = JSON.parse(readFileSync(resolve(FOLDER, "fixture.json"), "utf8")) as {
    readonly scenarios: readonly {
      readonly name: string;
      readonly files: readonly { readonly file: string }[];
    }[];
  };
  const pinned = fixture.scenarios.find((each) => each.name.startsWith("witness"));
  assert.equal(
    remote.text,
    pinned?.files[0]?.file,
    "byte-equal to the base's file of the same session",
  );
});
