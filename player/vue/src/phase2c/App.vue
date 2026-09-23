<script setup lang="ts">
import { computed, provide, ref, shallowRef } from "vue";
import type { InkContrastMethod } from "../../../theme/color.js";
import { playerInkComparison } from "@/components/playerInkComparison";
import { scrimComparison, type ScrimComparison } from "./scrimComparison";
import { useEventListener, useResizeObserver } from "@vueuse/core";
import ToolLifetimeFixture from "./ToolLifetimeFixture.vue";
import LayoutDebug from "./LayoutDebug.vue";
import ThemeLab from "./ThemeLab.vue";
import Stage from "./Stage.vue";
import PlayerComposition from "./PlayerComposition.vue";
import PlayerTopBar from "./PlayerTopBar.vue";
import RuntimeInteraction from "./RuntimeInteraction.vue";
import { transcriptAuthoredFixtures, transcriptFixtures, transcriptFixtureSpeakers, transcriptMarkupFixtures, transcriptProseFixtures } from "./transcriptFixtures";
import { createPlayerRuntimeSession, createPlayerRuntimeRestorePoint, restorePlayerRuntimeSession, type PlayerRuntimeSession, type PlayerRuntimeRestorePoint } from "../../../runtime-adapter.js";
import { runtimeScenario, interactionScenario, buttonScenario } from "./runtimeScenario";
import { stageFixtures } from "./stageFixtures";
import type { PlayerTimerKind } from "../../../model.js";
import TimerFixtureRegion from "./TimerFixtureRegion.vue";
import StageRightRail from "./StageRightRail.vue";
import BackgroundControlsFixture from "./BackgroundControlsFixture.vue";
import { Button } from "@/components/ui/button";
import SidebarTrigger from "@/components/ui/sidebar/SidebarTrigger.vue";
import type { PlayerThemeIntent } from "../../../theme/palette.js";
import PlayerToolsShell from "./PlayerToolsShell.vue";
import { usePlayerTheme } from "./usePlayerTheme";
import { usePlayerKeyboardFocus } from "./usePlayerKeyboardFocus";

usePlayerKeyboardFocus();

const isDevelopment = import.meta.env.DEV;
// Opt-in browser-test content; never populate the normal settings surface with fixtures.
const toolStateFixture = isDevelopment && new URLSearchParams(window.location.search).has("tool-state-fixture");
const mediaFixture = ref<keyof typeof stageFixtures>("Landscape");
const longTitle = ref(false);
const timerKind = ref<PlayerTimerKind>("visible");
const timerCount = ref(1);
const timerReset = ref(0);
const timerPaused = ref(true);
const backgroundControlsReset = ref(0);
const themeIntent = ref<PlayerThemeIntent>({
  mode: "light", contrast: "standard",
  surfaceHue: 70, surfaceTint: 0.5,
  surfaceMaxChroma: 8.5, monochrome: false,
  accentSeed: { l: 0.59208, c: 0.19138, h: 11.08 },
});
const inkMethod = ref<InkContrastMethod>("WCAG21");
provide(playerInkComparison, inkMethod);
const scrimPreview = ref<ScrimComparison>({ method: "WCAG21", apcaTarget: 75 });
provide(scrimComparison, scrimPreview);
usePlayerTheme(themeIntent, inkMethod);
function toggleThemeMode() {
  themeIntent.value = { ...themeIntent.value, mode: themeIntent.value.mode === "dark" ? "light" : "dark" };
}
function setThemeIntent(intent: PlayerThemeIntent) {
  themeIntent.value = intent;
}
const transcriptEntries = ref(transcriptFixtures(0, 2000));
const runtimeSession = shallowRef<PlayerRuntimeSession | null>(null);
const runtimeRestore = shallowRef<PlayerRuntimeRestorePoint | null>(null);
const runtimeGeneration = ref(0);
const interactionReset = ref(0);
function startRuntime(source = runtimeScenario) {
  runtimeGeneration.value++;
  interactionReset.value++;
  runtimeSession.value = createPlayerRuntimeSession(source);
  runtimeRestore.value = createPlayerRuntimeRestorePoint(runtimeSession.value);
}
if (isDevelopment) startRuntime(buttonScenario);
function restoreRuntime() {
  if (!runtimeRestore.value) return;
  interactionReset.value++;
  runtimeSession.value = restorePlayerRuntimeSession(runtimeRestore.value);
}
let nextMessage = 2000;
let firstMessage = 0;

