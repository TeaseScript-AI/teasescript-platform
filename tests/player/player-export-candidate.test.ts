import assert from "node:assert/strict";
import test from "node:test";
import { ref, shallowRef } from "vue";

import type { CapturedMediaRecord } from "../../player/media/captured-media.js";
import type { ExportCaptureReply } from "../../player/engine-bridge/session-protocol.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import {
  useActivationRun,
  type InitialOrigin,
  type RunOrigin,
} from "../../player/vue/src/session/activation/useActivationRun.js";
import { useExportCandidate } from "../../player/vue/src/session/activation/useExportCandidate.js";
import { coverageGaps, product, type Coordinates } from "../helpers/family-coverage.js";
import { loadPlayerModule } from "../helpers/player-modules.js";

/** The Player's record before any activation. */
const INITIAL: InitialOrigin = { kind: "initial" };

/*
 * L5h.3b's export candidate owner (`session/activation/useExportCandidate.ts`) and the Stage adapter it reads through: until the
 * dialog holds a candidate, the owner releases its ticket on every failed construction; the Stage it reports is the
 * matched view's, not the Player's possibly lagging shown session.
 */

const PHOTO = "captured-media:11111111-1111-4111-8111-111111111111:1";

/**
 * A bridge whose capture delivers `reply` with `view`, and which records its releases. Its recording's answers used
 * `photos`; `captured` holds the capture's resolution after its reply hook ran, until it resolves.
 */
function fakeBridge(
  view: PlayerSession,
  photos: readonly string[] = [PHOTO],
  captured: Promise<void> = Promise.resolve(),
) {
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
      operations: photos.map((reference, index) => ({
        kind: "completeAction",
        args: [{ actionId: index + 1, payload: { kind: "image", reference } }],
      })),
      endSnapshot: null,
      endFailure: null,
      complete: true,
      reason: null,
    },
  } as unknown as ExportCaptureReply;
  const released: string[] = [];
  const counts = { captures: 0 };
  const bridge = {
    captureExport: async <T>(
      _session: PlayerSession | null,
      _recording: unknown,
      deliver: (reply: ExportCaptureReply, shown: PlayerSession | null) => T,
    ) => {
      counts.captures += 1;
      const delivered = deliver(reply, view);
      await captured;
      return delivered;
    },
    releaseRecording: async (ticket: string) => void released.push(ticket),
    exportPrepare: async () => ({}),
  };
  return { bridge, released, counts };
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
    // No activation: the initial record, whose recording is the current one, and nothing retires the export.
    activation: {
      current: () => INITIAL,
      admits: (origin) => origin === INITIAL,
      own: () => () => {},
    },
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
    throwing.owner.debugExportCandidate(() => {
      throw new TypeError("The details could not be read.");
    }, new AbortController().signal),
    TypeError,
  );
  assert.deepEqual(throwing.released, ["r7"], "a details getter that throws");
  const unreadable = ownerOver(async () => {
    throw new Error("The photo store failed.");
  });
  await assert.rejects(
    unreadable.owner.debugExportCandidate(() => SHOWN, new AbortController().signal),
  );
  assert.deepEqual(unreadable.released, ["r7"], "a photo read that rejects");
  // A construction that succeeds hands its ticket to the dialog: nothing is released here.
  const fine = ownerOver(async () => null);
  const candidate = await fine.owner.debugExportCandidate(
    () => SHOWN,
    new AbortController().signal,
  );
  assert.ok(candidate !== null);
  assert.deepEqual(fine.released, []);
});

