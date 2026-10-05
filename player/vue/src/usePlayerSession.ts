import { computed, ref, shallowRef, watch } from "vue";
import { tryOnScopeDispose, useIntervalFn } from "@vueuse/core";
import { createBrowserCaptureHost, browserMediaUrls } from "../../browser-capture.js";
import { CaptureDevice } from "../../capture-device.js";
import {
  CapturedMediaStore,
  isCapturedMediaReference,
  type CapturedMediaRepository,
} from "../../captured-media.js";
import {
  browserCapturedMediaLocks,
  capturedMediaStorage,
} from "../../captured-media-persistence.js";
import { MediaDevice, MediaLoadQueue, type MediaDeviceElement } from "../../media-device.js";
import {
  completePlayerRuntimeStorageWrite,
  continuePlayerRuntimeSession,
  playerTemporalContext,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeCameraView,
  playerRuntimeMedia,
  reportPlayerRuntimeMediaLoad,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../../runtime-adapter.js";
import type { ScriptStorageProvider } from "../../script-storage.js";
import { CaptureService, SessionCamera, type PlayerDiagnostic } from "../../session-camera.js";
import type { RuntimeScriptStorageEntrySnapshot, TemporalContext } from "../../../src/index.js";
import { silence } from "./generatedAudio";
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
   * Durable storage for captured photos that a saved value references, in the script storage's scope. Without a
   * repository, captures stay session media, and a persistent save that references one fails.
   */
  capturedMedia?: { readonly repository: CapturedMediaRepository | null };
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
  // Bumped when a stored photo finished loading, so presentation resolves its reference again.
  const mediaRevision = ref(0);
  const capturedMedia = new CapturedMediaStore(
    options.capturedMedia?.repository ?? null,
    browserMediaUrls,
    options.scriptStorage?.scope ?? "player",
    () => mediaRevision.value++,
  );
  // A Player that can capture or read stored photos saves a value only after storing the photos it references, and
  // only while it holds the scope's live lock, so no other Player reclaims media it might still use. Without either,
  // no captured photo can exist here, and storage is used directly.
  const capturedMediaPersistence =
    options.scriptStorage &&
    (options.capabilities?.camera === true || options.capturedMedia?.repository)
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
  const audioBlocked = ref(false);
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
      loads.add(mediaId, report);
      pendingLoadCount.value = loads.size;
    },
    requestObservation: () => clock.observe(),
    blockedChanged: (blocked) => (audioBlocked.value = blocked),
  });
  const clock = useRuntimeSceneClock(session, () => device.sample());

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
    // Issued saves still finish and store their photos before the live lock and the session media are released.
    void (capturedMediaPersistence?.close() ?? Promise.resolve()).finally(() =>
      capturedMedia.close(),
    );
  });

  // The stored values that seed the next session, or `null` when storage is session-local: no provider, or one that
  // could not load, such as a browser that denies storage. A session-local run plays normally and keeps nothing.
  const storedEntries = shallowRef<readonly RuntimeScriptStorageEntrySnapshot[] | null>(null);
  /**
   * Reads the stored values freshly for the next Start; call it before each `prepare`. Reading ahead keeps Start
   * synchronous within the player's activation.
   */
  async function loadScriptStorage(): Promise<void> {
    if (!scriptStorage) return;
    try {
      storedEntries.value = await scriptStorage.load();
    } catch {
      storedEntries.value = null;
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
        writesInFlight.delete(flight);
        // A write that settles after unmount must not continue the session.
        if (disposed) return;
        const latest = session.value;
        // The report must belong to the session that requested it.
        if (generation.value !== sessionGeneration || latest === null) return;
        if (pendingPlayerRuntimeStorageWrite(latest.snapshot)?.actionId !== write!.actionId) return;
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
  const canClearScriptStorage = computed(
    () =>
      scriptStorage !== undefined &&
      storedEntries.value !== null &&
      !clearing.value &&
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
      return true;
    } catch {
      return false;
    } finally {
      clearing.value = false;
    }
  }

  // Starts or restores a session; its scene time continues from the persisted observation, so a
  // gap while no Player ran is not consumed.
  function start(next: PlayerRuntimeSession) {
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
   * Shows the explicit Start control for a new session; `create` runs only on activation, so no statement executes
   * on page load and the click is the user activation later audible playback relies on.
   */
  function prepare(create: () => PlayerRuntimeSession) {
    activationToken++;
    openingCamera.value = false;
    // A new session needs its own camera; a superseded acquisition never stays open.
    camera.release();
    activation.value = { kind: "start", begin: create };
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
      begin: () => continuePlayerRuntimeSession(restored, temporalCapture()).session,
    };
  }
  /**
   * Runs the prepared Start or Continue; call it from the activating click. With the camera capability it first opens
   * the session camera, so any browser permission request happens here, before ordinary script execution. A camera
   * failure never prevents the session from starting.
   */
  async function activate() {
    const pending = activation.value;
    if (!pending || clearing.value) return;
    activation.value = null;
    const token = ++activationToken;
    if (options.capabilities?.camera !== true) {
      // Without the capability nothing waits: `takePhoto()` is unconfigured (settled before `open` returns), and the
      // session starts within the activating click.
      void camera.open(false);
      captures.reset();
      start(pending.begin());
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
    start(pending.begin());
  }

  return {
    session: computed(() => session.value),
    generation: computed(() => generation.value),
    interactionReset: computed(() => interactionReset.value),
    /** The prepared Start or Continue, or `null` once the session runs or while saved data is being cleared. */
    activation: computed(() => (clearing.value ? null : (activation.value?.kind ?? null))),
    /** Whether the browser refused audible playback; `retryAudio` must run from a user activation. */
    audioBlocked: computed(() => audioBlocked.value),
    retryAudio: () => device.retryBlocked(),
    /** Whether the host persists script storage, so the Player offers to clear it. */
    hasScriptStorage: scriptStorage !== undefined,
    canClearScriptStorage,
    clearScriptStorage,
    loadScriptStorage,
    scriptStorageOptions,
    resolveAsset,
    /** The session camera's live track while the script shows a camera view and the camera is available, else `null`. */
    viewfinder,
    /** Where the script shows the camera view, `"window"` or `"stage"`, or `null` while it shows none. */
    viewfinderPlacement,
    /** Bounded developer diagnostics, for example an unavailable session camera. */
    diagnostics: computed(() => diagnostics.value),
    /** Presented runtime timers; hidden timers have no entry. */
    timers: clock.timers,
    /** Observes elapsed time and media progress, runs the session, and returns the published session. */
    observe: clock.observe,
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
