import { computed, ref, shallowRef, watch } from "vue";
import { tryOnScopeDispose, useIntervalFn } from "@vueuse/core";
import { MediaDevice, MediaLoadQueue } from "../../media-device.js";
import {
  completePlayerRuntimeStorageWrite,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeMedia,
  reportPlayerRuntimeMediaLoad,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../../runtime-adapter.js";
import type { ScriptStorageProvider } from "../../script-storage.js";
import type { RuntimeScriptStorageEntrySnapshot } from "../../../src/index.js";
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
   * Persistent script storage for `save`/`load`/`delete` in the host's stable, opaque scope for this script and player.
   * Without it, saves last only for the session.
   */
  scriptStorage?: ScriptStorageProvider;
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
  const scriptStorage = options.scriptStorage;

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
  let disposed = false;
  tryOnScopeDispose(() => (disposed = true));
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
  // A running or resumable session keeps its own view of the stored values, so clearing waits until it ends.
  const canClearScriptStorage = computed(
    () =>
      scriptStorage !== undefined &&
      storedEntries.value !== null &&
      activation.value?.kind !== "continue" &&
      (session.value === null ||
        session.value.snapshot.status === "halted" ||
        session.value.snapshot.status === "failed"),
  );
  /** Removes this script's saved data; resolves to whether it was cleared. */
  async function clearScriptStorage(): Promise<boolean> {
    if (!scriptStorage || !canClearScriptStorage.value) return false;
    try {
      await scriptStorage.clear();
    } catch {
      return false;
    }
    storedEntries.value = [];
    return true;
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
    /** Whether the host persists script storage, so the Player offers to clear it. */
    hasScriptStorage: scriptStorage !== undefined,
    canClearScriptStorage,
    clearScriptStorage,
    loadScriptStorage,
    scriptStorageOptions,
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
