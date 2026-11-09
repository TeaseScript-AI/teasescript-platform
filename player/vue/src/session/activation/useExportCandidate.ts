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
import type { Origin } from "./useActivationRun.js";

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
  readonly activation: {
    current(): Origin;
    admits(origin: Origin): boolean;
    own(origin: Origin, cleanup: () => void): () => void;
  };
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
   * it is the candidate only while the dialog wants it (`wanted`), no stop is under way here, and it is of what shows: the shown
   * lineage, or for no session, the same run and still no session, and of the activation it began in (`origin`), while
   * that lives. Events and transcript come from the store's view, marks and incident only from the capture. Otherwise
   * its ticket is released.
   */
  function deliver(
    host: PlayerBridge,
    origin: Origin,
    current: PlayerSession | null,
    reply: ExportCaptureReply,
    view: PlayerSession | null,
    details: ExportDetails,
    wanted: AbortSignal,
  ): Omit<DebugExportCandidate, "photos"> | typeof PENDING_CAPTURE | null {
    if (reply.kind === "pending") return PENDING_CAPTURE;
    if (reply.kind !== "captured") return null;
    // The lease is the activation's from here until the dialog holds it: released once, at a refusal, a failed
    // construction, the dialog's cancellation or the activation's retirement, whichever comes first. A retired
    // activation's lease is released at once, inside `own`.
    let released = false;
    let unown = () => {};
    const handOver = () => {
      unown();
      wanted.removeEventListener("abort", release);
    };
    const release = () => {
      if (released) return;
      released = true;
      handOver();
      void host.releaseRecording(reply.ticket).catch(() => {});
    };
    wanted.addEventListener("abort", release);
    unown = options.activation.own(origin, release);
    const matches =
      current === null
        ? session.value === null &&
          reply.identity.run === (origin.kind === "run" ? origin.begin.run : null)
        : view !== null && session.value?.lineage === current.lineage;
    if (wanted.aborted || halting.value || !matches || !lives(origin)) {
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
    const candidate: Omit<DebugExportCandidate, "photos"> = {
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
    leases.set(candidate, handOver);
    return candidate;
  }
  /**
   * The lease of each candidate under construction: handing the candidate over keeps its ticket from the retirement and
   * the cancellation.
   */
  const leases = new WeakMap<object, () => void>();

  /** Whether `origin` still lives: an activation's run, or the initial record until the first activation. */
  const lives = (origin: Origin) => options.activation.admits(origin);

  /**
   * Resolves once no Player error stop is under way here (`halting`), once `origin` retired, or once the dialog no
   * longer wants the candidate (`wanted`): its watch stops then too. None is made for a retired `origin` or a cancelled
   * candidate.
   */
  function stopShown(origin: Origin, wanted: AbortSignal): Promise<void> {
    if (!halting.value || !lives(origin) || wanted.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let unown = () => {};
      const settle = () => {
        stop();
        unown();
        wanted.removeEventListener("abort", settle);
        resolve();
      };
      const stop = watch(halting, (now) => {
        if (!now) settle();
      });
      wanted.addEventListener("abort", settle);
      unown = options.activation.own(origin, settle);
    });
  }

  /**
   * Captures what a debug export can contain, frozen: in the host, the shown session's state, marks and failure, the
   * run's incident and the recording (the one up to a Player error, else the session's own); here, in the capture's
   * reply, that publication's events and transcript, and what `details` reads of the Player's interface for it.
   * `wanted` aborts once the dialog no longer wants the candidate. `null` when the capture is refused or does not match
   * what shows, once the dialog cancelled, or once the activation it began in retired: after every await it goes on
   * only while that activation lives and the dialog wants it, and nothing then stays held. A candidate handed over
   * before the retirement stays the dialog's.
   */
  async function debugExportCandidate(
    details: ExportDetails,
    wanted: AbortSignal,
  ): Promise<DebugExportCandidate | null> {
    // A Player error's capture under way settles first: the export then selects what it settled to. The export is of
    // the activation it began in, and asks nothing more once that retired.
    const origin = options.activation.current();
    // The initial record has no failure recording: its selection is the current recording at once, with no wait.
    const failed = origin.kind === "run" ? await origin.failure.selection() : "current";
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
        deliver(host, origin, current, reply, view, details, wanted),
      );
    let frozen: Awaited<ReturnType<typeof capture>> | null;
    try {
      frozen = await capture();
      // A stop of the run was still committing: once it shows, the capture is tried once more, while its activation
      // lives.
      if (frozen === PENDING_CAPTURE && lives(origin)) {
        await stopShown(origin, wanted);
        frozen = !wanted.aborted && lives(origin) ? await capture() : null;
      }
    } catch (error) {
      // The capture of an activation that retired meanwhile gives nothing, also when it failed.
      if (!lives(origin)) return null;
      throw error;
    }
    if (frozen === PENDING_CAPTURE || frozen === null) return null;
    // Until the dialog holds the candidate, this owns its ticket: a construction that fails, is cancelled or whose
    // activation retired releases it.
    const owned = frozen;
    const goesOn = () => {
      if (lives(origin) && !wanted.aborted) return true;
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
      // A photo read that failed after the activation retired or the dialog cancelled gives nothing, as any other end.
      if (!goesOn()) return null;
      throw error;
    }
    // Once more at the handoff: the dialog takes only a live activation's wanted candidate, and holds its lease from
    // now on.
    if (!goesOn()) return null;
    leases.get(frozen)?.();
    return { ...frozen, photos };
  }

  return { debugExportCandidate };
}