function loadTranscript(count: number) {
  runtimeSession.value = null;
  firstMessage = 0;
  nextMessage = count;
  transcriptEntries.value = transcriptFixtures(0, count);
}
function loadMarkupSample() {
  runtimeSession.value = null;
  firstMessage = 0;
  transcriptEntries.value = transcriptMarkupFixtures();
  nextMessage = transcriptEntries.value.length;
}
function loadProseSample() {
  runtimeSession.value = null;
  firstMessage = 0;
  transcriptEntries.value = transcriptProseFixtures();
  nextMessage = transcriptEntries.value.length;
}
function loadAuthoredSample() {
  runtimeSession.value = null;
  firstMessage = 0;
  transcriptEntries.value = transcriptAuthoredFixtures();
  nextMessage = transcriptEntries.value.length;
}
function appendTranscript() {
  transcriptEntries.value = [...transcriptEntries.value, ...transcriptFixtures(nextMessage++, 1)];
}
function appendPreviewResponse(text: string) {
  transcriptEntries.value = [...transcriptEntries.value, {
    id: `message-${nextMessage++}`, kind: "message", speakerId: "user", text,
  }];
}
function prependTranscript() {
  firstMessage -= 50;
  transcriptEntries.value = [...transcriptFixtures(firstMessage, 50), ...transcriptEntries.value];
}
const stage = ref<InstanceType<typeof Stage> | null>(null);
const stageHeight = ref(0);
const mediaAspect = ref(0);
// PlayerComposition owns Stage height. Its measurement positions the ambient fade and
// determines the contained image width; neither feeds back into the Stage track.
useResizeObserver(computed(() => stage.value?.$el as HTMLElement | undefined), ([entry]) => { if (entry) stageHeight.value = entry.contentRect.height; });
const fullscreen = ref(document.fullscreenElement === document.documentElement);
const fullscreenSupported = document.fullscreenEnabled;
const fullscreenError = ref("");
useEventListener(document, "fullscreenchange", () => {
  fullscreen.value = document.fullscreenElement === document.documentElement;
});
async function toggleFullscreen() {
  fullscreenError.value = "";
  try {
    // Full-document preview keeps body-portaled Reka surfaces in fullscreen too.
    // The production iframe must separately be granted fullscreen by its host.
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    document.querySelector<HTMLButtonElement>("[data-fullscreen-control]")?.focus({ preventScroll: true });
  } catch {
    fullscreenError.value = "Fullscreen could not be changed. Please try again.";
  }
}
</script>

