import { computed, ref, watch, type Ref } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import type { StorageCapture } from "../../../engine-bridge/ops/history.js";
import type { DebugRewoundWhileDebugging } from "../../../debug/debug-export.js";
import { bridgeOf, type PlayerBridge } from "../../../runtime/player-bridge.js";
import { playerNoticeKeys, playerNotices, type PlayerNotices } from "../../../presentation/notices.js";
import { pendingPlayerRuntimeStorageWrite, type PlayerSession } from "../../../runtime/runtime-view.js";
import type { ScriptStorageProvider } from "../../../persistence/script-storage.js";
import { createRewindOwner } from "./rewindOwner";
import type { useRuntimeSceneClock } from "./useRuntimeSceneClock";

/*
 * Debug's rewind as the session composable shows it, moved from `usePlayerSession` unchanged: its owner
 * (`rewindOwner.ts`), the inspection it reports, the step and adoption work, and the states it shows.
 */

/** What the rewind needs from the Player's session composable. */
interface SessionRewindHost {
  /** The engine's host now, or `null` before it is ready. */
  readonly bridgeNow: () => PlayerBridge | null;
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly generation: Readonly<Ref<number>>;
  readonly stopped: Readonly<Ref<boolean>>;
  readonly isDisposed: () => boolean;
  readonly reportHostError: (error: unknown) => void;
  readonly showSession: (next: PlayerSession, options: { readonly paused: boolean }) => void;
  readonly scriptStorage: ScriptStorageProvider | undefined;
  readonly applyDebugMode: () => void;
  /** Random control's adoption, read when used. */
  readonly adoptRandom: (next: PlayerSession) => void;
  /** Random control's natural resolution of a draw nobody decides, read when used. */
  readonly settleUncontrolledDraw: () => void;
  /** The rewind's surface on the return surface, which a host or a test may change; read when used. */
  readonly rewindApi: () => { beforeRestart(): void | Promise<void> };
  /** The scene clock, read when used. */
  readonly clock: () => ReturnType<typeof useRuntimeSceneClock>;
  /** The Player's notices, read when used. */
  readonly notices: () => PlayerNotices;
  /** The prepared Start or Continue, read when used. */
  readonly activation: () => Readonly<Ref<unknown>>;
  /** Whether saved data is being imported, cleared, or a session begins; read when used. */
  readonly importing: () => Readonly<Ref<boolean>>;
  readonly clearing: () => Readonly<Ref<boolean>>;
  readonly beginning: () => Readonly<Ref<boolean>>;
  /** Debug storage edits under way, read when used. */
  readonly editsInFlight: () => Readonly<Ref<number>>;
  /** The count of this Player's changes to the saved values, read when used. */
  readonly savedDataRevision: () => Ref<number>;
}

export function useSessionRewind({
  bridgeNow,
  session,
  generation,
  stopped,
  isDisposed,
  reportHostError,
  showSession,
  scriptStorage,
  applyDebugMode,
  adoptRandom,
  settleUncontrolledDraw,
  rewindApi,
  clock,
  notices,
  activation,
  importing,
  clearing,
  beginning,
  editsInFlight,
  savedDataRevision,
}: SessionRewindHost) {
  /**
   * The rewind retirement stamp (`rewindRetirements`, below) the owner's reply guards read; declared first, as the owner
   * is made before everything that reads it.
   */
  const rewindRetirements = ref(0);
  // Debug's rewind over the Player's lifetime, which outlives each Debug scope (DEBUGGER.md "Rewind"): one deciding
  // function (`player/debug/rewind-lifecycle.ts`) and the owner that applies what it decides.
  const rewindOwner = createRewindOwner({
    bridge: bridgeNow,
    retirements: () => rewindRetirements.value,
    shown: () => session.value,
    ready: () => rewindReady.value,
    generation: () => generation.value,
    beginStep: () => beginRewindStep(),
    show: (next, paused) => showRewound(next, { paused }),
    // Read at each call, so a host or a test can put its own gate there.
    beforeRestart: () => rewindApi().beforeRestart(),
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
  let rewoundGeneration = -1;
  /**
   * Readies the session for input before the input is evaluated: an inspected state Debug's rewind restored is adopted
   * first. `true` when input may go ahead at once, else whether it may once the state is adopted; a state that could
   * not be adopted, or one being adopted for other input, takes none, and stays as it was.
   */
  function prepareInput(): true | Promise<boolean> {
    return inspecting.value ? adoptRewound() : true;
  }
  /**
   * Shows a session Debug's rewind restored or reinstated in the host (DEBUGGER.md "Rewind"), with its marks, as a new
   * generation of the session: paused for inspection, or running, as the session Back left when Return reinstates it.
   * The host began its recording anew at it.
   */
  function showRewound(next: PlayerSession, { paused }: { readonly paused: boolean }) {
    // An unmounted Player publishes nothing.
    if (isDisposed()) return;
    showSession(next, { paused });
    rewoundGeneration = generation.value;
  }
  // Debug's rewind does one thing at a time: restoring a state (a step, which may read a spilled snapshot) or adopting
  // the inspected one (which replaces the saved data). Each holds this until it is done, and neither starts meanwhile.
  const rewindWork = ref<"step" | "adopt" | null>(null);
  let adoption: Promise<boolean> | null = null;
  /** Whether the session may be left for a restored state now: nothing waits for the host or the player. */
  const rewindReady = computed(
    () =>
      session.value !== null &&
      activation().value === null &&
      !importing().value &&
      !clearing().value &&
      !beginning().value &&
      editsInFlight().value === 0 &&
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
      !isDisposed() &&
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
      notices().publish(playerNotices.rewindNotAdopted());
      return false;
    }
    try {
      if (scriptStorage && outcome.capture.persistent)
        await scriptStorage.replace(outcome.capture.entries);
      return true;
    } catch {
      if (ownsShown(owner, shown)) notices().publish(playerNotices.rewindNotAdopted());
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
    notices().dismiss(playerNoticeKeys.rewindNotAdopted);
    savedDataRevision().value++;
    clock().rebase();
    applyDebugMode();
    if (session.value !== null) adoptRandom(session.value);
    settleUncontrolledDraw();
    return true;
  }

  return {
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
    /** The generation of the last session the rewind showed, which does not end anew. */
    rewoundGeneration: () => rewoundGeneration,
    /** Follows each new session and shown publication, and ends with the Player; at their place in the setup. */
    followSessions() {
      // A new session, a Start's or a Continue's, gets a history of its own; a session the rewind shows is none.
      watch(generation, () => rewindOwner.showing || rewindOwner.newSession(), { flush: "sync" });
      watch(session, (next) => rewindOwner.follow(next), { flush: "sync" });
      tryOnScopeDispose(() => rewindOwner.disposal());
    },
  };
}
