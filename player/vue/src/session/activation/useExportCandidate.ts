import { watch, type Ref } from "vue";
import type { CapturedMediaRecord } from "../../../../media/captured-media.js";
import {
  debugPhotoUses,
  type DebugExportCandidate,
  type DebugPhotoCandidate,
} from "../../../../debug/debug-export-assembly.js";
import type { ExportCaptureReply } from "../../../../engine-bridge/session-protocol.js";
import type { PlayerBridge } from "../../../../runtime/player-bridge.js";
import type { PlayerSession } from "../../../../runtime/runtime-view.js";
import type { ActivationRun } from "./useActivationRun.js";

/*
 * A debug export's candidate (L5h.3b): captured in the host (`captureExport`), decided in the capture's reply hook
 * against what shows, then given the photo reads its frozen uses name. Nothing the Player shows later reaches it.
 */

/** A capture that met a stop of its run still committing (`captureExport`'s `pending`). */
const PENDING_CAPTURE = Symbol("pending capture");

/** The details a debug export's dialog reads of the Player's interface, for the shown session `shown`. */
export type ExportDetails = (
  shown: PlayerSession | null,
) => Pick<DebugExportCandidate, "player" | "host">;

export function useExportCandidate(options: {
  /** The shown session. */
  readonly session: Readonly<Ref<PlayerSession | null>>;
  /** The Player's engine bridge, or `null` before it is ready. */
  readonly bridge: () => PlayerBridge | null;
  /**
   * The activations' runs (`useActivationRun`): the export is of the live one, with the recording its failure
   * recording selects, and only while it lives.
   */
  readonly activation: { current(): ActivationRun | null; admits(origin: ActivationRun): boolean };
  /** Whether a Player error stop is under way here, until the host acknowledged it. */
  readonly halting: Readonly<Ref<boolean>>;
  readonly build: DebugExportCandidate["build"];
  readonly package: DebugExportCandidate["package"];
  /** Reads a captured photo's record, as the Player's media store holds it. */
  readonly readPhoto: (reference: string) => Promise<CapturedMediaRecord | null>;
}) {
  const { session, halting } = options;

  /**
   * Decides a capture in its reply's hook (`captureExport`, which matched a session's capture against the store's view):
   * it is the candidate only while the dialog wants it, no stop is under way here, and it is of what shows: the shown
   * lineage, or for no session, the same run and still no session, and of the activation it began in (`origin`), while
   * that lives. Events and transcript come from the store's view, marks and incident only from the capture. Otherwise
   * its ticket is released.
   */
  function deliver(
    host: PlayerBridge,
    origin: ActivationRun | null,
    current: PlayerSession | null,
    reply: ExportCaptureReply,
    view: PlayerSession | null,
    details: ExportDetails,
    live: () => boolean,
  ): Omit<DebugExportCandidate, "photos"> | typeof PENDING_CAPTURE | null {
    if (reply.kind === "pending") return PENDING_CAPTURE;
    if (reply.kind !== "captured") return null;
    const release = () => void host.releaseRecording(reply.ticket).catch(() => {});
    const matches =
      current === null
        ? session.value === null && reply.identity.run === (origin?.begin.run ?? null)
        : view !== null && session.value?.lineage === current.lineage;
    if (!live() || halting.value || !matches || !lives(origin)) {
      release();
      return null;
    }
    // What the dialog reads of the interface may throw: the capture is then no candidate, and its ticket goes.
    let shown: Pick<DebugExportCandidate, "player" | "host">;
    try {
      shown = details(view);
    } catch (error) {
      release();
      throw error;
    }
    return {
      build: options.build,
      package: options.package,
      session:
        view === null
          ? null
          : {
              snapshot: reply.snapshot,
              failure: reply.failure,
              events: [...view.events],
              transcriptEntries: [...view.transcriptEntries],
            },
      recording: reply.recording,
      prepare: (replay) => host.exportPrepare(reply.ticket, replay),
      release,
      hostError: reply.incident?.errorName ?? null,
      editedWhileDebugging: reply.marks?.editedWhileDebugging ?? null,
      rewoundWhileDebugging: reply.marks?.rewoundWhileDebugging ?? null,
      ...shown,
    };
  }

  /** Whether the activation `origin` still lives; without an activation, nothing retires. */
  const lives = (origin: ActivationRun | null) =>
    origin === null ? options.activation.current() === null : options.activation.admits(origin);

  /** Resolves once no Player error stop is under way here (`halting`). */
  function stopShown(): Promise<void> {
    if (!halting.value) return Promise.resolve();
    return new Promise((resolve) => {
      const stop = watch(halting, (now) => {
        if (now) return;
        stop();
        resolve();
      });
    });
  }

  /**
   * Captures what a debug export can contain, frozen: in the host, the shown session's state, marks and failure, the
   * run's incident and the recording (the one up to a Player error, else the session's own); here, in the capture's
   * reply, that publication's events and transcript, and what `details` reads of the Player's interface for it. `live`
   * says whether the dialog still wants the candidate. `null` when the capture is refused or does not match what shows,
   * or once the activation it began in retired: after every await it goes on only while that activation lives, and
   * nothing then stays held. A candidate handed over before the retirement stays the dialog's.
   */
  async function debugExportCandidate(
    details: ExportDetails,
    live: () => boolean,
  ): Promise<DebugExportCandidate | null> {
    // A Player error's capture under way settles first: the export then selects what it settled to. The export is of
    // the activation it began in, and asks nothing more once that retired.
    const origin = options.activation.current();
    const failed = origin === null ? "current" : await origin.failure.selection();
    if (!lives(origin)) return null;
    const current = session.value;
    const host = current?.connection ?? options.bridge();
    if (host === null) return null;
    // A ticket of another connection is no recording of this one: it is proved absent here.
    const recording =
      typeof failed === "string"
        ? failed
        : failed.bridge === host
          ? { ticket: failed.ticket }
          : "none";
    const capture = () =>
      host.captureExport(current, recording, (reply, view) =>
        deliver(host, origin, current, reply, view, details, live),
      );
    let frozen = await capture();
    // A stop of the run was still committing: once it shows, the capture is tried once more, while its activation lives.
    if (frozen === PENDING_CAPTURE && lives(origin)) {
      await stopShown();
      frozen = live() && lives(origin) ? await capture() : null;
    }
    if (frozen === PENDING_CAPTURE || frozen === null) return null;
    // Until the dialog holds the candidate, this owns its ticket: a construction that fails, or whose activation
    // retired, releases it.
    const owned = frozen;
    const goesOn = () => {
      if (lives(origin)) return true;
      owned.release();
      return false;
    };
    if (!goesOn()) return null;
    const photos: DebugPhotoCandidate[] = [];
    try {
      for (const [reference, usedBy] of debugPhotoUses(frozen)) {
        const record = await options.readPhoto(reference);
        if (!goesOn()) return null;
        if (record === null || record.kind !== "image") continue;
        photos.push({
          reference,
          mimeType: record.mimeType,
          byteLength: record.size,
          width: record.width ?? null,
          height: record.height ?? null,
          usedBy,
          read: async () => new Uint8Array(await record.data.arrayBuffer()),
        });
      }
    } catch (error) {
      frozen.release();
      throw error;
    }
    if (!live()) {
      frozen.release();
      return null;
    }
    // Once more at the handoff: the dialog takes only a live activation's candidate.
    if (!goesOn()) return null;
    return { ...frozen, photos };
  }

  return { debugExportCandidate };
}
