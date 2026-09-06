<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import type { CSSProperties } from "vue";
import type { PlayerPresentation, PlayerToolDefinition } from "../../model.js";
import {
  activePlayerRuntimeInteraction,
  activatePlayerRuntimeButton,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimeForeground,
  playerRuntimePacingGate,
  restorePlayerRuntimeSession,
  selectPlayerRuntimeChoice,
  skipPlayerRuntimePacing,
  submitPlayerRuntimeComposer,
  type PlayerRuntimeControlResult,
  type PlayerRuntimeRestorePoint,
} from "../../runtime-adapter.js";
import PlayerComposer from "./components/PlayerComposer.vue";
import PlayerForeground from "./components/PlayerForeground.vue";
import PlayerMedia from "./components/PlayerMedia.vue";
import PlayerRightRail from "./components/PlayerRightRail.vue";
import PlayerTitleBar from "./components/PlayerTitleBar.vue";
import PlayerTools from "./components/PlayerTools.vue";
import PlayerTranscript from "./components/PlayerTranscript.vue";
import { usePlayerLayout } from "./composables/usePlayerLayout.js";
import { createPlayerCoreState, reducePlayerCoreState, type PlayerCoreAction } from "./state.js";

const props = defineProps<{
  presentation: PlayerPresentation;
  runtimeSource: string;
  tools?: readonly PlayerToolDefinition[];
  toolLabel?: string;
}>();

const player = ref<HTMLElement | null>(null);
const composer = ref<InstanceType<typeof PlayerComposer> | null>(null);
const toolDefinitions = computed<readonly PlayerToolDefinition[]>(() => {
  if (props.tools !== undefined) return props.tools;
  return props.toolLabel === undefined ? [] : [{ id: "scene", label: props.toolLabel }];
});
const state = ref(
  createPlayerCoreState(
    props.presentation,
    toolDefinitions.value.map((tool) => tool.id),
  ),
);
const runtime = shallowRef(createPlayerRuntimeSession(props.runtimeSource));
const foreground = computed(() => playerRuntimeForeground(runtime.value));
const pacingGate = computed(() => playerRuntimePacingGate(runtime.value));
const transcriptEntries = computed(() => [
  ...runtime.value.transcriptEntries,
  ...state.value.fixtureTranscriptEntries,
]);
const transcriptRevision = computed(
  () => runtime.value.transcriptRevision + state.value.nextActivitySequence - 1,
);
const transcriptSpeakers = computed(() => {
  const fixtureUser = props.presentation.speakers.user ?? runtime.value.speakers.user;
  return fixtureUser === undefined
    ? runtime.value.speakers
    : { ...runtime.value.speakers, "fixture-user": fixtureUser };
});
const layout = usePlayerLayout({ player });
const toolsAvailable = computed(() => toolDefinitions.value.length > 0);
const effectiveLeftMode = computed(() => (toolsAvailable.value ? layout.leftMode.value : "closed"));
let sessionTimeOriginMs = performance.now() - runtime.value.snapshot.currentSessionTimeMs;
let timeTimer: ReturnType<typeof setTimeout> | null = null;
let activeTypedActionId = typedInteractionActionId();
const pointerGestures = new Map<
  number,
  {
    readonly startX: number;
    readonly startY: number;
    readonly target: EventTarget | null;
    moved: boolean;
  }
>();

const playerStyle = computed(
  () =>
    ({
      "--media-fit": props.presentation.media.fit,
      "--package-accent": props.presentation.package.accentColor,
      "--scene-ambient": props.presentation.media.ambientColor,
    }) as CSSProperties,
);

function dispatch(action: PlayerCoreAction): void {
  state.value = reducePlayerCoreState(state.value, action);
}

function setFeedback(message: string): void {
  dispatch({ type: "set-composer-feedback", message });
}

function submitComposer(): void {
  const result = submitPlayerRuntimeComposer(runtime.value, state.value.composerValue);
  if (result === null) {
    if (foreground.value?.kind === "show-button") {
      setFeedback("Use the rendered button to continue.");
    } else if (foreground.value === null) {
      dispatch({ type: "submit-fixture-composer" });
    }
    return;
  }
  applyRuntimeControl(result, true);
}

function activateForeground(optionId: string | null): void {
  const result =
    optionId === null
      ? activatePlayerRuntimeButton(runtime.value)
      : selectPlayerRuntimeChoice(runtime.value, optionId);
  if (result !== null) applyRuntimeControl(result, false);
}

function skipPacing(): void {
  if (relevantPlayerTextSelection()) return;
  const result = skipPlayerRuntimePacing(runtime.value);
  if (result !== null) applyRuntimeControl(result, false);
}

