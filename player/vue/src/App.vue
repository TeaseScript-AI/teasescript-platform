<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { createDemoHistoryMessages, DEMO_PRESENTATION } from "../../demo-session.js";
import type { PlayerPresentation, PlayerToolDefinition } from "../../model.js";
import type { PlayerRuntimeRestorePoint } from "../../runtime-adapter.js";
import PlayerCore from "./PlayerCore.vue";
import RuntimeSessionTool from "./components/RuntimeSessionTool.vue";
import TranscriptStressFixture from "./components/TranscriptStressFixture.vue";
import VisualLabTool from "./components/VisualLabTool.vue";
import LayoutDebugTool from "./devtools/LayoutDebugTool.vue";
import { createLayoutDebugOptions, type LayoutDebugOptions } from "./devtools/layoutDebug.js";
import type { PlayerDevelopmentOptions } from "./devtools/playerDevelopment.js";
import {
  createVisualLabState,
  resetVisualLabState,
  updateVisualLabControl,
  VISUAL_LAB_CONTROLS,
  type VisualLabActionTarget,
  type VisualLabControlValue,
} from "./devtools/visual-lab.js";
import { PLAYER_RUNTIME_SCENARIOS } from "./runtime-scenarios.js";

const presentation = ref<PlayerPresentation>(DEMO_PRESENTATION);
const baselinePresentation = ref<PlayerPresentation>(DEMO_PRESENTATION);
const playerCore = ref<InstanceType<typeof PlayerCore> | null>(null);
const runtimeSource = ref<string | null>(null);
const runtimeStatus = ref("Loading runtime source…");
const savedRestorePoint = ref<PlayerRuntimeRestorePoint | null>(null);
const fixture =
  typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("fixture");
const transcriptStressFixture = fixture === "transcript-stress";
const layoutDebugRequested =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("layout-debug") === "1";
const layoutDebugOptions = ref(createLayoutDebugOptions({ enabled: layoutDebugRequested }));
const visualLabState = ref(createVisualLabState(VISUAL_LAB_CONTROLS));
const PLAYER_DEVELOPMENT_TOOLS: readonly PlayerToolDefinition[] = Object.freeze([
  Object.freeze({ id: "visuals", label: "Visual Lab" }),
  Object.freeze({ id: "layout-debug", label: "Layout Debug" }),
  Object.freeze({ id: "runtime-session", label: "Runtime Session" }),
]);
const ACCENT_VALUES: Readonly<Record<string, string>> = Object.freeze({
  plum: "#8f3f5d",
  rose: DEMO_PRESENTATION.package.accentColor,
  teal: "#406f79",
});
const effectivePresentation = computed<PlayerPresentation>(() => {
  const accent = ACCENT_VALUES[stringSetting("accent")] ?? DEMO_PRESENTATION.package.accentColor;
  const media =
    stringSetting("stage-content") === "empty"
      ? { ...presentation.value.media, src: "", title: "Intentionally empty stage" }
      : presentation.value.media;
  return {
    ...presentation.value,
    package: { ...presentation.value.package, accentColor: accent },
    media,
  };
});
const developmentOptions = computed<PlayerDevelopmentOptions>(() => ({
  busyStyle: choiceSetting("busy-action", [
    "off",
    "pulse",
    "sweep",
    "dots",
    "corner-dot",
    "spinner",
    "wash",
  ]),
  busyTarget: choiceSetting("busy-control-target", ["action", "toggle", "select"]),
  controlsDisabled: stringSetting("ordinary-control-availability") === "disabled",
  historyEntries: createDemoHistoryMessages(numberSetting("history-messages")),
  mediaTransition: choiceSetting("media-transition", ["direct", "fade", "crossfade"]),
  rightControlsVisible: booleanSetting("right-rail-controls"),
  styleOverrides: Object.fromEntries(
    VISUAL_LAB_CONTROLS.flatMap((control) =>
      control.kind === "tuning"
        ? visualLabState.value.values[control.id] !== visualLabState.value.baseline[control.id]
          ? [[control.cssProperty, `${numberSetting(control.id)}${control.unit}`] as const]
          : []
        : [],
    ),
  ),
  timerCount: numberSetting("timer-count"),
  timerKind: choiceSetting("timer-presentation", ["visible", "mystery", "hidden"]),
}));

onMounted(async () => {
  if (transcriptStressFixture) return;
  const [media, source] = await Promise.all([loadDemoMedia(), loadRuntimeSource()]);
  if (media !== null) {
    presentation.value = { ...DEMO_PRESENTATION, media: { ...DEMO_PRESENTATION.media, ...media } };
    baselinePresentation.value = presentation.value;
  }
  if (source !== null) {
    runtimeSource.value = source;
    runtimeStatus.value = "Runtime source loaded.";
  }
});

function saveCheckpoint(): void {
  const restorePoint = playerCore.value?.saveCheckpoint();
  if (restorePoint === undefined) return;
  savedRestorePoint.value = restorePoint;
  runtimeStatus.value = "Runtime checkpoint saved.";
}

function restoreCheckpoint(): void {
  if (savedRestorePoint.value === null) {
    runtimeStatus.value = "No runtime checkpoint has been saved.";
    return;
  }
  playerCore.value?.restoreCheckpoint(savedRestorePoint.value);
  runtimeStatus.value = "Runtime checkpoint restored.";
}

