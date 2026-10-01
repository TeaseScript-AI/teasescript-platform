import { computed, ref, shallowRef, watch } from "vue";
import { tryOnScopeDispose, useIntervalFn } from "@vueuse/core";
import { MediaDevice, MediaLoadQueue } from "../../../media-device.js";
import {
  playerRuntimeMedia,
  reportPlayerRuntimeMediaLoad,
  type PlayerRuntimeSession,
} from "../../../runtime-adapter.js";
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
}

type Activation = {
  readonly kind: "start" | "continue";
  readonly begin: () => PlayerRuntimeSession;
};

// Presentation lifecycle around the canonical runtime session. The adapter session stays the only
// Player state; this host records which session is shown, when presentation must reset, maps
// browser time onto the session's scene time, and plays the session's media on browser elements.
export function usePlayerSession(options: PlayerSessionOptions = {}) {
  const resolveAsset = options.resolveAsset ?? (() => null);
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
  tryOnScopeDispose(() => {
    loads.clear();
    device.reset();
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
    activation.value = { kind: "start", begin: create };
  }
  /** Shows the explicit Continue control for a restored session; its execution, time and media resume only then. */
  function prepareRestore(restored: PlayerRuntimeSession) {
    activation.value = { kind: "continue", begin: () => restored };
  }
  /** Runs the prepared Start or Continue; call it from the activating click. */
  function activate() {
    const pending = activation.value;
    if (!pending) return;
    activation.value = null;
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
