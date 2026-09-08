<script setup lang="ts">
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { CSSProperties } from "vue";
import type {
  PlayerPresentation,
  PlayerToolDefinition,
  PlayerTranscriptEntryPresentation,
} from "../../model.js";
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
import PlayerBackgroundControls from "./components/PlayerBackgroundControls.vue";
import PlayerComposer from "./components/PlayerComposer.vue";
import PlayerForeground from "./components/PlayerForeground.vue";
import PlayerGlobalBar from "./components/PlayerGlobalBar.vue";
import PlayerMedia from "./components/PlayerMedia.vue";
import PlayerTimer from "./components/PlayerTimer.vue";
import PlayerTools from "./components/PlayerTools.vue";
import PlayerTranscript from "./components/PlayerTranscript.vue";
import { TooltipProvider } from "./components/ui/tooltip/index.js";
import { usePlayerLayout } from "./composables/usePlayerLayout.js";
import PlayerLayoutDebugOverlay from "./devtools/PlayerLayoutDebugOverlay.vue";
import type { LayoutDebugOptions } from "./devtools/layoutDebug.js";
import type {
  PlayerDevelopmentOptions,
  ScriptUpdateFeedback,
  ScriptUpdateTarget,
} from "./devtools/playerDevelopment.js";
import { usePlayerLayoutDebug } from "./devtools/usePlayerLayoutDebug.js";
import {
  createPlayerCoreState,
  reducePlayerCoreState,
  replaceRuntimeTranscriptEntries,
  type PlayerCoreAction,
} from "./state.js";

const props = defineProps<{
  presentation: PlayerPresentation;
  runtimeSource: string;
  development: PlayerDevelopmentOptions;
  layoutDebugOptions: LayoutDebugOptions;
  tools?: readonly PlayerToolDefinition[];
}>();

const player = ref<HTMLElement | null>(null);
const composer = ref<InstanceType<typeof PlayerComposer> | null>(null);
const toolDefinitions = computed<readonly PlayerToolDefinition[]>(() => {
  return props.tools ?? [];
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
const presentationTranscriptEntries = shallowRef<readonly PlayerTranscriptEntryPresentation[]>([
  ...runtime.value.transcriptEntries,
]);
const transcriptRevision = ref(runtime.value.transcriptRevision);
/*
  Runtime speakers own runtime output. Presentation speakers stay available
  underneath so development history fixtures still resolve an identity instead
  of rendering an empty avatar and name slot.
*/
const transcriptSpeakers = computed(() => {
  const presentationUser = props.presentation.speakers.user;
  const merged = { ...props.presentation.speakers, ...runtime.value.speakers };
  return presentationUser === undefined ? merged : { ...merged, user: presentationUser };
});
const layout = usePlayerLayout({ player });
const { snapshot: layoutDebugSnapshot } = usePlayerLayoutDebug(player);
const toolsAvailable = computed(() => toolDefinitions.value.length > 0);
const effectiveLeftMode = computed(() => (toolsAvailable.value ? layout.leftMode.value : "closed"));
const visibleRightControls = computed(() =>
  props.development.rightControlsVisible ? state.value.rightControls : [],
);
let sessionTimeOriginMs = performance.now() - runtime.value.snapshot.currentSessionTimeMs;
let timeTimer: ReturnType<typeof setTimeout> | null = null;
let scriptUpdateTimer: ReturnType<typeof setTimeout> | null = null;
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
      ...props.development.styleOverrides,
    }) as CSSProperties,
);
const displayedTranscriptEntries = computed(() => [
  ...props.development.historyEntries,
  ...presentationTranscriptEntries.value,
]);

