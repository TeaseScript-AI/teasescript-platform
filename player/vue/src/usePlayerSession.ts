import { computed, ref, shallowRef, watch } from "vue";
import { tryOnScopeDispose, useEventListener, useIntervalFn } from "@vueuse/core";
import { createBrowserCaptureHost, browserMediaUrls } from "../../browser-capture.js";
import { CaptureDevice } from "../../capture-device.js";
import {
  CapturedMediaNotStoredError,
  CapturedMediaStore,
  isCapturedMediaReference,
  type CapturedMediaRecord,
  type CapturedMediaRepository,
} from "../../captured-media.js";
import {
  browserCapturedMediaLocks,
  capturedMediaStorage,
  withCapturedMedia,
  type CapturedMediaStorage,
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
  beginPlayerRuntimeRecording,
  completePlayerRuntimeStorageWrite,
  applyPlayerRuntimeStorageEdit,
  continuePlayerRuntimeSession,
  playerTemporalContext,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeCameraView,
  playerRuntimeMedia,
  playerRuntimeMediaOrigin,
  playerRuntimePermanentButtons,
  playerRuntimeSnapshot,
  playerRuntimeSnapshotJson,
  playerRuntimeSnapshotOrNull,
  pressPlayerRuntimePermanentButton,
  reportPlayerRuntimeMediaLoad,
  restorePlayerRuntimeSessionAt,
  resumePlayerRuntimeRandomDraw,
  setPlayerRuntimeDebugMode,
  setPlayerRuntimeRandomControl,
  withPlayerRuntimeDebugTrace,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../../runtime-adapter.js";
import {
  debugPhotoUses,
  type DebugExportCandidate,
  type DebugPhotoCandidate,
} from "../../debug-export-assembly.js";
import type { DebugRewoundWhileDebugging } from "../../debug-export.js";
import {
  DEBUG_HISTORY_MEMORY_BUDGET,
  type DebugHistoryMarks,
  type DebugHistorySpill,
} from "../../debug-history.js";
import { openDebugHistorySpill, sweepDebugHistories } from "../../debug-history-indexeddb.js";
import { DebugRecorder } from "../../debug-recorder.js";
import {
  capturedMediaReferencesInJson,
  keptPhotoReferences,
  keptSession,
  memoryKeptRoomStore,
  memoryKeptSessionStore,
  type KeptRoomStore,
  type KeptSessionStore,
} from "../../kept-sessions.js";
import { RuntimeDebugContext } from "../../../src/index.js";
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
  type InstructionPlan,
  type InterpreterEvent,
  type RandomControlOptions,
  type RandomDrawResolutionOutcome,
  type RandomOutcome,
  type RuntimeScriptStorageEntrySnapshot,
  type SerializableRuntimeValue,
  type TemporalContext,
} from "../../../src/index.js";
import { serializableEquals } from "../../../src/runtime/serializable-values.js";
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
  /**
   * Where the script's session is kept, so that a reload or a later visit in this browser continues it (PLAYER-UI
   * "Session start and user activation"); in this page's memory by default. Only a script with storage that the host
   * prepares with `prepareScript` keeps one.
   */
  keptSessions?: KeptSessionStore;
  /**
   * Where the debug rooms of this browser's scripts are kept (DEBUGGER.md "Debug room"): each with its own session,
   * saved values, and photos; in this page's memory by default.
   */
  debugRooms?: KeptRoomStore;
  /** The room the page opens (DEBUGGER.md "Debug room"): the script's own, `normal` by default, or its debug room. */
  room?: "normal" | "debug";
  /** Opens where Debug's rewind history spills snapshots; IndexedDB by default, `null` keeps them in memory. */
  debugHistorySpill?: () => Promise<DebugHistorySpill | null>;
  /** Characters of state JSON a rewind history keeps in memory before it spills; diagnostic tuning for tests. */
  debugHistoryMemoryBudget?: number;
}

type Activation = {
  readonly kind: "start" | "continue";
  readonly begin: () => PlayerRuntimeSession;
  /** The marks a continued session had, which it keeps. */
  readonly marks?: DebugHistoryMarks;
};

/**
 * Creates a new session at Start; pass `recording` on to `createPlayerRuntimeSession`, so a debug export can replay it,
 * while Debug runs its value trace records it from the start, and the script reads whether Debug is on.
 */
