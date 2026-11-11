import { computed, ref, shallowRef, watch } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import { browserMediaUrls } from "../../../media/browser-capture.js";
import {
  CapturedMediaStore,
  isCapturedMediaReference,
  type CapturedMediaRepository,
} from "../../../media/captured-media.js";
import {
  browserCapturedMediaLocks,
  capturedMediaStorage,
} from "../../../media/captured-media-persistence.js";
import { browserImageDecoder, type ImageDecoder } from "../../../media/image-file.js";
import { type LockDialogInput } from "../../../encryption/lock-service.js";
import type { LockServices } from "../../../encryption/content-lock.js";
import {
  playerTemporalContext,
  playerRuntimeMedia,
  playerRuntimePermanentButtons,
  type PlayerSession,
} from "../../../runtime/runtime-view.js";
import { createInProcessBackend } from "../../../engine-bridge/in-process.js";
import {
  bridgeOf,
  endsQuietly,
  type PlayerBridge,
  type ServiceSection,
  type SessionSection,
} from "../../../runtime/player-bridge.js";
import type { SessionOp } from "../../../engine-bridge/op-catalogue.js";
import { RETIRED, type InputSection, type InputSectionHost } from "./runtime-input";
import { sweepDebugHistories } from "../../../debug/debug-history-indexeddb.js";
import type { DebugHistorySpill } from "../../../engine-bridge/history/snapshots.js";
import {
  keptPhotoReferences,
  type KeptRoomStore,
  type KeptSessionStore,
} from "../../../persistence/kept-sessions.js";
import type { SavedDataHost } from "../../../persistence/saved-data.js";
import { playerBuildIdentity } from "../../../build-identity.js";
import type { ScriptStorageProvider } from "../../../persistence/script-storage.js";
import { type PlayerDiagnostic } from "../../../media/session-camera.js";
import {
  PlayerNotices,
  playerNoticeKeys,
  playerNotices,
  type PlayerNotice,
} from "../../../presentation/notices.js";
import type { TemporalContext } from "../../../../src/index.js";

import { useRuntimeSceneClock, type SectionWork } from "./useRuntimeSceneClock";
import { useScreenWakeLock } from "./useScreenWakeLock";
import { useCallView } from "./useCallView.js";
import { usePlayerCameraLifecycle, useSessionCamera } from "./usePlayerCameras.js";
import { usePlayerSessionServices } from "./usePlayerSessionServices.js";
import { useExportCandidate } from "./activation/useExportCandidate.js";
import type { Origin } from "./activation/useActivationRun.js";
import { useRandomControl } from "./useRandomControl.js";
import { useDebugModeAndTrace } from "./useDebugModeAndTrace.js";
import { useSessionMedia } from "./useSessionMedia.js";
import { useSessionRewind } from "./useSessionRewind.js";
import { useStorageRoute } from "./persistence/useStorageRoute.js";
import { useKeptSession } from "./persistence/useKeptSession.js";
import { useSavedDataTransfer } from "./persistence/useSavedDataTransfer.js";
import { useSessionTransfer } from "./persistence/useSessionTransfer.js";
import { useSessionActivation } from "./activation/useSessionActivation.js";
import { useSavedValues } from "./persistence/useSavedValues.js";

export interface PlayerSessionOptions {
  /**
   * The engine's host; the in-process backend by default. One live Player per
   * bridge, which a later Player may reuse after the previous Player scope is disposed; while another holds it, this
   * Player never becomes ready.
   */
  bridge?: Promise<PlayerBridge>;
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
  /** The time lock's code, the drand relays, and the device clock that locks use; the browser's by default. */
  lockServices?: LockServices;
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
  /**
   * Opens where Debug's rewind history in the composable's own host spills snapshots; IndexedDB by default, `null`
   * keeps them in memory. An injected `bridge`'s host has its own.
   */
  debugHistorySpill?: () => Promise<DebugHistorySpill | null>;
  /**
   * UTF-16 code units of snapshot JSON a rewind history in the composable's own host admits in memory, pending spill
   * writes included (`DEBUG_HISTORY_ADMITTED_SNAPSHOT_CHARS` by default); diagnostic tuning for tests.
   */
  debugHistoryMemoryBudget?: number;
}

export type { PlayerSessionStart } from "./sessionStart.js";