function dispatch(action: PlayerCoreAction): void {
  const previousFixtureCount = state.value.fixtureTranscriptEntries.length;
  const nextState = reducePlayerCoreState(state.value, action);
  state.value = nextState;
  const appendedFixtureEntries = nextState.fixtureTranscriptEntries.slice(previousFixtureCount);
  if (appendedFixtureEntries.length !== 0) {
    presentationTranscriptEntries.value = [
      ...presentationTranscriptEntries.value,
      ...appendedFixtureEntries,
    ];
    transcriptRevision.value += 1;
  }
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
  applyRuntimeSession(result.session, false);
  if (result.outcome.kind === "completed") {
    dispatch({ type: "set-composer-feedback", message: "" });
    if (clearComposer) dispatch({ type: "set-composer", value: "" });
  } else {
    setFeedback(runtimeOutcomeMessage(result.outcome));
  }
  focusComposerForActiveTypedInteraction(false);
  scheduleTimeObservation();
}

function applyRuntimeSession(
  session: PlayerRuntimeControlResult["session"],
  restoring: boolean,
): void {
  runtime.value = session;
  if (restoring) {
    const restoredRuntimeIds = new Set(session.transcriptEntries.map((entry) => entry.id));
    const fixtureIds = new Set(state.value.fixtureTranscriptEntries.map((entry) => entry.id));
    const retainedTimeline = presentationTranscriptEntries.value.filter(
      (entry) => fixtureIds.has(entry.id) || restoredRuntimeIds.has(entry.id),
    );
    const retainedIds = new Set(retainedTimeline.map((entry) => entry.id));
    const missingRuntimeEntries = session.transcriptEntries.filter(
      (entry) => !retainedIds.has(entry.id),
    );
    presentationTranscriptEntries.value =
      missingRuntimeEntries.length === 0
        ? retainedTimeline
        : [...session.transcriptEntries, ...state.value.fixtureTranscriptEntries];
    transcriptRevision.value += 1;
    return;
  }

  const presentedIds = new Set(presentationTranscriptEntries.value.map((entry) => entry.id));
  const appendedRuntimeEntries = session.transcriptEntries.filter(
    (entry) => !presentedIds.has(entry.id),
  );
  if (appendedRuntimeEntries.length !== 0) {
    presentationTranscriptEntries.value = [
      ...presentationTranscriptEntries.value,
      ...appendedRuntimeEntries,
    ];
    transcriptRevision.value += 1;
  }
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
    target.classList.contains("transcript-virtualizer")
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
  applyRuntimeSession(restorePlayerRuntimeSession(restorePoint), true);
  sessionTimeOriginMs = performance.now() - runtime.value.snapshot.currentSessionTimeMs;
  focusComposerForActiveTypedInteraction(true);
  scheduleTimeObservation();
}

function startRuntimeSource(source: string): void {
  const session = createPlayerRuntimeSession(source);
  if (timeTimer !== null) {
    clearTimeout(timeTimer);
    timeTimer = null;
  }
  runtime.value = session;
  presentationTranscriptEntries.value = replaceRuntimeTranscriptEntries(
    state.value.fixtureTranscriptEntries,
    session.transcriptEntries,
  );
  transcriptRevision.value += 1;
  sessionTimeOriginMs = performance.now() - session.snapshot.currentSessionTimeMs;
  activeTypedActionId = typedInteractionActionId();
  focusComposerForActiveTypedInteraction(true);
  scheduleTimeObservation();
}

function resetVisualTests(): void {
  if (timeTimer !== null) {
    clearTimeout(timeTimer);
    timeTimer = null;
  }
  if (scriptUpdateTimer !== null) {
    clearTimeout(scriptUpdateTimer);
    scriptUpdateTimer = null;
  }
  state.value = createPlayerCoreState(
    props.presentation,
    toolDefinitions.value.map((tool) => tool.id),
  );
  const session = createPlayerRuntimeSession(props.runtimeSource);
  runtime.value = session;
  presentationTranscriptEntries.value = [...session.transcriptEntries];
  transcriptRevision.value += 1;
  sessionTimeOriginMs = performance.now() - session.snapshot.currentSessionTimeMs;
  activeTypedActionId = typedInteractionActionId();
  scheduleTimeObservation();
}