function startRuntimeScenario(scenarioId: string): void {
  const scenario = PLAYER_RUNTIME_SCENARIOS.find((candidate) => candidate.id === scenarioId);
  if (scenario === undefined) throw new Error(`Unknown runtime scenario: ${scenarioId}`);
  playerCore.value?.startRuntimeSource(scenario.source);
  savedRestorePoint.value = null;
  runtimeStatus.value = `${scenario.label} runtime scenario started.`;
}

function updateVisualLab(controlId: string, value: VisualLabControlValue): void {
  visualLabState.value = updateVisualLabControl(
    VISUAL_LAB_CONTROLS,
    visualLabState.value,
    controlId,
    value,
  );
}

async function activateVisualLabAction(target: VisualLabActionTarget): Promise<void> {
  switch (target.kind) {
    case "reset-visual-tests":
      visualLabState.value = resetVisualLabState(visualLabState.value);
      presentation.value = baselinePresentation.value;
      playerCore.value?.resetVisualTests();
      savedRestorePoint.value = null;
      runtimeStatus.value = "Visual tests reset.";
      return;
    case "replace-demo-media": {
      const media = await loadDemoMedia();
      if (media !== null) {
        presentation.value = {
          ...presentation.value,
          media: { ...presentation.value.media, ...media },
        };
      }
      return;
    }
    case "simulate-script-update":
      playerCore.value?.simulateScriptUpdate(
        choiceSetting("script-update-target", ["toggle", "select"]),
        choiceSetting("script-update-feedback", ["toast", "highlight", "toast-highlight"]),
      );
      return;
    case "runtime-scenario":
      startRuntimeScenario(target.scenarioId);
  }
}

function stringSetting(controlId: string): string {
  const value = visualLabState.value.values[controlId];
  if (typeof value !== "string") throw new Error(`Visual Lab setting is not text: ${controlId}`);
  return value;
}

function choiceSetting<const T extends string>(controlId: string, allowed: readonly T[]): T {
  const value = stringSetting(controlId);
  const matched = allowed.find((candidate) => candidate === value);
  if (matched === undefined)
    throw new Error(`Visual Lab setting has an invalid choice: ${controlId}`);
  return matched;
}

function numberSetting(controlId: string): number {
  const value = visualLabState.value.values[controlId];
  if (typeof value !== "number") throw new Error(`Visual Lab setting is not numeric: ${controlId}`);
  return value;
}

function booleanSetting(controlId: string): boolean {
  const value = visualLabState.value.values[controlId];
  if (typeof value !== "boolean")
    throw new Error(`Visual Lab setting is not boolean: ${controlId}`);
  return value;
}

function updateLayoutDebug(options: LayoutDebugOptions): void {
  layoutDebugOptions.value = options;
}

async function loadRuntimeSource(): Promise<string | null> {
  if (fixture === "runtime-unskippable") {
    return 'say unskippable "Locked", 60\nsay "After", 60';
  }
  if (fixture === "runtime-skippable-long") {
    return 'say "Long pacing", 60\nsay "After", 60\nshowButton "Continue"';
  }
  if (fixture === "runtime-message-markup") {
    return 'say "# Heading\\n- **Bold** [spoiler]Secret[/spoiler] [Docs](https://example.com) <img src=x onerror=alert(1)>", instant';
  }
  try {
    const response = await fetch("/examples/playground/player-controls.tease", {
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(`Runtime source request failed with HTTP ${response.status}.`);
    return await response.text();
  } catch (error) {
    runtimeStatus.value =
      error instanceof Error ? error.message : "Runtime source could not be loaded.";
    return null;
  }
}

async function loadDemoMedia(): Promise<{
  readonly id: string;
  readonly src: string;
  readonly title: string;
} | null> {
  try {
    const response = await fetch("/player/demo-media/random", { cache: "no-store" });
    if (!response.ok) return null;
    const value = (await response.json()) as unknown;
    if (!isDemoMedia(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function isDemoMedia(
  value: unknown,
): value is { readonly id: string; readonly src: string; readonly title: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.src === "string" &&
    typeof candidate.title === "string"
  );
}
</script>

<template>
  <TranscriptStressFixture v-if="transcriptStressFixture" />
  <p v-else-if="runtimeSource === null" id="player-runtime-status" role="status">
    {{ runtimeStatus }}
  </p>
  <PlayerCore
    v-else
    ref="playerCore"
    :development="developmentOptions"
    :layout-debug-options="layoutDebugOptions"
    :presentation="effectivePresentation"
    :runtime-source="runtimeSource"
    :tools="PLAYER_DEVELOPMENT_TOOLS"
  >
    <template #tool="{ toolId, layoutDebugSnapshot }">
      <VisualLabTool
        v-if="toolId === 'visuals'"
        :registry="VISUAL_LAB_CONTROLS"
        :state="visualLabState"
        @action="(_controlId, target) => activateVisualLabAction(target)"
        @change="updateVisualLab"
      />
      <LayoutDebugTool
        v-else-if="toolId === 'layout-debug'"
        :options="layoutDebugOptions"
        :snapshot="layoutDebugSnapshot"
        @update:options="updateLayoutDebug"
      />
      <RuntimeSessionTool
        v-else-if="toolId === 'runtime-session'"
        :can-restore="savedRestorePoint !== null"
        :status="runtimeStatus"
        @restore="restoreCheckpoint"
        @save="saveCheckpoint"
      />
    </template>
  </PlayerCore>
</template>
