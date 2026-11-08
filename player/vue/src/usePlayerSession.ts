import { computed, ref, shallowRef, watch } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import { browserMediaUrls } from "../../browser-capture.js";
import { NO_MARKS, type HistoryMarks } from "../../debug-history-marks.js";
import { planLockNeeds } from "../../plan-metadata.js";
import {
  CapturedMediaStore,
  isCapturedMediaReference,
  type CapturedMediaRepository,
} from "../../captured-media.js";
import {
  browserCapturedMediaLocks,
  capturedMediaStorage,
} from "../../captured-media-persistence.js";
import { browserImageDecoder, type ImageDecoder } from "../../image-file.js";
import { type LockDialogInput } from "../../lock-service.js";
import type { LockServices } from "../../encryption/lock.js";
import type { PlayerRuntimeSession } from "../../runtime-adapter.js";
import {
  playerTemporalContext,
  playerRuntimeMedia,
  playerRuntimePermanentButtons,
  type PlayerSession,
} from "../../runtime-view.js";
import {
  createInProcessBackend,
  heldPlan,
  heldRecording,
  introduceNow,
} from "../../engine-bridge/in-process.js";
import type { StartOptions } from "../../engine-bridge/ops/session.js";
import {
  bridgeOf,
  endsQuietly,
  type PlayerBridge,
  type ServiceSection,
  type SessionSection,
} from "../../player-bridge.js";
import { RETIRED, type InputSectionHost } from "./runtime-input";
import { sweepDebugHistories } from "../../debug-history-indexeddb.js";
import type { DebugHistorySpill } from "../../engine-bridge/history/snapshots.js";
import type { DebugRecorder, DebugRecording } from "../../debug-recorder.js";
import {
  keptPhotoReferences,
  type KeptRoomStore,
  type KeptSessionStore,
} from "../../kept-sessions.js";
import type { RuntimeDebugContext } from "../../../src/index.js";
import type { Problem } from "./ProblemCard.vue";
import type { SavedDataHost } from "../../saved-data.js";
import { playerBuildIdentity } from "../../build-identity.js";
import type { ScriptStorageProvider } from "../../script-storage.js";
import { type PlayerDiagnostic } from "../../session-camera.js";
import {
  PlayerNotices,
  playerNoticeKeys,
  playerNotices,
  type PlayerNotice,
} from "../../notices.js";
import type { RandomControlOptions, TemporalContext } from "../../../src/index.js";

import { useRuntimeSceneClock, type SectionWork } from "./useRuntimeSceneClock";
import { useScreenWakeLock } from "./useScreenWakeLock";
import { useCallView } from "./session/useCallView.js";
import { usePlayerCameraLifecycle, useSessionCamera } from "./session/usePlayerCameras.js";
import { usePlayerSessionServices } from "./session/usePlayerSessionServices.js";
import { stopArguments, useActivationRun, type ActivationRun } from "./session/useActivationRun.js";
import { useExportCandidate } from "./session/useExportCandidate.js";
import { useRandomControl } from "./session/useRandomControl.js";
import { useDebugModeAndTrace } from "./session/useDebugModeAndTrace.js";
import { useSessionMedia } from "./session/useSessionMedia.js";
import { useSessionRewind } from "./session/useSessionRewind.js";
import { useStorageRoute } from "./session/persistence/useStorageRoute.js";
import { useKeptSession } from "./session/persistence/useKeptSession.js";
import { useSavedDataTransfer } from "./session/persistence/useSavedDataTransfer.js";
import { useSessionTransfer } from "./session/persistence/useSessionTransfer.js";
import { useSavedValues } from "./session/persistence/useSavedValues.js";

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

/** What Start and Continue record of the player's click: the zone and presentation, and the wall clock. */
type TemporalCapture = { temporalContext: TemporalContext; wallClockMs: number };

