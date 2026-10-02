import { computed, ref, shallowRef, watch } from "vue";
import { tryOnScopeDispose, useIntervalFn } from "@vueuse/core";
import { createBrowserCaptureHost, browserMediaUrls } from "../../browser-capture.js";
import { CaptureDevice } from "../../capture-device.js";
import {
  CapturedMediaStore,
  isCapturedMediaReference,
  type CapturedMediaRepository,
} from "../../captured-media.js";
import { browserCapturedMediaLocks } from "../../captured-media-persistence.js";
import { MediaDevice, MediaLoadQueue } from "../../media-device.js";
import {
  activePlayerRuntimeCapture,
  answerPlayerRuntimeCapture,
  playerRuntimeMedia,
  reportPlayerRuntimeMediaLoad,
  type PlayerRuntimeSession,
} from "../../runtime-adapter.js";
import { CaptureDelivery, SessionCamera, type PlayerDiagnostic } from "../../session-camera.js";
import { useRuntimeSceneClock } from "./useRuntimeSceneClock";

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
   * Trusted session capabilities. This is a temporary host bridge until package capability metadata exists; it is
   * neither author syntax nor a manifest format.
   */
  capabilities?: { readonly camera?: boolean };
  /**
   * Durable captured-media storage and the trusted script scope that owns it; without a repository, captures stay
   * session media and saved photos do not resolve in later runs.
   */
  capturedMedia?: { readonly repository: CapturedMediaRepository | null; readonly scope: string };
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
  const scope = options.capturedMedia?.scope ?? "player";
  const capturedMedia = new CapturedMediaStore(
    options.capturedMedia?.repository ?? null,
    browserMediaUrls,
    scope,
    () => mediaRevision.value++,
  );
  // While this Player lives, no other Player of the scope may reclaim media it might still use.
  const releaseLiveMedia = browserCapturedMediaLocks().holdLive(scope);
  const camera: SessionCamera<MediaStreamTrack> = new SessionCamera(
    new CaptureDevice(
      createBrowserCaptureHost((kind, state) => {
        if (kind === "camera" && state.status === "ended") camera.revoked();
      }),
      capturedMedia,
    ),
    reportDiagnostic,
  );
  const captures = new CaptureDelivery();
  /** Captured media resolves only through the trusted store, never as a package asset. */
  const resolveAsset = (path: string): string | null => {
    if (!isCapturedMediaReference(path)) return resolvePackageAsset(path);
    void mediaRevision.value;
    const resolved = capturedMedia.resolve(path);
    return resolved.state === "ready" ? resolved.url : null;
  };
  const session = shallowRef<PlayerRuntimeSession | null>(null);
  // A new session remounts the transcript and resets interaction-local state.
  const generation = ref(0);
  const interactionReset = ref(0);
  const activation = shallowRef<Activation | null>(null);
  const audioBlocked = ref(false);

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
  const device = new MediaDevice({
    createElement: () => new Audio(),
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
  // Answers each `takePhoto()` once from the session camera and delivers that answer until the runtime settles it.
  let servicing = false;
  async function serviceCapture(): Promise<void> {
    const action = session.value && activePlayerRuntimeCapture(session.value.snapshot);
    if (!action || servicing) return;
    servicing = true;
    const servedGeneration = generation.value;
    try {
      const answer = await captures.answerFor(action.actionId, () => camera.answer());
      if (servedGeneration !== generation.value) return;
      // Input happens at the observed time; elapsed time cannot replace a capture, but stay defensive.
      const observed = clock.observe() ?? session.value;
      if (
        !observed ||
        activePlayerRuntimeCapture(observed.snapshot)?.actionId !== action.actionId
      ) {
        captures.settled(action.actionId);
        return;
      }
      const result = answerPlayerRuntimeCapture(observed, action.actionId, answer, capturedMedia);
      switch (result.outcome.kind) {
        case "executionPending":
          // The same answer is offered again after the engine ran.
          setTimeout(() => void serviceCapture(), 0);
          return;
        case "invalidPayload":
          reportDiagnostic({ code: "capture-rejected", message: result.outcome.message });
          captures.settled(action.actionId);
          // Never leave the script waiting: answer this capture as unavailable instead.
          session.value = answerPlayerRuntimeCapture(observed, action.actionId, {
            kind: "unavailable",
            reason: "failed",
          }).session;
          return;
        default:
          captures.settled(action.actionId);
          session.value = result.session;
      }
    } finally {
      servicing = false;
    }
    void serviceCapture();
  }
  watch(session, () => void serviceCapture());
  // A session that ended releases its camera.
  watch(
    () => session.value?.snapshot.status,
    (status) => {
      if (status === "halted" || status === "failed") camera.release();
    },
  );

  let activationToken = 0;
  let disposed = false;
  tryOnScopeDispose(() => {
    disposed = true;
    activationToken++;
    loads.clear();
    device.reset();
    camera.release();
    captures.reset();
    capturedMedia.close();
    releaseLiveMedia();
  });

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
    activation.value = { kind: "start", begin: create };
  }
  /** Shows the explicit Continue control for a restored session; its execution, time and media resume only then. */
  function prepareRestore(restored: PlayerRuntimeSession) {
    activationToken++;
    activation.value = { kind: "continue", begin: () => restored };
  }
  /**
   * Runs the prepared Start or Continue; call it from the activating click. With the camera capability it first opens
   * the session camera, so any browser permission request happens here, before ordinary script execution. A camera
   * failure never prevents the session from starting.
   */
  async function activate() {
    const pending = activation.value;
    if (!pending) return;
    activation.value = null;
    const token = ++activationToken;
    const opened = await camera.open(options.capabilities?.camera === true);
    // Replaced, re-prepared, or unmounted while the browser answered: an obsolete session never starts.
    if (!opened || disposed || token !== activationToken) return;
    captures.reset();
    start(pending.begin());
  }

  return {
    session: computed(() => session.value),
    generation: computed(() => generation.value),
    interactionReset: computed(() => interactionReset.value),
    /** The prepared Start or Continue, or `null` once the session runs. */
    activation: computed(() => activation.value?.kind ?? null),
    /** Whether the browser refused audible playback; `retryAudio` must run from a user activation. */
    audioBlocked: computed(() => audioBlocked.value),
    retryAudio: () => device.retryBlocked(),
    resolveAsset,
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
  };
}

export type PlayerSessionHost = ReturnType<typeof usePlayerSession>;