export type PlayerSessionStart = (recording: {
  readonly recorder: DebugRecorder;
  readonly debugTrace?: RuntimeDebugContext;
  readonly debugMode: boolean;
  readonly randomControl?: RandomControlOptions;
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
  // Rewind histories that pages which ended without deleting theirs left behind go now.
  if (options.debugHistorySpill === undefined) void sweepDebugHistories();
  // The error name of an exception of the Player itself, such as one at Start; it stays until the next Start.
  const hostError = ref<string | null>(null);
  function reportHostError(error: unknown) {
    hostError.value = error instanceof Error ? error.name : "Error";
    console.error("[player] host error", error);
  }
  // Debug's value trace (DEBUGGER.md "Player Debug"), while Debug runs: every session operation records into it.
  const debugTrace = shallowRef<RuntimeDebugContext | null>(null);
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
      ? capturedMediaStorage(
          options.scriptStorage,
          capturedMedia,
          browserCapturedMediaLocks(),
          keptPhotoReferences(options.keptSessions),
        )
      : undefined;
  // The script's own saved data, which the debug room leaves as they are.
  const normalStorage = capturedMediaPersistence ?? options.scriptStorage;
  // The room shown, whose session, saved values, and photos are in use (DEBUGGER.md "Debug room"): the script's own,
  // `normal`, or its debug room, `debug`, which the page's URL opens and Debug on in the normal room goes on in. Only a
  // script with storage has a debug room.
  const room = ref<"normal" | "debug">(
    options.room === "debug" && normalStorage !== undefined ? "debug" : "normal",
  );
  // Whether Debug is on, which the script reads as `debugMode`.
  let debugMode = false;
  // The script's debug room, or `null` without one, and whether it keeps a session.
  let debugRooms = options.debugRooms ?? memoryKeptRoomStore();
  const debugRoom = shallowRef<{ readonly session: boolean } | null>(null);
  let debugRoomStorage: CapturedMediaStorage | null = null;
  // Where storage operations go: the provider in use, or a switch to another one, which operations issued meanwhile wait
  // for, in issue order.
  let storageRoute: ScriptStorageProvider | Promise<ScriptStorageProvider> | undefined =
    normalStorage;
  const routed = <T>(operation: (provider: ScriptStorageProvider) => Promise<T>): Promise<T> => {
    const route = storageRoute!;
    return route instanceof Promise ? route.then(operation) : operation(route);
  };
  const storageProvider: ScriptStorageProvider | undefined = normalStorage && {
    scope: normalStorage.scope,
    load: () => routed((provider) => provider.load()),
    write: (key, value) => routed((provider) => provider.write(key, value)),
    replace: (entries) => routed((provider) => provider.replace(entries)),
    clear: () => routed((provider) => provider.clear()),
  };
  /**
   * Sends storage operations where `next` resolves from now on, once the operations issued before have finished where
   * they were issued. `next` must not reject.
   */
  function switchStorage(next: () => Promise<ScriptStorageProvider>): Promise<void> {
    const previous = storageRoute!;
    const switched = (async () => {
      const provider = await previous;
      await (provider === debugRoomStorage ? debugRoomStorage : capturedMediaPersistence)?.flush();
      return next();
    })();
    storageRoute = switched;
    return switched.then((provider) => {
      if (storageRoute === switched) storageRoute = provider;
    });
  }
  /** Sends saved values and photos to the scope's debug room, which exists; `durable` are its photos this Player holds. */
  function enterDebugRoom(
    scope: string,
    state: { readonly session: boolean },
    durable: ReadonlySet<string>,
  ): ScriptStorageProvider {
    capturedMedia.useRepository(debugRooms.media, durable);
    debugRoomStorage = withCapturedMedia(debugRooms.values(scope), capturedMedia);
    debugRoom.value = state;
    return debugRoomStorage;
  }
  // The room the page opens is in use before a session is prepared; the debug room is made from a copy of the script's
  // own saved data when there is none yet.
  if (normalStorage !== undefined)
    void switchStorage(async () => {
      debugRoom.value = await debugRooms.read(normalStorage.scope).catch(() => null);
      if (room.value === "normal") return normalStorage;
      const durable =
        debugRoom.value === null
          ? await createDebugRoom(normalStorage.scope, false)
          : new Set<string>();
      return enterDebugRoom(normalStorage.scope, debugRoom.value ?? { session: false }, durable);
    });
  // Every change this Player makes to the stored values goes through here, which keeps the values the next Start loads
  // (`storedEntries`) equal to what the provider holds, so Play again starts without reading storage again. A failed
  // change leaves them as they were; session-local values (`null`) stay session-local.
  const scriptStorage: ScriptStorageProvider | undefined = storageProvider && {
    scope: storageProvider.scope,
    load: () => storageProvider.load(),
    write: (key, value) =>
      seeding(storageProvider.write(key, value), () => seedNextStart(key, value)),
    replace: (entries) =>
      seeding(storageProvider.replace(entries), () => {
        if (storedEntries.value !== null) storedEntries.value = [...entries];
      }),
    clear: () =>
      seeding(storageProvider.clear(), () => {
        if (storedEntries.value !== null) storedEntries.value = [];
      }),
  };
  // Seeds once the provider stored the change, before its caller learns of it, and hands the caller the provider's own
  // promise, so the change settles for it exactly as it would without seeding.
  function seeding(change: Promise<void>, seed: () => void): Promise<void> {
    change.then(seed, () => {});
    return change;
  }
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
  // Counts the times this script's saved data were replaced outside Debug's rewind, which ends its history.
  const rewindRetirements = ref(0);
  // While Debug's rewind shows a restored state (DEBUGGER.md "Rewind"), nothing runs on its own: the clock stands, media
  // hold their position, and load reports and capture requests wait, until new input adopts the state as the session.
  const inspecting = ref(false);
  // Whether Debug's rewind restored an earlier state of the session; for its debug export.
  const rewound = shallowRef<DebugRewoundWhileDebugging | null>(null);
  // While the session is paused at a random draw (DEBUGGER.md "Random draws"), it holds like an inspected state until
  // the draw is resolved.
  const drawPending = computed(() => session.value?.state.randomDraw != null);
  const held = computed(() => inspecting.value || drawPending.value);
  // Which random draws Debug decides or pauses at; every session of the Player gets it.
  let randomControl: RandomControlOptions | null = null;
  // The session as other parts of the Player service it: none while a restored state is inspected or a draw is paused.
  const servicedSession = computed(() => (held.value ? null : session.value));
  // A new session remounts the transcript and resets interaction-local state.
  const generation = ref(0);
  const interactionReset = ref(0);
  // The transcript revision through which the session's transcript shows directly, as history: what development time
  // jumps published. -1 for none in this generation.
  const jumpedRevision = ref(-1);
  const activation = shallowRef<Activation | null>(null);
  // The script places the camera view with `showCamera [stage]` and hides it with `hideCamera`; the view only previews
  // the session camera, which stays open for `takePhoto()`. Without an available camera there is nothing to show.
  const viewfinderPlacement = computed(() => {
    const current = session.value;
    return current === null ? null : playerRuntimeCameraView(current.state);
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
      if (held.value) return "pending";
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
  const clock = useRuntimeSceneClock(session, () => device.sample(), held);
  const stageImage = computed(() =>
    session.value === null ? null : playerRuntimeMedia(session.value.state).stage.image,
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
    [session, held],
    ([current, paused]) => {
      const media = current ? playerRuntimeMedia(current.state).media : [];
      // An inspected state, and a draw that waits, show their media where they were, without playing them.
      device.reconcile(
        paused ? media.map((projection) => ({ ...projection, state: "paused" as const })) : media,
      );
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
    session: () => servicedSession.value,
    generation: () => generation.value,
    observe: () => clock.observe(),
    publish: (next) => (session.value = next),
    capturedMedia,
    diagnostic: reportDiagnostic,
    later: (task) => setTimeout(task, 0),
  });
  const serviceCapture = () => captures.request();
  watch(servicedSession, () => void serviceCapture());
  // A session that ended releases its camera.
  watch(
    () => session.value?.state.status,
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
    session: servicedSession,
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
      const request = session.value && activePlayerRuntimeInteraction(session.value.state);
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
  // The latest Start, offered again after an import replaced the saved data, and by Play again.
  const lastStart = shallowRef<PlayerSessionStart | null>(null);
  // The source text of each file of the script Start runs, by path, when its host supplied it.
  let scriptSources: ReadonlyMap<string, string> = new Map();
  let disposed = false;
  tryOnScopeDispose(() => {
    disposed = true;
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
    void Promise.all([capturedMediaPersistence?.close(), debugRoomStorage?.drain()]).finally(() =>
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
  // For each Debug edit being stored: the script writes stored meanwhile, by key, which then stand over the edit.
  const scriptWritesStored = new Set<Map<string, SerializableRuntimeValue>>();
  watch(
    session,
    (current) => {
      const write = current && pendingPlayerRuntimeStorageWrite(current.state);
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
        writesInFlight.delete(flight);
        // A write that settles after unmount must not continue the session.
        if (disposed) return;
        const latest = session.value;
        // The report must belong to the session that requested it.
        if (generation.value !== sessionGeneration || latest === null) return;
        if (pendingPlayerRuntimeStorageWrite(latest.state)?.actionId !== write!.actionId) return;
        if (!stored) notices.publish(playerNotices.storageWriteFailed());
        else {
          savedDataRevision.value++;
          for (const stored of scriptWritesStored) stored.set(write!.key, write!.value);
        }
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
  // Debug storage edits (DEBUGGER.md "Player Debug"), one at a time. An edit is stored first and reaches the running
  // session only once that succeeded, through the engine's storage-edit input; its next `load` then returns it. While
  // the script's own write waits for the host, an edit is not taken: it would have to come between that write and the
  // script. A write the script issues while an edit is being stored settles as usual first.
  let editChain: Promise<unknown> = Promise.resolve();
  /** Puts a stored value into the values the next Start loads, as the provider now holds them; see `scriptStorage`. */
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
    (session.value.state.status === "running" || session.value.state.status === "waiting") &&
    activation.value === null &&
    !openingCamera.value;
  /** Whether the running session's own write waits for the host, so it takes no edit until that settled. */
  const scriptSaving = () =>
    liveSession() && pendingPlayerRuntimeStorageWrite(session.value!.state) !== null;
  // Edits that wait for the session's write to settle; each published session or new run wakes them to look again.
  const writeSettledWaiters = new Set<() => void>();
  watch([session, generation], () => {
    for (const resolve of writeSettledWaiters) resolve();
    writeSettledWaiters.clear();
  });
  tryOnScopeDispose(() => {
    for (const resolve of writeSettledWaiters) resolve();
    writeSettledWaiters.clear();
  });

  /**
   * Changes one saved value for Debug: `value: null` deletes the key. `expected` is the value the editor started from,
   * `undefined` for a new key; a saved value that changed meanwhile is reported, not overwritten. The edit is stored
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
    // Debug's rewind waits until the edit is stored and the session took it.
    editsInFlight.value++;
    void editChain.then(() => editsInFlight.value--);
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
    const sessionChanged = () => failed("The session changed meanwhile; open the editor again.");
    if (retired()) return sessionChanged();
    if (!scriptStorage || storedEntries.value === null)
      return failed("This browser's saved data cannot be read.");
    if (
      importing.value ||
      clearing.value ||
      openingCamera.value ||
      inspecting.value ||
      activation.value?.kind === "continue"
    )
      return failed("Saved data cannot be changed right now.");
    if (scriptSaving()) return { kind: "busy" };
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
    if (retired()) return sessionChanged();
    const now = current.find((entry) => entry.key === key)?.value;
    if (!sameSavedValue(now, expected)) return { kind: "changed" };
    if (scriptSaving()) return { kind: "busy" };
    // A script write issued from here on is stored after the edit: the Player's providers store writes in the order
    // they were issued. Once those settled, a stored one of this key stands, in storage as in the session.
    const stored = new Map<string, SerializableRuntimeValue>();
    scriptWritesStored.add(stored);
    try {
      try {
        await scriptStorage.write(key, value);
      } catch {
        return failed("The change could not be saved in this browser. Nothing changed.");
      }
      savedDataRevision.value++;
      while (
        !retired() &&
        session.value !== null &&
        pendingPlayerRuntimeStorageWrite(session.value.state) !== null
      )
        await new Promise<void>((resolve) => writeSettledWaiters.add(resolve));
    } finally {
      scriptWritesStored.delete(stored);
    }
    if (retired()) return { kind: "saved", live: false };
    if (stored.has(key)) return { kind: "overtaken" };
    if (!liveSession()) return { kind: "saved", live: false };
    const latest = session.value!;
    const edited = applyPlayerRuntimeStorageEdit(latest, { key, value });
    if (edited.outcome.kind !== "applied") return { kind: "saved", live: false };
    session.value = edited.session;
    debugEdits.value = {
      firstEditSceneTimeMs:
        debugEdits.value?.firstEditSceneTimeMs ?? latest.state.observedSessionTimeMs,
      editCount: (debugEdits.value?.editCount ?? 0) + 1,
    };
    return { kind: "saved", live: true };
  }
  const canClearScriptStorage = computed(
    () =>
      scriptStorage !== undefined &&
      storedEntries.value !== null &&
      !clearing.value &&
      !importing.value &&
      !openingCamera.value &&
      !inspecting.value &&
      activation.value?.kind !== "continue" &&
      (session.value === null ||
        session.value.state.status === "halted" ||
        session.value.state.status === "failed"),
  );
  /** Removes this script's saved data; resolves to whether it was cleared. */
  async function clearScriptStorage(): Promise<boolean> {
    if (!scriptStorage || !canClearScriptStorage.value) return false;
    clearing.value = true;
    try {
      await scriptStorage.clear();
      savedDataRevision.value++;
      // Debug's rewind could restore the saved data cleared now, so its history ends.
      rewindRetirements.value++;
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
      // This Player's script is read through its own storage, after the saves its session issued; the debug room is
      // never exported.
      if (scope === scriptStorage?.scope) {
        if (room.value === "normal")
          script = await collectSavedScript(scriptStorage, capturedMedia, name);
        else {
          const media = ownStoredMedia(scope);
          try {
            script = await collectSavedScript(normalStorage!, media, name);
          } finally {
            media.close();
          }
        }
      } else if (options.savedData) {
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
          ? await (room.value === "normal" ? scriptStorage! : normalStorage!).load()
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
        // The debug room's session does not use the script's own saved data, so an import does not end it.
        shown: own && room.value === "normal",
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
    // In the debug room an import replaces the script's own saved data, which the debug room and its session do not use.
    const inDebugRoom = room.value === "debug";
    const ownChosen =
      scriptStorage !== undefined && chosen.has(scriptStorage.scope) && !inDebugRoom;
    importing.value = true;
    const failed: string[] = [];
    try {
      // Debug's rewind could restore this script's earlier saved data over the import, so its history ends too, and so
      // does an inspected state, also one that ended.
      if (ownChosen) {
        if (sessionInProgress.value || inspecting.value) endSession();
        rewindRetirements.value++;
        // A session being kept is kept before the import discards it.
        while (keeping !== null) await keeping;
      }
      for (const script of review.bundle.scripts) {
        if (!chosen.has(script.scope)) continue;
        try {
          if (script.scope === scriptStorage?.scope && inDebugRoom) {
            const media = ownStoredMedia(script.scope);
            const storage = withCapturedMedia(options.scriptStorage!, media);
            try {
              if (capturedMediaPersistence === undefined && usesImages(script))
                throw new CapturedMediaNotStoredError("This Player cannot keep saved photos.");
              await replaceScript(storage, media, script, review.images);
            } finally {
              await storage.drain();
              media.close();
            }
          } else if (script.scope === scriptStorage?.scope) {
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
          // The script's next session loads the imported values: a kept session, with its older view, does not go on.
          await keptSessions.discard(script.scope).catch(() => {});
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
        if (lastStart.value !== null && !sessionInProgress.value) prepare(lastStart.value);
      } else importing.value = false;
    }
    if (failed.length > 0)
      throw new StorageTransferError(
        `Not imported, and their saved data is unchanged: ${failed.join("; ")}. Any other chosen script was imported.`,
      );
  }
  /** The script's own stored photos while the debug room is shown; close it after use. */
  function ownStoredMedia(scope: string): CapturedMediaStore {
    return new CapturedMediaStore(
      options.capturedMedia?.repository ?? null,
      browserMediaUrls,
      scope,
    );
  }
  /** Whether a session runs, waits for Continue, or is starting; its own view of the saved values is in use. */
  const sessionInProgress = computed(
    () =>
      openingCamera.value ||
      activation.value?.kind === "continue" ||
      (session.value !== null &&
        session.value.state.status !== "halted" &&
        session.value.state.status !== "failed"),
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
    jumpedRevision.value = -1;
    inspecting.value = false;
    rewound.value = null;
    session.value = null;
  }

  // Starts or restores a session; its scene time continues from the persisted observation, so a
  // gap while no Player ran is not consumed. A state Debug's rewind restored is published `paused` for inspection.
  function start(next: PlayerRuntimeSession, paused = false) {
    // A failed write concerns the run it happened in.
    notices.dismiss(playerNoticeKeys.storageWriteFailed);
    reportedMedia = new Set();
    debugEdits.value = null;
    inspecting.value = paused;
    rewound.value = null;
    device.reset();
    loads.clear();
    pendingLoadCount.value = 0;
    generation.value++;
    interactionReset.value++;
    jumpedRevision.value = -1;
    applyRandomControl(next);
    session.value = next;
    clock.rebase();
    if (!paused) {
      applyDebugMode();
      settleUncontrolledDraw();
    }
    // The session that runs is the one a reload continues in its room.
    if (!paused) keepSessionLater();
  }
  // Publishes the result of a completed runtime action. Input to an inspected state is evaluated only once
  // `prepareInput` adopted it, so a result for the inspected state itself is never published.
  function update(next: PlayerRuntimeSession) {
    if (!inspecting.value) session.value = next;
  }
  // Counts the sessions that ended as they played, also within their Start; a state Debug's rewind restored has ended
  // before and does not end anew.
  const endings = ref(0);
  let rewoundGeneration = -1;
  watch([session, generation], ([next, current], [previous, before]) => {
    if (next?.state.status !== "halted") return;
    if (current === before ? previous?.state.status !== "halted" : current !== rewoundGeneration)
      endings.value++;
  });

  // The script's kept session, which a reload or a later visit continues (PLAYER-UI "Session start and user
  // activation"); only a script with storage keeps one, under its storage scope. The debug room keeps its own.
  const keptSessions = options.keptSessions ?? memoryKeptSessionStore();
  const keptScope = options.scriptStorage?.scope ?? null;
  const keptStore = (): KeptSessionStore => (room.value === "debug" ? debugRooms : keptSessions);
  // The plan of the script, which a kept session runs.
  let scriptPlan: InstructionPlan | null = null;
  // What is kept of the shown session, so that keeping it again adds only the events after it: whether the plan is kept,
  // and how many events, the last of which is `last`. A new session starts with none.
  let kept: {
    readonly plan: boolean;
    readonly count: number;
    readonly last: InterpreterEvent | null;
  } = { plan: false, count: 0, last: null };
  let keeping: Promise<void> | null = null;
  let keepAgain = false;
  /**
   * Keeps the shown session, where a reload continues it, together with the photos only it uses. One write runs at a
   * time; a request meanwhile keeps the session as it is once that is done. A state Debug's rewind shows for inspection
   * is never kept: the session it left is.
   */
  function keepSessionLater() {
    if (keeping !== null) {
      keepAgain = true;
      return;
    }
    keeping = (async () => {
      // The caller finishes first, such as a Continue that gives the session its marks.
      await Promise.resolve();
      do {
        keepAgain = false;
        await keepOnce();
      } while (keepAgain && !disposed);
    })().finally(() => (keeping = null));
  }
  async function keepOnce() {
    const current = session.value;
    // Only a script a host prepared with `prepareScript` keeps its session.
    if (keptScope === null || scriptPlan === null || current === null) return;
    if (inspecting.value || activation.value !== null) return;
    // Taken before anything waits: later operations change the session.
    let snapshotJson: string;
    try {
      snapshotJson = playerRuntimeSnapshotJson(current);
    } catch {
      return;
    }
    const events = current.events;
    const from =
      kept.count <= events.length && (kept.count === 0 || events[kept.count - 1] === kept.last)
        ? kept.count
        : 0;
    const count = events.length;
    const added = events.slice(from, count);
    const last = events[count - 1] ?? null;
    const planJson = kept.plan && from > 0 ? null : JSON.stringify(current.plan);
    const marks = { editedWhileDebugging: debugEdits.value, rewoundWhileDebugging: rewound.value };
    const references = capturedMediaReferencesInJson(snapshotJson + JSON.stringify(added));
    const inDebugRoom = room.value === "debug";
    const store = keptStore();
    // The room's saved data are in use once storage reached it.
    await storageRoute;
    if (disposed || (room.value === "debug") !== inDebugRoom) return;
    try {
      if (inDebugRoom) {
        // The debug room stores the session's photos like its saved ones.
        await capturedMedia.promote(references).catch(() => {});
      } else {
        // A new session replaces the one kept before, with its photos.
        if (from === 0) await store.discard(keptScope);
        // The photos no save stored go with the session, a photo already kept as it is; a stored one stays stored
        // while the session uses it (`capturedMediaStorage`).
        for (const photo of capturedMedia.sessionRecords(references))
          await store.media.add(photo).catch(() => {});
      }
      await store.publish(keptScope, {
        planJson,
        snapshotJson,
        eventsFrom: from,
        events: added,
        marks,
      });
      kept = { plan: true, count, last };
      if (inDebugRoom) debugRoom.value = { session: true };
    } catch {
      // The session kept before stays; a reload continues from there.
    }
  }
  /** Keeps the shown session as it is now and waits until it is kept. */
  async function keepSession(): Promise<void> {
    keepSessionLater();
    while (keeping !== null) await keeping;
  }
  // The session is kept at each interaction it newly presents and when it ends, and when the page is hidden.
  let keptActionId: number | null = null;
  watch(session, (current) => {
    if (current === null || inspecting.value) return;
    const actionId = activePlayerRuntimeInteraction(current.state)?.actionId ?? null;
    const ended = current.state.status === "halted" || current.state.status === "failed";
    if ((actionId === null || actionId === keptActionId) && !ended) return;
    keptActionId = actionId;
    keepSessionLater();
  });
  useEventListener(
    () => (typeof document === "undefined" ? undefined : document),
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") keepSessionLater();
    },
  );
  /**
   * Prepares a session of `plan`, which `create` starts: Continue when the script keeps a session that can go on, else
   * Start. Call it instead of `prepare` once the stored values are loaded.
   */
  async function prepareScript(
    plan: InstructionPlan,
    create: PlayerSessionStart,
    sources?: ReadonlyMap<string, string>,
  ): Promise<void> {
    scriptPlan = plan;
    lastStart.value = create;
    if (sources !== undefined) scriptSources = sources;
    await prepareKept();
  }
  /** Shows Continue when the script keeps a session that can go on, else Start. */
  async function prepareKept(): Promise<void> {
    const continued = scriptPlan === null ? null : await restoreKept(scriptPlan);
    if (disposed) return;
    if (continued !== null) {
      kept = {
        plan: true,
        count: continued.session.events.length,
        last: continued.session.events.at(-1) ?? null,
      };
      prepareRestore(continued.session, continued.marks);
    } else if (lastStart.value !== null) prepare(lastStart.value);
  }
  /**
   * The kept session, restored, when it runs `plan` and has not ended; else `null`. The photos only it uses are its
   * session media again.
   */
  async function restoreKept(
    plan: InstructionPlan,
  ): Promise<{ readonly session: PlayerRuntimeSession; readonly marks: DebugHistoryMarks } | null> {
    if (keptScope === null) return null;
    await storageRoute;
    const store = keptStore();
    const stored = await store.session(keptScope).catch(() => null);
    const found = stored === null ? null : keptSession(stored);
    if (found === null || found.planJson !== JSON.stringify(plan)) return null;
    let restored: PlayerRuntimeSession;
    try {
      restored = restorePlayerRuntimeSessionAt(plan, found.snapshotJson, found.events);
    } catch {
      return null;
    }
    if (restored.state.status === "halted" || restored.state.status === "failed") return null;
    // The debug room reads its photos like its saved ones; a normal session's come back as session media.
    if (store === keptSessions)
      for (const reference of capturedMediaReferencesInJson(
        found.snapshotJson + JSON.stringify(found.events),
      ))
        capturedMedia.restoreSessionMedia(
          reference,
          await store.media.get(keptScope, reference).catch(() => null),
        );
    return { session: restored, marks: found.marks };
  }
  /**
   * Returns to the start page once the session ended by `exit`, which the host does when the player closes the end
   * dialog; the ended session is kept first, so a reload starts anew.
   */
  async function toStartPage(): Promise<void> {
    if (session.value?.state.status !== "halted") return;
    await keepSession();
    if (disposed || session.value?.state.status !== "halted") return;
    endSession();
    await prepareKept();
  }

  /**
   * Turns Debug on or off for the script. On in the normal room, play goes on in the debug room (`copyToDebugRoom`). Off,
   * play goes on where it is. A running session reads the change from its next statement on.
   */
  function setDebugMode(enabled: boolean) {
    if (enabled === debugMode) return;
    debugMode = enabled;
    if (enabled && room.value === "normal" && normalStorage !== undefined) void copyToDebugRoom();
    else applyDebugMode();
  }
  /**
   * Gives the running session the current Debug state. One that waits for Continue takes it at Continue, and a state
   * Debug's rewind shows for inspection once it is adopted or the session it left is back.
   */
  function applyDebugMode() {
    const current = session.value;
    if (
      current === null ||
      inspecting.value ||
      activation.value !== null ||
      (current.state.status !== "running" && current.state.status !== "waiting") ||
      current.state.debugMode === debugMode
    )
      return;
    const result = setPlayerRuntimeDebugMode(current, debugMode);
    if (result.outcome.kind !== "set") return;
    session.value = result.session;
    keepSessionLater();
  }
  /**
   * Gives every session from now on Debug's random control, or none. Without one, a draw the session is paused at goes
   * on naturally.
   */
  function setRandomControl(control: RandomControlOptions | null) {
    randomControl = control;
    const current = session.value;
    if (current === null) return;
    applyRandomControl(current);
    if (control === null && current.state.randomDraw !== null)
      resolveRandomDraw(current.state.randomDraw.drawId, "natural");
  }
  function applyRandomControl(current: PlayerRuntimeSession) {
    if (current.state.status === "halted" || current.state.status === "failed") return;
    setPlayerRuntimeRandomControl(current, randomControl);
  }
  // A session that runs again while paused at a draw nobody decides any more, such as a restored state adopted after
  // Debug's control ended, goes on naturally.
  function settleUncontrolledDraw() {
    const draw = session.value?.state.randomDraw;
    if (randomControl === null && draw != null) resolveRandomDraw(draw.drawId, "natural");
  }
  /**
   * Resolves the random draw the session is paused at, naturally or with a chosen outcome; the session's clock goes on
   * from the time it paused at. `null` when the session is not paused at that draw.
   */
  function resolveRandomDraw(
    drawId: number,
    outcome: "natural" | RandomOutcome,
  ): RandomDrawResolutionOutcome | null {
    const current = session.value;
    if (current === null || inspecting.value || current.state.randomDraw?.drawId !== drawId)
      return null;
    const result = resumePlayerRuntimeRandomDraw(current, { drawId, outcome });
    session.value = result.session;
    clock.rebase();
    return result.outcome;
  }
  /** Whether the shown session runs or waits. */
  const sessionLive = computed(
    () =>
      session.value !== null &&
      (session.value.state.status === "running" || session.value.state.status === "waiting"),
  );
  // A room change runs to its end before another starts; like an import, it replaces the saved data in use.
  let roomChange: Promise<void> = Promise.resolve();
  /**
   * Goes on in the debug room. A normal session that runs or waits goes on there as a copy, with a copy of the script's
   * own saved values and photos as they are now, replacing any earlier debug room; the normal session stays where it is
   * and keeps counting, and its saves until now stay the script's own. Without one, the debug room is made from that copy
   * unless there is one, and shows its Start or Continue.
   */
  function copyToDebugRoom(): Promise<void> {
    // The switch excludes Start and Continue: a prepared one, also one waiting for the camera, is retired at once, none
    // runs meanwhile, and the debug room's own is prepared once its saved data are in use.
    if (!sessionLive.value) endSession();
    importing.value = true;
    roomChange = roomChange.then(async () => {
      try {
        if (normalStorage === undefined || room.value !== "normal" || !debugMode || disposed)
          return;
        const scope = normalStorage.scope;
        const live = sessionLive.value;
        // The normal room keeps its session as it is now, which a later visit continues.
        if (live) await keepSession();
        const making = live || debugRoom.value === null;
        const replacing = live && debugRoom.value !== null;
        room.value = "debug";
        kept = { plan: false, count: 0, last: null };
        keptActionId = null;
        await switchStorage(async () => {
          if (replacing) await debugRooms.discard(scope).catch(() => {});
          const durable = making ? await createDebugRoom(scope, false) : new Set<string>();
          return enterDebugRoom(scope, making ? { session: live } : debugRoom.value!, durable);
        });
        await loadScriptStorage();
        if (live) applyDebugMode();
        else {
          // A normal session that ended meanwhile stays in the normal room.
          endSession();
          await prepareKept();
        }
      } finally {
        importing.value = false;
      }
    });
    return roomChange;
  }
  /**
   * Stores a new debug room with a copy of the script's own saved values and photos as they are now, or none when
   * `empty`. Resolves to the references of its photos.
   */
  async function createDebugRoom(scope: string, empty: boolean): Promise<ReadonlySet<string>> {
    let entries: readonly RuntimeScriptStorageEntrySnapshot[] = [];
    let photos: readonly CapturedMediaRecord[] = [];
    try {
      if (!empty) {
        entries = await normalStorage!.load();
        photos = await storedPhotos(scope);
      }
    } catch {
      // Saved data this browser cannot read is not copied; the debug room starts without it.
    }
    try {
      await debugRooms.create(scope, entries, photos);
    } catch {
      // Another tab created it meanwhile, or this browser cannot keep it: then it lives in this page.
      if ((await debugRooms.read(scope).catch(() => null)) === null) {
        debugRooms = memoryKeptRoomStore();
        await debugRooms
          .create(scope, entries, photos)
          .catch(() => debugRooms.create(scope, [], []));
      }
    }
    return new Set(photos.map((photo) => photo.reference));
  }
  /** The script's stored photos, checked as the Player reads them. */
  async function storedPhotos(scope: string): Promise<readonly CapturedMediaRecord[]> {
    const repository = options.capturedMedia?.repository ?? null;
    if (repository === null) return [];
    const reader = new CapturedMediaStore(repository, browserMediaUrls, scope);
    try {
      const photos: CapturedMediaRecord[] = [];
      for (const reference of await repository.listReferences(scope)) {
        const record = await reader.read(reference);
        if (record !== null) photos.push(record);
      }
      return photos;
    } finally {
      reader.close();
    }
  }
  /**
   * From the debug room's start page and the player's click, starts a new debug session: with the debug room's saved
   * data as they are, deleting only its session (`reload`), or with its saved data and photos deleted too (`reset`).
   */
  function startDebugSessionAnew(clear: "reload" | "reset"): Promise<void> {
    primeAudio();
    roomChange = roomChange.then(async () => {
      if (room.value !== "debug" || normalStorage === undefined || disposed) return;
      const scope = normalStorage.scope;
      importing.value = true;
      try {
        while (keeping !== null) await keeping;
        endSession();
        kept = { plan: false, count: 0, last: null };
        keptActionId = null;
        if (clear === "reset")
          await switchStorage(async () => {
            await debugRooms.discard(scope).catch(() => {});
            return enterDebugRoom(scope, { session: false }, await createDebugRoom(scope, true));
          });
        await loadScriptStorage();
      } finally {
        importing.value = false;
      }
      if (lastStart.value !== null && !disposed) {
        prepare(lastStart.value);
        await activate();
      }
    });
    return roomChange;
  }
  /**
   * Readies the session for input before the input is evaluated: an inspected state Debug's rewind restored is adopted
   * first. `true` when input may go ahead at once, else whether it may once the state is adopted; a state that could
   * not be adopted, or one being adopted for other input, takes none, and stays as it was.
   */
  function prepareInput(): true | Promise<boolean> {
    return inspecting.value ? adoptRewound() : true;
  }

  /**
   * Shows a state Debug's rewind restored (DEBUGGER.md "Rewind") as a new generation of the session, with the marks it
   * had: paused for inspection, or running, as when Return reinstates the session Back left. `create` gets the recorder
   * to begin anew at the state.
   */
  function publishRewound(
    create: PlayerSessionStart,
    state: { readonly paused: boolean; readonly marks: DebugHistoryMarks },
  ) {
    // An unmounted Player publishes nothing.
    if (disposed) return;
    const next = create({ recorder, debugMode });
    start(next, state.paused);
    rewoundGeneration = generation.value;
    debugEdits.value = state.marks.editedWhileDebugging;
    rewound.value = state.marks.rewoundWhileDebugging;
  }
  // Debug's rewind does one thing at a time: restoring a state (a step, which may read a spilled snapshot) or adopting
  // the inspected one (which replaces the saved data). Each holds this until it is done, and neither starts meanwhile.
  const rewindWork = ref<"step" | "adopt" | null>(null);
  let adoption: Promise<boolean> | null = null;
  const editsInFlight = ref(0);
  /** Whether the session may be left for a restored state now: nothing waits for the host or the player. */
  const rewindReady = computed(
    () =>
      session.value !== null &&
      activation.value === null &&
      !importing.value &&
      !clearing.value &&
      !openingCamera.value &&
      editsInFlight.value === 0 &&
      pendingPlayerRuntimeStorageWrite(session.value.state) === null,
  );
  /** Whether Debug's rewind may begin a step now: the session may be left, and no other rewind work runs. */
  const canRewind = computed(() => rewindReady.value && rewindWork.value === null);
  /** Begins a rewind step, if one may begin now; call the returned function once the step is done. */
  function beginRewindStep(): (() => void) | null {
    if (!canRewind.value) return null;
    rewindWork.value = "step";
    let held = true;
    return () => {
      if (held && rewindWork.value === "step") rewindWork.value = null;
      held = false;
    };
  }
  let rewindAdopted: (() => void) | null = null;
  /**
   * Adopts the inspected state as the session: the saved data are replaced by the state's own, as one validated
   * replacement that also keeps the photos they use, and the state runs from then on, saving as any session. When the
   * saved data cannot be replaced, the state stays inspected and nothing changes. Resolves to whether it was adopted.
   */
  function adoptRewound(): Promise<boolean> {
    if (!inspecting.value || rewindWork.value !== null || session.value === null)
      return Promise.resolve(false);
    adoption = adoptShown(session.value).finally(() => (adoption = null));
    return adoption;
  }
  async function adoptShown(shown: PlayerRuntimeSession): Promise<boolean> {
    const owner = generation.value;
    // The adopted state, exported once before the first await.
    const adopted = playerRuntimeSnapshot(shown);
    rewindWork.value = "adopt";
    try {
      if (scriptStorage && adopted.scriptStoragePersistent)
        await scriptStorage.replace(adopted.scriptStorage);
    } catch {
      if (!disposed) notices.publish(playerNotices.rewindNotAdopted());
      return false;
    } finally {
      rewindWork.value = null;
    }
    // Turning the value trace on or off rewraps the shown session; only a rewind or a new session replaces it.
    if (disposed || generation.value !== owner || !inspecting.value) return false;
    notices.dismiss(playerNoticeKeys.rewindNotAdopted);
    savedDataRevision.value++;
    rewindAdopted?.();
    inspecting.value = false;
    clock.rebase();
    applyDebugMode();
    settleUncontrolledDraw();
    return true;
  }
  /**
   * Publishes a session that development time jumps (#615) advanced from the current one: playing media seek to the
   * progress the jumps reported, and the scene clock continues from the new observed time.
   */
  function publishJump(next: PlayerRuntimeSession) {
    if (inspecting.value) return;
    jumpedRevision.value = next.transcriptRevision;
    session.value = next;
    device.jumped(playerRuntimeMedia(next.state).media);
    clock.rebase();
  }
  const permanentButtons = computed(() =>
    session.value === null ? [] : playerRuntimePermanentButtons(session.value.state),
  );
  /** Clicks a permanent button at the observed time, like other input; a click it does not accept changes nothing. */
  async function pressPermanentButton(buttonId: number) {
    if (!(await prepareInput())) return;
    const current = clock.observe();
    if (current === null) return;
    const result = pressPlayerRuntimePermanentButton(current, buttonId);
    if (result.outcome.kind === "pressed") update(result.session);
  }
  /**
   * Shows the explicit Start control for a new session; `create` runs only on activation, so no statement executes
   * on page load and the click is the user activation later audible playback relies on. `sources`, the text of the
   * script's files by path, lets the error dialog show a failing line; a later `prepare` without them keeps them.
   */
  function prepare(create: PlayerSessionStart, sources?: ReadonlyMap<string, string>) {
    lastStart.value = create;
    if (sources !== undefined) scriptSources = sources;
    activationToken++;
    openingCamera.value = false;
    // A new session needs its own camera; a superseded acquisition never stays open.
    camera.release();
    activation.value = {
      kind: "start",
      begin: () =>
        create({
          recorder,
          debugMode,
          ...(debugTrace.value === null ? {} : { debugTrace: debugTrace.value }),
          ...(randomControl === null ? {} : { randomControl }),
        }),
    };
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
  function prepareRestore(restored: PlayerRuntimeSession, marks?: DebugHistoryMarks) {
    activationToken++;
    openingCamera.value = false;
    camera.release();
    activation.value = {
      kind: "continue",
      begin: () => {
        // The recording of a restored session starts from the state it continues, and so does a new trace epoch.
        beginPlayerRuntimeRecording(restored, recorder);
        debugTrace.value?.reset("restore");
        let continued: PlayerRuntimeSession = Object.freeze({
          ...restored,
          recorder,
          debugTrace: debugTrace.value,
        });
        // A session kept while paused at a random draw goes on with its natural outcome first: until then, the engine
        // takes no other input.
        const draw = continued.state.randomDraw;
        if (draw !== null)
          continued = resumePlayerRuntimeRandomDraw(continued, {
            drawId: draw.drawId,
            outcome: "natural",
          }).session;
        // The script reads whether Debug is on now.
        if (continued.state.debugMode !== debugMode)
          continued = setPlayerRuntimeDebugMode(continued, debugMode).session;
        applyRandomControl(continued);
        return continuePlayerRuntimeSession(continued, temporalCapture()).session;
      },
      ...(marks === undefined ? {} : { marks }),
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
    // A new session replaces the one kept before.
    if (pending.kind === "start") {
      kept = { plan: false, count: 0, last: null };
      keptActionId = null;
    }
    if (pending.marks !== undefined) {
      debugEdits.value = pending.marks.editedWhileDebugging;
      rewound.value = pending.marks.rewoundWhileDebugging;
    }
  }

  return {
    session: computed(() => session.value),
    generation: computed(() => generation.value),
    interactionReset: computed(() => interactionReset.value),
    /**
     * The transcript revision through which the transcript shows directly, like history, rather than entering as live
     * play: what development time jumps published (#615). -1 for none since the session started.
     */
    jumpedRevision: computed(() => jumpedRevision.value),
    setDebugMode,
    setRandomControl,
    /**
     * The random draw the session is paused at, or `null`; a restored state Debug's rewind shows waits at its draw only
     * once input adopts it.
     */
    randomDraw: computed(() =>
      inspecting.value ? null : (session.value?.state.randomDraw ?? null),
    ),
    resolveRandomDraw,
    /**
     * The normal room and the debug room (DEBUGGER.md "Debug room"). `reloadDebug` and `resetDebug` start a new debug
     * session from the debug room's start page on the player's click.
     */
    rooms: {
      /** The room shown. */
      current: computed(() => room.value),
      /** Whether the debug room keeps a session, which Debug on during a normal session would overwrite. */
      debugSessionExists: computed(() => debugRoom.value?.session === true),
      /** Whether the debug room is shown and has something to delete: a kept session or saved values. */
      debugHasData: computed(
        () =>
          room.value === "debug" &&
          (debugRoom.value?.session === true || (storedEntries.value?.length ?? 0) > 0),
      ),
      /** Whether Debug on copies the normal session shown, which runs or waits, over the debug room's session. */
      copies: computed(() => room.value === "normal" && sessionLive.value),
      reloadDebug: () => startDebugSessionAnew("reload"),
      resetDebug: () => startDebugSessionAnew("reset"),
    },
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
        !inspecting.value &&
        activation.value?.kind !== "continue",
      live: liveSession(),
      /** The running session's own write waits for the host; Debug edits wait until it settled. */
      scriptSaving: scriptSaving(),
    })),
    /** Whether Debug changed this session's saved values: from which scene time and how often; for its debug export. */
    debugEdits: computed(() => debugEdits.value),
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
     * What a debug export can contain now, frozen: the session, its recording, and the photos it used. `shown` adds
     * what only the Player's interface knows: its presentation details and what it observed of the Stage and media.
     */
    async debugExportCandidate(
      shown: Pick<DebugExportCandidate, "player" | "host">,
    ): Promise<DebugExportCandidate> {
      // Everything is taken before the first photo is read, so play continuing meanwhile cannot mix in later state.
      const current = session.value;
      // The shown state, after a call that threw rebuilt from the recorded calls; without it, the export has no session
      // state, so it never presents an earlier state as the one shown.
      const snapshot = current === null ? null : playerRuntimeSnapshotOrNull(current);
      const recording = recorder.recording();
      const frozen = {
        build: playerBuildIdentity,
        package: options.debugPackage ?? { id: null, version: null },
        session:
          current === null || snapshot === null
            ? null
            : {
                plan: current.plan,
                snapshot,
                events: [...current.events],
                transcriptEntries: [...current.transcriptEntries],
              },
        recording,
        hostError: hostError.value,
        editedWhileDebugging: debugEdits.value,
        rewoundWhileDebugging: rewound.value,
        ...shown,
      };
      const storage = (snapshot ?? recording?.endSnapshot)?.scriptStorage ?? [];
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
    /** Debug's value trace while Debug runs, else `null`; it changes in place, with each published session. */
    debugTrace: computed(() => debugTrace.value),
    /**
     * Turns Debug's value trace on or off. A new trace attaches to a running session at its next operation, so earlier
     * values read as not recorded; Start and Continue begin a new epoch; off drops the trace and all its history.
     */
    setDebugTracing(on: boolean) {
      if (on === (debugTrace.value !== null)) return;
      debugTrace.value = on ? new RuntimeDebugContext() : null;
      if (session.value !== null)
        session.value = withPlayerRuntimeDebugTrace(session.value, debugTrace.value);
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
    prepareInput,
    /** Debug's rewind (DEBUGGER.md "Rewind"): how the session host shows the states it restores. */
    rewind: {
      /** Whether a restored state is shown for inspection, which runs only once input adopts it. */
      inspecting: computed(() => inspecting.value),
      /** Whether a restored state is being adopted: its saved data are being replaced. */
      adopting: computed(() => rewindWork.value === "adopt"),
      /** Changes whenever this script's saved data were cleared or imported, which ends the rewind history. */
      retirements: computed(() => rewindRetirements.value),
      /** Whether a rewind step or an adoption runs now. */
      working: computed(() => rewindWork.value !== null),
      /** Whether the session may be left for a restored state, apart from rewind work under way. */
      ready: rewindReady,
      beginStep: beginRewindStep,
      /** Whether the session is a restored state: when, and how many rewinds led to it; for its debug export. */
      rewound: computed(() => rewound.value),
      canRewind,
      /** Opens a new spill store for a rewind history. */
      openSpill: options.debugHistorySpill ?? (() => openDebugHistorySpill()),
      memoryBudget: options.debugHistoryMemoryBudget ?? DEBUG_HISTORY_MEMORY_BUDGET,
      publish: publishRewound,
      /** Adopts the inspected state without new input, so it runs on; resolves to whether it was adopted. */
      resume: () => adoptRewound(),
      /** The adoption under way, which resolves to whether the state was adopted, or `null`. */
      adoption: () => adoption,
      /** Calls `listener` whenever an inspected state is adopted as the session, before it runs on. */
      onAdopted(listener: (() => void) | null) {
        rewindAdopted = listener;
      },
    },
    prepare,
    prepareScript,
    prepareRestore,
    activate,
    toStartPage,
    /** The source text of a file of the script, or `null` when its host did not supply it. */
    scriptSource: (path: string): string | null => scriptSources.get(path) ?? null,
    /** Changes whenever a session ends as it plays, including at its Start; not when Debug's rewind restores an end. */
    endings: computed(() => endings.value),
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
  /** The running session's own write waits for the host; nothing was written. */
  | { readonly kind: "busy" }
  /** The script saved the same key after the edit was stored; its value stands, stored and in the session. */
  | { readonly kind: "overtaken" }
  /** The saved value changed since the editor read it; nothing was written. */
  | { readonly kind: "changed" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Whether two saved values are the same, as the script's `==` compares them; `undefined` is an absent key. A value too
 * large to write as text compares too.
 */
function sameSavedValue(
  left: SerializableRuntimeValue | undefined,
  right: SerializableRuntimeValue | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return serializableEquals(left, right);
}
