import assert from "node:assert/strict";
import test from "node:test";
import { ref, shallowRef } from "vue";

import type { CapturedMediaRecord } from "../player/captured-media.js";
import type { ExportCaptureReply } from "../player/engine-bridge/session-protocol.js";
import type { PlayerBridge } from "../player/player-bridge.js";
import type { PlayerSession } from "../player/runtime-view.js";
import { useExportCandidate } from "../player/vue/src/session/useExportCandidate.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

/*
 * L5h.3b's export candidate owner (`session/useExportCandidate.ts`) and the Stage adapter it reads through: until the
 * dialog holds a candidate, the owner releases its ticket on every failed construction; the Stage it reports is the
 * matched view's, not the Player's possibly lagging shown session.
 */

const PHOTO = "captured-media:11111111-1111-4111-8111-111111111111:1";

/** A bridge whose capture delivers `reply` with `view`, and which records its releases. */
function fakeBridge(view: PlayerSession) {
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: a captured reply in the fields the owner reads; its recording names a photo answer.
  const reply = {
    kind: "captured",
    ticket: "r7",
    identity: { run: 1, session: "s1", revision: 1, eventsThrough: 0, stop: null },
    snapshot: null,
    failure: null,
    marks: null,
    incident: null,
    // A recording whose answer used a photo, so the candidate reads it.
    recording: {
      plan: { steps: [] },
      anchorSnapshot: {},
      operations: [
        {
          kind: "completeAction",
          args: [{ actionId: 1, payload: { kind: "image", reference: PHOTO } }],
        },
      ],
      endSnapshot: null,
      endFailure: null,
      complete: true,
      reason: null,
    },
  } as unknown as ExportCaptureReply;
  const released: string[] = [];
  const bridge = {
    captureExport: async <T>(
      _session: PlayerSession | null,
      _recording: unknown,
      deliver: (reply: ExportCaptureReply, shown: PlayerSession | null) => T,
    ) => deliver(reply, view),
    releaseRecording: async (ticket: string) => void released.push(ticket),
    exportPrepare: async () => ({}),
  };
  return { bridge, released };
}

function ownerOver(readPhoto: (reference: string) => Promise<CapturedMediaRecord | null>): {
  readonly owner: ReturnType<typeof useExportCandidate>;
  readonly released: string[];
} {
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: the owner reads a session's `connection` and `lineage`, which this literal has.
  const view = {
    connection: null,
    lineage: "l1",
    events: [],
    transcriptEntries: [],
  } as unknown as PlayerSession;
  const { bridge, released } = fakeBridge(view);
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: the owner calls only `captureExport`, `releaseRecording` and `exportPrepare` of a bridge, which this fake has.
  const typed = bridge as unknown as PlayerBridge;
  const owner = useExportCandidate({
    session: shallowRef(view),
    bridge: () => typed,
    // No activation: the recording is the current one, and nothing retires the export.
    activation: { current: () => null, admits: () => false },
    halting: ref(false),
    build: { commit: null, dirty: null, mode: "development", appVersion: "0" },
    package: { id: null, version: null },
    readPhoto,
  });
  return { owner, released };
}

const SHOWN = {
  player: {},
  host: {
    stage: { status: "hidden" as const, path: null },
    media: [],
    notices: [],
    debugLog: null,
  },
};

test("a candidate whose construction fails releases its ticket, whether its details or its photo reads fail", async () => {
  const throwing = ownerOver(async () => null);
  await assert.rejects(
    throwing.owner.debugExportCandidate(
      () => {
        throw new TypeError("The details could not be read.");
      },
      () => true,
    ),
    TypeError,
  );
  assert.deepEqual(throwing.released, ["r7"], "a details getter that throws");
  const unreadable = ownerOver(async () => {
    throw new Error("The photo store failed.");
  });
  await assert.rejects(
    unreadable.owner.debugExportCandidate(
      () => SHOWN,
      () => true,
    ),
  );
  assert.deepEqual(unreadable.released, ["r7"], "a photo read that rejects");
  // A construction that succeeds hands its ticket to the dialog: nothing is released here.
  const fine = ownerOver(async () => null);
  const candidate = await fine.owner.debugExportCandidate(
    () => SHOWN,
    () => true,
  );
  assert.ok(candidate !== null);
  assert.deepEqual(fine.released, []);
});

test("the Stage adapter reports the described session's image, not the Player's shown one", async () => {
  // The adapter is a Vue module, loaded as the composables are.
  const { debugStageImage } = await loadPlayerModule("player/vue/src/debugStageImage.ts");
  assert.equal(typeof debugStageImage, "function");
  // EVIDENCE: fixture: the module's export, checked callable above, with the signature `debugStageImage.ts` declares.
  const stageOf = debugStageImage as (
    player: unknown,
    shown: { covered: boolean; overridden: boolean; session?: unknown },
  ) => { readonly path: string | null };
  const sessionWith = (image: string) => ({
    state: { stage: { image, videoMediaId: null }, media: [] },
  });
  const player = {
    session: ref(sessionWith("images/before.jpg")),
    stageImage: ref("images/before.jpg"),
    stageImageObservation: ref({ loaded: null, failed: null }),
    resolveAsset: (path: string) => `asset:${path}`,
  };
  const matched = sessionWith("images/after.jpg");
  assert.equal(
    stageOf(player, { covered: false, overridden: false, session: matched }).path,
    "images/after.jpg",
  );
  assert.equal(stageOf(player, { covered: false, overridden: false }).path, "images/before.jpg");
});