// Presentation lifecycle around the shown session. It holds the shown `PlayerSession` publication; the engine's host
// owns the canonical runtime state. This host records which session is shown, when presentation must reset, maps
// browser time onto the session's scene time, and plays the session's media on browser elements.
export function usePlayerSession(options: PlayerSessionOptions = {}) {
  const resolvePackageAsset = options.resolveAsset ?? (() => null);
  const diagnostics = shallowRef<readonly PlayerDiagnostic[]>([]);
  const reportDiagnostic = (diagnostic: PlayerDiagnostic) => {
    console.warn(`[player] ${diagnostic.code}: ${diagnostic.message}`);
    diagnostics.value = [...diagnostics.value, diagnostic];
  };
  // The session composable's shared state, which its owners read: the shown session, and what holds or stops it.
  const session = shallowRef<PlayerSession | null>(null);
  // While the session is paused at a random draw (DEBUGGER.md "Random draws"), it holds like an inspected state until
  // the draw is resolved.
  const drawPending = computed(() => session.value?.state.randomDraw != null);
  // An exception of the Player itself stops the session where it stands (PLAYER-UI "Session end and failure"): nothing
  // of it runs, observes time, or takes input any more, and late answers, reports, and writes are dropped. Its
  // transcript, Stage, and recording stay for the error dialog and a debug export, until the next Start.
  const stopped = computed(() => hostError.value !== null || halting.value);
  const held = computed(() => inspecting.value || drawPending.value || stopped.value);
  // The session as other parts of the Player service it: none while a restored state is inspected or a draw is paused.
  const servicedSession = computed(() => (held.value ? null : session.value));
  // A new session remounts the transcript and resets interaction-local state.
  const generation = ref(0);
  const interactionReset = ref(0);
  // The engine's host, which owns the plans, the sessions and the recorder of every session's engine calls from Start,
  // in every build, for a debug export (DEBUGGER.md "Debug export"); in-process by default.
  // The in-process backend is ready at once, so a Start within the first click needs no wait.
  let bridge: PlayerBridge | null =
    options.bridge === undefined
      ? createInProcessBackend(playerBuildIdentity, {
          ...(options.debugHistorySpill && { historySpill: options.debugHistorySpill }),
          ...(options.debugHistoryMemoryBudget !== undefined && {
            historyBudget: options.debugHistoryMemoryBudget,
          }),
        })
      : null;
  // This Player's hold on its bridge (`PlayerBridge.claim`): one live Player per bridge.
  const claim = Symbol("Player");
  // Once the host is reachable, and only while this Player lives: it takes the bridge, observes its loss (see
  // `bridgeLost`), and sends its tracing setting before any Start that waits for it. A host that never became reachable,
  // or one another Player holds, is the `bridge` promise's failure, which its own callers handle.
  const bridgeReady = (options.bridge ?? Promise.resolve(bridge!)).then((ready) => {
    if (disposed) return ready;
    random.claimed(ready.claim(claim));
    bridge = ready;
    ready.client.onLoss(bridgeLost);
    // An injected bridge with a tracing serial allocated: only an earlier Player can have allocated it, as this one could
    // send nothing to the bridge before now.
    if (options.bridge !== undefined && ready.hasAllocatedTracingIntent) debug.pendTracing();
    flushTracing(ready);
    flushRandom(ready, null);
    return ready;
  });
  bridgeReady.catch(() => {
    debug.dropPending();
    random.dropPending();
  });
  // The activation under way: its preparation, begin, completions and error stop (`session/activation/`).
  const {
    activationRun,
    heldDebugRecording,
    hostError,
    halting,
    reportActivationError,
    reportPageError,
    lose,
    activation,
    beginning,
    lastStart,
    supersede,
    prepare,
    prepareStart,
    prepareRestore,
    activate,
    temporalCapture,
    beforeRewindRestart,
    remember,
    scriptSource,
  } = useSessionActivation({
    options,
    session,
    stopped,
    bridgeNow: () => bridge,
    bridgeReady,
    requireBridge,
    isDisposed: () => disposed,
    showSession,
    camera: { open: (capability) => camera.open(capability), release: () => camera.release() },
    captures: { reset: () => captures.reset() },
    device: { reset: () => device.reset() },
    primeAudio: () => primeAudio(),
    hasScriptStorage: () => scriptStorage !== undefined,
    loadScriptStorage: () => loadScriptStorage(),
    clearing: () => clearing,
    importing: () => importing,
    keptOwner: () => keptOwner,
    settlePlanJson: (event) => settlePlanJson(event),
    nextPreparation: () => nextPreparation(),
    debugModeOn: () => debugModeOn(),
    tracingIntent: () => tracingIntent(),
    adoptRandom: (next, origin) => adoptRandom(next, origin),
    startRandom: () => startRandom(),
    random: { issuedRandom: () => random.issuedRandom() },
    resolveTemporalContext: () => resolveTemporalContext(),
  });
  // Rewind histories that pages which ended without deleting theirs left behind go now.
  if (options.debugHistorySpill === undefined) void sweepDebugHistories();
  /**
   * The engine Worker was lost: the path of an exception of the Player that cannot be recovered, the error stop. What
   * the player sees then is the owner's open decision (#1897). An intentional `terminate()` is no loss and never reaches
   * it.
   */
  function bridgeLost(error: Error) {
    if (disposed) return;
    // The host's trace and random control went with it.
    debug.dropPending();
    random.dropPending();
    traceId.value = null;
    // So did every state Debug's rewind could reinstate, and its history: its view stays, read-only, and nothing waiting
    // on it acts.
    retireRewind("loss");
    lose(error);
  }
  // Debug's value trace and Debug mode (`session/useDebugModeAndTrace.ts`).
  const debug = useDebugModeAndTrace({
    bridgeNow: () => bridge,
    isDisposed: () => disposed,
    reportActivationError,
    reportPageError,
    session,
    stopped,
    activationRun,
    publishOwned,
    keepSessionLater: () => keepSessionLater(),
    copyToDebugRoom,
    clock: () => clock,
    room: () => room,
    hasNormalStorage: () => normalStorage !== undefined,
    inspecting: () => inspecting,
    activation: () => activation,
  });
  const {
    debugTracing,
    traceId,
    tracingIntent,
    flushTracing,
    debugView,
    setDebugTracing,
    setDebugMode,
    applyDebugMode,
    debugModeOn,
  } = debug;
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
  // Where saved values and photos go: the room shown and its route (`session/persistence/useStorageRoute.ts`).
  const route = useStorageRoute({
    options,
    capturedMedia,
    capturedMediaPersistence,
    retireStaleOperations: () => retireStaleOperations(),
  });
  const { normalStorage, room, debugRoom, switchStorage, enterDebugRoom, createDebugRoom } = route;
  // The saved values' entry points, and the note of a change that landed on the route shown (`handOverValues`).
  const { storageProvider, operationStorage, whenLanded } = route.handOverValues();
  // The script's saved values: read, written, edited and cleared (`session/persistence/useSavedValues.ts`).
  const savedValues = useSavedValues({
    values: { storageProvider, whenLanded },
    capturedMedia,
    session,
    generation,
    stopped,
    isDisposed: () => disposed,
    inputSection: (work, body) => inputSection(work, body),
    retireRewind: (by) => retireRewind(by),
    notices: () => notices,
    inspecting: () => inspecting,
    activation: () => activation,
    beginning: () => beginning,
  });
  const {
    scriptStorage,
    storedEntries,
    savedDataRevision,
    loadScriptStorage,
    readScriptStorage,
    applyScriptStorage,
    scriptStorageOptions,
    clearing,
    importing,
    debugEdits,
    liveSession,
    scriptSaving,
    editSavedData,
    canClearScriptStorage,
    clearScriptStorage,
    holdImporting,
    rejectedUnlessStale,
    editsInFlight,
  } = savedValues;
  const { cameraRevision, chosenCamera, camera } = useSessionCamera({
    capturedMedia,
    reportDiagnostic,
  });
  /** Captured media resolves only through the trusted store, never as a package asset. */
  const resolveAsset = (path: string): string | null => {
    if (!isCapturedMediaReference(path)) return resolvePackageAsset(path);
    void mediaRevision.value;
    // Only an image is shown, never a stored file of another type (V30 §33).
    const resolved = capturedMedia.resolve(path, "image");
    return resolved.state === "ready" ? resolved.url : null;
  };
  const resolveTemporalContext = options.temporalContext ?? (() => playerTemporalContext());
  // Debug's rewind over the Player's lifetime (`session/useSessionRewind.ts`).
  const rewind = useSessionRewind({
    bridgeNow: () => bridge,
    session,
    generation,
    stopped,
    isDisposed: () => disposed,
    reportPageError,
    // The rewind's show and its descendants act for the activation live at its synchronous entry.
    showSession: (next, options) => showSession(next, activationRun.current(), options),
    scriptStorage,
    applyDebugMode: () => applyDebugMode(activationRun.current()),
    adoptRandom: (next) => adoptRandom(next, activationRun.current()),
    settleUncontrolledDraw: () => settleUncontrolledDraw(activationRun.current()),
    rewindApi: () => rewindApi,
    clock: () => clock,
    notices: () => notices,
    activation: () => activation,
    importing: () => importing,
    clearing: () => clearing,
    beginning: () => beginning,
    editsInFlight: () => editsInFlight,
  });
  const {
    rewindOwner,
    inspecting,
    retireRewind,
    rewound,
    prepareInput,
    rewindWork,
    rewindReady,
    canRewind,
    beginRewindStep,
    adoptRewound,
  } = rewind;
  // Debug's random control (`session/useRandomControl.ts`).
  const random = useRandomControl({
    bridgeNow: () => bridge,
    claim,
    isDisposed: () => disposed,
    activationRun,
    reportActivationError,
    reportPageError,
    clock: () => clock,
    session,
    inspecting,
    ownedSection,
    publishOwned,
  });
  const {
    flushRandom,
    adoptRandom,
    startRandom,
    setRandomControl,
    forgetRandomHistory,
    settleUncontrolledDraw,
    resolveRandomDraw,
    randomTried,
    randomRevision,
  } = random;
  // The transcript revision through which the session's transcript shows directly, as history: what development time
  // jumps published. -1 for none in this generation.
  const jumpedRevision = ref(-1);
  const notices = new PlayerNotices();
  const noticeList = shallowRef<readonly PlayerNotice[]>([]);
  notices.subscribe((current) => (noticeList.value = current));
  // The shown session's media on browser elements (`session/useSessionMedia.ts`).
  const media = useSessionMedia({
    session,
    generation,
    held,
    stopped,
    notices,
    capturedMedia,
    resolvePackageAsset,
    resolveAsset,
    isDisposed: () => disposed,
    currentOrigin: () => activationRun.current(),
    reportActivationError,
    ownedSection,
    publishOwned,
    clock: () => clock,
    decodeImage: () => decodeImage,
  });
  const {
    pendingLoadCount,
    loads,
    audioElements,
    device,
    stageImage,
    failedStageSource,
    loadedStageSource,
    reportUnusableMedia,
    storeImageFile,
    primeAudio,
  } = media;
  /**
   * The publication boundary of work that completes after a bridge reply: input such as the pacing skip, the clock's
   * observations and catch-up, development time's jumps, and the services' sections. `next` shows only while the session
   * that issued the work still owns the UI: `next` is of the shown session's store, no Player error stopped it, and the
   * Player is mounted. It shows as that store's latest publication, so a reply never brings back an older state; what
   * follows a publication, such as a jump's media seek, takes the returned one. Start, Continue, Return and the error
   * stop show a new or the stopped session under their own ownership (`activationToken`).
   */
  function publishOwned(next: PlayerSession): PlayerSession | null {
    const shown = session.value;
    if (disposed || stopped.value || shown === null || shown.lineage !== next.lineage) return null;
    session.value = bridgeOf(next).latest(next) ?? next;
    return session.value;
  }
  // A late observation catches up on a copy of the session, except while Debug runs: its history and the debug
  // export's replay then follow each observation as it happens.
  const clock = useRuntimeSceneClock(
    session,
    () => device.sample(),
    held,
    () => !debugTracing.value && random.randomControlOff(),
    publishOwned,
  );
  // Input and the work that continues it take their session from here when they run: a session a Player error stopped
  // gives none, so what was admitted before the stop and runs only now does nothing. The observation's own publish can
  // cause the error, so the stop is checked again after it. `null` is no observation: stopped, no longer shown, or
  // refused twice at its turn (`clock.observe`).
  const observeForInput = async (): Promise<PlayerSession | null> => {
    if (stopped.value) return null;
    const current = await clock.observe();
    return stopped.value ? null : current;
  };
  /**
   * A section of `current` that the clock opens for `work` (`clock.section`), with that row's observation. Observing
   * rows give `null` once `current` no longer owns the UI, before or after the observation; rows that observe nothing
   * give the section's session. The body receives liveness checks (`owned`); it rechecks them after each await, as what
   * it sends is applied to the session's store and shown only while `current` owns the UI (`publishOwned`). `null`
   * without `current`, or once a Player error stopped it.
   */
  function ownedSection<T>(
    current: PlayerSession | null,
    work: SectionWork,
    body: (
      section: SessionSection,
      owned: () => boolean,
      observed: PlayerSession | null,
    ) => Promise<T>,
  ): Promise<T | null> {
    if (current === null || stopped.value) return Promise.resolve(null);
    const owned = () => !disposed && !stopped.value && session.value?.lineage === current.lineage;
    return clock.section(work, current, owned, (section, observed) =>
      body(section, owned, observed),
    );
  }
  /** A service's section of the serviced session (`ownedSection`); `null` without one, or once stopped. */
  function serviceSection<T>(
    body: (section: ServiceSection, observed: PlayerSession | null) => Promise<T>,
  ): Promise<T | null> {
    return ownedSection(servicedSession.value, "service", (section, _owned, observed) =>
      body(
        // EVIDENCE: invariant: `ServiceSection` pairs each op with its arguments, which this forwards as they are.
        {
          // What the services send shows as any work completing after a reply does.
          send: (op: SessionOp, args: unknown, basis: number) =>
            // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- EVIDENCE: invariant: the pairs `ServiceSection` made, sent on as they are.
            section.send<SessionOp>(op as never, args as never, {
              basis,
              publish: (next) => void publishOwned(next),
            }),
        } as ServiceSection,
        observed,
      ),
    );
  }
  /**
   * An input section of the shown session (`ownedSection`): its observation and ops read no basis, and an op is posted
   * only while the session owns the UI. A refusal of the stopped session (`halted`) changed nothing, as one never posted.
   */
  const inputSection: InputSectionHost = (work, body) =>
    ownedSection(session.value, work, (section, owned, observed) =>
      body(
        // EVIDENCE: invariant: `InputSection` pairs each op with its arguments, which this forwards as they are.
        {
          owned,
          send: async (op: SessionOp, args: unknown) => {
            if (!owned()) return RETIRED;
            try {
              // EVIDENCE: invariant: the pairs `InputSection` made, sent on as they are.
              return await section.send<SessionOp>(op as never, args as never, {
                publish: (next) => void publishOwned(next),
              });
            } catch (error) {
              if (endsQuietly(error)) return RETIRED;
              throw error;
            }
          },
          get session() {
            return section.session;
          },
        } as InputSection,
        observed,
      ),
    );

  const { demandCallView } = useCallView({
    session,
    stopped,
    isDisposed: () => disposed,
    publishOwned,
    currentOrigin: () => activationRun.current(),
    reportActivationError,
  });

  media.watchMedia();
  const { captures, fileStores, lockDialog, locks } = usePlayerSessionServices({
    camera,
    capturedMedia,
    reportDiagnostic,
    servicedSession,
    generation,
    serviceSection,
    options,
  });
  const {
    cameraOffered,
    captureCamera,
    cameraChoice,
    imageCapture,
    viewfinderPlacement,
    viewfinder,
  } = usePlayerCameraLifecycle({
    session,
    servicedSession,
    stopped,
    generation,
    notices,
    capturedMedia,
    camera,
    cameraRevision,
    chosenCamera,
    options,
  });
  // A stopped session's captures and cameras end; its media goes with the media watcher above.
  watch(
    stopped,
    (stop) => {
      if (!stop) return;
      captures.reset();
      fileStores.reset();
      locks.reset();
      camera.release();
      captureCamera.release();
      loads.clear();
      pendingLoadCount.value = 0;
    },
    { flush: "sync" },
  );
  const decodeImage = options.decodeImage ?? browserImageDecoder;

  // The script's kept session and its persistence operations (`session/persistence/useKeptSession.ts`).
  const keptOwner = useKeptSession({
    options,
    bridgeNow: () => bridge,
    bridgeReady,
    isDisposed: () => disposed,
    session,
    capturedMedia,
    notices,
    route,
    room,
    debugRoom,
    debugEdits,
    inspecting,
    rewound,
    activation,
    endSession,
    prepareStart,
    prepareRestore,
    lastStart: () => lastStart,
    remember,
    clock: () => clock,
    rejectedUnlessStale,
  });
  const {
    retireStaleOperations,
    nextPreparation,
    persistenceOwnership,
    owned,
    settlePlanJson,
    keepSessionLater,
    settleKeepAttempt,
    prepareScript,
    prepareKept,
    toStartPage,
  } = keptOwner;
  let disposed = false;
  tryOnScopeDispose(() => {
    // The trace was this Player's: it ends with it.
    debug.dispose(bridge);
    // Its random control ends with it too, with its history.
    random.dispose(bridge);
    // The activation's run ends before the Player gives the connection up.
    activationRun.retire();
    bridge?.unclaim(claim);
    disposed = true;
    supersede();
    // The host's JSON of the plans this page prepared, written or waiting for its task, is not needed any more.
    settlePlanJson({ kind: "dispose" });
    loads.clear();
    device.reset();
    for (const element of audioElements.splice(0)) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
    captures.stop();
    fileStores.stop();
    locks.stop();
    camera.release();
    captureCamera.release();
    // Issued saves still finish and store their photos before the live lock and the session media are released.
    void Promise.all([
      capturedMediaPersistence?.close(),
      route.debugRoomStorageNow()?.drain(),
    ]).finally(() => capturedMedia.close());
  });

  savedValues.watchWrites();

  // Export and import of saved data (`session/persistence/useSavedDataTransfer.ts`).
  const { savedScripts, reviewSavedDataImport, importSavedData } = useSavedDataTransfer({
    options,
    scriptStorage,
    normalStorage,
    room,
    capturedMedia,
    capturedMediaPersistence,
    decodeImage,
    importing,
    clearing,
    holdImporting,
    readScriptStorage,
    applyScriptStorage,
    operationStorage,
    keptOwner,
    nextPreparation,
    persistenceOwnership,
    owned,
    activation,
    lastStart,
    inspecting,
    endSession,
    retireRewind,
    prepareStart,
    sessionInProgress: () => sessionInProgress,
  });
  /** Whether a session runs, waits for Continue, or is starting; its own view of the saved values is in use. */
  const sessionInProgress = computed(
    () =>
      beginning.value ||
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
    supersede();
    beginning.value = false;
    activation.value = null;
    captures.reset();
    fileStores.reset();
    locks.reset();
    camera.release();
    captureCamera.release();
    device.reset();
    loads.clear();
    pendingLoadCount.value = 0;
    generation.value++;
    interactionReset.value++;
    jumpedRevision.value = -1;
    // The generation's new session ends the inspection (`rewindOwner.newSession`).
    session.value = null;
  }

  // Shows a session a Start began or a restore brought, as the Player's from now on; its scene time continues from the
  // persisted observation, so a gap while no Player ran is not consumed. `paused`: a state Debug's rewind restored and
  // shows for inspection (`showRewound`), which takes Debug's random control and the clock only once input adopts it.
  // `origin`: the activation that shows it, which its caller captured at its synchronous entry; its adoption, Debug
  // application and draw settlement act for it.
  function showSession(
    next: PlayerSession,
    origin: Origin,
    { paused }: { readonly paused: boolean } = { paused: false },
  ) {
    // A failed write concerns the run it happened in.
    notices.dismiss(playerNoticeKeys.storageWriteFailed);
    media.newSession();
    // The inspection is the rewind owner's: a rewind's own show decided it, and any other is a new session's.
    device.reset();
    loads.clear();
    pendingLoadCount.value = 0;
    generation.value++;
    interactionReset.value++;
    jumpedRevision.value = -1;
    // An inspected state takes Debug's random control only once input adopts it (`adoptRewound` below).
    if (!paused) adoptRandom(next, origin);
    session.value = next;
    clock.rebase();
    if (!paused) {
      applyDebugMode(origin);
      settleUncontrolledDraw(origin);
    }
    // The session that runs is the one a reload continues in its room.
    if (!paused) keepSessionLater();
  }
  // Publishes the result of a completed runtime action. Input to an inspected state is evaluated only once
  // `prepareInput` adopted it, so a result for the inspected state itself is never published.
  function update(next: PlayerSession) {
    if (!inspecting.value) publishOwned(next);
  }
  // Counts the sessions that ended as they played, also within their Start; a state Debug's rewind restored has ended
  // before and does not end anew.
  const endings = ref(0);

  watch([session, generation], ([next, current], [previous, before]) => {
    if (next?.state.status !== "halted") return;
    if (
      current === before
        ? previous?.state.status !== "halted"
        : current !== rewind.rewoundGeneration()
    )
      endings.value++;
  });

  keptOwner.startKeeping();

  // Export and import of a session (`session/persistence/useSessionTransfer.ts`).
  const {
    exportableSession,
    exportSession,
    readTransfer,
    reviewSessionImport,
    discardSessionReview,
    importSession,
  } = useSessionTransfer({
    options,
    bridgeNow: () => bridge,
    bridgeReady,
    session,
    room,
    scriptStorage,
    capturedMedia,
    capturedMediaPersistence,
    clearing,
    importing,
    activation,
    liveSession,
    inspecting,
    sessionInProgress,
    holdImporting,
    endSession,
    retireRewind,
    keptOwner,
    nextPreparation,
    persistenceOwnership,
    owned,
    operationStorage,
    readScriptStorage,
    applyScriptStorage,
    prepareKept,
    settlePlanJson,
  });

  /** Whether the shown session runs or waits. */
  const sessionLive = computed(
    () =>
      session.value !== null &&
      (session.value.state.status === "running" || session.value.state.status === "waiting"),
  );
  // The screen stays on from the Start or Continue click, while the session begins, until it ends or stops; also
  // while Debug holds it at an inspected state or a random draw, where a draw in its first statement leaves it `ready`.
  useScreenWakeLock(
    () =>
      beginning.value ||
      (session.value !== null &&
        !stopped.value &&
        session.value.state.status !== "halted" &&
        session.value.state.status !== "failed"),
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
    const releaseImporting = holdImporting();
    roomChange = roomChange.then(async () => {
      try {
        if (normalStorage === undefined || room.value !== "normal" || !debugModeOn() || disposed)
          return;
        const scope = normalStorage.scope;
        const live = sessionLive.value;
        // The normal room keeps its session as it is now, which a later visit continues; one that ended is kept as it
        // ended, by the keep still under way.
        if (live) await settleKeepAttempt();
        else while (keptOwner.keepingNow() !== null) await keptOwner.keepingNow();
        const making = live || debugRoom.value === null;
        const replacing = live && debugRoom.value !== null;
        // A Continue or Start still being prepared is the normal room's.
        nextPreparation();
        room.value = "debug";
        keptOwner.forgetKeptPoint();
        keptOwner.forgetPresentation();
        await switchStorage(async () => {
          if (replacing)
            await route
              .debugRoomsNow()
              .discard(scope)
              .catch(() => {});
          const durable = making ? await createDebugRoom(scope, false) : new Set<string>();
          return enterDebugRoom(scope, making ? { session: live } : debugRoom.value!, durable);
        });
        await loadScriptStorage();
        if (live) applyDebugMode(activationRun.current());
        else {
          // A normal session that ended meanwhile stays in the normal room.
          endSession();
          await prepareKept();
        }
      } finally {
        releaseImporting();
      }
    });
    return roomChange;
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
      const releaseImporting = holdImporting();
      try {
        while (keptOwner.keepingNow() !== null) await keptOwner.keepingNow();
        endSession();
        keptOwner.forgetKeptPoint();
        keptOwner.forgetPresentation();
        if (clear === "reset")
          await switchStorage(async () => {
            await route
              .debugRoomsNow()
              .discard(scope)
              .catch(() => {});
            return enterDebugRoom(scope, { session: false }, await createDebugRoom(scope, true));
          });
        await loadScriptStorage();
      } finally {
        releaseImporting();
      }
      if (lastStart.value !== null && !disposed) {
        prepare(lastStart.value);
        await activate();
      }
    });
    return roomChange;
  }

  const exportCandidate = useExportCandidate({
    session,
    bridge: () => bridge,
    activation: activationRun,
    halting,
    build: playerBuildIdentity,
    package: options.debugPackage ?? { id: null, version: null },
    readPhoto: (reference) => capturedMedia.read(reference),
  });

  rewind.followSessions();

  /**
   * Publishes a session that development time jumps (#615) advanced from the current one: playing media seek to the
   * progress the jumps reported, and the scene clock continues from the new observed time.
   */
  function publishJump(next: PlayerSession) {
    const published = inspecting.value ? null : publishOwned(next);
    if (published === null) return;
    jumpedRevision.value = published.transcriptRevision;
    device.jumped(playerRuntimeMedia(published.state).media);
    clock.rebase();
  }
  const permanentButtons = computed(() =>
    session.value === null ? [] : playerRuntimePermanentButtons(session.value.state),
  );
  /** Clicks a permanent button at the observed time, like other input; a click it does not accept changes nothing. */
  async function pressPermanentButton(buttonId: number) {
    if (!(await prepareInput())) return;
    await inputSection("inputAnswer", async (section, observed) => {
      if (observed === null) return;
      // Its publication shows as the op's reply applies (`publishOwned`), whatever the press's outcome.
      await section.send("pressPermanentButton", { buttonId });
    });
  }
  /** The engine's host, which the in-process backend gives at once; an injected one is ready before any Start. */
  function requireBridge(): PlayerBridge {
    if (bridge === null) throw new Error("The engine's host is not ready.");
    return bridge;
  }

  const rewindApi = {
    /** Whether a restored state is shown for inspection, which runs only once input adopts it. */
    inspecting: computed(() => inspecting.value),
    /** Whether a restored state is being adopted: its saved data are being replaced. */
    adopting: computed(() => rewindWork.value === "adopt"),
    /** Whether a rewind step or an adoption runs now. */
    working: computed(() => rewindWork.value !== null),
    /** Whether the session may be left for a restored state, apart from rewind work under way. */
    ready: rewindReady,
    beginStep: beginRewindStep,
    /** Whether the session is a restored state: when, and how many rewinds led to it; for its debug export. */
    rewound: computed(() => rewound.value),
    canRewind,
    beforeRestart: beforeRewindRestart,
    /** Adopts the inspected state without new input, so it runs on; resolves to whether it was adopted. */
    resume: () => adoptRewound(),
    /** Debug's rewind over the Player's lifetime: its history, its handoffs and its lifecycle (`rewindOwner.ts`). */
    owner: rewindOwner,
  };

  return {
    session: computed(() => session.value),
    demandCallView,
    /** The engine's host, once it is ready. */
    bridge: bridgeReady,
    generation: computed(() => generation.value),
    interactionReset: computed(() => interactionReset.value),
    /**
     * The transcript revision through which the transcript shows directly, like history, rather than entering as live
     * play: what development time jumps published (#615). -1 for none since the session started.
     */
    jumpedRevision: computed(() => jumpedRevision.value),
    setDebugMode,
    setRandomControl,
    forgetRandomHistory,
    randomTried,
    randomRevision: computed(() => randomRevision.value),
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
    /** Why the prepared Start shows instead of Continue: a Player update changed the kept session's format; or `null`. */
    outdatedSession: computed(() =>
      clearing.value || importing.value ? null : (activation.value?.outdated ?? null),
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
        !beginning.value &&
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
      return capturedMedia.resolve(reference, "image");
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
    /** Why the session cannot be exported now, or `null` when it can. */
    sessionExportUnavailable: computed(() => {
      const found = exportableSession.value;
      return "unavailable" in found ? found.unavailable : null;
    }),
    exportSession,
    readTransfer,
    reviewSessionImport,
    discardSessionReview,
    importSession,
    /**
     * For tests, the recorded engine calls the host holds, read from it (`heldDebugRecording`): after a Player error
     * whose capture is held, those up to it until the next Start; else the recorder's current ones, or `null` before
     * any Start.
     */
    debugRecording: heldDebugRecording,
    /** The error name of an exception of the Player itself, or `null`. */
    hostError: computed(() => hostError.value),
    /** Whether an exception of the Player itself stopped the session where it stands; until the next Start. */
    stopped,
    /** Reports an exception of the Player's interface or host: the page's error reporter (`reportPageError`). */
    reportHostError: reportPageError,
    /** What a debug export can contain, frozen (`useExportCandidate`). */
    debugExportCandidate: exportCandidate.debugExportCandidate,
    /** Whether Debug's value trace runs: the host keeps it, and every session operation there records into it. */
    debugTracing: computed(() => debugTracing.value),
    /** Which of the host's traces runs, once the host answered `setDebugTracing`; `null` without one. */
    traceId: computed(() => traceId.value),
    /**
     * Turns Debug's value trace on or off, in the host. A new trace attaches to a running session at its next
     * operation, so earlier values read as not recorded; Start and Continue begin a new epoch; off drops the trace and
     * all its history. Sent at once when the host is reachable, else once it is, before a Start that waits for it; an
     * unmounted Player changes nothing.
     */
    setDebugTracing,
    debugView,
    loadScriptStorage,
    scriptStorageOptions,
    resolveAsset,
    /** Reports a speaker's avatar image that the browser could not load or decode, as a Stage image is reported. */
    avatarFailed(path: string) {
      if (resolvePackageAsset(path) !== null)
        reportUnusableMedia(path, playerNotices.unusableMedia("image", path, "failed"));
    },
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
     * The camera view's controls, also on an image request's viewfinder: its mirroring, and the switch to the next
     * camera where the browser reports two or more.
     */
    cameraChoice,
    /**
     * The image input of `askImage`: `store` checks and stores a chosen file, and `discard` drops a stored image that
     * never became the request's preview, for example after the request ended while the file was read.
     */
    images: {
      /** Whether a camera can be used here for a request that allows it: the session camera, or one the browser opens. */
      camera: cameraOffered,
      store: storeImageFile,
      discard: (reference: string) => capturedMedia.discard(reference),
    },
    /**
     * The steps of a presented `askImage` request: its controls in the chat, the preview on the Stage, and the camera
     * step's viewfinder on the Stage or in the script's camera window; its `view` is `null` without such a request.
     */
    imageCapture,
    /**
     * The dialog of the lock step the session waits for, while it shows, and whether the Player is busy with what the
     * player gave in it; `submit` answers it, and `cancel` cancels an unlock dialog, which gives the call's default.
     */
    lock: {
      dialog: lockDialog,
      submit: (input: LockDialogInput) => locks.submit(input),
      cancel: () => locks.cancel(),
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
    /**
     * Observes elapsed time and media progress, runs the session, and resolves with the published session; `null` when
     * there was no observation, as once a Player error stopped it, so input and its continuations take none.
     */
    observe: observeForInput,
    /** A section of the shown session for input (`runtime-input.ts`). */
    inputSection,
    publishJump,
    /** Shows `next` as the Player's session from now on; Debug's rewind shows its own states through its owner. */
    showSession: (next: PlayerSession) => showSession(next, activationRun.current()),
    update,
    prepareInput,
    /** Debug's rewind (DEBUGGER.md "Rewind"): how the session host shows the states it restores. */
    rewind: rewindApi,
    prepare,
    prepareScript,
    prepareRestore,
    activate,
    toStartPage,
    /** The source text of a file of the script, or `null` when its host did not supply it. */
    scriptSource,
    /** Changes whenever a session ends as it plays, including at its Start; not when Debug's rewind restores an end. */
    endings: computed(() => endings.value),
    /** The capture a new session records at Start; Continue records its own. */
    temporalCapture,
  };
}

export type PlayerSessionHost = ReturnType<typeof usePlayerSession>;