function applyRuntimeControl(result: PlayerRuntimeControlResult, clearComposer: boolean): void {
  runtime.value = result.session;
  if (result.outcome.kind === "completed") {
    dispatch({ type: "set-composer-feedback", message: "" });
    if (clearComposer) dispatch({ type: "set-composer", value: "" });
  } else {
    setFeedback(runtimeOutcomeMessage(result.outcome));
  }
  focusComposerForActiveTypedInteraction(false);
  scheduleTimeObservation();
}

function focusComposerForActiveTypedInteraction(force: boolean): void {
  const actionId = typedInteractionActionId();
  const actionChanged = actionId !== activeTypedActionId;
  activeTypedActionId = actionId;
  if (actionId !== null && (force || actionChanged)) {
    void nextTick(() => composer.value?.focusInput());
  }
}

function typedInteractionActionId(): number | null {
  const action = activePlayerRuntimeInteraction(runtime.value.snapshot);
  return action?.interactionKind === "text" || action?.interactionKind === "number"
    ? action.actionId
    : null;
}

function runtimeOutcomeMessage(outcome: PlayerRuntimeControlResult["outcome"]): string {
  if (outcome.kind === "invalidPayload" || outcome.kind === "invalidObservation") {
    return outcome.message;
  }
  if (outcome.kind === "wrongActionKind") return "The active Player control changed; try again.";
  if (outcome.kind === "alreadySettled") return "That Player action was already completed.";
  if (outcome.kind === "staleAction" || outcome.kind === "unknownAction") {
    return "That Player action is no longer active.";
  }
  if (outcome.kind === "notDue") return "That timed action is not due yet.";
  return "";
}

function handlePlayerPointer(event: PointerEvent): void {
  const gesture = pointerGestures.get(event.pointerId);
  pointerGestures.delete(event.pointerId);
  if (
    gesture === undefined ||
    gesture.moved ||
    event.button !== 0 ||
    !event.isPrimary ||
    !isPacingBackgroundTarget(gesture.target) ||
    relevantPlayerTextSelection()
  ) {
    return;
  }
  skipPacing();
}

function rememberPlayerPointerTarget(event: PointerEvent): void {
  pointerGestures.set(event.pointerId, {
    startX: event.clientX,
    startY: event.clientY,
    target: event.target,
    moved: false,
  });
}

function markPlayerPointerMoved(event: PointerEvent): void {
  const gesture = pointerGestures.get(event.pointerId);
  if (
    gesture !== undefined &&
    (event.clientX !== gesture.startX || event.clientY !== gesture.startY)
  ) {
    gesture.moved = true;
  }
}

function forgetPlayerPointerTarget(event: PointerEvent): void {
  pointerGestures.delete(event.pointerId);
}

function isPacingBackgroundTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (
    target === player.value ||
    target.classList.contains("transcript") ||
    target.classList.contains("title-bg")
  ) {
    return true;
  }
  const mediaSurface = target.closest(".media-surface");
  return mediaSurface !== null && target.closest(".media-content") === null;
}

function relevantPlayerTextSelection(): boolean {
  const selection = document.getSelection();
  return (
    selection !== null &&
    !selection.isCollapsed &&
    (player.value?.contains(selection.anchorNode) === true ||
      player.value?.contains(selection.focusNode) === true)
  );
}

function saveCheckpoint(): PlayerRuntimeRestorePoint {
  return createPlayerRuntimeRestorePoint(runtime.value);
}

function restoreCheckpoint(restorePoint: PlayerRuntimeRestorePoint): void {
  runtime.value = restorePlayerRuntimeSession(restorePoint);
  sessionTimeOriginMs = performance.now() - runtime.value.snapshot.currentSessionTimeMs;
  dispatch({ type: "set-composer", value: "" });
  focusComposerForActiveTypedInteraction(true);
  scheduleTimeObservation();
}

function observeCurrentTime(): void {
  const currentSessionTimeMs = Math.max(
    runtime.value.snapshot.currentSessionTimeMs,
    Math.floor(performance.now() - sessionTimeOriginMs),
  );
  const result = observePlayerRuntimeTime(runtime.value, currentSessionTimeMs);
  runtime.value = result.session;
  if (result.outcome.kind === "invalidObservation") setFeedback(result.outcome.message);
  focusComposerForActiveTypedInteraction(false);
  scheduleTimeObservation();
}