function simulateScriptUpdate(target: ScriptUpdateTarget, feedback: ScriptUpdateFeedback): void {
  dispatch({ type: "simulate-script-update", target, feedback });
  if (scriptUpdateTimer !== null) clearTimeout(scriptUpdateTimer);
  scriptUpdateTimer = setTimeout(() => {
    scriptUpdateTimer = null;
    dispatch({ type: "clear-script-update-feedback" });
  }, 1_600);
}

function observeCurrentTime(): void {
  const currentSessionTimeMs = Math.max(
    runtime.value.snapshot.currentSessionTimeMs,
    Math.floor(performance.now() - sessionTimeOriginMs),
  );
  const result = observePlayerRuntimeTime(runtime.value, currentSessionTimeMs);
  applyRuntimeSession(result.session, false);
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

/*
  A response lane or control tray that appears or disappears changes how much
  height the conversation can keep. Neither is a resize of an existing element,
  so the layout owner is told to re-solve the composition explicitly.
*/
watch(
  () => [foreground.value?.kind ?? null, visibleRightControls.value.length] as const,
  () => layout.refreshComposition(),
);

onMounted(() => {
  scheduleTimeObservation();
  document.addEventListener("visibilitychange", observeAfterVisibilityChange);
});
onBeforeUnmount(() => {
  if (timeTimer !== null) clearTimeout(timeTimer);
  if (scriptUpdateTimer !== null) clearTimeout(scriptUpdateTimer);
  document.removeEventListener("visibilitychange", observeAfterVisibilityChange);
});

defineExpose({
  restoreCheckpoint,
  saveCheckpoint,
  simulateScriptUpdate,
  startRuntimeSource,
  resetVisualTests,
});

function closeToolColumn(id: string): void {
  const collapsesPanel = state.value.toolColumns.length === 1;
  dispatch({ type: "close-tool-column", id });
  if (collapsesPanel) layout.closeLeft();
}
</script>

<template>
  <TooltipProvider :delay-duration="500" :skip-delay-duration="300">
    <main
      ref="player"
      class="player fx-ambient"
      :data-chrome="layout.chrome.value"
      :data-compact-timers="String(layout.compactTimers.value)"
      :data-conversation="layout.conversationDensity.value"
      :data-keyboard="layout.keyboard.value"
      :data-keyboard-geometry="layout.keyboardGeometry.value"
      :data-left="effectiveLeftMode"
      :data-media-fit="presentation.media.fit"
      :data-right="layout.rightMode.value"
      :data-right-backing="layout.rightBacking.value"
      :data-right-layout="layout.rightLayout.value"
      :data-theme="development.theme"
      :data-timer-kind="development.timerKind"
      :data-transcript-edge="development.transcriptEdge"
      :data-tools="layout.toolsGeometry.value"
      :data-tools-open="String(toolsAvailable && layout.leftOpen.value)"
      :style="playerStyle"
      @pointercancel="forgetPlayerPointerTarget"
      @pointerdown="rememberPlayerPointerTarget"
      @pointermove="markPlayerPointerMoved"
      @pointerup="handlePlayerPointer"
    >
      <PlayerMedia
        :media="presentation.media"
        :transition="development.mediaTransition"
        @natural-size="layout.observeStageMedia"
      >
        <template #stage-instruments>
          <PlayerTimer
            :timer="presentation.timer"
            :timer-count="development.timerCount"
            :timer-kind="development.timerKind"
          />
        </template>
      </PlayerMedia>

      <PlayerGlobalBar
        :fullscreen-active="layout.fullscreenActive.value"
        :left-open="toolsAvailable && layout.leftOpen.value"
        :right-docked="layout.rightDocked.value"
        title="TeaseScript Player"
        :tools-available="toolsAvailable"
        :tooltip-host="player"
        @toggle-fullscreen="layout.toggleFullscreen"
        @toggle-left="layout.toggleLeft"
        @toggle-right="layout.toggleRight"
      />

      <PlayerTools
        v-if="toolsAvailable"
        :columns="state.toolColumns"
        :open="layout.leftOpen.value"
        :overlay="layout.toolsGeometry.value === 'drawer'"
        :tools="toolDefinitions"
        :layout-debug-snapshot="layoutDebugSnapshot"
        @add="dispatch({ type: 'add-tool-column' })"
        @close="closeToolColumn"
        @dismiss="layout.closeLeft"
        @select="(id, toolId) => dispatch({ type: 'select-tool-column', id, toolId })"
      >
        <template #tool="{ toolId }">
          <p v-if="toolId === null" class="tool-placeholder">Choose a tool for this column.</p>
          <slot v-else name="tool" :layout-debug-snapshot="layoutDebugSnapshot" :tool-id="toolId">
            <p class="tool-placeholder">No content is available for this tool.</p>
          </slot>
        </template>
      </PlayerTools>

      <PlayerTranscript
        :entries="displayedTranscriptEntries"
        :revision="transcriptRevision"
        :speakers="transcriptSpeakers"
      />

      <!--
        The long-lived control group keeps one component and one markup across
        geometries. Only the sheet needs an anchored surface, so it borrows the
        shared Reka popover for positioning, focus return and dismissal instead
        of introducing a second overlay mechanism.
      -->
      <PlayerBackgroundControls
        v-if="layout.rightLayout.value !== 'sheet'"
        :busy-style="development.busyStyle"
        :busy-target="development.busyTarget"
        :controls="visibleRightControls"
        :controls-disabled="development.controlsDisabled"
        :script-update-control-id="state.scriptUpdateControlId"
        :script-update-feedback="state.scriptUpdateFeedback"
        @action="dispatch({ type: 'activate-right-action', controlId: $event })"
        @select="(controlId, value) => dispatch({ type: 'change-right-select', controlId, value })"
        @toggle="
          (controlId, checked) => dispatch({ type: 'change-right-toggle', controlId, checked })
        "
      />
      <PopoverRoot
        v-else-if="visibleRightControls.length > 0"
        :open="layout.sheetOpen.value"
        @update:open="layout.setSheetOpen"
      >
        <PopoverTrigger as-child>
          <button class="instrument-disclosure instrument" type="button" data-instrument-sheet>
            Controls
            <span class="instrument-disclosure-count">{{ visibleRightControls.length }}</span>
          </button>
        </PopoverTrigger>
        <PopoverPortal v-if="player !== null" :to="player">
          <PopoverContent
            class="instrument-sheet"
            side="top"
            align="start"
            :side-offset="8"
            :collision-padding="10"
          >
            <PlayerBackgroundControls
              :busy-style="development.busyStyle"
              :busy-target="development.busyTarget"
              :controls="visibleRightControls"
              :controls-disabled="development.controlsDisabled"
              :script-update-control-id="state.scriptUpdateControlId"
              :script-update-feedback="state.scriptUpdateFeedback"
              @action="dispatch({ type: 'activate-right-action', controlId: $event })"
              @select="
                (controlId, value) => dispatch({ type: 'change-right-select', controlId, value })
              "
              @toggle="
                (controlId, checked) =>
                  dispatch({ type: 'change-right-toggle', controlId, checked })
              "
            />
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>

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

      <div
        v-if="
          state.scriptUpdateNotice.length > 0 &&
          (state.scriptUpdateFeedback === 'toast' ||
            state.scriptUpdateFeedback === 'toast-highlight')
        "
        class="script-update-toast"
        role="status"
      >
        {{ state.scriptUpdateNotice }}
      </div>

      <PlayerLayoutDebugOverlay :options="layoutDebugOptions" :snapshot="layoutDebugSnapshot" />
    </main>
  </TooltipProvider>
</template>
