import { computed, effectScope, ref, shallowRef, watch, type EffectScope } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import { debugCountdownText } from "../../presentation.js";
import {
  playerRuntimeDebugCountdown,
  playerRuntimeTranscriptEventSequence,
} from "../../runtime-adapter.js";
import type { RuntimeDebugContext } from "../../../src/index.js";
import { useDebugLog, type DebugLog } from "./useDebugLog";
import { useDebugRewind, type DebugRewind } from "./useDebugRewind";
import { useDevelopmentTime, type DevelopmentTime } from "./useDevelopmentTime";
import type { PlayerSessionHost } from "./usePlayerSession";

/**
 * The Player's Debug feature (DEBUGGER.md "Player Debug"). Settings' **Debug menu** switch offers the Debug panel; it is
 * not stored, so every load starts with it off unless the host starts it on (`?dev`). The panel's own **Debug** switch,
 * on whenever the menu is turned on, pauses the features without leaving the panel.
 *
 * The Debug log lives while the menu is on. Time controls, countdowns, the value trace, and rewind's history live only
 * while both switches are on: turning either off stops auto-skip, ends a jump at its next yield, and drops the trace and
 * the rewind history; turning it on again starts with auto-skip off and a new trace. A countdown shows while the session
 * runs or waits, never before Start or Continue.
 *
 * **Explain values** on a chat message selects it for the Variables tab by its event sequence. The selection belongs to
 * the trace and epoch it was made in: Start, Continue, a rewind, or Debug off ends it.
 */
export function usePlayerDebug(
  player: PlayerSessionHost,
  initial: { readonly menu: boolean; readonly autoSkip: boolean },
) {
  const menu = ref(initial.menu);
  const active = ref(true);
  watch(
    menu,
    (on) => {
      if (on) active.value = true;
    },
    { flush: "sync" },
  );

  const log = shallowRef<DebugLog | null>(null);
  const time = shallowRef<DevelopmentTime | null>(null);
  const rewind = shallowRef<DebugRewind | null>(null);
  let logScope: EffectScope | null = null;
  let timeScope: EffectScope | null = null;
  // Only the first enablement takes the host's initial auto-skip.
  let autoSkip = initial.autoSkip;

  watch(
    menu,
    (on) => {
      logScope?.stop();
      logScope = on ? effectScope(true) : null;
      log.value = logScope?.run(() => useDebugLog()) ?? null;
    },
    { immediate: true, flush: "sync" },
  );
  watch(
    () => menu.value && active.value,
    (enabled) => {
      timeScope?.stop();
      timeScope = enabled ? effectScope(true) : null;
      const features = timeScope?.run(() => ({
        time: useDevelopmentTime(player, { autoSkip }, (text) => log.value?.add(text)),
        rewind: useDebugRewind(player),
      }));
      time.value = features?.time ?? null;
      rewind.value = features?.rewind ?? null;
      if (enabled) autoSkip = false;
      player.setDebugTracing(enabled);
    },
    { immediate: true, flush: "sync" },
  );
  tryOnScopeDispose(() => {
    timeScope?.stop();
    logScope?.stop();
    player.setDebugTracing(false);
  });

  /** The panel's tab, kept while the panel is closed. */
  const tab = ref("now");
  const explained = shallowRef<PlayerDebugExplained | null>(null);
  let requests = 0;
  /** Whether a message offers Explain values: Debug traces and the entry came from a runtime event. */
  function offers(entryId: string): boolean {
    return (
      player.debugTrace.value !== null && playerRuntimeTranscriptEventSequence(entryId) !== null
    );
  }
  /** Selects a message for the Variables tab and shows that tab; `false` if the message does not offer it. */
  function explain(entryId: string): boolean {
    const trace = player.debugTrace.value;
    const sequence = playerRuntimeTranscriptEventSequence(entryId);
    if (trace === null || sequence === null) return false;
    requests += 1;
    explained.value = Object.freeze({
      trace,
      epoch: trace.status().epoch,
      sequence,
      entryId,
      request: requests,
    });
    tab.value = "variables";
    return true;
  }

  const countdown = computed(() => {
    const session = player.session.value;
    if (time.value === null || session === null || player.activation.value !== null) return null;
    return playerRuntimeDebugCountdown(session);
  });
  player.refreshSceneTimeWhile(() => countdown.value !== null);
  // The estimate may lag a just-published session until its next refresh; scene time never runs backwards.
  const countdownText = computed(() => {
    const session = player.session.value;
    return countdown.value === null || session === null
      ? null
      : debugCountdownText(
          countdown.value,
          Math.max(session.snapshot.observedSessionTimeMs, player.sceneTimeMs.value),
        );
  });

  return {
    /** Settings' Debug menu switch: whether the Debug panel is offered. */
    menu,
    /** The panel's Debug switch: whether the Debug features run while the menu is on. */
    active,
    /** The Debug log while the menu is on, else `null`. */
    log: computed(() => log.value),
    /** Time controls while the Debug features run, else `null`. */
    time: computed(() => time.value),
    /** Rewind while the Debug features run, else `null`. */
    rewind: computed(() => rewind.value),
    /** The Debug countdown line for the current foreground wait while the Debug features run, else `null`. */
    countdownText,
    tab,
    /** The message Explain values selected last, or `null`; see `PlayerDebugExplained`. */
    explained,
    offers,
    explain,
  };
}

/** A message Explain values selected, valid only while `trace` is the session's trace and still in `epoch`. */
export interface PlayerDebugExplained {
  readonly trace: RuntimeDebugContext;
  readonly epoch: number;
  /** The event sequence of its `say` event. */
  readonly sequence: number;
  /** Its transcript entry ID. */
  readonly entryId: string;
  /** Counts selections, so that selecting the same message again shows it again. */
  readonly request: number;
}
