import { computed, ref, shallowRef, watch } from "vue";
import { tryOnScopeDispose, useIntervalFn } from "@vueuse/core";
import { createBrowserCaptureHost, browserMediaUrls } from "../../browser-capture.js";
import { CaptureDevice } from "../../capture-device.js";
import {
  CapturedMediaNotStoredError,
  CapturedMediaStore,
  isCapturedMediaReference,
  type CapturedMediaRepository,
} from "../../captured-media.js";
import {
  browserCapturedMediaLocks,
  capturedMediaStorage,
} from "../../captured-media-persistence.js";
import {
  browserImageDecoder,
  checkImageFile,
  type ImageDecoder,
  type ImageFileFilters,
} from "../../image-file.js";
import { MediaDevice, MediaLoadQueue, type MediaDeviceElement } from "../../media-device.js";
import {
  activePlayerRuntimeInteraction,
  completePlayerRuntimeStorageWrite,
  applyPlayerRuntimeStorageEdit,
  continuePlayerRuntimeSession,
  playerTemporalContext,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeCameraView,
  playerRuntimeMedia,
  playerRuntimeMediaOrigin,
  playerRuntimePermanentButtons,
  pressPlayerRuntimePermanentButton,
  reportPlayerRuntimeMediaLoad,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../../runtime-adapter.js";
import {
  debugPhotoUses,
  type DebugExportCandidate,
  type DebugPhotoCandidate,
} from "../../debug-export-assembly.js";
import { DebugRecorder } from "../../debug-recorder.js";
import type { SavedDataHost } from "../../saved-data.js";
import { playerBuildIdentity } from "./buildIdentity";
import type { ScriptStorageProvider } from "../../script-storage.js";
import {
  checkStorageTransferImages,
  collectSavedScript,
  remapCapturedMediaReferences,
  StorageTransferError,
  type CheckedTransferImage,
  type SavedScript,
  type StorageBundle,
  type StorageBundleScript,
} from "../../storage-transfer.js";
import { CaptureService, SessionCamera, type PlayerDiagnostic } from "../../session-camera.js";
import {
  PlayerNotices,
  playerNoticeKeys,
  playerNotices,
  type PlayerNotice,
} from "../../notices.js";
import {
  validateScriptStorageEntries,
  type CapturedMediaAdmission,
  type RuntimeScriptStorageEntrySnapshot,
  type SerializableRuntimeValue,
  type TemporalContext,
} from "../../../src/index.js";
import { serializeValidatedRuntimeJson } from "../../../src/runtime/checkpoint.js";
import { silence } from "./generatedAudio";
import { useImageCapture } from "./useImageCapture";
import { useRuntimeSceneClock } from "./useRuntimeSceneClock";

const PRIMED_AUDIO_ELEMENTS = 2;
const SILENCE = silence(50);

// Media progress is sampled this often while media loads or plays; cues fire at this resolution.
const MEDIA_SAMPLE_MS = 100;

export interface PlayerSessionOptions {
  /**
   * Trusted host resolution of authored, package-relative media references (for example `sounds/bell.mp3`) to
   * playable URLs. Returning `null` makes the runtime treat the source as not loadable; there is no default access to
   * arbitrary URLs.
   */
  resolveAsset?: (path: string) => string | null;
  /**
   * Persistent script storage for `save`/`load`/`delete` in the host's stable, opaque scope for this script and player.
   * Without it, saves last only for the session.
   */
  scriptStorage?: ScriptStorageProvider;
  /**
   * Trusted session capabilities. This is a temporary host bridge until package capability metadata exists; it is
   * neither author syntax nor a manifest format.
   */
  capabilities?: { readonly camera?: boolean };
  /**
   * Durable storage for captured photos and chosen images that a saved value references, in the script storage's scope.
   * Without a repository, they stay session media, and a persistent save that references one fails. A host with
   * persistent script storage passes it, also without a repository, so that no saved reference outlives its media.
   */
  capturedMedia?: { readonly repository: CapturedMediaRepository | null };
  /**
   * The saved data of every script this browser keeps, which export and import of saved data read and write as the
   * player's own; without it they cover only the script this Player shows.
   */
  savedData?: SavedDataHost;
  /** What the trusted host knows of the script, for debug exports; unknown fields are `null`. */
  debugPackage?: { readonly id: string | null; readonly version: string | null };
  /** Decodes a chosen image file before it is stored; the browser's decoder by default. */
  decodeImage?: ImageDecoder;
  /**
   * The player's time zone and date and time presentation as they are now: the account settings, else the browser's,
   * which is the default. Start and Continue resolve it again, so a changed setting applies from that point on.
   */
  temporalContext?: () => TemporalContext;
}

type Activation = {
  readonly kind: "start" | "continue";
  readonly begin: () => PlayerRuntimeSession;
};

/** Creates a new session at Start; pass `recording` on to `createPlayerRuntimeSession` so a debug export can replay it. */
export type PlayerSessionStart = (recording: {
  readonly recorder: DebugRecorder;
}) => PlayerRuntimeSession;

// Presentation lifecycle around the canonical runtime session. The adapter session stays the only
// Player state; this host records which session is shown, when presentation must reset, maps
// browser time onto the session's scene time, and plays the session's media on browser elements.
export function usePlayerSession(options: PlayerSessionOptions = {}) {
  const resolvePackageAsset = options.resolveAsset ?? (() => null);
  const diagnostics = shallowRef<readonly PlayerDiagnostic[]>([]);
  const reportDiagnostic = (diagnostic: PlayerDiagnostic) => {
    console.warn(`[player] ${diagnostic.code}: ${diagnostic.message}`);
    diagnostics.value = [...diagnostics.value, diagnostic];
  };
  // Records every session's engine calls from Start, in every build, for a debug export (DEBUGGER.md "Debug export").
  const recorder = new DebugRecorder();
  // The error name of an exception of the Player itself, such as one at Start; it stays until the next Start.
  const hostError = ref<string | null>(null);
  function reportHostError(error: unknown) {
    hostError.value = error instanceof Error ? error.name : "Error";
    console.error("[player] host error", error);
  }
  // Bumped when a stored photo finished loading, so presentation resolves its reference again.
  const mediaRevision = ref(0);
  const capturedMedia = new CapturedMediaStore(
    options.capturedMedia?.repository ?? null,
    browserMediaUrls,
    options.scriptStorage?.scope ?? "player",
    () => mediaRevision.value++,
  );
  // A Player that can capture photos, or whose host keeps captured and chosen media, saves a value only after storing the
  // media it references, and only while it holds the scope's live lock, so no other Player reclaims media it might still
  // use. Otherwise storage is used directly.
  const capturedMediaPersistence =
    options.scriptStorage &&
    (options.capabilities?.camera === true || options.capturedMedia !== undefined)
      ? capturedMediaStorage(options.scriptStorage, capturedMedia, browserCapturedMediaLocks())
      : undefined;
  const scriptStorage = capturedMediaPersistence ?? options.scriptStorage;
  // Changes whenever the session camera may have opened, failed, ended, or been released.
  const cameraRevision = ref(0);
  const camera: SessionCamera<MediaStreamTrack> = new SessionCamera(
    new CaptureDevice(
      createBrowserCaptureHost((kind, state) => {
        if (kind !== "camera") return;
        if (state.status === "ended") camera.revoked();
        cameraRevision.value++;
      }),
      capturedMedia,
    ),
    reportDiagnostic,
  );
  /** Captured media resolves only through the trusted store, never as a package asset. */
  const resolveAsset = (path: string): string | null => {
    if (!isCapturedMediaReference(path)) return resolvePackageAsset(path);
    void mediaRevision.value;
    const resolved = capturedMedia.resolve(path);
    return resolved.state === "ready" ? resolved.url : null;
  };
  const resolveTemporalContext = options.temporalContext ?? (() => playerTemporalContext());
  const session = shallowRef<PlayerRuntimeSession | null>(null);
  // A new session remounts the transcript and resets interaction-local state.
  const generation = ref(0);
  const interactionReset = ref(0);
  const activation = shallowRef<Activation | null>(null);
  // The script places the camera view with `showCamera [stage]` and hides it with `hideCamera`; the view only previews
  // the session camera, which stays open for `takePhoto()`. Without an available camera there is nothing to show.
  const viewfinderPlacement = computed(() => {
    const current = session.value;
    return current === null ? null : playerRuntimeCameraView(current.snapshot);
  });
  const viewfinder = computed(() => {
    void cameraRevision.value;
    return viewfinderPlacement.value === null ? null : camera.previewTrack;
  });
  const notices = new PlayerNotices();
  const noticeList = shallowRef<readonly PlayerNotice[]>([]);
  notices.subscribe((current) => (noticeList.value = current));
  // A media file the script refers to but the Player cannot use is reported once per session and path, so a loop that
  // shows it again does not repeat the notice. Captured media is no package file and is never reported.
  let reportedMedia = new Set<string>();
  function reportUnusableMedia(path: string, notice: PlayerNotice) {
    if (isCapturedMediaReference(path) || reportedMedia.has(path)) return;
    reportedMedia.add(path);
    notices.publish(notice);
  }
  function reportFailedMedia(mediaId: number) {
    const origin = session.value && playerRuntimeMediaOrigin(session.value, mediaId);
    if (!origin) return;
    const missing = resolvePackageAsset(origin.source) === null;
    // The Player cannot play video yet, so a video file that exists is not the script's problem.
    if (origin.media === "video" && !missing) return;
    reportUnusableMedia(
      origin.source,
      playerNotices.unusableMedia(
        origin.media,
        origin.source,
        missing ? "missing" : "failed",
        origin.location,
      ),
    );
  }

  const pendingLoadCount = ref(0);
  const loads = new MediaLoadQueue(
    () => clock.observe(),
    (mediaId, report) => {
      const current = session.value;
      if (!current) return "delivered";
      const result = reportPlayerRuntimeMediaLoad(current, mediaId, report);
      if (result.outcome.kind === "executionPending") return "pending";
      if (result.outcome.kind === "accepted") session.value = result.session;
      return "delivered";
    },
  );
  // Audio elements reused across media. Browsers such as Safari allow playback per element only from a user
  // activation; an element that played during the activating click keeps that permission when its source changes.
  const audioElements: MediaDeviceElement[] = [];
  const device = new MediaDevice({
    createElement: () => audioElements.pop() ?? new Audio(),
    releaseElement: (element) => audioElements.push(element),
    resolveSource: resolveAsset,
    reportLoad: (mediaId, report) => {
      if (report.kind === "failed") reportFailedMedia(mediaId);
      loads.add(mediaId, report);
      pendingLoadCount.value = loads.size;
    },
    requestObservation: () => clock.observe(),
    blockedChanged: (blocked) =>
      blocked
        ? notices.publish(playerNotices.audioBlocked(() => device.retryBlocked()))
        : notices.dismiss(playerNoticeKeys.audioBlocked),
  });
  const clock = useRuntimeSceneClock(session, () => device.sample());
  const stageImage = computed(() =>
    session.value === null ? null : playerRuntimeMedia(session.value.snapshot).stage.image,
  );
  // The Stage source the browser could not load, as the Stage reports it while it shows that source, or `null`. The
  // Stage keeps that image hidden while its source stays, also into a new session, which then gets no new browser error.
  const failedStageSource = shallowRef<string | null>(null);
  // The Stage source the browser has loaded and decoded, as the Stage reports it, or `null`; for Debug's Now view.
  const loadedStageSource = shallowRef<string | null>(null);
  // A Stage image that is no package file, or one the Stage shows as failed when a session starts.
  watch([generation, stageImage], ([, image]) => {
    if (image === null) return;
    if (resolvePackageAsset(image) === null)
      reportUnusableMedia(image, playerNotices.unusableMedia("image", image, "missing"));
    else if (failedStageSource.value !== null && resolveAsset(image) === failedStageSource.value)
      reportUnusableMedia(image, playerNotices.unusableMedia("image", image, "failed"));
  });

  watch(
    session,
    (current) => {
      device.reconcile(current ? playerRuntimeMedia(current.snapshot).media : []);
      loads.retry();
      pendingLoadCount.value = loads.size;
    },
    { immediate: true },
  );
  // Media cues depend on measured progress, not on a deadline, so observe regularly while media is active.
  const sampling = useIntervalFn(() => clock.observe(), MEDIA_SAMPLE_MS, { immediate: false });
  // Pending load reports also keep observing, so the engine runs until it can accept them.
  watch(
    () => session.value !== null && (device.active || pendingLoadCount.value > 0),
    (active) => (active ? sampling.resume() : sampling.pause()),
    { immediate: true },
  );
  const captures = new CaptureService(() => camera.answer(), {
    session: () => session.value,
    generation: () => generation.value,
    observe: () => clock.observe(),
    publish: (next) => (session.value = next),
    capturedMedia,
    diagnostic: reportDiagnostic,
    later: (task) => setTimeout(task, 0),
  });
  const serviceCapture = () => captures.request();
  watch(session, () => void serviceCapture());
  // A session that ended releases its camera.
  watch(
    () => session.value?.snapshot.status,
    (status) => {
      if (status === "halted" || status === "failed") camera.release();
    },
  );

  // The camera route of `askImage` opens as the request asks and uses the session camera while it is open. Otherwise the
  // request opens a camera of its own, which only captures use and which is released when the capture ends, so it never
  // serves `takePhoto()` or a script's camera view. Its problems show in the viewfinder itself.
  const cameraOffered =
    options.capabilities?.camera === true ||
    (typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function");
  const captureCamera: SessionCamera<MediaStreamTrack> = new SessionCamera(
    new CaptureDevice(
      createBrowserCaptureHost((kind, state) => {
        if (kind !== "camera") return;
        if (state.status === "ended") captureCamera.revoked();
        cameraRevision.value++;
      }),
      capturedMedia,
    ),
    () => {},
  );
  const imageCapture = useImageCapture({
    session,
    generation,
    sessionCamera: camera,
    captureCamera,
    cameraRevision,
    media: capturedMedia,
    offered: cameraOffered,
    observe: () => clock.observe(),
    publish: (next) => (session.value = next),
  });
  // An image request that allows only the camera cannot be answered where no camera can be used. Each such request, of
  // a session and an action, is reported once, so a dismissal holds only for the request it was given for.
  watch(
    () => {
      const request = session.value && activePlayerRuntimeInteraction(session.value.snapshot);
      return request?.ui.kind === "image" && !request.ui.allowFile && !cameraOffered
        ? `${generation.value}:${request.actionId}`
        : null;
    },
    (cameraOnlyRequest) =>
      cameraOnlyRequest === null
        ? notices.dismiss(playerNoticeKeys.imageNeedsCamera)
        : notices.publish(playerNotices.imageNeedsCamera()),
  );
  const decodeImage = options.decodeImage ?? browserImageDecoder;
  // The runtime accepts an image answer only when the store vouches for it.
  const imageAdmission: CapturedMediaAdmission = capturedMedia;
  /**
   * Checks an image file the player chose for the pending `askImage` and stores it as session media, like a photo.
   * Resolves to its reference, or to why the file is not accepted.
   */
  async function storeImageFile(
    file: File,
    filters: ImageFileFilters,
  ): Promise<{ readonly reference: string } | { readonly message: string }> {
    const checked = await checkImageFile(file, filters, decodeImage);
    if (!checked.ok) return { message: checked.message };
    // An unmounted Player keeps no media.
    if (disposed) return { message: "This interaction is no longer available." };
    const stored = capturedMedia.add("image", checked.data, {
      width: checked.width,
      height: checked.height,
    });
    return { reference: stored.reference };
  }

  /**
   * Plays silence on spare audio elements within the activating click, so script audio may still play when the
   * session starts later, for example after a camera permission prompt. Two cover the common overlap of a
   * background loop and a cue; more elements fall back to the refused-playback retry.
   */
  function primeAudio() {
    while (audioElements.length < PRIMED_AUDIO_ELEMENTS) audioElements.push(new Audio());
    for (const element of audioElements) {
      element.src = SILENCE;
      void element.play().catch(() => {});
    }
  }

  let activationToken = 0;
  // The latest Start, offered again after an import replaced the saved data.
  let lastStart: PlayerSessionStart | null = null;
  let disposed = false;
  tryOnScopeDispose(() => {
    disposed = true;
    // A Debug storage edit waiting for a script write gives up; the retired session never runs on.
    handOffWrite(null);
    activationToken++;
    loads.clear();
    device.reset();
    for (const element of audioElements.splice(0)) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
    captures.stop();
    camera.release();
    captureCamera.release();
    // Issued saves still finish and store their photos before the live lock and the session media are released.
    void (capturedMediaPersistence?.close() ?? Promise.resolve()).finally(() =>
      capturedMedia.close(),
    );
  });

  // The stored values that seed the next session, or `null` when storage is session-local: no provider, or one that
  // could not load, such as a browser that denies storage. A session-local run plays normally and keeps nothing.
  const storedEntries = shallowRef<readonly RuntimeScriptStorageEntrySnapshot[] | null>(null);
  // Counts changes this Player made to the saved values: a stored save, a clear, an import, or a fresh read.
  const savedDataRevision = ref(0);
  /**
   * Reads the stored values freshly for the next Start; call it before each `prepare`. Reading ahead keeps Start
   * synchronous within the player's activation.
   */
  async function loadScriptStorage(): Promise<void> {
    if (!scriptStorage) return;
    try {
      storedEntries.value = await scriptStorage.load();
      savedDataRevision.value++;
      notices.dismiss(playerNoticeKeys.storageUnavailable);
    } catch {
      storedEntries.value = null;
      notices.publish(playerNotices.storageUnavailable());
    }
  }
  /** Session options for the script's storage; call it from the Start factory. */
  function scriptStorageOptions(): PlayerRuntimeSessionOptions {
    return storedEntries.value === null
      ? {}
      : { scriptStorage: storedEntries.value, persistentScriptStorage: true };
  }
  // Each pending write is persisted once through the provider and then reported to the runtime, which keeps the
  // previous value when it failed (warning TSW014). Every published session is observed, whichever operation made it.
  // Keyed by session generation too: a newer session reuses action IDs.
  const writesInFlight = new Set<string>();
  watch(
    session,
    (current) => {
      const write = current && pendingPlayerRuntimeStorageWrite(current.snapshot);
      if (!scriptStorage || !write) return;
      const sessionGeneration = generation.value;
      const flight = `${sessionGeneration}:${write.actionId}`;
      if (writesInFlight.has(flight)) return;
      writesInFlight.add(flight);
      void scriptStorage.write(write.key, write.value).then(
        () => yieldThenReport(true),
        () => yieldThenReport(false),
      );
      // Continue in a later task: a script that saves in a loop must not starve input and rendering.
      function yieldThenReport(stored: boolean) {
        setTimeout(() => report(stored), 0);
      }
      function report(stored: boolean) {
        // A write that settles after unmount must not continue the session.
        if (disposed) return void writesInFlight.delete(flight);
        const latest = session.value;
        // The report must belong to the session that requested it.
        if (
          generation.value !== sessionGeneration ||
          latest === null ||
          pendingPlayerRuntimeStorageWrite(latest.snapshot)?.actionId !== write!.actionId
        ) {
          writesInFlight.delete(flight);
          return void handOffWrite(null);
        }
        if (!stored) notices.publish(playerNotices.storageWriteFailed());
        else savedDataRevision.value++;
        // A Debug storage edit waiting for this write settles it itself, before the script continues. The write stays
        // in flight until then, so a publication meanwhile does not issue it again.
        const settled = {
          actionId: write!.actionId,
          stored,
          generation: sessionGeneration,
          flight,
        };
        if (handOffWrite(settled)) return;
        writesInFlight.delete(flight);
        session.value = completePlayerRuntimeStorageWrite(latest, write!.actionId, stored).session;
      }
    },
    { flush: "sync" },
  );
  // A running or resumable session keeps its own view of the stored values, so clearing waits until it ends; while a
  // clear runs, no second clear and no Start can begin, so a new session never starts from the values being removed.
  const clearing = ref(false);
  // A Start or Continue waiting for the camera already owns its view of the stored values, although its session is not
  // published yet; a restored one may still write them.
  const openingCamera = ref(false);
  // While an import replaces the saved data, no Start, Continue, or clear begins.
  const importing = ref(false);
  // Debug storage edits (DEBUGGER.md "Player Debug"), one at a time. An edit is persisted first and reaches the running
  // session only once that succeeded, through the engine's storage-edit input. While the script's own write waits for
  // the host, the edit waits for that write's result: the write is then settled without running on, the edit follows,
  // and only then does the script continue, so its next `load` returns the edit.
  type SettledWrite = {
    readonly actionId: number;
    readonly stored: boolean;
    readonly generation: number;
    /** Its entry in `writesInFlight`, removed once the write is acknowledged. */
    readonly flight: string;
  };
  let writeWaiter: ((write: SettledWrite | null) => void) | null = null;
  /** Gives a settled write to a waiting edit; `null` when that write no longer belongs to the session. */
  function handOffWrite(write: SettledWrite | null): boolean {
    const waiter = writeWaiter;
    if (waiter === null) return false;
    writeWaiter = null;
    waiter(write);
    return write !== null;
  }
  let editChain: Promise<unknown> = Promise.resolve();
  /** Puts a stored edit into the values the next Start loads, as the provider now holds them. */
  function seedNextStart(key: string, value: SerializableRuntimeValue) {
    const entries = storedEntries.value;
    if (entries === null) return;
    const others = entries.filter((entry) => entry.key !== key);
    storedEntries.value = value === null ? others : [...others, { key, value }];
  }
  // Which session Debug changed the saved values of, for its debug export: when and how often.
  const debugEdits = shallowRef<{
    readonly firstEditSceneTimeMs: number;
    readonly editCount: number;
  } | null>(null);
  /** Whether a running or waiting session takes an edit now; one that waits for Continue or the camera does not. */
  const liveSession = () =>
    session.value !== null &&
    (session.value.snapshot.status === "running" || session.value.snapshot.status === "waiting") &&
    activation.value === null &&
    !openingCamera.value;

  /**
   * Changes one saved value for Debug: `value: null` deletes the key. `expected` is the value the editor started from,
   * `undefined` for a new key; a saved value that changed meanwhile is reported, not overwritten. The edit is persisted
   * first; a running session's next `load` then returns it, and values it already loaded keep what they loaded.
   */
  function editSavedData(edit: {
    readonly key: string;
    readonly value: SerializableRuntimeValue;
    readonly expected: SerializableRuntimeValue | undefined;
  }): Promise<SavedDataEditResult> {
    // The edit belongs to the session at hand when it was made; a later session, or an unmounted Player, never takes it.
    const owner = generation.value;
    const result = editChain.then(() => applySavedDataEdit(edit, owner));
    editChain = result.catch(() => undefined);
    return result;
  }
  async function applySavedDataEdit(
    {
      key,
      value,
      expected,
    }: {
      readonly key: string;
      readonly value: SerializableRuntimeValue;
      readonly expected: SerializableRuntimeValue | undefined;
    },
    owner: number,
  ): Promise<SavedDataEditResult> {
    const failed = (message: string) => ({ kind: "failed", message }) as const;
    const retired = () => disposed || generation.value !== owner;
    const overtaken = () => failed("The session changed meanwhile; open the editor again.");
    if (retired()) return overtaken();
    if (!scriptStorage || storedEntries.value === null)
      return failed("This browser's saved data cannot be read.");
    if (
      importing.value ||
      clearing.value ||
      openingCamera.value ||
      activation.value?.kind === "continue"
    )
      return failed("Saved data cannot be changed right now.");
    if (value !== null) {
      const problem = validateScriptStorageEntries([{ key, value }], "value");
      if (problem !== null) return failed(problem);
    }
    let current: readonly RuntimeScriptStorageEntrySnapshot[];
    try {
      current = await scriptStorage.load();
    } catch {
      return failed("This browser's saved data cannot be read.");
    }
    if (retired()) return overtaken();
    const now = current.find((entry) => entry.key === key)?.value;
    if (!sameSavedValue(now, expected)) return { kind: "changed" };

    const waitForWrite = () =>
      new Promise<SettledWrite | null>((resolve) => {
        writeWaiter = resolve;
      });
    let settled: SettledWrite | null = null;
    for (;;) {
      if (liveSession() && pendingPlayerRuntimeStorageWrite(session.value!.snapshot)) {
        settled = await waitForWrite();
        if (retired()) {
          if (settled !== null) writesInFlight.delete(settled.flight);
          return overtaken();
        }
      }
      try {
        await scriptStorage.write(key, value);
      } catch {
        if (settled !== null) settle(settled, true);
        return failed("The change could not be saved in this browser. Nothing changed.");
      }
      savedDataRevision.value++;
      // The next Start loads the stored values as they are now.
      seedNextStart(key, value);
      if (disposed) return { kind: "saved", live: false };
      if (!liveSession() || generation.value !== owner) {
        if (settled !== null) settle(settled, true);
        return { kind: "saved", live: false };
      }
      // Acknowledge the waiting write without running on, then edit, then run, in one step.
      let latest = session.value!;
      let settledWithoutRun = false;
      if (settled !== null) {
        writesInFlight.delete(settled.flight);
        if (pendingPlayerRuntimeStorageWrite(latest.snapshot)?.actionId === settled.actionId) {
          latest = completePlayerRuntimeStorageWrite(latest, settled.actionId, settled.stored, {
            continueRun: false,
          }).session;
          settledWithoutRun = true;
        }
        settled = null;
      }
      const edited = applyPlayerRuntimeStorageEdit(
        latest,
        { key, value },
        { continueRun: settledWithoutRun },
      );
      // A write the script issued while this edit was being stored settles first; the edit is stored again after it.
      if (edited.outcome.kind === "storageWritePending") {
        session.value = latest;
        continue;
      }
      session.value = edited.session;
      if (edited.outcome.kind === "applied") {
        const count = debugEdits.value?.editCount ?? 0;
        debugEdits.value = {
          firstEditSceneTimeMs:
            debugEdits.value?.firstEditSceneTimeMs ?? latest.snapshot.observedSessionTimeMs,
          editCount: count + 1,
        };
      }
      return { kind: "saved", live: edited.outcome.kind === "applied" };
    }

    /** Settles a write that waited for this edit as it would have been without it, running on. */
    function settle(write: SettledWrite, run: boolean) {
      writesInFlight.delete(write.flight);
      const latest = session.value;
      if (
        latest === null ||
        generation.value !== write.generation ||
        pendingPlayerRuntimeStorageWrite(latest.snapshot)?.actionId !== write.actionId
      )
        return;
      session.value = completePlayerRuntimeStorageWrite(latest, write.actionId, write.stored, {
        continueRun: run,
      }).session;
    }
  }
  const canClearScriptStorage = computed(
    () =>
      scriptStorage !== undefined &&
      storedEntries.value !== null &&
      !clearing.value &&
      !importing.value &&
      !openingCamera.value &&
      activation.value?.kind !== "continue" &&
      (session.value === null ||
        session.value.snapshot.status === "halted" ||
        session.value.snapshot.status === "failed"),
  );
  /** Removes this script's saved data; resolves to whether it was cleared. */
  async function clearScriptStorage(): Promise<boolean> {
    if (!scriptStorage || !canClearScriptStorage.value) return false;
    clearing.value = true;
    try {
      await scriptStorage.clear();
      storedEntries.value = [];
      savedDataRevision.value++;
      return true;
    } catch {
      return false;
    } finally {
      clearing.value = false;
    }
  }

  /** The saved data of every script this browser keeps, for an export; scripts without values are left out. */
  async function savedScripts(): Promise<readonly SavedScript[]> {
    const scopes = new Set(options.savedData?.scopes() ?? []);
    if (scriptStorage) scopes.add(scriptStorage.scope);
    const saved: SavedScript[] = [];
    for (const scope of [...scopes].sort()) {
      const name = options.savedData?.name(scope) ?? null;
      let script: SavedScript;
      // This Player's script is read through its own storage, after the saves its session issued.
      if (scope === scriptStorage?.scope)
        script = await collectSavedScript(scriptStorage, capturedMedia, name);
      else if (options.savedData) {
        const media = options.savedData.media(scope);
        try {
          script = await collectSavedScript(options.savedData.provider(scope), media, name);
        } finally {
          media.close();
        }
      } else continue;
      if (script.script.entries.length > 0) saved.push(script);
    }
    return saved;
  }
  /**
   * Checks exported saved data for an import, all of it, photos included, and compares each script with what this
   * browser keeps now; nothing changes yet. Rejects with a `StorageTransferError` naming the problem.
   */
  async function reviewSavedDataImport(bundle: StorageBundle): Promise<SavedDataImportReview> {
    const images = await checkStorageTransferImages(bundle.images, decodeImage);
    const scripts: SavedDataImportScript[] = [];
    for (const script of bundle.scripts) {
      const own = script.scope === scriptStorage?.scope;
      if (!own && !options.savedData)
        throw new StorageTransferError(
          "This Player can import only the saved data of the script it shows.",
        );
      let current: readonly RuntimeScriptStorageEntrySnapshot[];
      try {
        current = own
          ? await scriptStorage!.load()
          : await options.savedData!.provider(script.scope).load();
      } catch {
        throw new StorageTransferError(
          "This browser's saved data cannot be read, so nothing can be imported.",
        );
      }
      scripts.push({
        scope: script.scope,
        name: script.name ?? options.savedData?.name(script.scope) ?? null,
        values: script.entries.length,
        photos: script.photos.length,
        currentValues: current.length,
        shown: own,
      });
    }
    return { bundle, images, scripts };
  }
  /**
   * Imports the chosen scripts of a reviewed bundle, each replacing its own scope's saved data at once, photos stored
   * first under new references. When this Player's script is among them, a session in progress ends first and Start is
   * offered with the imported data. A script that fails keeps its saved data; the rejection names it, and the scripts
   * imported before it stay imported. Unchosen scripts are untouched.
   */
  async function importSavedData(
    review: SavedDataImportReview,
    chosen: ReadonlySet<string>,
  ): Promise<void> {
    if (importing.value || clearing.value)
      throw new StorageTransferError("Saved data cannot be replaced right now.");
    const ownChosen = scriptStorage !== undefined && chosen.has(scriptStorage.scope);
    importing.value = true;
    const failed: string[] = [];
    try {
      if (ownChosen && sessionInProgress.value) endSession();
      for (const script of review.bundle.scripts) {
        if (!chosen.has(script.scope)) continue;
        try {
          if (script.scope === scriptStorage?.scope) {
            // Without durable captured media, imported photos would not outlive this page.
            if (capturedMediaPersistence === undefined && usesImages(script))
              throw new CapturedMediaNotStoredError("This Player cannot keep saved photos.");
            await replaceScript(scriptStorage, capturedMedia, script, review.images);
          } else {
            const { storage, media } = options.savedData!.persistence(script.scope);
            try {
              await replaceScript(storage, media, script, review.images);
            } finally {
              await storage.close();
              media.close();
            }
          }
        } catch (error) {
          failed.push(
            `${script.name ?? script.scope} (${error instanceof CapturedMediaNotStoredError ? "its photos could not be stored" : "it could not be saved, for example because storage is full"})`,
          );
        }
      }
    } finally {
      if (ownChosen) {
        await loadScriptStorage();
        importing.value = false;
        if (lastStart !== null && !sessionInProgress.value) prepare(lastStart);
      } else importing.value = false;
    }
    if (failed.length > 0)
      throw new StorageTransferError(
        `Not imported, and their saved data is unchanged: ${failed.join("; ")}. Any other chosen script was imported.`,
      );
  }
  /** Whether a session runs, waits for Continue, or is starting; its own view of the saved values is in use. */
  const sessionInProgress = computed(
    () =>
      openingCamera.value ||
      activation.value?.kind === "continue" ||
      (session.value !== null &&
        session.value.snapshot.status !== "halted" &&
        session.value.snapshot.status !== "failed"),
  );
  /**
   * Ends the session without running any more of it: its clock, captures, cameras, and media stop, a pending Start or
   * Continue is discarded, and any late answer belongs to an older session generation and is ignored.
   */
  function endSession() {
    activationToken++;
    openingCamera.value = false;
    activation.value = null;
    captures.reset();
    camera.release();
    captureCamera.release();
    device.reset();
    loads.clear();
    pendingLoadCount.value = 0;
    generation.value++;
    interactionReset.value++;
    session.value = null;
  }

  // Starts or restores a session; its scene time continues from the persisted observation, so a
  // gap while no Player ran is not consumed.
  function start(next: PlayerRuntimeSession) {
    // A failed write concerns the run it happened in.
    notices.dismiss(playerNoticeKeys.storageWriteFailed);
    reportedMedia = new Set();
    debugEdits.value = null;
    // A Debug storage edit waiting for the previous session's write is for that session only.
    handOffWrite(null);
    device.reset();
    loads.clear();
    pendingLoadCount.value = 0;
    generation.value++;
    interactionReset.value++;
    session.value = next;
    clock.rebase();
  }
  // Publishes the result of a completed runtime action.
  function update(next: PlayerRuntimeSession) {
    session.value = next;
  }
  /**
   * Publishes a session that development time jumps (#615) advanced from the current one: playing media seek to the
   * progress the jumps reported, and the scene clock continues from the new observed time.
   */
  function publishJump(next: PlayerRuntimeSession) {
    session.value = next;
    device.jumped(playerRuntimeMedia(next.snapshot).media);
    clock.rebase();
  }
  const permanentButtons = computed(() =>
    session.value === null ? [] : playerRuntimePermanentButtons(session.value.snapshot),
  );
  /** Clicks a permanent button at the observed time, like other input; a click it does not accept changes nothing. */
  function pressPermanentButton(buttonId: number) {
    const current = clock.observe();
    if (current === null) return;
    const result = pressPlayerRuntimePermanentButton(current, buttonId);
    if (result.outcome.kind === "pressed") session.value = result.session;
  }
  /**
   * Shows the explicit Start control for a new session; `create` runs only on activation, so no statement executes
   * on page load and the click is the user activation later audible playback relies on.
   */
  function prepare(create: PlayerSessionStart) {
    lastStart = create;
    activationToken++;
    openingCamera.value = false;
    // A new session needs its own camera; a superseded acquisition never stays open.
    camera.release();
    activation.value = { kind: "start", begin: () => create({ recorder }) };
  }
  /**
   * What Start and Continue record about the player now: the zone and presentation, then the wall clock, sampled last so
   * that resolving the zone does not age it.
   */
  function temporalCapture(): { temporalContext: TemporalContext; wallClockMs: number } {
    const temporalContext = resolveTemporalContext();
    return { temporalContext, wallClockMs: Date.now() };
  }
  /**
   * Shows the explicit Continue control for a restored session; its execution, time and media resume only then.
   * Continue records the wall clock and the player's zone and presentation as they are now.
   */
  function prepareRestore(restored: PlayerRuntimeSession) {
    activationToken++;
    openingCamera.value = false;
    camera.release();
    activation.value = {
      kind: "continue",
      begin: () => {
        // The recording of a restored session starts from the state it continues.
        recorder.begin(restored.plan, restored.snapshot);
        return continuePlayerRuntimeSession(
          Object.freeze({ ...restored, recorder }),
          temporalCapture(),
        ).session;
      },
    };
  }
  /**
   * Runs the prepared Start or Continue; call it from the activating click. With the camera capability it first opens
   * the session camera, so any browser permission request happens here, before ordinary script execution. A camera
   * failure never prevents the session from starting.
   */
  async function activate() {
    const pending = activation.value;
    if (!pending || clearing.value || importing.value) return;
    activation.value = null;
    const token = ++activationToken;
    if (options.capabilities?.camera !== true) {
      // Without the capability nothing waits: `takePhoto()` is unconfigured (settled before `open` returns), and the
      // session starts within the activating click.
      void camera.open(false);
      captures.reset();
      startFrom(pending);
      return;
    }
    // Retire the previous session first: its elements return to the pool before priming, so the new session never
    // receives an element the browser still blocks, and it cannot project media while the camera opens.
    session.value = null;
    device.reset();
    primeAudio();
    openingCamera.value = true;
    let opened: boolean;
    try {
      opened = await camera.open(true);
    } finally {
      // A superseding prepare already reset it for its own activation.
      if (token === activationToken) openingCamera.value = false;
    }
    // Replaced, re-prepared, or unmounted while the browser answered: an obsolete session never starts.
    if (!opened || disposed || token !== activationToken) return;
    captures.reset();
    startFrom(pending);
  }
  /** Starts the prepared session; an exception of the Player while it begins is reported, with what was recorded. */
  function startFrom(pending: Activation) {
    hostError.value = null;
    let next: PlayerRuntimeSession;
    try {
      next = pending.begin();
    } catch (error) {
      reportHostError(error);
      return;
    }
    start(next);
  }

  return {
    session: computed(() => session.value),
    generation: computed(() => generation.value),
    interactionReset: computed(() => interactionReset.value),
    /** The prepared Start or Continue, or `null` once the session runs or while saved data is cleared or imported. */
    activation: computed(() =>
      clearing.value || importing.value ? null : (activation.value?.kind ?? null),
    ),
    /** Current Player notices, such as blocked audio; a notice's action runs from the player's click. */
    notices: computed(() => noticeList.value),
    /** Reports a host condition to the player; publishing the same key again replaces that notice. */
    publishNotice: (notice: PlayerNotice) => notices.publish(notice),
    /** Withdraws a notice once its producer's condition resolves, including one the player cannot dismiss. */
    withdrawNotice: (key: string) => notices.dismiss(key),
    /** Dismisses a notice for the player; a notice that is the only way to recover stays until it resolves. */
    dismissNotice: (key: string) => {
      if (notices.list.some((notice) => notice.key === key && notice.dismissible !== false))
        notices.dismiss(key);
    },
    /** Whether the host persists script storage, so the Player offers to clear it. */
    hasScriptStorage: scriptStorage !== undefined,
    canClearScriptStorage,
    clearScriptStorage,
    /**
     * The saved values as stored now, with the saved photos they reference, for an export; also during a session, whose
     * saves count once they are stored. Rejects when storage cannot be read.
     */
    /**
     * The saved values as stored now, read freshly through the provider in issue order, for Debug's Storage tab; rejects
     * when storage cannot be read. `savedDataRevision` changes when this Player changed them.
     */
    readSavedData: () =>
      scriptStorage
        ? scriptStorage.load()
        : Promise.reject(new Error("This script keeps no saved data.")),
    savedDataRevision: computed(() => savedDataRevision.value),
    editSavedData,
    /** Whether Debug can change saved values now, and whether a running session takes the change too. */
    savedDataEditing: computed(() => ({
      available:
        scriptStorage !== undefined &&
        storedEntries.value !== null &&
        !importing.value &&
        !clearing.value &&
        !openingCamera.value &&
        activation.value?.kind !== "continue",
      live: liveSession(),
    })),
    /** Whether Debug changed this session's saved values: from which scene time and how often; for its debug export. */
    debugEdits: computed(() => debugEdits.value),
    /** The host's storage scope of this script's saved values, or `null` without script storage. */
    savedDataScope: scriptStorage?.scope ?? null,
    /** A saved photo, loaded on first use: its URL once ready, or whether it still loads or is missing. */
    savedPhoto(reference: string) {
      void mediaRevision.value;
      return capturedMedia.resolve(reference);
    },
    /** Whether the Player offers saved data: of every script this browser keeps, or at least of the shown one. */
    hasSavedData: options.savedData !== undefined || scriptStorage !== undefined,
    savedScripts,
    /** Remembers the shown script's title for listing its saved data among other scripts'. */
    rememberScriptName(name: string) {
      if (scriptStorage) options.savedData?.rememberName(scriptStorage.scope, name);
    },
    /** Whether saved data can be imported now: no import or clear runs. */
    canImportSavedData: computed(() => !clearing.value && !importing.value),
    /** Whether an import that includes this script must end its session first. */
    sessionInProgress,
    /** The storage scope of the script this Player shows, or `null`. */
    scriptScope: scriptStorage?.scope ?? null,
    reviewSavedDataImport,
    importSavedData,
    /** The current or last session's recorded engine calls for a debug export, or `null` before any Start. */
    debugRecording: () => recorder.recording(),
    /** The error name of an exception of the Player itself, or `null`. */
    hostError: computed(() => hostError.value),
    reportHostError,
    /**
     * What a debug export can contain now, frozen: the session, its recording, and the photos it used. `player` adds
     * the presentation details only the Player's interface knows.
     */
    async debugExportCandidate(
      player: DebugExportCandidate["player"],
    ): Promise<DebugExportCandidate> {
      // Everything is taken before the first photo is read, so play continuing meanwhile cannot mix in later state.
      const current = session.value;
      const frozen = {
        build: playerBuildIdentity,
        package: options.debugPackage ?? { id: null, version: null },
        session:
          current === null
            ? null
            : {
                plan: current.plan,
                snapshot: current.snapshot,
                events: [...current.events],
                transcriptEntries: [...current.transcriptEntries],
              },
        recording: recorder.recording(),
        hostError: hostError.value,
        player,
      };
      const storage =
        current?.snapshot.scriptStorage ?? frozen.recording?.endSnapshot.scriptStorage ?? [];
      const photos: DebugPhotoCandidate[] = [];
      for (const [reference, usedBy] of debugPhotoUses(frozen.recording, storage)) {
        const record = await capturedMedia.read(reference);
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
      return { ...frozen, photos };
    },
    loadScriptStorage,
    scriptStorageOptions,
    resolveAsset,
    /** The authored Stage image of the session, or `null` for an empty Stage. */
    stageImage,
    /** What the Stage reports about the source it shows: loaded and decoded, or failed; for Debug's Now view. */
    stageImageObservation: computed(() => ({
      loaded: loadedStageSource.value,
      failed: failedStageSource.value,
    })),
    /** The Stage source the browser has loaded and decoded, or `null` while it loads, failed, or shows none. */
    stageImageLoad(src: string | null) {
      loadedStageSource.value = src;
    },
    /**
     * The Stage source the browser could not load or decode, or `null` once the Stage shows another source. A failure is
     * reported only while `src` is still the session's Stage image.
     */
    stageImageFailure(src: string | null) {
      failedStageSource.value = src;
      const image = stageImage.value;
      if (src === null || image === null || resolveAsset(image) !== src) return;
      reportUnusableMedia(image, playerNotices.unusableMedia("image", image, "failed"));
    },
    /** The session camera's live track while the script shows a camera view and the camera is available, else `null`. */
    viewfinder,
    /** Where the script shows the camera view, `"window"` or `"stage"`, or `null` while it shows none. */
    viewfinderPlacement,
    /**
     * The image input of `askImage`: `store` checks and stores a chosen file, `admission` vouches for stored images when
     * the runtime is answered, and `discard` drops a stored image that never answered, for example after the request
     * ended while the file was read.
     */
    images: {
      /** Whether a camera can be used here for a request that allows it: the session camera, or one the browser opens. */
      camera: cameraOffered,
      store: storeImageFile,
      admission: imageAdmission,
      discard: (reference: string) => capturedMedia.discard(reference),
    },
    /**
     * Taking a photo for an `askImage` request that allows the camera: open while the request is presented, on the
     * Stage or in the script's camera window; `null` otherwise.
     */
    imageCapture: {
      view: imageCapture.view,
      retry: imageCapture.retry,
      shutter: imageCapture.shutter,
      retake: imageCapture.retake,
      use: imageCapture.use,
    },
    /** Bounded developer diagnostics, for example an unavailable session camera. */
    diagnostics: computed(() => diagnostics.value),
    /** Presented runtime timers; hidden timers have no entry. */
    timers: clock.timers,
    /** The display estimate of scene time, for presentation only; see `refreshSceneTimeWhile`. */
    sceneTimeMs: clock.displayTimeMs,
    /** Keeps `sceneTimeMs` refreshing while `demand` holds, until the calling scope ends. */
    refreshSceneTimeWhile: clock.refreshWhile,
    /** The permanent buttons the script shows, in creation order; a busy one is inactive until its block ends. */
    permanentButtons,
    pressPermanentButton,
    /** Observes elapsed time and media progress, runs the session, and returns the published session. */
    observe: clock.observe,
    publishJump,
    start,
    update,
    prepare,
    prepareRestore,
    activate,
    /** The capture a new session records at Start; Continue records its own. */
    temporalCapture,
  };
}

export type PlayerSessionHost = ReturnType<typeof usePlayerSession>;

/**
 * Replaces one script's saved data with its imported values: its own photos are added under new references first. Any
 * other reference in its values, such as another script's photo, stays the text it was.
 */
async function replaceScript(
  storage: ScriptStorageProvider,
  media: CapturedMediaStore,
  script: StorageBundleScript,
  images: readonly CheckedTransferImage[],
): Promise<void> {
  const own = new Set(script.photos);
  const references = new Map<string, string>();
  const added: string[] = [];
  try {
    for (const image of images) {
      if (!own.has(image.reference)) continue;
      const stored = media.add("image", image.data, { width: image.width, height: image.height });
      references.set(image.reference, stored.reference);
      added.push(stored.reference);
    }
    // Issued saves of an ended session finish first: storage runs its operations in issue order.
    await storage.replace(
      script.entries.map((entry) => ({
        key: entry.key,
        value: remapCapturedMediaReferences(entry.value, references),
      })),
    );
  } catch (error) {
    // Media stored before the failure is reclaimed later, as no saved value references it.
    for (const reference of added) media.discard(reference);
    throw error;
  }
}

function usesImages(script: StorageBundleScript): boolean {
  return script.photos.length > 0;
}

/** A checked import and how each script in it changes the saved data, shown before the player confirms it. */
export interface SavedDataImportReview {
  readonly bundle: StorageBundle;
  readonly images: readonly CheckedTransferImage[];
  readonly scripts: readonly SavedDataImportScript[];
}

export interface SavedDataImportScript {
  readonly scope: string;
  readonly name: string | null;
  readonly values: number;
  readonly photos: number;
  /** How many values are saved now; with none, the import adds the script. */
  readonly currentValues: number;
  /** Whether it is the script this Player shows, whose session an import ends. */
  readonly shown: boolean;
}

/** What a Debug storage edit did: saved (and taken by the running session when `live`), not saved, or overtaken. */
export type SavedDataEditResult =
  | { readonly kind: "saved"; readonly live: boolean }
  /** The saved value changed since the editor read it; nothing was written. */
  | { readonly kind: "changed" }
  | { readonly kind: "failed"; readonly message: string };

/** Whether two saved values are the same, comparing their stored form; `undefined` is an absent key. */
function sameSavedValue(
  left: SerializableRuntimeValue | undefined,
  right: SerializableRuntimeValue | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return serializeValidatedRuntimeJson(left) === serializeValidatedRuntimeJson(right);
}
