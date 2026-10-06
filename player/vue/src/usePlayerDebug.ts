import { computed, effectScope, ref, shallowRef, watch, type EffectScope } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import { debugCountdownText } from "../../presentation.js";
import { playerRuntimeDebugCountdown } from "../../runtime-adapter.js";
import { useDebugLog, type DebugLog } from "./useDebugLog";
import { useDevelopmentTime, type DevelopmentTime } from "./useDevelopmentTime";
import type { PlayerSessionHost } from "./usePlayerSession";

/**
 * The Player's Debug feature (DEBUGGER.md "Player Debug"). Settings' **Debug menu** switch offers the Debug panel; it is
 * not stored, so every load starts with it off unless the host starts it on (`?dev`). The panel's own **Debug** switch,
 * on whenever the menu is turned on, pauses the features without leaving the panel.
 *
 * The Debug log lives while the menu is on. Time controls, countdowns, and the value trace live only while both switches
 * are on: turning either off stops auto-skip, ends a jump at its next yield, and drops the trace with its history;
 * turning it on again starts with auto-skip off and a new trace. A countdown shows while the session runs or waits,
 * never before Start or Continue.
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
      time.value =
        timeScope?.run(() =>
          useDevelopmentTime(player, { autoSkip }, (text) => log.value?.add(text)),
        ) ?? null;
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
    /** The Debug countdown line for the current foreground wait while the Debug features run, else `null`. */
    countdownText,
  };
}
