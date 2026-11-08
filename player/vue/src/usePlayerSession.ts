import { computed, ref, shallowRef, watch } from "vue";
import { tryOnScopeDispose, useEventListener, useIntervalFn } from "@vueuse/core";
import { browserMediaUrls } from "../../browser-capture.js";
import { NO_MARKS, type HistoryMarks } from "../../debug-history-marks.js";
import { planLockNeeds } from "../../plan-metadata.js";
import {
  CapturedMediaNotStoredError,
  CapturedMediaStore,
  insertOrAcceptExisting,
  isCapturedMediaReference,
  isWellFormedCapturedMediaReference,
  type CapturedMediaRecord,
  type CapturedMediaRepository,
  type StoredCapturedMedia,
} from "../../captured-media.js";
import {
  browserCapturedMediaLocks,
  capturedMediaReferences,
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
import { type LockDialogInput } from "../../lock-service.js";
import type { LockServices } from "../../encryption/lock.js";
import type {
  PlayerRuntimeRestorePoint,
  PlayerRuntimeSession,
  PlayerRuntimeSessionOptions,
} from "../../runtime-adapter.js";
import {
  activePlayerRuntimeInteraction,
  playerTemporalContext,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeMedia,
  playerRuntimeMediaOrigin,
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
import type { RandomIntent, TracingIntent } from "../../engine-bridge/player-ops.js";
import type { StorageCapture } from "../../engine-bridge/ops/history.js";
import type { KeepCapture } from "../../engine-bridge/ops/persistence.js";
import type {
  DrawResolution,
  RandomTriedView,
  ResolveDrawResult,
} from "../../engine-bridge/ops/random.js";
import type { RandomNext } from "../../random-decisions.js";
import {
  StaleOperation,
  persistenceOwnership as ownershipOf,
  type PersistenceOwnership,
} from "../../persistence-ownership.js";
import {
  EMPTY_PLAN_JSON_LEASE,
  settle,
  type PlanJsonEvent,
  type PlanJsonLease,
} from "../../plan-json-lease.js";
import {
  bridgeOf,
  endsQuietly,
  refusalCode,
  type PlayerBridge,
  type ServiceSection,
  type SessionSection,
} from "../../player-bridge.js";
import { BridgeRequestError } from "../../engine-bridge/client.js";
import { RETIRED, type InputSectionHost } from "./runtime-input";
import {
  debugPhotoUses,
  type DebugExportCandidate,
  type DebugPhotoCandidate,
} from "../../debug-export-assembly.js";
import type { DebugRewoundWhileDebugging } from "../../debug-export.js";
import { sweepDebugHistories } from "../../debug-history-indexeddb.js";
import { createRewindOwner } from "./rewindOwner";
import type { DebugHistorySpill } from "../../engine-bridge/history/snapshots.js";
import type { DebugRecorder, DebugRecording } from "../../debug-recorder.js";
import {
  capturedMediaReferencesIn,
  keptPhotoReferences,
  keptSession,
  memoryKeptRoomStore,
  memoryKeptSessionStore,
  type KeptRoomStore,
  type KeptSessionStore,
} from "../../kept-sessions.js";
import type { RuntimeDebugContext } from "../../../src/index.js";
import type { DebugView, DebugViewRequest } from "../../debug-view.js";
import {
  serializeValidatedRuntimeJson,
  type CheckpointErrorInfo,
} from "../../../src/runtime/snapshot/checkpoint-json.js";
import { INSTRUCTION_PLAN_VERSION } from "../../../src/plan/model.js";
import { RUNTIME_SNAPSHOT_VERSION } from "../../../src/runtime/snapshot/snapshot-format.js";
import { validateScriptStorageEntries } from "../../../src/runtime/host-data/script-storage.js";
import type { Problem } from "./ProblemCard.vue";
import type { SavedDataHost } from "../../saved-data.js";
import { playerBuildIdentity } from "../../build-identity.js";
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
import { type PlayerDiagnostic } from "../../session-camera.js";
import {
  sessionMediumRecord,
  sessionTransferMedium,
  type SessionTransfer,
  type SessionTransferMedium,
} from "../../session-transfer.js";
import {
  PlayerNotices,
  playerNoticeKeys,
  playerNotices,
  type PlayerNotice,
} from "../../notices.js";
import type {
  InterpreterEvent,
  MediaReportOutcome,
  RandomControlOptions,
  RuntimeScriptStorageEntrySnapshot,
  SerializableRuntimeValue,
  TemporalContext,
  TimeObservationOutcome,
} from "../../../src/index.js";

import { serializableEquals } from "../../../src/runtime/values/serializable-values.js";
import { silence } from "./generatedAudio";
import { useRuntimeSceneClock } from "./useRuntimeSceneClock";
import { useScreenWakeLock } from "./useScreenWakeLock";
import { useCallView } from "./session/useCallView.js";
import { usePlayerCameraLifecycle, useSessionCamera } from "./session/usePlayerCameras.js";
import { usePlayerSessionServices } from "./session/usePlayerSessionServices.js";
import { useFailureRecording } from "./session/useFailureRecording.js";
import type { ExportCaptureReply } from "../../engine-bridge/session-protocol.js";

const PRIMED_AUDIO_ELEMENTS = 2;
const SILENCE = silence(50);

// Media progress is sampled this often while media loads or plays; cues fire at this resolution.
const MEDIA_SAMPLE_MS = 100;
/** A debug export's capture that met a stop of its run still committing (`captureExport`'s `pending`). */
const PENDING_CAPTURE = Symbol("pending capture");

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
  readonly begin: () => PlayerSession | Promise<PlayerSession>;
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
    randomOwner = ready.claim(claim);
    bridge = ready;
    ready.client.onLoss(bridgeLost);
    // An injected bridge with a tracing serial allocated: only an earlier Player can have allocated it, as this one could
    // send nothing to the bridge before now.
    if (options.bridge !== undefined && ready.hasAllocatedTracingIntent) pendingTracing = true;
    flushTracing(ready);
    flushRandom(ready, null);
    return ready;
  });
  bridgeReady.catch(() => {
    pendingTracing = false;
    pendingRandom = false;
  });
  // The recording up to a Player error, captured in the host as the stop is sent and kept until the next Start, while
  // Debug's rewind may begin the recorder anew at a restored state.
  const failureRecording = useFailureRecording();
  /** The recording a debug export shows: the one up to a Player error, else the host's recorder's. */
  const exportedRecording = (): DebugRecording | null => {
    const failed = failureRecording.ticket();
    if (failed !== null) return heldRecording(failed.bridge, failed.ticket);
    return bridge === null ? null : heldRecording(bridge);
  };
  // Rewind histories that pages which ended without deleting theirs left behind go now.
  if (options.debugHistorySpill === undefined) void sweepDebugHistories();
  // The error name of an exception of the Player itself, such as one at Start; it stays until the next Start. Such an
  // exception stops the session where it stands (see `stopped`).
  const hostError = ref<string | null>(null);
  // The diagnostic run of the latest Start or Continue (`ExportObservation`): the host binds its sessions to it, and a
  // Player error stop commits the run's incident there. `null` before the first activation.
  let run: number | null = null;
  /** Begins the next run in the host before the activation's session exists, ending the run before it. */
  function beginRun(host: PlayerBridge) {
    const retires = run;
    run = host.nextRun();
    void host.beginRun(run, retires).catch(() => {});
  }
  /** The stop arguments of a Player error `name` at stop `stop`, in the current run; `null` outside any run. */
  const stopOf = (name: string, stop: number) => (run === null ? null : { error: name, run, stop });
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
   * names it. Its last publication then shows, and the stop renders after it; input stops at once (`stopped`).
   */
  function reportHostError(error: unknown) {
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
    if (target !== null) return stopAt(target, name, stop);
    // Without a session to stop, the run's incident is committed by itself.
    const incident = () => {
      const args = stopOf(name, stop);
      if (args !== null) void bridge?.commitIncident(args).catch(() => {});
    };
    if (starting === null) {
      hostError.value = name;
      incident();
      return;
    }
    haltUntil(stop);
    void starting.then(
      (started) => stopAt(started, name, stop),
      () => {
        endHalting(stop);
        if (stop !== activationToken) return;
        hostError.value ??= name;
        incident();
      },
    );
  }
  /**
   * Stops at `target`: once its store froze at the host's acknowledgement, its last publication is the shown session,
   * which the recording and export hold, and the stop renders. A later activation or unmount supersedes it.
   */
  function stopAt(target: PlayerSession, name: string, stop: number) {
    const host = bridgeOf(target);
    const acknowledged = host.halt(target, stopOf(name, stop));
    failureRecording.stopped(target);
    const commit = () => {
      if (disposed || stop !== activationToken) return endHalting(stop);
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
    pendingTracing = false;
    pendingRandom = false;
    traceId.value = null;
    // So did every state Debug's rewind could reinstate, and its history: its view stays, read-only, and nothing waiting
    // on it acts.
    retireRewind("loss");
    reportHostError(error);
  }
  // Debug's value trace (DEBUGGER.md "Player Debug"), while Debug runs: the host holds it, as the connection's state
  // (`debugTracing`), and every session operation there records into it. `traceId` names the host's trace now, once
  // the host answered.
  const debugTracing = ref(false);
  const traceId = shallowRef<number | null>(null);
  // Counts this Player's tracing changes, so a reply of an older one sets no `traceId`.
  let tracingToggles = 0;
  // Whether `debugTracing` waits to be sent, until the host is reachable. Only the latest setting goes, and only while
  // this Player lives. A bridge a Player traced on before may still hold that Player's work in its queue: the setting
  // then goes in any case, so that this Player's Starts carry it ahead of that work.
  let pendingTracing = false;
  // This Player's newest tracing intent sent, with its serial from the connection (`nextTracingIntent`), which every op
  // that sets the host's trace carries (`TracingIntent`): the host applies only the newest, whichever channel brings it.
  let lastIssued: TracingIntent | undefined;
  /** This Player's newest tracing intent sent, or `undefined` before any: the host's trace is then off. */
  const tracingIntent = () => lastIssued;
  /** Sends tracing `on`, with the connection's next serial. */
  function issueTracing(host: PlayerBridge, on: boolean) {
    const intent = { on, intent: host.nextTracingIntent() };
    lastIssued = intent;
    return host.client.request("debugTracing", intent);
  }
  /** Sends the pending tracing setting, while this Player lives; its reply names the host's trace. */
  function flushTracing(host: PlayerBridge) {
    if (!pendingTracing || disposed) return;
    pendingTracing = false;
    const toggle = tracingToggles;
    issueTracing(host, debugTracing.value).then(
      (reply) => {
        // EVIDENCE: validation: `debugTracing` replies from the same build with the trace it holds now.
        const now = (reply.result as { readonly traceId: number | null }).traceId;
        if (toggle === tracingToggles && !disposed) traceId.value = now;
      },
      (error: unknown) => {
        if (!endsQuietly(error) && !disposed) reportHostError(error);
      },
    );
  }
  /**
   * A view of Debug's value trace for the shown session, made in the host (`debugView`, `debug-view.ts`): the reply
   * names the revision and trace it shows, which its caller compares with what shows when it arrives. `null` without a
   * shown session or a trace, and for a session that no longer shows or that the host no longer holds; it never
   * rejects.
   */
  function debugView(request: DebugViewRequest): Promise<DebugView | null> {
    const current = session.value;
    if (current === null || !debugTracing.value) return Promise.resolve(null);
    return bridgeOf(current)
      .read(current, "debugView", { request })
      .then(
        (view) => (session.value?.lineage === current.lineage ? view : null),
        (error: unknown) => {
          // A session the host released meanwhile has nothing to read; any other failure is the Player's error stop,
          // as an op's failure is.
          const gone = error instanceof BridgeRequestError && error.name === "SessionGoneError";
          if (
            !endsQuietly(error) &&
            !gone &&
            !disposed &&
            !stopped.value &&
            session.value?.lineage === current.lineage
          )
            reportHostError(error);
          return null;
        },
      );
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
  /** The Debug mode last asked of a session's host while its request is under way (`applyDebugMode`), or `null`. */
  let debugModeAsked: { readonly lineage: object; readonly on: boolean } | null = null;
  // The script's debug room, or `null` without one, and whether it keeps a session.
  let debugRooms = options.debugRooms ?? memoryKeptRoomStore();
  const debugRoom = shallowRef<{ readonly session: boolean } | null>(null);
  let debugRoomStorage: CapturedMediaStorage | null = null;
  /**
   * Where saved values go: a provider used as it is, or one that keeps their captured media durable, each with its view
   * for one persistence operation, whose ownership admits every call it makes (`persistence-ownership.ts`).
   */
  interface StorageRoute {
    readonly provider: ScriptStorageProvider;
    forOperation(owner: PersistenceOwnership): ScriptStorageProvider;
  }
  const plainRoute = (provider: ScriptStorageProvider): StorageRoute => ({
    provider,
    forOperation: (owner) => owner.values(provider),
  });
  const capturedRoute = (storage: CapturedMediaStorage): StorageRoute => ({
    provider: storage,
    forOperation: (owner) => storage.forOperation(owner),
  });
  const normalRoute: StorageRoute | undefined =
    capturedMediaPersistence === undefined
      ? options.scriptStorage && plainRoute(options.scriptStorage)
      : capturedRoute(capturedMediaPersistence);
  // Where storage operations go: the route in use, or a switch to another one, which operations issued meanwhile wait
  // for, in issue order.
  let storageRoute: StorageRoute | Promise<StorageRoute> | undefined = normalRoute;
  const routed = <T>(operation: (route: StorageRoute) => Promise<T>): Promise<T> => {
    const route = storageRoute!;
    return route instanceof Promise ? route.then(operation) : operation(route);
  };
  /** The saved values in use, for the persistence operation `owner`: every call it makes there is admitted. */
  const operationStorage = (owner: PersistenceOwnership): ScriptStorageProvider => ({
    scope: normalStorage!.scope,
    load: () => routed((route) => route.forOperation(owner).load()),
    write: (key, value) => routed((route) => route.forOperation(owner).write(key, value)),
    replace: (entries) => routed((route) => route.forOperation(owner).replace(entries)),
    clear: () => routed((route) => route.forOperation(owner).clear()),
  });
  const storageProvider: ScriptStorageProvider | undefined = normalStorage && {
    scope: normalStorage.scope,
    load: () => routed((route) => route.provider.load()),
    write: (key, value) => routed((route) => route.provider.write(key, value)),
    replace: (entries) => routed((route) => route.provider.replace(entries)),
    clear: () => routed((route) => route.provider.clear()),
  };
  /**
   * Sends storage operations where `next` resolves from now on, once the operations issued before have finished where
   * they were issued. `next` must not reject.
   */
  function switchStorage(next: () => Promise<StorageRoute>): Promise<void> {
    const previous = storageRoute!;
    const switched = (async () => {
      const { provider } = await previous;
      await (provider === debugRoomStorage ? debugRoomStorage : capturedMediaPersistence)?.flush();
      return next();
    })();
    storageRoute = switched;
    return switched.then((route) => {
      if (storageRoute === switched) storageRoute = route;
    });
  }
  /** Sends saved values and photos to the scope's debug room, which exists; `durable` are its photos this Player holds. */
  function enterDebugRoom(
    scope: string,
    state: { readonly session: boolean },
    durable: ReadonlySet<string>,
  ): StorageRoute {
    capturedMedia.useRepository(debugRooms.media, durable);
    debugRoomStorage = withCapturedMedia(debugRooms.values(scope), capturedMedia);
    debugRoom.value = state;
    return capturedRoute(debugRoomStorage);
  }
  // The room the page opens is in use before a session is prepared; the debug room is made from a copy of the script's
  // own saved data when there is none yet.
  if (normalStorage !== undefined)
    void switchStorage(async () => {
      debugRoom.value = await debugRooms.read(normalStorage.scope).catch(() => null);
      if (room.value === "normal") return normalRoute!;
      const durable =
        debugRoom.value === null
          ? await createDebugRoom(normalStorage.scope, false)
          : new Set<string>();
      return enterDebugRoom(normalStorage.scope, debugRoom.value ?? { session: false }, durable);
    });
  // Every change this Player makes to the stored values goes through here, which keeps `storedEntries` equal to what the
  // provider holds as far as this Player knows, such as for the debug room's offer to delete them; another tab's
  // changes arrive with the next read. A failed change leaves them as they were; session-local values (`null`) stay
  // session-local.
  const scriptStorage: ScriptStorageProvider | undefined = storageProvider && {
    scope: storageProvider.scope,
    load: () => storageProvider.load(),
    write: (key, value) =>
      whenStored(storageProvider.write(key, value), () => noteStored(key, value)),
    replace: (entries) =>
      whenStored(storageProvider.replace(entries), () => {
        if (storedEntries.value !== null) storedEntries.value = [...entries];
      }),
    clear: () =>
      whenStored(storageProvider.clear(), () => {
        if (storedEntries.value !== null) storedEntries.value = [];
      }),
  };
  // Notes the change once the provider stored it, before its caller learns of it, and hands the caller the provider's
  // own promise, so the change settles for it exactly as it would without the note.
  function whenStored(change: Promise<void>, note: () => void): Promise<void> {
    change.then(note, () => {});
    return change;
  }
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
  const session = shallowRef<PlayerSession | null>(null);
  /**
   * The rewind retirement stamp (`rewindRetirements`, below) the owner's reply guards read; declared first, as the owner
   * is made before everything that reads it.
   */
  const rewindRetirements = ref(0);
  // Debug's rewind over the Player's lifetime, which outlives each Debug scope (DEBUGGER.md "Rewind"): one deciding
  // function (`player/rewind-lifecycle.ts`) and the owner that applies what it decides.
  const rewindOwner = createRewindOwner({
    bridge: () => bridge,
    retirements: () => rewindRetirements.value,
    shown: () => session.value,
    ready: () => rewindReady.value,
    generation: () => generation.value,
    beginStep: () => beginRewindStep(),
    show: (next, paused) => showRewound(next, { paused }),
    // Read at each call, so a host or a test can put its own gate there.
    beforeRestart: () => rewindApi.beforeRestart(),
    reportHostError: (error) => reportHostError(error),
  });
  // While Debug's rewind shows a restored state (DEBUGGER.md "Rewind"), nothing runs on its own: the clock stands, media
  // hold their position, and load reports and capture requests wait, until new input adopts the state as the session.
  // Whether it does is the rewind owner's lifecycle state, the one account of it; every show and end reports there.
  const inspecting = rewindOwner.inspecting;
  /**
   * Debug's rewind history ends when what it could reinstate is gone: a clear, an import, or the lost host. This one
   * stamp counts those retirements, and every guard of a rewind reply reads it; the reason goes to the rewind owner as
   * plain data.
   */
  function retireRewind(by: "clear" | "import" | "loss") {
    rewindRetirements.value++;
    if (by === "loss") rewindOwner.lost();
    else rewindOwner.retired(by);
  }
  // Whether Debug's rewind restored an earlier state of the session, as the shown session's marks say; for its debug
  // export.
  const rewound = computed<DebugRewoundWhileDebugging | null>(
    () => session.value?.marks.rewoundWhileDebugging ?? null,
  );
  // While the session is paused at a random draw (DEBUGGER.md "Random draws"), it holds like an inspected state until
  // the draw is resolved.
  const drawPending = computed(() => session.value?.state.randomDraw != null);
  // An exception of the Player itself stops the session where it stands (PLAYER-UI "Session end and failure"): nothing
  // of it runs, observes time, or takes input any more, and late answers, reports, and writes are dropped. Its
  // transcript, Stage, and recording stay for the error dialog and a debug export, until the next Start.
  const stopped = computed(() => hostError.value !== null || halting.value);
  const held = computed(() => inspecting.value || drawPending.value || stopped.value);
  // Debug's random control (DEBUGGER.md "Random draws"), as the host holds it for this Player (`randomOwner`, from its claim
  // of the bridge): which sites go on by themselves while Choose outcomes is on, or `null` while it is off. As tracing,
  // a change before the host is reachable waits as the Player's (`pendingRandom`), and only its latest goes, while the
  // Player lives; every intent carries the serial of the newest reset of the history it asked for (`resetAt`).
  // A private bridge is this Player's from the start: a Start may begin before the readiness callback ran.
  let randomOwner: number | null = bridge?.claim(claim) ?? null;
  let desiredRandom: { readonly sites: readonly (readonly [string, RandomNext])[] } | null = null;
  let resetRequested = false;
  let pendingRandom = false;
  let lastRandom: RandomIntent | undefined;
  // The host's history's revision, from its latest reply: what `randomTried` reads again for.
  const randomRevision = ref(0);
  /**
   * Sends the pending random intent, while this Player lives, after the earlier requests of `ahead` (the shown session),
   * so that session's next op runs with it. It gives no session this Player's control: only `adoptRandom` does.
   */
  function flushRandom(host: PlayerBridge, ahead: PlayerSession | null) {
    if (!pendingRandom || disposed || randomOwner === null) return;
    pendingRandom = false;
    const intent = host.nextRandomIntent();
    lastRandom = Object.freeze({
      owner: randomOwner,
      control: desiredRandom,
      resetAt: resetRequested ? intent : (lastRandom?.resetAt ?? 0),
      intent,
    });
    resetRequested = false;
    sendRandomRequest(
      host,
      "randomControl",
      { intent: lastRandom },
      ahead === null ? {} : { after: ahead.id },
    );
  }
  /** Sends a random op on the Worker itself; its reply gives the history's revision. */
  function sendRandomRequest(
    host: PlayerBridge,
    op: "randomControl" | "adoptRandom",
    args: Record<string, unknown>,
    options: { readonly after?: string },
  ) {
    host.client.request(op, args, options).then(
      (reply) => {
        // EVIDENCE: validation: the random ops reply from the same build with the history's revision.
        const { revision } = reply.result as { readonly revision: number };
        if (!disposed) randomRevision.value = revision;
      },
      (error: unknown) => {
        if (!endsQuietly(error) && !disposed) reportHostError(error);
      },
    );
  }
  /**
   * Adopts `next`: gives it this Player's random control from its next op on. Only the invariant's points call it:
   * `showSession` without inspection, input adopting an inspected state, Continue after its kept draw went on. A Start's
   * session is already its Player's from the `start` that made it.
   */
  function adoptRandom(next: PlayerSession) {
    if (lastRandom === undefined || disposed) return;
    sendRandomRequest(
      bridgeOf(next),
      "adoptRandom",
      { session: next.id, intent: lastRandom },
      { after: next.id },
    );
  }
  /** What a Start carries: this Player, whose session it is, and its newest random intent. */
  const startRandom = () =>
    randomOwner === null
      ? undefined
      : { owner: randomOwner, ...(lastRandom === undefined ? {} : { intent: lastRandom }) };
  // The session as other parts of the Player service it: none while a restored state is inspected or a draw is paused.
  const servicedSession = computed(() => (held.value ? null : session.value));
  // A new session remounts the transcript and resets interaction-local state.
  const generation = ref(0);
  const interactionReset = ref(0);
  // The transcript revision through which the session's transcript shows directly, as history: what development time
  // jumps published. -1 for none in this generation.
  const jumpedRevision = ref(-1);
  const activation = shallowRef<Activation | null>(null);
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
    const shown = session.value;
    if (shown === null) return;
    // As a call through the facade did: the session's replies still in transit apply first, so a medium an observation
    // already ended has no origin. With the Worker nothing arrives early, and the latest applied publication answers.
    const host = bridgeOf(shown);
    host.deliverInTransit?.(shown.id);
    const origin = playerRuntimeMediaOrigin(host.latest(shown) ?? shown, mediaId);
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
  /**
   * Delivers queued load reports to the shown session, in one of its sections, after an observation when new reports
   * arrived. A report waits while the session is inspected or a draw waits, and while the runtime cannot take it yet
   * (`executionPending`). Only an accepted report shows: a refusal changed nothing, and showing it would retry at once.
   */
  const loads = new MediaLoadQueue(
    async (reports, observe, acknowledge) => {
      const current = session.value;
      // Without a session, nothing takes them.
      if (current === null) return reports.forEach(([mediaId]) => acknowledge(mediaId));
      try {
        await ownedSection(current, "observeTime", async (section, owned, observed) => {
          if (observe && (await observed()) === null) return;
          for (const [mediaId, report] of reports) {
            if (held.value || !owned()) return;
            const outcome = await section.send<MediaReportOutcome>("reportMediaLoad", {
              mediaId,
              report,
            });
            if (outcome.kind === "executionPending") continue;
            if (outcome.kind === "accepted") publishOwned(section.session);
            acknowledge(mediaId);
          }
        });
      } catch (error) {
        // Refusals changed nothing. A basis another op since replaced (the observation's) leaves the rest for the retry
        // its publication makes; a stopped session, or a lost Worker, takes nothing more, and the stop clears the queue. Any other error is
        // the Player's error stop, as a report's throw through the facade was, unless the session no longer owns the UI.
        if (endsQuietly(error) || (error instanceof BridgeRequestError && error.code === "basis"))
          return;
        if (!disposed && !stopped.value && session.value?.lineage === current.lineage)
          reportHostError(error);
      }
    },
    () => (pendingLoadCount.value = loads.size),
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
    requestObservation: () => clock.before("audioEnded"),
    blockedChanged: (blocked) =>
      blocked
        ? notices.publish(playerNotices.audioBlocked(() => device.retryBlocked()))
        : notices.dismiss(playerNoticeKeys.audioBlocked),
  });
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
    () => !debugTracing.value && desiredRandom === null,
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
   * A section of `current`, with an observation inside it as `observeForInput` makes one: the clock's now and media
   * samples, observed over the bridge with `observeOp`, and `null` once `current` no longer owns the UI, before and
   * after. While the clock is paused (an inspected state, a waiting draw) nothing is observed, as `clock.observe()`
   * observes nothing then. The body receives liveness checks (`owned`); it rechecks them after each await, as what it
   * sends is applied to the session's store and shown only while `current` owns the UI (`publishOwned`). `null`
   * without `current`, or once a Player error stopped it.
   */
  function ownedSection<T>(
    current: PlayerSession | null,
    observeOp: "observeTime" | "observeInput",
    body: (
      section: SessionSection,
      owned: () => boolean,
      observe: () => Promise<PlayerSession | null>,
    ) => Promise<T>,
  ): Promise<T | null> {
    if (current === null || stopped.value) return Promise.resolve(null);
    const owned = () => !disposed && !stopped.value && session.value?.lineage === current.lineage;
    return bridgeOf(current).section(current, (section) =>
      body(section, owned, async () => {
        if (!owned()) return null;
        if (held.value) return section.session;
        clock.cancel();
        const shown = section.session;
        let outcome: TimeObservationOutcome;
        try {
          outcome = await section.send<TimeObservationOutcome>(observeOp, {
            atMs: clock.sceneTimeMs(shown),
            media: device.sample(),
          });
        } catch (error) {
          // Refused as stopped, or lost with the Worker: the session no longer owns the UI.
          if (endsQuietly(error)) return null;
          throw error;
        }
        if (!owned()) return null;
        if (outcome.kind === "observed" && publishOwned(section.session) === null) return null;
        return section.session;
      }),
    );
  }
  /** A service's section of the serviced session (`ownedSection`); `null` without one, or once stopped. */
  function serviceSection<T>(body: (section: ServiceSection) => Promise<T>): Promise<T | null> {
    return ownedSection(servicedSession.value, "observeTime", (section, _owned, observe) =>
      body({
        observe,
        // What the services send shows as any work completing after a reply does.
        send: (op, args, basis) =>
          section.send(op, args, { basis, publish: (next) => void publishOwned(next) }),
      }),
    );
  }
  /**
   * An input section of the shown session (`ownedSection`): its observation and ops read no basis, and an op is posted
   * only while the session owns the UI. A refusal of the stopped session (`halted`) changed nothing, as one never posted.
   */
  const inputSection: InputSectionHost = (body) =>
    ownedSection(session.value, "observeInput", (section, owned, observe) =>
      body({
        observe,
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
      }),
    );

  const { demandCallView } = useCallView({
    session,
    stopped,
    isDisposed: () => disposed,
    publishOwned,
    reportHostError,
  });
  const stageImage = computed(() =>
    session.value === null ? null : playerRuntimeMedia(session.value.state).stage.image,
  );
  // The Stage source the browser could not load, as the Stage reports it while it shows that source, or `null`. The
  // Stage keeps that image hidden while its source stays, also into a new session, which then gets no new browser error.
  const failedStageSource = shallowRef<string | null>(null);
  // The Stage source the browser has loaded and decoded, as the Stage reports it, or `null`; for Debug's Now view.
  const loadedStageSource = shallowRef<string | null>(null);
  // A speaker's avatar image that is no package file is reported as a Stage image is; the glyph shows instead. The
  // session adds its messages and speakers in place, so each published session's new messages are read, and a speaker
  // is checked when a message first shows it.
  let readEntries: PlayerSession["transcriptEntries"] | null = null;
  let readCount = 0;
  const checkedSpeakers = new Set<string>();
  watch(session, (current) => {
    const entries = current?.transcriptEntries ?? null;
    if (entries !== readEntries) {
      readEntries = entries;
      readCount = 0;
      checkedSpeakers.clear();
    }
    if (current === null || entries === null) return;
    for (; readCount < entries.length; readCount++) {
      const entry = entries[readCount]!;
      if (entry.kind !== "message" || checkedSpeakers.has(entry.speakerId)) continue;
      checkedSpeakers.add(entry.speakerId);
      const image = current.speakers[entry.speakerId]?.avatarImage;
      if (image !== undefined && resolvePackageAsset(image) === null)
        reportUnusableMedia(image, playerNotices.unusableMedia("image", image, "missing"));
    }
  });
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
      // A stopped session keeps no media.
      const media = current && !stopped.value ? playerRuntimeMedia(current.state).media : [];
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
  const sampling = useIntervalFn(clock.catchUp, MEDIA_SAMPLE_MS, { immediate: false });
  // Pending load reports also keep observing, so the engine runs until it can accept them.
  watch(
    () => session.value !== null && (device.active || pendingLoadCount.value > 0),
    (active) => (active ? sampling.resume() : sampling.pause()),
    { immediate: true },
  );
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
  // The kept-session preparation under way (`prepareScript`, `prepareKept`). A later preparation, and every transition
  // that replaces what it would show, retires it: Start, Continue, a session's end (`supersede`), an import of the shown
  // script, a room change, unmount. Only the current one shows its Continue or Start and puts its photos back.
  let preparation = 0;
  // The persistence operations under way (`persistenceOwnership`), each revoked for good where it retires.
  const pendingOwnerships = new Set<PersistenceOwnership>();
  /** Ends every persistence operation the page's change of room, store, plan tenure, preparation or life retired. */
  function retireStaleOperations() {
    for (const ownership of pendingOwnerships) ownership.retireIfStale();
  }
  /** A new preparation, which retires the ones before it. */
  function nextPreparation(): number {
    preparation += 1;
    retireStaleOperations();
    return preparation;
  }
  watch(room, retireStaleOperations, { flush: "sync" });
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
    // The trace was this Player's: it ends with it, as when the trace lived in the page, and a Player that uses the
    // connection next begins with it off. A setting not yet sent goes nowhere; a connection already lost takes nothing.
    pendingTracing = false;
    if (lastIssued?.on && bridge !== null) issueTracing(bridge, false).catch(() => {});
    lastIssued = undefined;
    // Its random control ends with it too, with its history.
    pendingRandom = false;
    if (
      lastRandom !== undefined &&
      bridge !== null &&
      (lastRandom.control !== null || lastRandom.resetAt !== lastRandom.intent)
    ) {
      const intent = bridge.nextRandomIntent();
      const shown = session.value;
      bridge.client
        .request(
          "randomControl",
          { intent: { owner: lastRandom.owner, control: null, resetAt: intent, intent } },
          shown === null ? {} : { after: shown.id },
        )
        .catch(() => {});
    }
    lastRandom = undefined;
    bridge?.unclaim(claim);
    if (bridge !== null && run !== null) void bridge.retireRun(run).catch(() => {});
    failureRecording.retire();
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
    void Promise.all([capturedMediaPersistence?.close(), debugRoomStorage?.drain()]).finally(() =>
      capturedMedia.close(),
    );
  });

  // The stored values that seed the next session, or `null` when storage is session-local: no provider, or one that
  // could not load, such as a browser that denies storage. A session-local run plays normally and keeps nothing.
  const storedEntries = shallowRef<readonly RuntimeScriptStorageEntrySnapshot[] | null>(null);
  // The references in the stored values that the media store had stored when they were read: the stored files a Start
  // names, with those it holds since.
  let readStoredFiles: ReadonlySet<string> = new Set();
  // Counts changes this Player made to the saved values: a stored save, a clear, an import, or a fresh read.
  const savedDataRevision = ref(0);
  /**
   * Reads the stored values freshly; call it before the first `prepare`, so the start page knows them. Each Start reads
   * them again (`activate`).
   */
  async function loadScriptStorage(): Promise<void> {
    applyScriptStorage(await readScriptStorage(scriptStorage));
  }
  /**
   * The stored values read freshly, with the references among them the media store had stored, or `null` when storage
   * could not be read; `undefined` without storage. It changes nothing on the page: `applyScriptStorage` does. For the
   * persistence operation `owner`, `values` are its own (`operationStorage`) and every call is admitted; a refused one
   * rejects with `StaleOperation`.
   */
  async function readScriptStorage(
    values: ScriptStorageProvider | undefined,
    owner?: PersistenceOwnership,
  ): Promise<
    | {
        readonly entries: readonly RuntimeScriptStorageEntrySnapshot[];
        readonly storedFiles: ReadonlySet<string>;
      }
    | null
    | undefined
  > {
    if (values === undefined) return undefined;
    try {
      const entries = await values.load();
      const storedFiles = await capturedMedia
        .knownReferences(storedValueReferences(entries), owner)
        .catch(rejectedUnlessStale(new Set<string>()));
      return { entries, storedFiles };
    } catch (error) {
      if (error instanceof StaleOperation) throw error;
      return null;
    }
  }
  /** Shows what `readScriptStorage` read, at once. */
  function applyScriptStorage(read: Awaited<ReturnType<typeof readScriptStorage>>): void {
    if (read === undefined) return;
    if (read === null) {
      storedEntries.value = null;
      notices.publish(playerNotices.storageUnavailable());
      return;
    }
    readStoredFiles = read.storedFiles;
    storedEntries.value = read.entries;
    savedDataRevision.value++;
    notices.dismiss(playerNoticeKeys.storageUnavailable);
  }
  /**
   * Session options for the script's storage; call it from the Start factory. The references in the stored values that
   * the media store holds, or had stored when they were read, are stored files the session knows, so `toJson` writes
   * them and `fileToBase64` reads them; other text, also text of the same shape, stays text.
   */
  function scriptStorageOptions(): PlayerRuntimeSessionOptions {
    if (storedEntries.value === null) return {};
    const storedFiles = [...storedValueReferences(storedEntries.value)].filter(
      (reference) => readStoredFiles.has(reference) || capturedMedia.knows(reference),
    );
    return { scriptStorage: storedEntries.value, persistentScriptStorage: true, storedFiles };
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
      // A stopped session issues no more writes, also when it is published again, such as by Debug's value trace.
      if (!scriptStorage || !write || stopped.value) return;
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
        // The flight lasts until the acknowledgement applied or retired: a publication that still shows the pending
        // write meanwhile issues no second provider write.
        void acknowledge(stored).finally(() => writesInFlight.delete(flight));
      }
      async function acknowledge(stored: boolean) {
        // A write that settles after unmount must not continue the session.
        if (disposed) return;
        const latest = session.value;
        // The report must belong to the session that requested it, which has not stopped.
        if (generation.value !== sessionGeneration || latest === null || stopped.value) return;
        if (pendingPlayerRuntimeStorageWrite(latest.state)?.actionId !== write!.actionId) return;
        if (!stored) notices.publish(playerNotices.storageWriteFailed());
        else {
          savedDataRevision.value++;
          for (const stored of scriptWritesStored) stored.set(write!.key, write!.value);
        }
        // The provider's write is made; the acknowledgement goes only to the session that still owns the UI, once.
        await inputSection(async (section) => {
          if (!section.owned() || generation.value !== sessionGeneration) return;
          await section.send("completeStorageWrite", { actionId: write!.actionId, stored });
        });
      }
    },
    { flush: "sync" },
  );
  // A running or resumable session keeps its own view of the stored values, so clearing waits until it ends; while a
  // clear runs, no second clear and no Start can begin, so a new session never starts from the values being removed.
  const clearing = ref(false);
  // A Start waiting for its read of the stored values or for the camera, or a Continue waiting for the camera, already
  // owns its view of the stored values, although its session is not published yet; a restored one may still write them.
  const beginning = ref(false);
  // While an import replaces the saved data, no Start, Continue, or clear begins.
  const importing = ref(false);
  // Debug storage edits (DEBUGGER.md "Player Debug"), one at a time. An edit is stored first and reaches the running
  // session only once that succeeded, through the engine's storage-edit input; its next `load` then returns it. While
  // the script's own write waits for the host, an edit is not taken: it would have to come between that write and the
  // script. A write the script issues while an edit is being stored settles as usual first.
  let editChain: Promise<unknown> = Promise.resolve();
  /** Puts a stored value into `storedEntries`, as the provider now holds it; see `scriptStorage`. */
  function noteStored(key: string, value: SerializableRuntimeValue) {
    const entries = storedEntries.value;
    if (entries === null) return;
    const others = entries.filter((entry) => entry.key !== key);
    storedEntries.value = value === null ? others : [...others, { key, value }];
  }
  // Which session Debug changed the saved values of, for its debug export: when and how often, as the shown session's
  // marks say (the host counts each edit it applied).
  const debugEdits = computed(() => session.value?.marks.editedWhileDebugging ?? null);
  /** Whether a running or waiting session takes an edit now; one that waits for Continue or the camera does not. */
  const liveSession = () =>
    session.value !== null &&
    !stopped.value &&
    (session.value.state.status === "running" || session.value.state.status === "waiting") &&
    activation.value === null &&
    !beginning.value;
  /** Whether the running session's own write waits for the host, so it takes no edit until that settled. */
  const scriptSaving = () =>
    liveSession() && pendingPlayerRuntimeStorageWrite(session.value!.state) !== null;
  // Edits that wait for the session's write to settle; each published session or new run wakes them to look again.
  const writeSettledWaiters = new Set<() => void>();
  // A stop wakes them too: the write they wait for is never acknowledged then.
  watch([session, generation, stopped], () => {
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
      beginning.value ||
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
      // The edit is stored once. It reaches the session once no script write is pending there, also one that became
      // pending while the edit waited for its section or after it was posted (`storageWritePending`): then it waits
      // for that write and tries again.
      for (;;) {
        while (
          !retired() &&
          !stopped.value &&
          session.value !== null &&
          pendingPlayerRuntimeStorageWrite(session.value.state) !== null
        )
          await new Promise<void>((resolve) => writeSettledWaiters.add(resolve));
        if (retired() || stopped.value) return { kind: "saved", live: false };
        if (stored.has(key)) return { kind: "overtaken" };
        if (!liveSession()) return { kind: "saved", live: false };
        const decided = await inputSection(async (section) => {
          // Rechecked at the section's turn: input before it may have published meanwhile.
          if (!section.owned() || retired()) return { kind: "saved", live: false } as const;
          if (stored.has(key)) return { kind: "overtaken" } as const;
          if (!liveSession()) return { kind: "saved", live: false } as const;
          if (pendingPlayerRuntimeStorageWrite(section.session.state) !== null) return "wait";
          let outcome: { readonly kind: string } | typeof RETIRED;
          try {
            outcome = await section.send<{ readonly kind: string }>("applyStorageEdit", {
              key,
              value,
            });
          } catch (error) {
            // Stored, the edit settles also when the bridge failed to carry it: what the engine threw is reported.
            if (error instanceof BridgeRequestError && error.kind === "engine") throw error;
            return { kind: "saved", live: false } as const;
          }
          if (outcome === RETIRED || !section.owned())
            return { kind: "saved", live: false } as const;
          if (outcome.kind === "storageWritePending") return "wait";
          if (outcome.kind !== "applied") return { kind: "saved", live: false } as const;
          return { kind: "saved", live: true } as const;
        });
        if (decided === null) return { kind: "saved", live: false };
        if (decided !== "wait") return decided;
        // A write the session issued meanwhile: wait for it outside the section, as above. Until the shown session
        // shows it, the next publication wakes the wait.
        if (
          session.value !== null &&
          pendingPlayerRuntimeStorageWrite(session.value.state) === null
        )
          await new Promise<void>((resolve) => writeSettledWaiters.add(resolve));
      }
    } finally {
      scriptWritesStored.delete(stored);
    }
  }
  const canClearScriptStorage = computed(
    () =>
      scriptStorage !== undefined &&
      storedEntries.value !== null &&
      !clearing.value &&
      !importing.value &&
      !beginning.value &&
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
      retireRewind("clear");
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
   *
   * The import is a persistence operation of this page (`persistence-ownership.ts`): this page's own writes and effects
   * go through its ownership, which a move of the page retires, so a stale import shows and says nothing. Another
   * script's saved data are the player's confirmed writes for a script this page does not show: no state of this page
   * retires them, and they finish (`importOtherScript`).
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
    const releaseImporting = holdImporting();
    // Start keeps saying why the kept session cannot continue while a failed import leaves that session.
    let outdated = ownChosen ? activation.value?.outdated : undefined;
    // Debug's rewind could restore this script's earlier saved data over the import, so its history ends too, and so
    // does an inspected state, also one that ended.
    if (ownChosen) {
      if (sessionInProgress.value || inspecting.value) endSession();
      retireRewind("import");
    }
    // Then the import is a preparation of its own: a Continue or Start still being prepared for the script would offer
    // what it replaces. It takes its number after the session it ends, which takes one itself.
    const ctx = persistenceOwnership(ownChosen ? nextPreparation() : null);
    const failed: string[] = [];
    const importScripts = async (): Promise<void> => {
      // A session being kept is kept before the import discards it.
      if (ownChosen) while (keeping !== null) await keeping;
      for (const script of review.bundle.scripts) {
        if (!chosen.has(script.scope)) continue;
        try {
          if (script.scope !== scriptStorage?.scope) {
            await importOtherScript(script, review.images);
            continue;
          }
          // Without durable captured media, imported photos would not outlive this page.
          if (capturedMediaPersistence === undefined && usesImages(script))
            throw new CapturedMediaNotStoredError("This Player cannot keep saved photos.");
          // The script's next session loads the imported values: its kept session, with its older view, goes first,
          // and a script whose kept session stays keeps its saved data.
          await ctx.kept(keptSessions).discard(script.scope);
          outdated = undefined;
          if (inDebugRoom) await replaceOwnInDebugRoom(ctx, script, review.images);
          else await replaceScript(operationStorage(ctx), capturedMedia, script, review.images);
        } catch (error) {
          // This page's write was refused: the page moved on, and the import goes on with the other scripts.
          if (error instanceof StaleOperation) continue;
          failed.push(
            `${script.name ?? script.scope} (${error instanceof CapturedMediaNotStoredError ? "its photos could not be stored" : "it could not be saved, for example because storage is full"})`,
          );
        }
      }
    };
    // An error no step expects is thrown once the import is done, as before.
    const unexpected = await importScripts().then(
      () => null,
      (error: unknown) => ({ error }),
    );
    // This page's end of the import, while it owns the page: the saved values it stored, then Start. `ranToEnd` says
    // whether that end ran whole, or, with no end of this page's, whether the page still owns the import.
    const ranToEnd = ownChosen
      ? await owned(ctx, async () => {
          ctx.check();
          const stored = await readScriptStorage(operationStorage(ctx), ctx);
          ctx.commit(() => applyScriptStorage(stored));
          releaseImporting();
          ctx.commit(() => {
            if (lastStart.value !== null && !sessionInProgress.value)
              prepareStart(lastStart.value, outdated);
          });
        })
      : ctx.current();
    pendingOwnerships.delete(ctx);
    releaseImporting();
    if (unexpected !== null) throw unexpected.error;
    // A stale import says nothing: the page moved on.
    if (failed.length > 0 && ranToEnd)
      throw new StorageTransferError(
        `Not imported, and their saved data is unchanged: ${failed.join("; ")}. Any other chosen script was imported.`,
      );
  }
  /** Replaces the script's own saved data while the debug room is shown, for the persistence operation `ctx`. */
  async function replaceOwnInDebugRoom(
    ctx: PersistenceOwnership,
    script: StorageBundleScript,
    images: readonly CheckedTransferImage[],
  ): Promise<void> {
    const media = ownStoredMedia(script.scope);
    const storage = withCapturedMedia(options.scriptStorage!, media);
    try {
      await replaceScript(storage.forOperation(ctx), media, script, images);
    } finally {
      await storage.drain();
      media.close();
    }
  }
  /**
   * Imports another script's saved data, which this page does not show: its kept session goes first, then its values,
   * with their photos. These are the player's confirmed writes; no state of this page retires them.
   */
  async function importOtherScript(
    script: StorageBundleScript,
    images: readonly CheckedTransferImage[],
  ): Promise<void> {
    await keptSessions.discard(script.scope);
    const { storage, media } = options.savedData!.persistence(script.scope);
    try {
      await replaceScript(storage, media, script, images);
    } finally {
      await storage.close();
      media.close();
    }
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
    reportedMedia = new Set();
    // The inspection is the rewind owner's: a rewind's own show decided it, and any other is a new session's.
    device.reset();
    loads.clear();
    pendingLoadCount.value = 0;
    generation.value++;
    interactionReset.value++;
    jumpedRevision.value = -1;
    // An inspected state takes Debug's random control only once input adopts it (`adoptInspected` below).
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
  // The host's token of the script's plan, which a kept session runs.
  let scriptPlan: string | null = null;
  // What is kept of the shown session, so that keeping it again adds only the events after it: whether the plan is kept,
  // and how many events, the last of which is `last`. A new session starts with none.
  let kept: {
    readonly plan: boolean;
    readonly count: number;
    readonly last: InterpreterEvent | null;
  } = { plan: false, count: 0, last: null };
  let keeping: Promise<void> | null = null;
  let keepAgain = false;
  // How long the host holds the JSON of the script's plan, which a new session's first save stores and a Continue
  // compares: for the current plan while this page is open; the host writes it in a task of its own before Start
  // (#1707), and every reader borrows it (`plan-json-lease.ts`). Only `settlePlanJson` changes it.
  let planJsonLease: PlanJsonLease = EMPTY_PLAN_JSON_LEASE;
  // Each different plan the page prepares begins a tenure: what an operation of an earlier one finds no longer goes on.
  let planTenure = 0;
  /**
   * One persistence operation's ownership (keep, the kept session's restore, an import): the room, store, plan tenure
   * and, where it has one, the preparation it began in. `current` is the one rule for every such operation: once the page
   * closes, switches room or store, prepares another plan, or (with a preparation) a newer preparation begins, the
   * operation is stale for good. A stale operation issues nothing more: it reaches its stores and the host only through
   * the ownership's handles, which admit no call once it is stale, and applies every page effect synchronously through
   * `commit`.
   */
  function persistenceOwnership(owner: number | null = null): PersistenceOwnership {
    const inRoom = room.value;
    const store = keptStore();
    const tenure = planTenure;
    const ownership = ownershipOf(
      () =>
        !disposed &&
        room.value === inRoom &&
        keptStore() === store &&
        planTenure === tenure &&
        (owner === null || owner === preparation),
    );
    pendingOwnerships.add(ownership);
    return ownership;
  }
  // The operation that set `importing` last, which alone clears it: a stale one never clears a newer one's.
  let importingHolder: object | null = null;
  /** Marks saved data as changing for the caller; the returned function clears the mark unless another took it. */
  function holdImporting(): () => void {
    const holder = {};
    importingHolder = holder;
    importing.value = true;
    return () => {
      if (importingHolder !== holder) return;
      importingHolder = null;
      importing.value = false;
    };
  }
  /** A fallback for a failed store call of a persistence operation, unless its handle refused the call as stale. */
  function rejectedUnlessStale<T>(fallback: T): (error: unknown) => T {
    return (error) => {
      if (error instanceof StaleOperation) throw error;
      return fallback;
    };
  }
  /**
   * Runs `operation` of `ownership`, which ends without effect where its ownership went stale; resolves to whether it ran
   * to its end.
   */
  async function owned(
    ownership: PersistenceOwnership,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    try {
      await operation();
      return true;
    } catch (error) {
      if (!(error instanceof StaleOperation)) throw error;
      return false;
    } finally {
      pendingOwnerships.delete(ownership);
    }
  }
  /** Settles `event` in the lease and posts the host messages it implies, on the connection the page has. */
  function settlePlanJson(event: PlanJsonEvent): void {
    const settled = settle(planJsonLease, event);
    if (settled.lease.current !== planJsonLease.current) planTenure += 1;
    planJsonLease = settled.lease;
    retireStaleOperations();
    for (const message of settled.messages) {
      const op = message.kind === "write" ? "preparePlanText" : "releasePlanText";
      void bridge?.client.request(op, { plan: message.plan }).catch(() => {});
    }
  }
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
      // The caller finishes first, such as a Continue that shows the session it keeps.
      await Promise.resolve();
      try {
        do {
          keepAgain = false;
          await keepOnce();
        } while (keepAgain && !disposed);
      } finally {
        // In the same step as the last check, so a request after it starts a new write instead of being lost.
        keeping = null;
      }
    })();
  }
  async function keepOnce() {
    const current = session.value;
    // Only a script a host prepared with `prepareScript` keeps its session.
    if (keptScope === null || scriptPlan === null || current === null || disposed) return;
    if (inspecting.value || activation.value !== null) return;
    // The session is kept in the room and store it plays in now, of the plan tenure now.
    const ctx = persistenceOwnership();
    await owned(ctx, () => keepIn(ctx, current, keptScope!));
  }
  async function keepIn(ctx: PersistenceOwnership, current: PlayerSession, scope: string) {
    // The session's events: its store's, which a capture's events end in.
    const events = current.events;
    const from =
      kept.count <= events.length && (kept.count === 0 || events[kept.count - 1] === kept.last)
        ? kept.count
        : 0;
    const withPlan = !(kept.plan && from > 0);
    const inDebugRoom = room.value === "debug";
    const store = ctx.kept(keptStore());
    // The state the host holds now, after the session's earlier requests, and for a first save the plan's JSON, which
    // the host holds for the page (`plan-json-lease.ts`); later operations change the session.
    let capture: KeepCapture;
    try {
      capture = await ctx.admit(() =>
        bridgeOf(current).read(current, "captureKeep", {
          plan: withPlan ? current.planToken : null,
        }),
      );
    } catch (error) {
      // A request the Worker's loss ended keeps the point kept before.
      if (endsQuietly(error)) return;
      ctx.check();
      await forgetKeptSession(current, ctx);
      return;
    }
    ctx.check();
    // The host no longer holds the session: the point kept before stays.
    if (capture.kind === "gone") return;
    if (capture.kind === "unkeepable") {
      // A state this browser cannot write, such as one holding a list too long to save, cannot be kept, and the point kept
      // before must not stand in for it: a reload would go on from an earlier state as if it were this one.
      await forgetKeptSession(current, ctx);
      return;
    }
    const { snapshotJson, planJson } = capture;
    const count = capture.eventsThrough;
    if (count > events.length || (withPlan && planJson === null)) return;
    const added = events.slice(from, count);
    const last = events[count - 1] ?? null;
    const marks = { editedWhileDebugging: debugEdits.value, rewoundWhileDebugging: rewound.value };
    // Written once, for the photos they show and for the store.
    const eventsJson = added.map(serializeValidatedRuntimeJson);
    const references = capturedMediaReferencesIn(snapshotJson, eventsJson);
    // The room's saved data are in use once storage reached it.
    await storageRoute;
    ctx.check();
    try {
      // A new session replaces the one kept before.
      if (from === 0) {
        await discardKeptSession(ctx, inDebugRoom);
        if (inDebugRoom) ctx.commit(() => (debugRoom.value = { session: false }));
      }
      ctx.check();
      // The session is kept only with every photo it uses: one that cannot be stored keeps the session kept before.
      if (inDebugRoom) {
        // The debug room stores the session's photos like its saved ones.
        await capturedMedia.promote(references, ctx);
        ctx.check();
      } else {
        // The photos no save stored go with the session, a photo already kept as it is; a stored one stays stored
        // while the session uses it (`capturedMediaStorage`).
        for (const photo of capturedMedia.sessionRecords(references)) {
          await insertOrAcceptExisting(store.media, photo);
          ctx.check();
        }
      }
      await store.publish(scope, {
        planJson: withPlan ? planJson : null,
        snapshotJson,
        eventsFrom: from,
        events: added,
        eventsJson,
        marks,
      });
    } catch (error) {
      if (error instanceof StaleOperation) throw error;
      // The session kept before stays; a reload continues from there.
      return;
    }
    // A publish already under way finishes in its store; a later operation's bookkeeping is its own.
    ctx.commit(() => {
      kept = { plan: true, count, last };
      if (inDebugRoom) debugRoom.value = { session: true };
      notices.dismiss(playerNoticeKeys.sessionNotKept);
    });
  }
  /**
   * Discards the session kept for a reload when its state `current` cannot be kept, so the next state that can be is kept
   * anew; while the session runs or waits, a notice says that a reload would lose it.
   */
  async function forgetKeptSession(current: PlayerSession, ctx: PersistenceOwnership) {
    const inDebugRoom = room.value === "debug";
    ctx.commit(() => (kept = { plan: false, count: 0, last: null }));
    const discarded = await discardKeptSession(ctx, inDebugRoom).then(
      () => true,
      () => false,
    );
    const live = current.state.status === "running" || current.state.status === "waiting";
    ctx.commit(() => {
      if (discarded && inDebugRoom) debugRoom.value = { session: false };
      if (!live) notices.dismiss(playerNoticeKeys.sessionNotKept);
      else if (!notices.list.some((notice) => notice.key === playerNoticeKeys.sessionNotKept))
        notices.publish(playerNotices.sessionNotKept());
    });
  }
  /**
   * Discards the session the room keeps: the normal room's with the photos only it uses, the debug room's alone, since
   * the room's saved data and photos stay, for the persistence operation `ctx`. The caller shows that the debug room
   * keeps no session.
   */
  function discardKeptSession(ctx: PersistenceOwnership, inDebugRoom: boolean): Promise<void> {
    return inDebugRoom
      ? ctx.rooms(debugRooms).discardSession(keptScope!)
      : ctx.kept(keptSessions).discard(keptScope!);
  }
  /**
   * Asks to keep the shown session as it is now and waits until the keep work under way settles. Keeping is best effort:
   * it settles also when the session is not kept, as when it cannot be written, the store refuses it, or the page
   * moved on; nothing here proves that the session was kept.
   */
  async function settleKeepAttempt(): Promise<void> {
    keepSessionLater();
    while (keeping !== null) await keeping;
  }
  // The session is kept at each interaction it newly presents, a lock's dialog or password field too, also when one
  // asks again after a block, and when it ends, and when the page is hidden.
  let keptPresentation: string | null = null;
  watch(session, (current) => {
    if (current === null || inspecting.value) return;
    const foreground = current.state.foregroundAction;
    const presentation =
      foreground?.kind === "lock" && foreground.phase === "ask"
        ? `lock ${foreground.actionId} ${foreground.resumes}`
        : (activePlayerRuntimeInteraction(current.state)?.actionId.toString() ?? null);
    const ended = current.state.status === "halted" || current.state.status === "failed";
    if ((presentation === null || presentation === keptPresentation) && !ended) return;
    keptPresentation = presentation;
    keepSessionLater();
  });
  useEventListener(
    () => (typeof document === "undefined" ? undefined : document),
    "visibilitychange",
    () => {
      if (document.visibilityState !== "hidden") return;
      // Time passed while the page was visible is observed before the keep's capture, which follows it in the session's
      // queue: the session kept is current.
      clock.before("keepCapture");
      keepSessionLater();
    },
  );
  /**
   * Prepares a session of `plan`, which `create` starts: Continue when the script keeps a session that can go on, else
   * Start. Call it instead of `prepare` once the stored values are loaded.
   */
  async function prepareScript(
    plan: string,
    create: PlayerSessionStart,
    sources?: ReadonlyMap<string, string>,
  ): Promise<void> {
    // The host holds the plan, under the token `prepare` gave it.
    // Owned from the call: a later preparation, or a transition that replaces it, while the host gets ready retires it.
    const owner = nextPreparation();
    await bridgeReady;
    if (disposed || owner !== preparation) return;
    // A plan this one replaces needs no JSON any more; this one's is written now, in a task of its own, for the kept
    // session's comparison and a first save to read.
    settlePlanJson({ kind: "replace", plan });
    if (keptScope !== null) settlePlanJson({ kind: "prepare", plan });
    scriptPlan = plan;
    lastStart.value = create;
    if (sources !== undefined) scriptSources = sources;
    await prepareKept(owner);
  }
  /**
   * Shows Continue when the script keeps a session that can go on, else Start, with the reason when a Player update
   * changed the format of the kept session. Only while the preparation `owner` is current: the kept session restored,
   * its photos, and its plan's JSON are installed together, or not at all. Resolves to whether it did.
   */
  async function prepareKept(
    owner = nextPreparation(),
    ctx = persistenceOwnership(owner),
  ): Promise<boolean> {
    // The preparation `owner`, in the room and plan tenure it began in, installs what it found; a stale one, nothing.
    return owned(ctx, async () => {
      ctx.check();
      const plan = scriptPlan;
      const found = plan === null ? {} : await restoreKept(plan, ctx);
      if ("session" in found && !ctx.current()) bridgeOf(found.session).release(found.session);
      ctx.check();
      if ("session" in found) {
        ctx.commit(() => {
          for (const [reference, stored] of found.media)
            capturedMedia.restoreSessionMedia(reference, stored);
          kept = {
            plan: true,
            count: found.session.events.length,
            last: found.session.events.at(-1) ?? null,
          };
          prepareRestore(found.session);
        });
        return;
      }
      ctx.commit(() => {
        // Unless the session goes on, a new session's first save stores the plan's JSON, which the comparison read.
        if (plan !== null) settlePlanJson({ kind: "prepare", plan });
        if (lastStart.value !== null) prepareStart(lastStart.value, found.outdated);
      });
    });
  }
  /**
   * The kept session, restored in the host, when it runs the held plan `plan` and has not ended, with the stored records of
   * the photos only it uses; else, for Start, why the kept session cannot continue when its plan or state is of another
   * revision than this Player's. Nothing of this Player changes yet (`prepareKept`); a session restored but not continued
   * is released in the host.
   */
  async function restoreKept(
    plan: string,
    ctx: PersistenceOwnership,
  ): Promise<
    | {
        readonly session: PlayerSession;
        readonly media: readonly (readonly [string, StoredCapturedMedia | null])[];
      }
    | { readonly outdated?: Problem }
  > {
    if (keptScope === null) return {};
    await storageRoute;
    ctx.check();
    // The normal room's photos come back as session media; the debug room reads its own like its saved ones.
    const normalRoom = keptStore() === keptSessions;
    const bound = ctx.kept(keptStore());
    const stored = await bound.session(keptScope).catch(rejectedUnlessStale(null));
    ctx.check();
    const found = stored === null ? null : keptSession(stored);
    if (found === null) return {};
    // Not for a session that ended, which only its events can show when its state is of another revision: the engine
    // ends a session with an `exit` or `runtimeFailure` event.
    const explain = !found.events.some(
      (event) => event.kind === "exit" || event.kind === "runtimeFailure",
    );
    let restored: PlayerSession | "otherPlan" | "ended";
    try {
      const host = await bridgeReady;
      ctx.check();
      restored = await ctx.admit(() =>
        host.restoreKept(plan, found.planJson, found.snapshotJson, found.events, found.marks),
      );
    } catch (error) {
      if (error instanceof StaleOperation) throw error;
      ctx.check();
      // The runtime's error says how it refuses a state of another revision.
      const revisions = explain
        ? revisionChange(found.snapshotJson, RUNTIME_SNAPSHOT_VERSION)
        : null;
      if (
        revisions === null ||
        !(error instanceof BridgeRequestError) ||
        error.name !== "CheckpointError" ||
        !isCheckpointErrorInfo(error.info)
      )
        return {};
      const { code, path, message } = error.info;
      return { outdated: { code, path, message: `${message} ${revisions}` } };
    }
    if (typeof restored === "object" && !ctx.current()) {
      // A session a stale preparation restored is released; nothing of it is shown.
      bridgeOf(restored).release(restored);
      throw new StaleOperation();
    }
    ctx.check();
    if (restored === "otherPlan") {
      // After a Player update the same script compiles to a plan of another revision; the plan has no runtime error.
      const revisions = explain ? revisionChange(found.planJson, INSTRUCTION_PLAN_VERSION) : null;
      return revisions === null
        ? {}
        : { outdated: { message: `Unsupported instruction-plan revision. ${revisions}` } };
    }
    if (restored === "ended") return {};
    // A session a stale preparation restored is released; nothing of it is shown.
    const session = restored;
    const owns = () => {
      if (ctx.current()) return;
      bridgeOf(session).release(session);
      throw new StaleOperation();
    };
    const media: (readonly [string, StoredCapturedMedia | null])[] = [];
    if (normalRoom)
      for (const reference of capturedMediaReferencesIn(found.snapshotJson, found.events)) {
        media.push([
          reference,
          await bound.media.get(keptScope, reference).catch(rejectedUnlessStale(null)),
        ]);
        owns();
      }
    owns();
    return { session, media };
  }
  /**
   * Returns to the start page once the session ended by `exit`, which the host does when the player closes the end
   * dialog; the ended session is kept first, so a reload starts anew.
   */
  async function toStartPage(): Promise<void> {
    if (session.value?.state.status !== "halted") return;
    await settleKeepAttempt();
    if (disposed || session.value?.state.status !== "halted") return;
    endSession();
    await prepareKept();
  }

  /**
   * The session an export of the session takes (PLAYER-UI "Player Settings"): the shown one while it runs or waits, or the
   * one Continue goes on with; or why there is none. A debug room's session stays in its browser.
   */
  const exportableSession = computed(
    (): { readonly session: PlayerSession } | { readonly unavailable: string } => {
      if (keptScope === null || scriptStorage === undefined)
        return { unavailable: "This Player does not keep sessions." };
      if (room.value === "debug") return { unavailable: "A debug session stays in this browser." };
      if (clearing.value || importing.value)
        return { unavailable: "Not while saved data changes." };
      const pending = activation.value;
      if (pending?.kind === "continue" && pending.restored !== undefined)
        return { session: pending.restored };
      if (liveSession() && !inspecting.value) return { session: session.value! };
      return { unavailable: "Available while a session runs or waits for Continue." };
    },
  );
  /**
   * The session for an export, as it is now: its checkpoint and events, the script's saved values read after the saves it
   * issued, and every photo, recording, or file they use that this browser holds. Rejects with a `StorageTransferError`
   * saying why it cannot be exported.
   */
  async function exportSession(): Promise<SessionExport> {
    const found = exportableSession.value;
    if ("unavailable" in found) throw new StorageTransferError(found.unavailable);
    let restorePoint: PlayerRuntimeRestorePoint;
    try {
      const capture = await bridgeOf(found.session).read(found.session, "captureCheckpoint");
      restorePoint = Object.freeze({
        checkpointJson: capture.checkpointJson,
        events: Object.freeze(found.session.events.slice(0, capture.eventsThrough)),
      });
    } catch {
      throw new StorageTransferError(
        "This browser cannot keep the session as it is now, so it cannot be exported. Play on and try again later.",
      );
    }
    let entries: readonly RuntimeScriptStorageEntrySnapshot[];
    try {
      // Issued at once, so storage reads it after the saves the session issued until its state was taken.
      entries = await scriptStorage!.load();
    } catch {
      throw new StorageTransferError(
        "This browser's saved data cannot be read, so the session cannot be exported.",
      );
    }
    const references = capturedMediaReferencesIn(restorePoint.checkpointJson, restorePoint.events);
    for (const entry of entries)
      for (const reference of storedValueReferences([entry])) references.add(reference);
    const media: SessionTransferMedium[] = [];
    let missing = 0;
    for (const reference of references) {
      const record = await capturedMedia.read(reference);
      if (record === null) missing += 1;
      else media.push(await sessionTransferMedium(record));
    }
    return {
      transfer: {
        scope: keptScope!,
        name: options.savedData?.name(keptScope!) ?? null,
        session: restorePoint,
        entries,
        media,
      },
      missing,
    };
  }
  /**
   * Checks an exported session for an import into the script this Player shows, all of it; nothing changes yet. Rejects
   * with a `StorageTransferError` saying why it cannot continue here.
   */
  async function reviewSessionImport(transfer: SessionTransferRead): Promise<SessionImportReview> {
    try {
      return await reviewedImport(transfer);
    } catch (error) {
      // A session that cannot be imported here holds nothing in the host any more.
      discardSessionReview(transfer);
      throw error;
    }
  }
  async function reviewedImport(transfer: SessionTransferRead): Promise<SessionImportReview> {
    if (room.value === "debug")
      throw new StorageTransferError(
        "A session cannot be imported into the debug room. Open this script outside the debug room and import it there.",
      );
    if (keptScope === null || scriptPlan === null || scriptStorage === undefined)
      throw new StorageTransferError(
        "This Player does not keep sessions, so it cannot import one.",
      );
    // Restored in the host against the held plan, as Continue would find it after a reload; its state stays there.
    const host = await bridgeReady;
    await asTransferError(
      host.client.request("reviewTransfer", {
        ticket: transfer.ticket,
        scope: keptScope,
        plan: scriptPlan,
      }),
    );
    const saved = new Set(storedValueReferences(transfer.entries));
    // Without durable captured media, a saved value's photo would not outlive this page.
    if (
      capturedMediaPersistence === undefined &&
      transfer.media.some((medium) => saved.has(medium.reference))
    )
      throw new StorageTransferError(
        "This Player cannot keep saved photos or files, so it cannot import this session.",
      );
    // A reference this browser already holds keeps its record, which must be the same, so no reference silently names
    // other media.
    for (const [index, medium] of transfer.media.entries()) {
      const held = await capturedMedia.read(medium.reference);
      if (held !== null && !(await sameMedium(held, medium)))
        throw new StorageTransferError(
          `This browser keeps another photo or file under the reference of photo or file ${index + 1}, so this session cannot be imported.`,
        );
    }
    let current: readonly RuntimeScriptStorageEntrySnapshot[];
    try {
      current = await scriptStorage.load();
    } catch {
      throw new StorageTransferError(
        "This browser's saved data cannot be read, so nothing can be imported.",
      );
    }
    return {
      transfer,
      name: transfer.name ?? options.savedData?.name(keptScope) ?? null,
      currentValues: current.length,
    };
  }
  /**
   * Reads an exported file's bytes or a pasted text of saved data or a session, in the host: saved data whole, a session
   * for `reviewSessionImport`. Rejects with a `StorageTransferError` saying why it cannot be read.
   */
  async function readTransfer(
    input: { readonly bytes: Uint8Array<ArrayBuffer> } | { readonly text: string },
  ): Promise<PlayerTransferRead> {
    const host = await bridgeReady;
    // EVIDENCE: validation: `readTransfer` replies from the same build with what it read.
    return (await asTransferError(host.client.request("readTransfer", input)))
      .result as PlayerTransferRead;
  }
  /** The tickets of the session imports under way, which `discardSessionReview` refuses. */
  const importedTickets = new Set<string>();
  /**
   * Lets go of a session read for an import that will not be imported: cancelled, replaced, or refused. Throws for one
   * whose import runs: that import still needs it, and lets the dialog go of it once it settles.
   */
  function discardSessionReview(transfer: SessionTransferRead): void {
    if (importedTickets.has(transfer.ticket))
      throw new Error(
        "A review being imported cannot be discarded: its import still needs the session read for it.",
      );
    void bridge?.client.request("releaseTransfer", { ticket: transfer.ticket }).catch(() => {});
  }
  /**
   * Imports a reviewed session. A session of this script in progress ends first; the session's saved values replace the
   * script's at once, their photos and files stored first; then the session becomes the one this browser keeps for the
   * script, with the photos and files only it uses, and Continue is offered. Rejects with a `StorageTransferError` saying
   * what was imported when this browser could not store it.
   */
  async function importSession(review: SessionImportReview): Promise<void> {
    if (
      importing.value ||
      clearing.value ||
      room.value === "debug" ||
      keptScope === null ||
      scriptPlan === null ||
      scriptStorage === undefined
    )
      throw new StorageTransferError(
        "A session cannot be imported right now. Try again in a moment.",
      );
    const { transfer } = review;
    const scope = keptScope;
    const plan = scriptPlan;
    const releaseImporting = holdImporting();
    // A session of this script in progress ends first; Debug's rewind could restore this script's earlier saved data
    // over the import, so its history ends.
    if (sessionInProgress.value || inspecting.value) endSession();
    retireRewind("import");
    // The import is then a preparation of its own: a Continue or Start still being prepared would offer what it
    // replaces. It owns that preparation, in this room and plan tenure; once either moves on, it issues nothing more.
    const owner = nextPreparation();
    const ctx = persistenceOwnership(owner);
    // The saved values in use and the kept sessions, through the import's handles. The values the import stored are
    // shown by its final read, while it owns the page.
    const storage = operationStorage(ctx);
    const sessions = ctx.kept(keptSessions);
    let failure: string | null = null;
    let ranToEnd = false;
    importedTickets.add(transfer.ticket);
    try {
      ranToEnd = await owned(ctx, async () => {
        const replaceSession = async (): Promise<void> => {
          // A session being kept is kept before the import replaces it.
          while (keeping !== null) await keeping;
          ctx.check();
          // Each photo and file is held under the reference the session and the values hold, as a restored kept
          // session's are; a value's is stored when the values are. One held already is the same (`reviewSessionImport`).
          const added = transfer.media.filter((medium) => !capturedMedia.knows(medium.reference));
          ctx.commit(() => {
            for (const medium of added)
              capturedMedia.restoreSessionMedia(
                medium.reference,
                sessionMediumRecord(medium, scope),
              );
          });
          try {
            await storage.replace(transfer.entries);
          } catch {
            ctx.commit(() => {
              for (const medium of added) capturedMedia.discard(medium.reference);
            });
            failure =
              "Nothing was imported: this browser could not save the session's data, for example because storage is full.";
            return;
          }
          ctx.check();
          let discarded = false;
          try {
            ctx.commit(() => (kept = { plan: false, count: 0, last: null }));
            await sessions.discard(scope);
            discarded = true;
            ctx.check();
            // The state as the kept session stores it, and its events as the engine writes them, from the host.
            const host = await bridgeReady;
            ctx.check();
            const committed = (
              await ctx.admit(() =>
                host.client.request("transferCommit", { ticket: transfer.ticket }),
              )
            ).result;
            ctx.check();
            // EVIDENCE: validation: `transferCommit` replies from the same build with the reviewed state and events.
            const { snapshotJson, eventsJson } = committed as {
              readonly snapshotJson: string;
              readonly eventsJson: readonly string[];
            };
            const references = capturedMediaReferencesIn(snapshotJson, eventsJson);
            // Unlike keeping a session as it plays, every photo goes into a store the discard emptied, so a failure is
            // real: the session is not kept without the media it uses.
            for (const photo of capturedMedia.sessionRecords(references)) {
              await sessions.media.add(photo);
              ctx.check();
            }
            // The plan's JSON, which the host holds for the page (`plan-json-lease.ts`).
            ctx.commit(() => settlePlanJson({ kind: "prepare", plan }));
            const planJson = (await ctx.admit(() => host.client.request("planText", { plan })))
              .result;
            ctx.check();
            if (typeof planJson !== "string") throw new Error("The host wrote no plan JSON.");
            await sessions.publish(scope, {
              planJson,
              snapshotJson,
              eventsFrom: 0,
              events: transfer.events,
              eventsJson,
              marks: { editedWhileDebugging: null, rewoundWhileDebugging: null },
            });
          } catch (error) {
            if (error instanceof StaleOperation) throw error;
            failure = discarded
              ? "The session's saved data was imported, but this browser could not keep the session, for example because storage is full. Start begins a new session with that data."
              : "The session's saved data was imported, but this browser could not replace the session it kept for this script. Continue, if offered, goes on with that earlier session.";
          }
        };
        // An error no step expects is thrown once the import prepared, as a stale end is at once.
        const unexpected = await replaceSession().then(
          () => null,
          (error: unknown) => (error instanceof StaleOperation ? Promise.reject(error) : { error }),
        );
        // The import's own preparation, while it owns the page: the saved values it stored, and its Start or Continue.
        ctx.check();
        const stored = await readScriptStorage(operationStorage(ctx), ctx);
        ctx.commit(() => applyScriptStorage(stored));
        if (!(await prepareKept(owner, ctx))) throw new StaleOperation();
        if (unexpected !== null) throw unexpected.error;
      });
    } finally {
      importedTickets.delete(transfer.ticket);
      releaseImporting();
    }
    // A stale import says nothing: the page moved on.
    if (failure !== null && ranToEnd) throw new StorageTransferError(failure);
  }

  /**
   * Turns Debug on or off for the script. On in the normal room, play goes on in the debug room (`copyToDebugRoom`). Off,
   * play goes on where it is. A running session reads the change from its next statement on.
   */
  function setDebugMode(enabled: boolean) {
    if (enabled === debugMode) return;
    // A catch-up under way finishes first, as one observation, so the change comes no earlier than without it.
    clock.before("debugMode");
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
      stopped.value ||
      activation.value !== null ||
      (current.state.status !== "running" && current.state.status !== "waiting")
    )
      return;
    // What the host will hold once the requests sent settle: the last one asked of this session, else what shows.
    const held =
      debugModeAsked?.lineage === current.lineage ? debugModeAsked.on : current.state.debugMode;
    if (held === debugMode) return;
    const on = debugMode;
    const asked = { lineage: current.lineage, on };
    debugModeAsked = asked;
    // In the host (`setDebugMode`); the session shows the change while it still owns the UI.
    void bridgeOf(current)
      .request<{ readonly kind: string }>(
        current,
        "setDebugMode",
        { on },
        { publish: (next) => void publishOwned(next) },
      )
      .finally(() => {
        if (debugModeAsked === asked) debugModeAsked = null;
      })
      .then(
        (outcome) => {
          if (outcome.kind === "set" && session.value?.lineage === current.lineage)
            keepSessionLater();
        },
        (error: unknown) => {
          if (endsQuietly(error)) return;
          if (!disposed && !stopped.value && session.value?.lineage === current.lineage)
            reportHostError(error);
        },
      );
  }
  /**
   * Gives this Player's sessions Debug's random control from their next op on: the sites set to go on by themselves,
   * or `null` for none. Without one, a draw the session is paused at goes on naturally.
   */
  function setRandomControl(
    control: { readonly sites: readonly (readonly [string, RandomNext])[] } | null,
  ) {
    if (disposed) return;
    // A catch-up under way finishes first, as one observation, with the draws it started with. The change follows the
    // shown session's queue whether or not that observation succeeds.
    clock.before("randomControl");
    const current = session.value;
    // Off while nothing is on and no reset is asked: the host has nothing to change.
    const changed = control !== null || desiredRandom !== null || resetRequested;
    desiredRandom = control;
    if (changed) pendingRandom = true;
    if (bridge !== null) flushRandom(bridge, current);
    if (control === null && current?.state.randomDraw != null)
      void resolveRandomDraw(current.state.randomDraw.drawId, "natural");
  }
  /** Ends Debug's random control and forgets what each site took, as when the Debug features end. */
  function forgetRandomHistory() {
    // A history needs forgetting only once the host may hold one.
    if (lastRandom !== undefined || pendingRandom) resetRequested = true;
    setRandomControl(null);
  }
  // A session that runs again while paused at a draw nobody decides any more, such as a restored state adopted after
  // Debug's control ended, goes on naturally.
  function settleUncontrolledDraw() {
    const draw = session.value?.state.randomDraw;
    if (desiredRandom === null && draw != null) void resolveRandomDraw(draw.drawId, "natural");
  }
  /**
   * Resolves the random draw the session is paused at, naturally, with a chosen outcome, or with its site's least-tried
   * one, in the host; with `record`, the outcome goes into the site's history. The session's clock goes on from the
   * time it paused at. `null` when the session is not paused at that draw or no longer owns the UI.
   */
  function resolveRandomDraw(
    drawId: number,
    outcome: DrawResolution,
    record = false,
  ): Promise<ResolveDrawResult["outcome"] | null> {
    if (inspecting.value) return Promise.resolve(null);
    // Which reset the record belongs to, as it was asked: one asked for since enters nothing.
    const recorded = record ? { resetAt: lastRandom?.resetAt ?? 0 } : null;
    return ownedSection(session.value, "observeInput", async (section, owned, observe) => {
      // Paused at the draw, the session observes no time; a stopped session gives none.
      const current = await observe();
      if (current === null || inspecting.value || current.state.randomDraw?.drawId !== drawId)
        return null;
      const result = await section.send<ResolveDrawResult>("resolveDraw", {
        drawId,
        outcome,
        record: recorded,
      });
      if (!disposed) randomRevision.value = result.revision;
      if (!owned() || publishOwned(section.session) === null) return null;
      clock.rebase();
      return result.outcome;
    }).catch((error: unknown) => {
      if (!endsQuietly(error) && refusalCode(error) === null && !disposed) reportHostError(error);
      return null;
    });
  }
  /** What `site` took, for the picker, from the host's history of the shown session's Player; `null` without one. */
  function randomTried(site: string): Promise<RandomTriedView> {
    const shown = session.value;
    if (shown === null) return Promise.resolve(null);
    return bridgeOf(shown)
      .read(shown, "randomTried", { site })
      .catch(() => null);
  }
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
        if (normalStorage === undefined || room.value !== "normal" || !debugMode || disposed)
          return;
        const scope = normalStorage.scope;
        const live = sessionLive.value;
        // The normal room keeps its session as it is now, which a later visit continues; one that ended is kept as it
        // ended, by the keep still under way.
        if (live) await settleKeepAttempt();
        else while (keeping !== null) await keeping;
        const making = live || debugRoom.value === null;
        const replacing = live && debugRoom.value !== null;
        // A Continue or Start still being prepared is the normal room's.
        nextPreparation();
        room.value = "debug";
        kept = { plan: false, count: 0, last: null };
        keptPresentation = null;
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
        releaseImporting();
      }
    });
    return roomChange;
  }
  /**
   * Stores a new debug room with a copy of the script's own saved values and photos as they are now, or none when
   * `empty`. Resolves to the references of the photos it copied, none when the room could not be created as a copy: the
   * Player then holds those photos itself.
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
    const all = () => new Set(photos.map((photo) => photo.reference));
    // The photos the room holds as copied, only once a creation that copied them succeeded.
    let copied: ReadonlySet<string> = new Set();
    try {
      await debugRooms.create(scope, entries, photos);
      copied = all();
    } catch {
      // Another tab created it meanwhile, or this browser cannot keep it: then it lives in this page.
      if ((await debugRooms.read(scope).catch(() => null)) === null) {
        debugRooms = memoryKeptRoomStore();
        retireStaleOperations();
        copied = await debugRooms
          .create(scope, entries, photos)
          .then(all, () => debugRooms.create(scope, [], []).then(() => new Set<string>()));
      }
    }
    // A photo the room did not take is held here, so a keep or save that uses it stores it in the room.
    for (const photo of photos)
      if (!copied.has(photo.reference)) capturedMedia.restoreSessionMedia(photo.reference, photo);
    return copied;
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
      const releaseImporting = holdImporting();
      try {
        while (keeping !== null) await keeping;
        endSession();
        kept = { plan: false, count: 0, last: null };
        keptPresentation = null;
        if (clear === "reset")
          await switchStorage(async () => {
            await debugRooms.discard(scope).catch(() => {});
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
  /**
   * Readies the session for input before the input is evaluated: an inspected state Debug's rewind restored is adopted
   * first. `true` when input may go ahead at once, else whether it may once the state is adopted; a state that could
   * not be adopted, or one being adopted for other input, takes none, and stays as it was.
   */
  function prepareInput(): true | Promise<boolean> {
    return inspecting.value ? adoptRewound() : true;
  }

  /**
   * Readies the page for a rewind step's commit or a reinstatement, which begins the host's recording anew: after a
   * Player error, the recording up to the error is kept for the debug export first. Its callers await what it returns.
   */
  /**
   * Decides a debug export's capture in its reply's hook (`captureExport`): it is the candidate only while the dialog
   * wants it, no stop is under way here, and it matches what shows. For a session: the shown lineage, and the store
   * view's revision, event boundary and diagnostic identity; for none: the same run, and still no session. Events and
   * transcript come from that store view, marks and incident only from the capture. Otherwise its ticket is released.
   */
  function deliverExport(
    host: PlayerBridge,
    current: PlayerSession | null,
    reply: ExportCaptureReply,
    view: PlayerSession | null,
    details: (shown: PlayerSession | null) => Pick<DebugExportCandidate, "player" | "host">,
    live: () => boolean,
  ): Omit<DebugExportCandidate, "photos"> | typeof PENDING_CAPTURE | null {
    if (reply.kind === "pending") return PENDING_CAPTURE;
    if (reply.kind !== "captured") return null;
    const release = () => void host.releaseRecording(reply.ticket).catch(() => {});
    const { identity } = reply;
    const matches =
      current === null
        ? session.value === null && identity.run === run
        : view !== null &&
          session.value?.lineage === current.lineage &&
          view.revision === identity.revision &&
          view.events.length === identity.eventsThrough &&
          view.diagnostic.run === identity.run &&
          view.diagnostic.stop === identity.stop;
    if (!live() || halting.value || !matches) {
      release();
      return null;
    }
    return {
      build: playerBuildIdentity,
      package: options.debugPackage ?? { id: null, version: null },
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
      ...details(view),
    };
  }
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
  function beforeRewindRestart(): void | Promise<void> {
    // The recording up to a Player error is captured before the host begins the recorder anew.
    return failureRecording.beforeRestart();
  }
  /**
   * Shows a session Debug's rewind restored or reinstated in the host (DEBUGGER.md "Rewind"), with its marks, as a new
   * generation of the session: paused for inspection, or running, as the session Back left when Return reinstates it.
   * The host began its recording anew at it.
   */
  function showRewound(next: PlayerSession, { paused }: { readonly paused: boolean }) {
    // An unmounted Player publishes nothing.
    if (disposed) return;
    showSession(next, { paused });
    rewoundGeneration = generation.value;
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
      !beginning.value &&
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
  // A new session, a Start's or a Continue's, gets a history of its own; a session the rewind shows is none.
  watch(generation, () => rewindOwner.showing || rewindOwner.newSession(), { flush: "sync" });
  watch(session, (next) => rewindOwner.follow(next), { flush: "sync" });
  tryOnScopeDispose(() => rewindOwner.disposal());

  /**
   * Adopts the inspected state as the session: the saved data are replaced by the state's own, as one validated
   * replacement that also keeps the photos they use, and the state runs from then on, saving as any session. When the
   * saved data cannot be replaced, the state stays inspected and nothing changes. Resolves to whether it was adopted.
   */
  function adoptRewound(): Promise<boolean> {
    // A stopped session is not adopted: its saved data are not replaced either.
    if (stopped.value || !inspecting.value || rewindWork.value !== null || session.value === null)
      return Promise.resolve(false);
    adoption = adoptShown(session.value).finally(() => (adoption = null));
    return adoption;
  }
  /**
   * Whether the adoption that began in generation `owner` on the shown session `shown` still owns the page: it is mounted,
   * no Start or rewind replaced the session, the state is still inspected and not stopped, and the shown session is
   * `shown`'s, at `capture`'s revision when there is one.
   */
  function ownsShown(
    owner: number,
    shown: PlayerSession,
    capture?: { readonly revision: number },
  ): boolean {
    return (
      !disposed &&
      generation.value === owner &&
      inspecting.value &&
      !stopped.value &&
      session.value?.lineage === shown.lineage &&
      (capture === undefined ||
        (session.value.revision === capture.revision && shown.revision === capture.revision))
    );
  }
  /**
   * Settles an adoption's read: when the adoption no longer owns the page, nothing is written and nothing is said,
   * however the read settled. Owning it, a failed read says so; a capture writes its saved values. Resolves to whether
   * they were written (or needed none).
   */
  async function settleAdoption(
    owner: number,
    shown: PlayerSession,
    outcome: { readonly capture: StorageCapture } | { readonly error: unknown },
  ): Promise<boolean> {
    if (!ownsShown(owner, shown, "capture" in outcome ? outcome.capture : undefined)) return false;
    if (!("capture" in outcome)) {
      notices.publish(playerNotices.rewindNotAdopted());
      return false;
    }
    try {
      if (scriptStorage && outcome.capture.persistent)
        await scriptStorage.replace(outcome.capture.entries);
      return true;
    } catch {
      if (ownsShown(owner, shown)) notices.publish(playerNotices.rewindNotAdopted());
      return false;
    }
  }
  async function adoptShown(shown: PlayerSession): Promise<boolean> {
    const owner = generation.value;
    // The history's adoption begins before the read, as requests to the host keep their order, and ends once settled.
    // Refused, nothing is read, written or adopted.
    if (!rewindOwner.adoptionBegun()) return false;
    rewindWork.value = "adopt";
    let written = false;
    let accepted = false;
    try {
      // The adopted state's saved values, read in the host while the adoption holds the rewind's work; each way the
      // read settles goes through `settleAdoption`, which first asks whether the adoption still owns the page.
      written = await bridgeOf(shown)
        .read(shown, "captureStorage")
        .then(
          (capture) => settleAdoption(owner, shown, { capture }),
          (error: unknown) => settleAdoption(owner, shown, { error }),
        );
    } finally {
      rewindWork.value = null;
      // Turning the value trace on or off rewraps the shown session; only a rewind or a new session replaces it.
      written &&= ownsShown(owner, shown);
      // The completion is the page's only while the owner accepts it: a write that finished after a new session or a
      // seal activates nothing.
      accepted = rewindOwner.adoptionSettled(written);
    }
    if (!written || !accepted) return false;
    notices.dismiss(playerNoticeKeys.rewindNotAdopted);
    savedDataRevision.value++;
    clock.rebase();
    applyDebugMode();
    if (session.value !== null) adoptRandom(session.value);
    settleUncontrolledDraw();
    return true;
  }
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
    await inputSection(async (section) => {
      if ((await section.observe()) === null) return;
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
      begin: () => startedSession(create, { debugMode }),
      ...(outdated === undefined ? {} : { outdated }),
    };
    prepareActivation("start");
  }
  /**
   * Prepares in a task of its own what the activation would otherwise compute within the click (#1707): the zone the
   * browser's settings name, which Start and Continue still capture anew, and a Start's plan JSON for its first save.
   */
  function prepareActivation(kind: Activation["kind"]) {
    if (kind === "start" && keptScope !== null && scriptPlan !== null)
      settlePlanJson({ kind: "prepare", plan: scriptPlan });
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
      begin: async () => {
        const host = bridgeOf(restored);
        continuing = restored;
        // A restored session runs without Debug's random control until its kept draw went on naturally, as before: one
        // a Start or an adoption gave this Player's control first gives it up (`adoptRandom` below takes it again).
        if (lastRandom !== undefined)
          void host.client
            .request("releaseRandom", { session: restored.id }, { after: restored.id })
            .catch(() => {});
        // Only the activation that began it goes on after each reply: a replaced one touches no trace or recorder.
        const owner = activationToken;
        const owned = () => {
          if (disposed || owner !== activationToken)
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
        await host.request(restored, "beginRecording", null);
        owned();
        const tracing = tracingIntent();
        if (tracing?.on)
          void host.request(restored, "restartTrace", { tracing }).catch((error: unknown) => {
            if (!endsQuietly(error) && !disposed && !stopped.value) reportHostError(error);
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
        if (continued.state.debugMode !== debugMode) {
          await host.request(continued, "setDebugMode", { on: debugMode });
          owned();
          continued = host.latest(continued) ?? continued;
        }
        adoptRandom(continued);
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
      );
    const startOptions = { ...create.options(), debugMode: recording.debugMode };
    return host.start(create.plan, startOptions, true, random);
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
    failureRecording.retire();
    beginRun(bridge);
    let begun: PlayerSession | Promise<PlayerSession>;
    // `begin` records the click's capture: it reads it before its first await, a Start in its factory or options.
    clicked = sample;
    try {
      begun = pending.begin();
    } catch (error) {
      reportHostError(error);
      return;
    } finally {
      clicked = null;
    }
    if (!(begun instanceof Promise)) return started(pending, begun);
    sessionBeginning = begun;
    const settled = begun.then(
      (next) => {
        if (!disposed && token === activationToken) started(pending, next);
      },
      (error: unknown) => {
        // An obsolete activation's failure stops nothing: the session that replaced it goes on.
        if (!disposed && token === activationToken) reportHostError(error);
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
      kept = { plan: false, count: 0, last: null };
      keptPresentation = null;
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
     * The current or last session's recorded engine calls for a debug export, after a Player error those up to it until
     * the next Start, or `null` before any Start.
     */
    debugRecording: exportedRecording,
    /** The error name of an exception of the Player itself, or `null`. */
    hostError: computed(() => hostError.value),
    /** Whether an exception of the Player itself stopped the session where it stands; until the next Start. */
    stopped,
    reportHostError,
    /**
     * Captures what a debug export can contain, frozen: in the host, the shown session's state, marks and failure, the
     * run's incident and the recording (`captureExport`); here, in the capture's reply, that publication's events and
     * transcript, and what `details` reads of the Player's interface for it. `live` says whether the dialog still wants
     * the candidate. `null` when the capture is refused or does not match what shows; nothing then stays held.
     */
    async debugExportCandidate(
      details: (shown: PlayerSession | null) => Pick<DebugExportCandidate, "player" | "host">,
      live: () => boolean,
    ): Promise<DebugExportCandidate | null> {
      const current = session.value;
      const host = current?.connection ?? bridge;
      if (host === null) return null;
      const failed = failureRecording.ticket();
      const recording =
        failed !== null && failed.bridge === host ? { ticket: failed.ticket } : "current";
      const capture = () =>
        host.captureExport(current, recording, (reply, view) =>
          deliverExport(host, current, reply, view, details, live),
        );
      let frozen = await capture();
      // A stop of the run was still committing: once it shows, the capture is tried once more.
      if (frozen === PENDING_CAPTURE) {
        await stopShown();
        frozen = live() ? await capture() : null;
      }
      if (frozen === PENDING_CAPTURE || frozen === null) return null;
      const photos: DebugPhotoCandidate[] = [];
      for (const [reference, usedBy] of debugPhotoUses(frozen)) {
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
      if (!live()) {
        frozen.release();
        return null;
      }
      return { ...frozen, photos };
    },
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
    setDebugTracing(on: boolean) {
      if (disposed || on === debugTracing.value) return;
      debugTracing.value = on;
      traceId.value = null;
      tracingToggles += 1;
      pendingTracing = true;
      if (bridge !== null) flushTracing(bridge);
    },
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

/** Whether `info`, an engine error's details from the host, is a `CheckpointError`'s. */
function isCheckpointErrorInfo(info: unknown): info is CheckpointErrorInfo {
  return (
    typeof info === "object" &&
    info !== null &&
    "code" in info &&
    typeof info.code === "string" &&
    "path" in info &&
    typeof info.path === "string" &&
    "message" in info &&
    typeof info.message === "string"
  );
}

/**
 * The saved and supported revisions, as the start page's Technical details say them, when the JSON of a kept plan or
 * state is of another revision than `supported`, this Player's; else `null`.
 */
function revisionChange(json: string, supported: number): string | null {
  let saved: unknown;
  try {
    const parsed: unknown = JSON.parse(json);
    saved =
      typeof parsed === "object" && parsed !== null && "version" in parsed
        ? parsed.version
        : undefined;
  } catch {
    return null;
  }
  return typeof saved !== "number" || saved === supported
    ? null
    : `Saved revision: ${saved}. Supported revision: ${supported}.`;
}

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

/**
 * `request`'s answer; a refusal the host gave as a `StorageTransferError` is one here too, with its words. The bridge
 * carries an error's name and message, not its class (`BridgeRequestError` copies the name onto itself), so a caller
 * that tests `instanceof StorageTransferError` needs the error rebuilt here.
 */
async function asTransferError<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof BridgeRequestError && error.name === "StorageTransferError")
      throw new StorageTransferError(error.message);
    throw error;
  }
}

/** Whether a held record is the medium of an import: the same kind, type, and bytes. */
async function sameMedium(
  record: CapturedMediaRecord,
  medium: SessionTransferMedium,
): Promise<boolean> {
  if (record.kind !== medium.kind || record.mimeType !== medium.type) return false;
  if (record.size !== medium.bytes.length) return false;
  const bytes = new Uint8Array(await record.data.arrayBuffer());
  return bytes.every((byte, index) => byte === medium.bytes[index]);
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

/** A session to export, and how many references in it name no photo or file this browser holds. */
export interface SessionExport {
  readonly transfer: SessionTransfer;
  readonly missing: number;
}

/**
 * A session read for an import (`readTransfer`): its scope, title, saved values, photos and files, and events, while its
 * checkpoint and restored state stay in the host under `ticket`.
 */
export interface SessionTransferRead {
  readonly ticket: string;
  readonly scope: string;
  readonly name: string | null;
  readonly entries: readonly RuntimeScriptStorageEntrySnapshot[];
  readonly media: readonly SessionTransferMedium[];
  readonly events: readonly InterpreterEvent[];
}

/** What an exported file or text holds, as `readTransfer` read it: the saved data of scripts, or a session. */
export type PlayerTransferRead =
  | { readonly kind: "savedData"; readonly bundle: StorageBundle }
  | ({ readonly kind: "session" } & SessionTransferRead);

/** A checked session import, shown before the player confirms it. */
export interface SessionImportReview {
  readonly transfer: SessionTransferRead;
  readonly name: string | null;
  /** How many values the script has saved now, which the import replaces. */
  readonly currentValues: number;
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

/** The captured-media references of the stored values, by their shape: candidates that only the media store can confirm. */
function storedValueReferences(entries: readonly RuntimeScriptStorageEntrySnapshot[]): Set<string> {
  const references = new Set<string>();
  for (const entry of entries)
    for (const reference of capturedMediaReferences(entry.value))
      if (isWellFormedCapturedMediaReference(reference)) references.add(reference);
  return references;
}