function scheduleTimeObservation(): void {
  if (timeTimer !== null) clearTimeout(timeTimer);
  const actions = [
    runtime.value.snapshot.foregroundAction,
    ...runtime.value.snapshot.backgroundActions,
  ];
  const deadlines = actions.flatMap((action) =>
    action?.kind === "delay" || action?.kind === "chatPacingGate" ? [action.deadlineMs] : [],
  );
  if (deadlines.length === 0) {
    timeTimer = null;
    return;
  }
  const nextDeadline = Math.min(...deadlines);
  const currentSessionTimeMs = Math.max(
    runtime.value.snapshot.currentSessionTimeMs,
    Math.floor(performance.now() - sessionTimeOriginMs),
  );
  const delay = Math.max(0, nextDeadline - currentSessionTimeMs);
  timeTimer = setTimeout(observeCurrentTime, Math.min(delay + 1, 2_147_483_647));
}

function observeAfterVisibilityChange(): void {
  if (document.visibilityState === "visible") observeCurrentTime();
}

onMounted(() => {
  scheduleTimeObservation();
  document.addEventListener("visibilitychange", observeAfterVisibilityChange);
});
onBeforeUnmount(() => {
  if (timeTimer !== null) clearTimeout(timeTimer);
  document.removeEventListener("visibilitychange", observeAfterVisibilityChange);
});

defineExpose({ restoreCheckpoint, saveCheckpoint });

function closeToolColumn(id: string): void {
  const collapsesPanel = state.value.toolColumns.length === 1;
  dispatch({ type: "close-tool-column", id });
  if (collapsesPanel) layout.closeLeft();
}
</script>

<template>
  <main
    ref="player"
    class="player fx-ambient"
    :data-chrome="layout.chrome.value"
    :data-compact-timers="String(layout.compactTimers.value)"
    :data-keyboard="layout.keyboard.value"
    :data-keyboard-geometry="layout.keyboardGeometry.value"
    :data-left="effectiveLeftMode"
    :data-media-fit="presentation.media.fit"
    :data-right="layout.rightMode.value"
    :data-right-backing="layout.rightBacking.value"
    :data-right-layout="layout.rightLayout.value"
    data-timer-kind="visible"
    :style="playerStyle"
    @pointercancel="forgetPlayerPointerTarget"
    @pointerdown="rememberPlayerPointerTarget"
    @pointermove="markPlayerPointerMoved"
    @pointerup="handlePlayerPointer"
  >
    <PlayerTitleBar
      :compact-timers="layout.compactTimers.value"
      :fullscreen-active="layout.fullscreenActive.value"
      :left-open="toolsAvailable && layout.leftOpen.value"
      :right-docked="layout.rightDocked.value"
      :timer="presentation.timer"
      :tools-available="toolsAvailable"
      @toggle-fullscreen="layout.toggleFullscreen"
      @toggle-left="layout.toggleLeft"
      @toggle-right="layout.toggleRight"
    />

    <PlayerTools
      v-if="toolsAvailable"
      :columns="state.toolColumns"
      :open="layout.leftOpen.value"
      :tools="toolDefinitions"
      @add="dispatch({ type: 'add-tool-column' })"
      @close="closeToolColumn"
      @dismiss="layout.closeLeft"
      @select="(id, toolId) => dispatch({ type: 'select-tool-column', id, toolId })"
    >
      <template #tool="{ toolId }">
        <p v-if="toolId === null" class="tool-placeholder">Choose a tool for this column.</p>
        <slot v-else name="tool" :tool-id="toolId">
          <p class="tool-placeholder">No content is available for this tool.</p>
        </slot>
      </template>
    </PlayerTools>

    <PlayerMedia :media="presentation.media" />

    <PlayerTranscript
      :entries="transcriptEntries"
      :revision="transcriptRevision"
      :speakers="transcriptSpeakers"
    />

    <PlayerForeground :foreground="foreground" @activate="activateForeground" />

    <PlayerComposer
      ref="composer"
      :feedback="state.composerFeedback"
      :foreground="foreground"
      :model-value="state.composerValue"
      :pacing-active="pacingGate !== null"
      @input-blur="layout.markInputBlurred"
      @skip-pacing="skipPacing"
      @submit="submitComposer"
      @touch-input="layout.markTouchInputExpected"
      @update:model-value="dispatch({ type: 'set-composer', value: $event })"
    />

    <PlayerRightRail
      :compact-timers="layout.compactTimers.value"
      :controls="state.rightControls"
      :timer="presentation.timer"
      @action="dispatch({ type: 'activate-right-action', controlId: $event })"
      @select="(controlId, value) => dispatch({ type: 'change-right-select', controlId, value })"
      @toggle="
        (controlId, checked) => dispatch({ type: 'change-right-toggle', controlId, checked })
      "
    />
  </main>
</template>
