import { computed, ref, shallowRef, watch } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import {
  DebugHistory,
  type DebugHistoryCurrent,
  type DebugHistoryMarks,
  type DebugHistoryRestore,
} from "../../debug-history.js";
import {
  restorePlayerRuntimeSessionAt,
  withPlayerRuntimeDebugTrace,
  type PlayerRuntimeSession,
} from "../../runtime-adapter.js";
import type { PlayerSessionHost } from "./usePlayerSession";

/**
 * Debug's rewind (DEBUGGER.md "Rewind") while the Debug features run: the history of the shown session, and Back,
 * Forward, Resume, and Return. Turning Debug off reinstates the session Back left, if a restored state is still only
 * inspected, and deletes the history; so does a new or replaced session.
 */
export function useDebugRewind(player: PlayerSessionHost) {
  const { rewind } = player;
  const history = shallowRef<DebugHistory | null>(null);
  // The history changes in place; this counts its changes for what presents it.
  const revision = ref(0);
  const busy = ref(false);
  const problem = ref<string | null>(null);
  // Set while this rewind publishes a state, which is no new session.
  let publishing = false;

  const marks = (): DebugHistoryMarks => ({
    editedWhileDebugging: player.debugEdits.value,
    rewoundWhileDebugging: rewind.rewound.value,
  });
  function end() {
    const ended = history.value;
    history.value = null;
    revision.value++;
    void ended?.destroy();
  }
  function follow(session: PlayerRuntimeSession | null) {
    if (publishing || session === null) return;
    history.value ??= new DebugHistory(session.plan, rewind.openSpill());
    history.value.follow(session, marks());
    revision.value++;
  }
  // Every published session is followed, so a point keeps exactly the events that led to it.
  watch(player.generation, () => publishing || end(), { flush: "sync" });
  watch(player.session, follow, { flush: "sync" });
  follow(player.session.value);
  rewind.onAdopted(() => {
    history.value?.adopt();
    revision.value++;
  });

  function publish(
    restored: DebugHistoryRestore,
    debugTrace: PlayerRuntimeSession["debugTrace"],
    plan: DebugHistory["plan"],
  ) {
    const { position, snapshotJson, marks: restoredMarks } = restored;
    publishing = true;
    try {
      rewind.publish(
        ({ recorder }) =>
          restorePlayerRuntimeSessionAt(
            plan,
            snapshotJson,
            position.events.slice(0, position.eventCount),
            recorder,
            debugTrace,
          ),
        { paused: true, marks: restoredMarks },
      );
    } finally {
      publishing = false;
    }
    revision.value++;
  }

  // Runs one rewind step; a failure, such as a state that could not be read back, changes nothing and is reported.
  async function step(restore: (history: DebugHistory) => Promise<DebugHistoryRestore>) {
    const current = history.value;
    const session = player.session.value;
    if (current === null || session === null || busy.value || !rewind.canRewind.value) return false;
    busy.value = true;
    problem.value = null;
    try {
      const restored = await restore(current);
      if (history.value !== current) return false;
      publish(restored, player.debugTrace.value, current.plan);
      return true;
    } catch (error) {
      if (history.value === current)
        problem.value = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      busy.value = false;
    }
  }

  /** Restores the point at `index`; the state left stays for Forward. Resolves to whether it was restored. */
  const back = (index: number) =>
    step((current) =>
      current.back(index, () => {
        const session = player.session.value;
        return session === null || !rewind.canRewind.value ? null : { session, marks: marks() };
      }),
    );
  /** Restores the state the last Back left. */
  const forward = () => step((current) => current.forward());

  /** Reinstates the session the first Back left, as it was then; the restored states go. */
  function returnToSession() {
    const current = history.value;
    if (current?.inspection == null || busy.value || rewind.adopting.value) return false;
    reinstate(current.returnToSession());
    return true;
  }
  function reinstate(parked: DebugHistoryCurrent) {
    publishing = true;
    try {
      rewind.publish(
        ({ recorder }) => {
          recorder.begin(parked.session.plan, parked.session.snapshot);
          const trace = player.debugTrace.value;
          trace?.reset("restore");
          return withPlayerRuntimeDebugTrace(parked.session, trace);
        },
        { paused: false, marks: parked.marks },
      );
    } finally {
      publishing = false;
    }
    revision.value++;
  }

  // Turning Debug off leaves no restored state inspected: one whose adoption is under way is reinstated only if that
  // adoption fails.
  tryOnScopeDispose(() => {
    const current = history.value;
    const adoption = rewind.adoption();
    if (current?.inspection != null) {
      const parked = current.returnToSession();
      if (adoption === null) reinstate(parked);
      else {
        const shown = player.session.value;
        void adoption.then((adopted) => {
          if (!adopted && rewind.inspecting.value && player.session.value === shown)
            reinstate(parked);
        });
      }
    }
    rewind.onAdopted(null);
    end();
  });

  return {
    /** The history's state, recomputed whenever it changes. */
    state: computed(() => {
      void revision.value;
      const current = history.value;
      return {
        points: current?.points ?? [],
        inspection: current?.inspection ?? null,
        shown: current?.shown ?? null,
        future: current?.future ?? null,
        complete: current?.complete ?? true,
        memoryChars: current?.memoryChars ?? 0,
        spilledCount: current?.spilledCount ?? 0,
      };
    }),
    /** Whether a rewind step runs now. */
    busy: computed(() => busy.value),
    /** Why the last rewind step changed nothing, or `null`. */
    problem: computed(() => problem.value),
    back,
    forward,
    /** Adopts the inspected state without new input, so it runs on; resolves to whether it was adopted. */
    resume: () => rewind.resume(),
    returnToSession,
  };
}

export type DebugRewind = ReturnType<typeof useDebugRewind>;