type Activation = {
  readonly kind: "start" | "continue";
  /** Begins the session; a Start or Continue over the bridge resolves once its first publication is applied. */
  readonly begin: (origin: ActivationRun) => PlayerSession | Promise<PlayerSession>;
  /** The restored session Continue goes on with. */
  readonly restored?: PlayerSession;
  /** Why Start shows instead of Continue: the kept session is of a format this Player no longer reads. */
  readonly outdated?: Problem;
};

/**
 * Creates a new session at Start. Either a held plan with the options its Start reads then, which starts over the
 * bridge (`start`); or a transitional factory, which the engine's host runs (`introduceNow`): pass `recording` on to
 * `createPlayerRuntimeSession`, so a debug export can replay it, while Debug runs its value trace records it from the
 * start, and the script reads whether Debug is on.
 */
export type PlayerSessionStart =
  | {
      /** The host's token for the plan. */
      readonly plan: string;
      /** The Start's data options, read at activation; Player Debug supplies `debugMode` (`setDebugMode`). */
      readonly options: () => Omit<StartOptions, "debugMode">;
    }
  | ((recording: {
      readonly recorder: DebugRecorder;
      readonly debugTrace?: RuntimeDebugContext;
      readonly debugMode: boolean;
      readonly randomControl?: RandomControlOptions;
    }) => PlayerRuntimeSession);

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
  // Each activation's diagnostic run, the one owner of what its completions may do; with its recording up to a Player
  // error, captured in the host as the stop is sent and kept until the next Start, while Debug's rewind may begin the
  // recorder anew at a restored state.
  const activationRun = useActivationRun();
  /**
   * The recording the host holds for diagnostics and tests: a Player error's, while its captured ticket is held, else
   * the recorder's current one. Not a debug export's selection (the failure recording's `selection()`), which waits for
   * a pending capture and selects none where it settled unavailable.
   */
  const heldDebugRecording = (): DebugRecording | null => {
    const failed = activationRun.current()?.failure.ticket() ?? null;
    if (failed !== null) return heldRecording(failed.bridge, failed.ticket);
    return bridge === null ? null : heldRecording(bridge);
  };
  // Rewind histories that pages which ended without deleting theirs left behind go now.
  if (options.debugHistorySpill === undefined) void sweepDebugHistories();
  // The error name of an exception of the Player itself, such as one at Start; it stays until the next Start. Such an
  // exception stops the session where it stands (see `stopped`).
  const hostError = ref<string | null>(null);
  // From a Player error stop until the host acknowledged it (a round trip with a Worker): input stops, nothing renders.
  // It belongs to the stop `haltingStop` names: only that stop ends it, and a later activation retires it.
  const halting = ref(false);
  let haltingStop = 0;
  function haltUntil(stop: number) {
    haltingStop = stop;
    halting.value = true;
  }
  function endHalting(stop: number) {
    if (stop === haltingStop) halting.value = false;
  }
  /**
   * The Player error stop. What shows is what the host ran before the stop, and nothing after it: the stop ends the
   * activation under way, so no Start or Continue completes on its own; the host refuses what the stopped session has
   * not run, and its store applies the replies to what it ran until the host acknowledges the stop. The stopped session
   * is the shown one, else the one still beginning: a Continue's restored session at once, a Start's once its reply
   * names it. Its last publication then shows, and the stop renders after it; input stops at once (`stopped`). The error
   * is `origin`'s, the live activation's by default: a deferred completion passes the activation it began in, and one
   * of a retired activation does nothing (`useActivationRun`).
   */
  function reportHostError(error: unknown, origin: ActivationRun | null = activationRun.current()) {
    if (origin !== null && !activationRun.admits(origin)) return;
    const name = error instanceof Error ? error.name : "Error";
    console.error("[player] host error", error);
    const restoring = continuing;
    const starting = sessionBeginning;
    continuing = null;
    activationToken += 1;
    beginning.value = false;
    const stop = activationToken;
    const target = session.value ?? restoring;
    // A Continue still beginning beside a shown session runs nothing more either.
    if (restoring !== null && restoring !== target) void bridgeOf(restoring).halt(restoring);
    if (target !== null) return stopAt(target, name, stop, origin);
    // Without a session to stop, the run's incident is committed by itself.
    const incident = () => {
      const args = stopArguments(origin, name, stop);
      if (origin !== null && args !== null && activationRun.admits(origin))
        void origin.bridge.commitIncident(args).catch(() => {});
    };
    if (starting === null) {
      hostError.value = name;
      incident();
      return;
    }
    haltUntil(stop);
    void starting.then(
      (started) => {
        // A retired activation's late session is only stopped, with no incident and no capture.
        if (origin !== null && !activationRun.admits(origin)) {
          endHalting(stop);
          return void bridgeOf(started).halt(started);
        }
        stopAt(started, name, stop, origin);
      },
      () => {
        endHalting(stop);
        if (stop !== activationToken || (origin !== null && !activationRun.admits(origin))) return;
        hostError.value ??= name;
        incident();
      },
    );
  }
  /**
   * Stops at `target` in `origin`'s run: once its store froze at the host's acknowledgement, its last publication is the
   * shown session, which the recording and export hold, and the stop renders. A later activation or unmount supersedes
   * it; a retired `origin` stops nothing.
   */
  function stopAt(target: PlayerSession, name: string, stop: number, origin: ActivationRun | null) {
    if (origin !== null && !activationRun.admits(origin)) return endHalting(stop);
    const host = bridgeOf(target);
    const acknowledged = host.halt(target, stopArguments(origin, name, stop));
    origin?.failure.stopped(target);
    const commit = () => {
      const live = origin === null ? !disposed : activationRun.admits(origin);
      if (!live || stop !== activationToken) return endHalting(stop);
      // The final publication shows, then the stop; the halt holds the session stopped until then, so nothing reacting
      // to that publication (the stop's call view, also of an unchanged state) sees it running for a moment.
      const final = host.latest(target);
      if (final !== null) session.value = final;
      hostError.value ??= name;
      endHalting(stop);
    };
    if (host.frozen(target)) return commit();
    haltUntil(stop);
    void acknowledged.then(commit);
  }
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
    reportHostError(error);
  }
  // Debug's value trace and Debug mode (`session/useDebugModeAndTrace.ts`).
  const debug = useDebugModeAndTrace({
    bridgeNow: () => bridge,
    isDisposed: () => disposed,
    reportHostError,
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
  const {
    normalStorage,
    room,
    debugRoom,
    operationStorage,
    storageProvider,
    switchStorage,
    enterDebugRoom,
    createDebugRoom,
  } = route;
  // The script's saved values: read, written, edited and cleared (`session/persistence/useSavedValues.ts`).
  const savedValues = useSavedValues({
    storageProvider,
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
    reportHostError,
    showSession,
    scriptStorage,
    applyDebugMode,
    adoptRandom: (next) => adoptRandom(next),
    settleUncontrolledDraw: () => settleUncontrolledDraw(),
    rewindApi: () => rewindApi,
    clock: () => clock,
    notices: () => notices,
    activation: () => activation,
    importing: () => importing,
    clearing: () => clearing,
    beginning: () => beginning,
    editsInFlight: () => editsInFlight,
    savedDataRevision: () => savedDataRevision,
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
    reportHostError,
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
  const activation = shallowRef<Activation | null>(null);
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
    reportHostError,
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
        {
          // What the services send shows as any work completing after a reply does.
          send: (op, args, basis) =>
            section.send(op, args, { basis, publish: (next) => void publishOwned(next) }),
        },
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
        {
          owned,
          send: async (op, args) => {
            if (!owned()) return RETIRED;
            try {
              return await section.send(op, args, { publish: (next) => void publishOwned(next) });
            } catch (error) {
              if (endsQuietly(error)) return RETIRED;
              throw error;
            }
          },
          get session() {
            return section.session;
          },
        },
        observed,
      ),
    );

  const { demandCallView } = useCallView({
    session,
    stopped,
    isDisposed: () => disposed,
    publishOwned,
    reportHostError,
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
  // A script that locks or opens loads the lock code while the Player is online, so locking works offline later; one
  // that locks also loads the public keys' code.
  watch(
    () => {
      const serviced = servicedSession.value;
      return serviced === null ? undefined : heldPlan(serviced.connection, serviced.planToken);
    },
    (plan) => {
      const needs = plan === undefined ? null : planLockNeeds(plan);
      if (needs?.locks !== true) return;
      void import("../../encryption/lock.js").catch(() => {});
      void (options.lockServices?.tlock ?? (() => import("../../encryption/tlock.js")))().catch(
        () => {},
      );
      if (needs.encrypts)
        void (options.lockServices?.age ?? (() => import("../../encryption/age.js")))().catch(
          () => {},
        );
    },
  );
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

  let activationToken = 0;
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
    remember: (create, sources) => {
      lastStart.value = create;
      if (sources !== undefined) scriptSources = sources;
    },
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
  // A Continue under way in the host, whose session no other activation may let run on; see `supersede`.
  let continuing: PlayerSession | null = null;
  // The Start or Continue still beginning over the bridge. A later activation begins only once it settled, so the
  // obsolete one's requests run in the host before the replacement's, which claims the recorder and trace last.
  let begunInFlight: Promise<void> | null = null;
  // The session that Start or Continue is beginning, once the host names it; an error stop stops at it.
  let sessionBeginning: Promise<PlayerSession> | null = null;
  /**
   * A new activation, preparation or end replaces the one under way: a Continue still beginning is halted in the host,
   * so its queued requests, such as starting the recording of an obsolete session, are refused without effect.
   */
  function supersede() {
    activationToken++;
    nextPreparation();
    // A pending error stop is retired with the activation it stopped; the replacement's input runs.
    halting.value = false;
    const obsolete = continuing;
    continuing = null;
    if (obsolete !== null) void bridgeOf(obsolete).halt(obsolete);
  }
  // The latest Start, which the start page offers again where no kept session goes on, as after the end dialog or an
  // import that replaced the saved data, and which the debug room's restarts run.
  const lastStart = shallowRef<PlayerSessionStart | null>(null);
  // The source text of each file of the script Start runs, by path, when its host supplied it.
  let scriptSources: ReadonlyMap<string, string> = new Map();
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
  // A Start waiting for its read of the stored values or for the camera, or a Continue waiting for the camera, already
  // owns its view of the stored values, although its session is not published yet; a restored one may still write them.
  const beginning = ref(false);

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
  function showSession(
    next: PlayerSession,
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
    if (!paused) adoptRandom(next);
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
        if (live) applyDebugMode();
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
  /**
   * Readies the page for a rewind step's commit or a reinstatement, which begins the host's recording anew: after a
   * Player error, the recording up to the error is kept for the debug export first. Its callers await what it returns.
   */
  function beforeRewindRestart(): void | Promise<void> {
    // The recording up to a Player error is captured before the host begins the recorder anew.
    return activationRun.current()?.failure.beforeRestart();
  }

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
  /**
   * Shows the explicit Start control for a new session; `create` runs only on activation, so no statement executes
   * on page load and the click is the user activation later audible playback relies on. `sources`, the text of the
   * script's files by path, lets the error dialog show a failing line; a later `prepare` without them keeps them.
   */
  function prepare(create: PlayerSessionStart, sources?: ReadonlyMap<string, string>) {
    lastStart.value = create;
    if (sources !== undefined) scriptSources = sources;
    prepareStart(create);
  }
  /** Shows Start for `create`, with `outdated`, why the kept session cannot continue, on the start page. */
  function prepareStart(create: PlayerSessionStart, outdated?: Problem) {
    supersede();
    beginning.value = false;
    // A new session needs its own camera; a superseded acquisition never stays open.
    camera.release();
    activation.value = {
      kind: "start",
      begin: (origin) => startedSession(create, { debugMode: debugModeOn() }, origin),
      ...(outdated === undefined ? {} : { outdated }),
    };
    prepareActivation("start");
  }
  /**
   * Prepares in a task of its own what the activation would otherwise compute within the click (#1707): the zone the
   * browser's settings name, which Start and Continue still capture anew, and a Start's plan JSON for its first save.
   */
  function prepareActivation(kind: Activation["kind"]) {
    if (kind === "start" && keptOwner.keptScopeNow() !== null && keptOwner.scriptPlanNow() !== null)
      settlePlanJson({ kind: "prepare", plan: keptOwner.scriptPlanNow()! });
    if (options.temporalContext !== undefined) return;
    const token = activationToken;
    setTimeout(() => {
      if (disposed || token !== activationToken) return;
      try {
        playerTemporalContext();
      } catch {
        // Start and Continue capture it themselves and report what fails.
      }
    }, 0);
  }
  /**
   * What Start and Continue record about the player now: the zone and presentation, then the wall clock, sampled last so
   * that resolving the zone does not age it.
   */
  function temporalCapture(): TemporalCapture {
    if (clicked !== null) {
      if ("error" in clicked) throw clicked.error;
      return clicked.capture;
    }
    return sampleTemporalCapture();
  }
  function sampleTemporalCapture(): TemporalCapture {
    const temporalContext = resolveTemporalContext();
    return { temporalContext, wallClockMs: Date.now() };
  }
  /** `temporalCapture()`'s result, sampled once, or what sampling threw. */
  type ClickSample = { readonly capture: TemporalCapture } | { readonly error: unknown };
  function sampleClick(): ClickSample {
    try {
      return { capture: sampleTemporalCapture() };
    } catch (error) {
      return { error };
    }
  }
  /**
   * The capture of the activation's click while its `begin` runs (#1886): Start's factories and options and Continue's
   * `begin` record it through `temporalCapture()`, whatever the activation waited for since the click.
   */
  let clicked: ClickSample | null = null;
  /**
   * Shows the explicit Continue control for a restored session; its execution, time and media resume only then.
   * Continue records the wall clock and the player's zone and presentation as they are now.
   */
  function prepareRestore(given: PlayerRuntimeSession, marks?: HistoryMarks): void;
  function prepareRestore(given: PlayerSession): void;
  function prepareRestore(given: PlayerSession | PlayerRuntimeSession, marks?: HistoryMarks) {
    // A session restored outside the host, such as one an embedding host restored, is registered there first, with
    // the marks it was given (none for an outside restore); a session the host holds keeps the host's.
    const restored =
      "lineage" in given ? given : introduceNow(requireBridge(), () => given, marks ?? NO_MARKS);
    supersede();
    beginning.value = false;
    camera.release();
    activation.value = {
      kind: "continue",
      begin: async (origin) => {
        const host = bridgeOf(restored);
        continuing = restored;
        // A restored session runs without Debug's random control until its kept draw went on naturally, as before: one
        // a Start or an adoption gave this Player's control first gives it up (`adoptRandom` below takes it again).
        if (random.issuedRandom() !== undefined)
          void host.client
            .request("releaseRandom", { session: restored.id }, { after: restored.id })
            .catch(() => {});
        // Only the activation that began it goes on after each reply: a replaced one touches no trace or recorder.
        const owner = activationToken;
        const owned = () => {
          if (disposed || owner !== activationToken || !activationRun.admits(origin))
            throw new Error("A replaced Continue goes no further.");
        };
        // Continue records the zone, presentation and clock of the click (#1886), before any reply or wait. A capture
        // that throws fails the Continue where it failed before: after its recording began, so the failure's recording
        // is the restored session's, not the previous one's.
        let taken: ClickSample;
        try {
          taken = { capture: temporalCapture() };
        } catch (error) {
          taken = { error };
        }
        // The recording of a restored session starts from the state it continues, and so does a new epoch of the
        // host's value trace, once the Continue owns the UI. The epoch's request is not awaited: the host runs it
        // before what follows (a draw's resume, Debug mode, Continue).
        await host.request(restored, "beginRecording", origin.begin);
        owned();
        const tracing = tracingIntent();
        if (tracing?.on)
          void host.request(restored, "restartTrace", { tracing }).catch((error: unknown) => {
            if (!endsQuietly(error) && !disposed && !stopped.value) reportHostError(error, origin);
          });
        let continued: PlayerSession = host.latest(restored) ?? restored;
        // A session kept while paused at a random draw goes on with its natural outcome first: until then, the engine
        // takes no other input.
        // It runs without Debug's random control until then, as before, and adopts it after (`adoptRandom` below).
        const draw = continued.state.randomDraw;
        if (draw !== null) {
          await host.request(continued, "resolveDraw", {
            drawId: draw.drawId,
            outcome: "natural",
            record: null,
          });
          owned();
          continued = host.latest(continued) ?? continued;
        }
        // The script reads whether Debug is on now.
        if (continued.state.debugMode !== debugModeOn()) {
          await host.request(continued, "setDebugMode", { on: debugModeOn() });
          owned();
          continued = host.latest(continued) ?? continued;
        }
        adoptRandom(continued, origin);
        if (!("capture" in taken)) throw taken.error;
        await host.request(continued, "continue", { capture: taken.capture });
        owned();
        return host.latest(continued) ?? continued;
      },
      restored,
    };
    prepareActivation("continue");
  }
  /**
   * Runs the prepared Start or Continue; call it from the activating click. With the camera capability it first opens
   * the session camera, so any browser permission request happens here, before ordinary script execution. A camera
   * failure never prevents the session from starting. Start then reads the stored values again, which another tab may
   * have changed since they were read; Continue goes on with its session's own view of them.
   */
  async function activate() {
    const pending = activation.value;
    if (!pending || clearing.value || importing.value) return;
    activation.value = null;
    // The activation it replaces, such as a Continue still beginning, goes.
    supersede();
    const token = activationToken;
    const withCamera = options.capabilities?.camera === true;
    const reading = pending.kind === "start" && scriptStorage !== undefined;
    // Everything the browser allows only within the player's click runs here, before any await or request: the
    // session may show only after the host replied (a Start of a held plan, a Continue), or after the camera answered.
    // Retire the previous session first: its elements return to the pool before priming, so the new session never
    // receives an element the browser still blocks, and it cannot project media while it waits. `beginning` keeps the
    // screen on from the click (`useScreenWakeLock`).
    session.value = null;
    device.reset();
    primeAudio();
    beginning.value = true;
    // What it records of the click (#1886) is sampled now, before anything it waits for; with the camera, as at the fork,
    // once the camera answered, and still before the stored values are read or another activation is waited for.
    let sample = withCamera ? null : sampleClick();
    if (!withCamera && !reading) {
      // `takePhoto()` is unconfigured (settled before `open` returns): nothing waits but the host's replies.
      void camera.open(false);
      captures.reset();
      try {
        if (begunInFlight !== null) {
          await begunInFlight;
          if (disposed || token !== activationToken) return;
        }
        await startFrom(pending, sample ?? sampleClick());
      } finally {
        if (token === activationToken) beginning.value = false;
      }
      return;
    }
    let opened = false;
    let failed = true;
    try {
      opened = await camera.open(withCamera);
      if (opened && !disposed && token === activationToken) sample ??= sampleClick();
      if (opened && reading && !disposed && token === activationToken) await loadScriptStorage();
      failed = false;
    } finally {
      // It stays set for a Start that goes on, so the lock asked for in the click is kept; a superseding prepare already
      // reset it for its own activation.
      if (token === activationToken && (failed || !opened || disposed)) beginning.value = false;
    }
    // Replaced, re-prepared, or unmounted while it waited: an obsolete session never starts.
    if (!opened || disposed || token !== activationToken) return;
    captures.reset();
    try {
      if (begunInFlight !== null) {
        await begunInFlight;
        if (disposed || token !== activationToken) return;
      }
      await startFrom(pending, sample ?? sampleClick());
    } finally {
      if (token === activationToken) beginning.value = false;
    }
  }
  /** The engine's host, which the in-process backend gives at once; an injected one is ready before any Start. */
  function requireBridge(): PlayerBridge {
    if (bridge === null) throw new Error("The engine's host is not ready.");
    return bridge;
  }
  /**
   * The session `create` makes: a held plan over the bridge (`start`), a transitional factory in the host before its
   * first run (`introduceNow`). Either runs with the host's value trace, and carries its Player's random ownership, as
   * only a Start does; a restore takes it at its adoption.
   */
  function startedSession(
    create: PlayerSessionStart,
    recording: { readonly debugMode: boolean },
    origin: ActivationRun,
  ): PlayerSession | Promise<PlayerSession> {
    const random = startRandom();
    const host = requireBridge();
    // A factory, as the Start's options, records the click's capture through `temporalCapture()`, which `begin` binds.
    if (typeof create === "function")
      return introduceNow(
        host,
        (made) =>
          create({
            ...recording,
            recorder: made.recorder,
            ...(made.debugTrace === null ? {} : { debugTrace: made.debugTrace }),
            ...(made.randomControl === null ? {} : { randomControl: made.randomControl }),
          }),
        NO_MARKS,
        tracingIntent(),
        random,
        origin.begin,
      );
    const startOptions = { ...create.options(), debugMode: recording.debugMode };
    return host.start(create.plan, startOptions, true, random, origin.begin);
  }
  /**
   * Starts the prepared session; an exception of the Player while it begins is reported, with what was recorded. A
   * session the host starts at once shows within the activating click; one that begins over the bridge shows once its
   * first publication arrives, unless it was replaced, re-prepared, or unmounted meanwhile.
   */
  function startFrom(pending: Activation, sample: ClickSample): Promise<void> | void {
    const token = activationToken;
    // The engine's host is ready at once in-process; an injected one may answer `ready` later, which this waits for.
    if (bridge === null)
      return bridgeReady.then(() => {
        if (!disposed && token === activationToken) return startFrom(pending, sample);
      });
    hostError.value = null;
    // The activation's run begins before anything of it can fail, retiring the one before it.
    const origin = activationRun.begin(bridge);
    let begun: PlayerSession | Promise<PlayerSession>;
    // `begin` records the click's capture: it reads it before its first await, a Start in its factory or options.
    clicked = sample;
    try {
      begun = pending.begin(origin);
    } catch (error) {
      reportHostError(error, origin);
      return;
    } finally {
      clicked = null;
    }
    if (!(begun instanceof Promise)) return started(pending, begun);
    sessionBeginning = begun;
    const settled = begun.then(
      (next) => {
        if (!disposed && token === activationToken && activationRun.admits(origin))
          started(pending, next);
      },
      (error: unknown) => {
        // An obsolete activation's failure stops nothing: the session that replaced it goes on.
        if (!disposed && token === activationToken && activationRun.admits(origin))
          reportHostError(error, origin);
      },
    );
    begunInFlight = settled;
    void settled.finally(() => {
      if (begunInFlight === settled) begunInFlight = null;
      if (sessionBeginning === begun) sessionBeginning = null;
    });
    return settled;
  }
  function started(pending: Activation, next: PlayerSession) {
    if (continuing?.id === next.id) continuing = null;
    showSession(next);
    // A new session replaces the one kept before.
    if (pending.kind === "start") {
      keptOwner.forgetKeptPoint();
      keptOwner.forgetPresentation();
    }
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
     * The recorded engine calls the host holds (`heldDebugRecording`): after a Player error whose capture is held, those
     * up to it until the next Start; else the recorder's current ones, or `null` before any Start.
     */
    debugRecording: heldDebugRecording,
    /** The error name of an exception of the Player itself, or `null`. */
    hostError: computed(() => hostError.value),
    /** Whether an exception of the Player itself stopped the session where it stands; until the next Start. */
    stopped,
    reportHostError,
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
    showSession: (next: PlayerSession) => showSession(next),
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
    scriptSource: (path: string): string | null => scriptSources.get(path) ?? null,
    /** Changes whenever a session ends as it plays, including at its Start; not when Debug's rewind restores an end. */
    endings: computed(() => endings.value),
    /** The capture a new session records at Start; Continue records its own. */
    temporalCapture,
  };
}

export type PlayerSessionHost = ReturnType<typeof usePlayerSession>;