<template>
  <PlayerToolsShell :stage-height="stageHeight" :media-aspect="mediaAspect">
    <template #tool="{ tool, player }">
          <ToolLifetimeFixture v-if="toolStateFixture && tool === 'Layout Debug'" />
          <LayoutDebug v-else-if="isDevelopment && tool === 'Layout Debug' && player" :player="player" />
          <div v-if="isDevelopment && tool === 'Visual Lab'" class="space-y-4 p-4 text-sm">
            <label class="grid gap-2">
              Button text contrast
              <select v-model="inkMethod" aria-label="Button text contrast" class="min-w-0 rounded border bg-[var(--surface-component)] p-2">
                <option value="WCAG21">Current · WCAG</option>
                <option value="APCA">APCA · experiment</option>
              </select>
              <span class="text-xs">Compare story-button text only. Send and transcript keep their current appearance.</span>
            </label>
            <label class="grid gap-2">
              Transcript scrim contrast
              <select v-model="scrimPreview.method" aria-label="Transcript scrim contrast" class="min-w-0 rounded border bg-[var(--surface-component)] p-2">
                <option value="WCAG21">Current · WCAG 4.6:1</option>
                <option value="APCA">APCA · experiment</option>
              </select>
            </label>
            <label v-if="scrimPreview.method === 'APCA'" class="grid gap-2">
              APCA target · Lc {{ scrimPreview.apcaTarget }}
              <input v-model.number="scrimPreview.apcaTarget" aria-label="APCA scrim target" type="range" min="60" max="90" step="5" />
              <span class="text-xs">Visual trial. If neither black nor white reaches the target, the strongest attainable cover is used.</span>
            </label>
            <ThemeLab :intent="themeIntent"
              @update:intent="setThemeIntent" />
            <label class="grid gap-2">
              Stage media fixture
              <select v-model="mediaFixture" class="min-w-0 rounded border bg-[var(--surface-component)] p-2">
                <option v-for="(_, name) in stageFixtures" :key="name">{{ name }}</option>
              </select>
            </label>
            <label class="flex items-center gap-2">
              <input v-model="longTitle" type="checkbox" /> Long stage title
            </label>
            <fieldset class="grid min-w-0 gap-2">
              <legend class="mb-2">Timer fixtures</legend>
              <label class="grid gap-2">
                Presentation
                <select v-model="timerKind" data-timer-fixture-kind class="min-w-0 rounded border bg-[var(--surface-component)] p-2">
                  <option value="visible">Visible</option>
                  <option value="mystery">Mystery</option>
                  <option value="hidden">Hidden</option>
                </select>
              </label>
              <label class="grid gap-2">
                Timers
                <select v-model.number="timerCount" data-timer-fixture-count class="min-w-0 rounded border bg-[var(--surface-component)] p-2">
                  <option :value="1">One</option>
                  <option :value="3">Three</option>
                </select>
              </label>
              <label class="flex items-center gap-2">
                <input v-model="timerPaused" type="checkbox" /> Pause timer fixtures
              </label>
              <Button class="min-w-0" variant="outline" @click="timerReset++">Reset timers</Button>
              <Button class="min-w-0" variant="outline" @click="backgroundControlsReset++">Reset background buttons</Button>
            </fieldset>
            <fieldset class="grid min-w-0 gap-2">
              <legend class="mb-2">Transcript fixtures</legend>
              <Button class="min-w-0" variant="outline" :disabled="!!runtimeSession" @click="appendTranscript">Append message</Button>
              <Button class="min-w-0" variant="outline" :disabled="!!runtimeSession" @click="prependTranscript">Prepend 50 messages</Button>
              <Button class="min-w-0" variant="outline" @click="loadTranscript(0)">Empty history</Button>
              <Button class="min-w-0" variant="outline" @click="loadTranscript(2000)">Load 2,000 messages</Button>
              <Button class="min-w-0" variant="outline" @click="loadTranscript(10000)">Load 10,000 messages</Button>
              <Button class="min-w-0" variant="outline" @click="loadMarkupSample">Markup sample</Button>
              <Button class="min-w-0" variant="outline" @click="loadProseSample">Prose sample</Button>
              <Button class="min-w-0" variant="outline" @click="loadAuthoredSample">Authored colour sample</Button>
            </fieldset>
            <fieldset class="grid min-w-0 gap-2">
              <legend class="mb-2">Runtime transcript scenario</legend>
              <Button class="min-w-0" variant="outline" @click="startRuntime()">Start runtime scenario</Button>
              <Button class="min-w-0" variant="outline" @click="startRuntime(buttonScenario)">Start button demo</Button>
              <Button class="min-w-0" variant="outline" @click="startRuntime(interactionScenario)">Start interaction scenario</Button>
              <template v-if="runtimeSession">
                <Button class="min-w-0" variant="outline" @click="runtimeRestore = createPlayerRuntimeRestorePoint(runtimeSession)">Capture runtime checkpoint</Button>
                <Button class="min-w-0" variant="outline" :disabled="!runtimeRestore" @click="restoreRuntime">Restore runtime checkpoint</Button>
              </template>
            </fieldset>
          </div>
    </template>
    <template #default="{ sidebarVisible }">
      <PlayerComposition>
        <template #topbar>
          <PlayerTopBar
            :title="longTitle ? 'An evening by the coast — a quiet moment before the journey begins' : 'Evening by the coast'"
            :fullscreen="fullscreen"
            :fullscreen-supported="fullscreenSupported"
            :fullscreen-error="fullscreenError"
            :theme-mode="themeIntent.mode"
            @toggle-fullscreen="toggleFullscreen"
            @toggle-theme-mode="toggleThemeMode"
          >
            <template v-if="!sidebarVisible" #tools>
              <SidebarTrigger class="size-8" aria-label="Show sidebar" title="Show sidebar" />
            </template>
          </PlayerTopBar>
        </template>
        <template #stage>
          <Stage ref="stage"
            :media="stageFixtures[mediaFixture]"
            @media-aspect="mediaAspect = $event"
          >
            <template #right-rail>
              <StageRightRail v-if="isDevelopment">
                <template #timers>
                  <TimerFixtureRegion :kind="timerKind" :count="timerCount" :reset="timerReset" :paused="timerPaused" />
                </template>
                <template #controls>
                  <BackgroundControlsFixture :key="backgroundControlsReset" />
                </template>
              </StageRightRail>
            </template>
          </Stage>
        </template>

        <RuntimeInteraction v-model:session="runtimeSession" :reset="interactionReset" :preview="isDevelopment"
          :transcript-key="runtimeSession ? `runtime-${runtimeGeneration}` : 'fixtures'"
          :entries="runtimeSession?.transcriptEntries ?? transcriptEntries"
          :speakers="runtimeSession?.speakers ?? transcriptFixtureSpeakers"
          :revision="runtimeSession?.transcriptRevision ?? 0"
          @preview-submit="appendPreviewResponse" />
      </PlayerComposition>
    </template>
  </PlayerToolsShell>
</template>