test("the Stage adapter reports the described session's image, not the Player's shown one", async () => {
  // The adapter is a Vue module, loaded as the composables are.
  const { debugStageImage } = await loadPlayerModule("player/vue/src/debug/debugStageImage.ts");
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

/*
 * Design round r2, after the second final review (B2-L-C-D-E): a candidate still being built when its activation
 * retires goes on with nothing. Generated over how many photos it reads × where its activation retires: while the
 * capture's reply resolves, while the first or the second read waits, or after the dialog took it. Before the handoff
 * the candidate is `null`, its ticket goes, no read starts after the retirement, and the successor's shown session is
 * untouched; a candidate the dialog took stays the dialog's. Session split S2 adds how the construction ends (the
 * activation's retirement, or the dialog's cancellation) and how the read it came at settles: a read that fails after
 * either end gives `null` too, not its failure.
 */
const RETIREMENT_AXES = {
  photos: ["one", "two"],
  retirement: ["capture", "firstRead", "secondRead", "afterHandoff"],
  end: ["retirement", "cancellation"],
  read: ["resolves", "rejects"],
} as const;
type RetirementCase = {
  readonly [A in keyof typeof RETIREMENT_AXES]: (typeof RETIREMENT_AXES)[A][number];
};

/** A case's coordinates as the case they name. */
function asRetirementCase(coordinates: Coordinates): RetirementCase {
  // EVIDENCE: invariant: `product` gives the declared axes' values.
  return coordinates as RetirementCase;
}

function retirementInfeasible(c: RetirementCase): string | null {
  if (c.photos === "one" && c.retirement === "secondRead") return "one photo has no second read";
  if (c.read === "rejects" && (c.retirement === "capture" || c.retirement === "afterHandoff"))
    return "no read waits when the construction ends";
  return null;
}

test("a candidate whose activation retires while it is built hands nothing over, wherever it waits", async () => {
  const cases = product({ ...RETIREMENT_AXES }).filter(
    (coordinates) => retirementInfeasible(asRetirementCase(coordinates)) === null,
  );
  const observed: Coordinates[] = [];
  for (const coordinates of cases) {
    const c = asRetirementCase(coordinates);
    const references = [PHOTO, PHOTO.replace(/:1$/u, ":2")].slice(0, c.photos === "one" ? 1 : 2);
    // An activation without a Player error: its export selects the current recording.
    const activation = () => ({
      kind: "run" as const,
      failure: { selection: async () => "current" as const },
    });
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: the owner reads an activation's failure selection, and compares activations by identity.
    const [origin, successor] = [activation(), activation()] as unknown as [RunOrigin, RunOrigin];
    let live: RunOrigin = origin;
    // What the live activation owns, released at its retirement (`useActivationRun`'s `own`).
    const owned = new Set<() => void>();
    const wanted = new AbortController();
    // The construction ends: its activation retires, or its dialog no longer wants it.
    const retire = () => {
      if (c.end === "cancellation") return wanted.abort();
      live = successor;
      for (const cleanup of owned) cleanup();
      owned.clear();
    };
    const ended = () => live !== origin || wanted.signal.aborted;
    let resolveCapture!: () => void;
    const captured = new Promise<void>((resolve) => (resolveCapture = resolve));
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: the owner reads a session's `connection` and `lineage`, which this literal has.
    const view = {
      connection: null,
      lineage: "l1",
      events: [],
      transcriptEntries: [],
    } as unknown as PlayerSession;
    const shown = shallowRef(view);
    const { bridge, released, counts } = fakeBridge(view, references, captured);
    const reads: { readonly reference: string; readonly afterRetirement: boolean }[] = [];
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: the owner calls only `captureExport`, `releaseRecording` and `exportPrepare` of a bridge, which this fake has.
    const typed = bridge as unknown as PlayerBridge;
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: the record fields a candidate's photo reads, which this literal has.
    const record = {
      kind: "image",
      mimeType: "image/png",
      size: 1,
      width: 1,
      height: 1,
      data: new Blob([new Uint8Array([1])]),
    } as unknown as CapturedMediaRecord;
    // The read the retirement comes at, while it waits: the first (0), the second (1), or none.
    const waitAt = c.retirement === "firstRead" ? 0 : c.retirement === "secondRead" ? 1 : -1;
    const owner = useExportCandidate({
      session: shown,
      bridge: () => typed,
      activation: {
        current: () => live,
        admits: (each) => each === live,
        own: (each, cleanup) => {
          if (each !== live) {
            cleanup();
            return () => {};
          }
          owned.add(cleanup);
          return () => void owned.delete(cleanup);
        },
      },
      halting: ref(false),
      build: { commit: null, dirty: null, mode: "development", appVersion: "0" },
      package: { id: null, version: null },
      readPhoto: async (reference) => {
        reads.push({ reference, afterRetirement: ended() });
        // The construction ends while this read waits, which then settles as the case says.
        const endsHere = reads.length - 1 === waitAt;
        if (endsHere) retire();
        await Promise.resolve();
        if (endsHere && c.read === "rejects") throw new Error("The photo store failed.");
        return record;
      },
    });
    const pending = owner.debugExportCandidate(() => SHOWN, wanted.signal);
    await Promise.resolve();
    if (c.retirement === "capture") retire();
    resolveCapture();
    const candidate = await pending;
    if (c.retirement === "afterHandoff") retire();
    const handedOver = c.retirement === "afterHandoff";
    assert.deepEqual(
      {
        candidate: candidate === null ? null : "handed over",
        released: [...released],
        readsAfterRetirement: reads.filter((read) => read.afterRetirement).length,
        reads: reads.length,
        captures: counts.captures,
        shown: shown.value === view,
      },
      {
        // A failed read after the end gives `null` (the await above would have thrown).
        candidate: handedOver ? "handed over" : null,
        released: handedOver ? [] : ["r7"],
        readsAfterRetirement: 0,
        // The reads that started before the retirement: none after the capture's, each up to the one it came at.
        reads:
          c.retirement === "capture"
            ? 0
            : c.retirement === "firstRead"
              ? 1
              : c.retirement === "secondRead"
                ? 2
                : references.length,
        captures: 1,
        shown: true,
      },
      JSON.stringify(c),
    );
    observed.push(coordinates);
  }
  assert.deepEqual(coverageGaps(cases, observed, { tuples: true }), []);
});

/*
 * Session split S2's resource owners (its HEAD 0), on the record owner itself: what an activation's export holds goes
 * when the activation retires, without waiting for its work to come back. The first activation retires the initial
 * record as any later one retires its predecessor.
 */
function recordOwner() {
  const run = useActivationRun({ report: () => {} });
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: a begin reads only the host's next run, and a disposal asks it to retire the run.
  const host = { nextRun: () => 1, retireRun: async () => {} } as unknown as PlayerBridge;
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: the owner reads a session's `connection` and `lineage`, which this literal has.
  const view = {
    connection: null,
    lineage: "l1",
    events: [],
    transcriptEntries: [],
  } as unknown as PlayerSession;
  return { run, begin: () => void run.begin(host), view };
}

for (const retiring of [
  "the initial record",
  "an activation's run",
  "the dialog's cancellation",
] as const)
  test(`${retiring} ending the export releases its lease at once, while a photo read never returns`, async () => {
    const { run, begin, view } = recordOwner();
    if (retiring === "an activation's run") begin();
    const wanted = new AbortController();
    const { bridge, released } = fakeBridge(view);
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: the owner calls only `captureExport`, `releaseRecording` and `exportPrepare` of a bridge, which this fake has.
    const typed = bridge as unknown as PlayerBridge;
    let reading = false;
    const owner = useExportCandidate({
      session: shallowRef(view),
      bridge: () => typed,
      activation: run,
      halting: ref(false),
      build: { commit: null, dirty: null, mode: "development", appVersion: "0" },
      package: { id: null, version: null },
      readPhoto: () => {
        reading = true;
        return new Promise(() => {});
      },
    });
    let settled = false;
    void owner.debugExportCandidate(() => SHOWN, wanted.signal).then(() => (settled = true));
    for (let turn = 0; turn < 10 && !reading; turn += 1) await Promise.resolve();
    assert.ok(reading, "the candidate waits for its photo");
    assert.deepEqual(released, []);
    if (retiring === "the dialog's cancellation") wanted.abort();
    else begin();
    assert.deepEqual(released, ["r7"], "the lease goes with the end, not with the read");
    assert.equal(settled, false);
  });

for (const ending of ["the activation retires", "the dialog cancels it"] as const)
  test(`an export waiting for its activation's stop to show settles when ${ending}, and asks nothing more`, async () => {
    const { run, begin, view } = recordOwner();
    begin();
    const wanted = new AbortController();
    const counts = { captures: 0 };
    const bridge = {
      // The stop is still committing: the capture is pending, as the host answers then.
      captureExport: async <T>(
        _session: PlayerSession | null,
        _recording: unknown,
        deliver: (reply: ExportCaptureReply, shown: PlayerSession | null) => T,
      ) => {
        counts.captures += 1;
        return deliver({ kind: "pending" }, view);
      },
      releaseRecording: async () => {},
      exportPrepare: async () => ({}),
    };
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture: the owner calls only `captureExport`, `releaseRecording` and `exportPrepare` of a bridge, which this fake has.
    const typed = bridge as unknown as PlayerBridge;
    const halting = ref(true);
    const owner = useExportCandidate({
      session: shallowRef(view),
      bridge: () => typed,
      activation: run,
      halting,
      build: { commit: null, dirty: null, mode: "development", appVersion: "0" },
      package: { id: null, version: null },
      readPhoto: async () => null,
    });
    const outcome: { value: string } = { value: "pending" };
    void owner
      .debugExportCandidate(() => SHOWN, wanted.signal)
      .then((candidate) => (outcome.value = candidate === null ? "null" : "candidate"));
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    assert.deepEqual([outcome.value, counts.captures], ["pending", 1], "it waits for the stop");
    if (ending === "the dialog cancels it") wanted.abort();
    else begin();
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    assert.equal(outcome.value, "null", "the end settles its wait");
    // Its watch went with it: the stop's end later asks for no capture.
    halting.value = false;
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    assert.equal(counts.captures, 1);
  });
