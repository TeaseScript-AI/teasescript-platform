<script setup lang="ts">
import { computed, reactive, ref, shallowRef } from "vue";
import { useEventListener, useResizeObserver } from "@vueuse/core";
import ToolLifetimeFixture from "./ToolLifetimeFixture.vue";
import LayoutDebug from "./LayoutDebug.vue";
import ThemeLab from "./ThemeLab.vue";
import Stage from "./Stage.vue";
import PlayerTopBar from "./PlayerTopBar.vue";
import Transcript from "./Transcript.vue";
import ConversationSurface from "./ConversationSurface.vue";
import { bubbleFills, transcriptDesignDefaults } from "./transcriptDesign";
import RuntimeInteraction from "./RuntimeInteraction.vue";
import { transcriptFixtures, transcriptFixtureSpeakers } from "./transcriptFixtures";
import { createPlayerRuntimeSession, createPlayerRuntimeRestorePoint, restorePlayerRuntimeSession, type PlayerRuntimeSession, type PlayerRuntimeRestorePoint } from "../../../runtime-adapter.js";
import { runtimeScenario, interactionScenario } from "./runtimeScenario";
import { stageFixtures } from "./stageFixtures";
import type { PlayerTimerKind } from "../../../model.js";
import TimerFixtureRegion from "./TimerFixtureRegion.vue";
import StageRightRail from "./StageRightRail.vue";
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
const themeIntent = ref<PlayerThemeIntent>({
  mode: "light", contrast: "standard",
  surfaceHue: 70, surfaceTint: 0.5,
  surfaceMaxChroma: 8.5, monochrome: false,
  accentSeed: { l: 0.59208, c: 0.19138, h: 11.08 },
});
usePlayerTheme(themeIntent);
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
function restoreRuntime() {
  if (!runtimeRestore.value) return;
  interactionReset.value++;
  runtimeSession.value = restorePlayerRuntimeSession(runtimeRestore.value);
}
let nextMessage = 2000;
let firstMessage = 0;
// Reviewable message presentation choices for issue #421.
const transcriptDesign = reactive({ ...transcriptDesignDefaults });

function loadTranscript(count: number) {
  runtimeSession.value = null;
  firstMessage = 0;
  nextMessage = count;
  transcriptEntries.value = transcriptFixtures(0, count);
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
const transcript = ref<InstanceType<typeof Transcript> | null>(null);
const stage = ref<InstanceType<typeof Stage> | null>(null);
const stageHeight = ref(0);
const mediaAspect = ref(0);
// The grid owns Stage height. Its measurement positions the ambient fade and
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
            <fieldset class="grid gap-3">
              <legend class="mb-2">Message design</legend>
              <label class="grid gap-2">
                Speaker bubble
                <select v-model="transcriptDesign.speakerFill" class="min-w-0 rounded border bg-[var(--surface-component)] p-2">
                  <option v-for="fill in bubbleFills" :key="fill" :value="fill">{{ fill }}</option>
                </select>
              </label>
              <label class="grid gap-2">
                Player bubble
                <select v-model="transcriptDesign.playerFill" class="min-w-0 rounded border bg-[var(--surface-component)] p-2">
                  <option v-for="fill in bubbleFills" :key="fill" :value="fill">{{ fill }}</option>
                </select>
              </label>
            </fieldset>
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
            </fieldset>
            <fieldset class="grid min-w-0 gap-2">
              <legend class="mb-2">Transcript fixtures</legend>
              <Button class="min-w-0" variant="outline" :disabled="!!runtimeSession" @click="appendTranscript">Append message</Button>
              <Button class="min-w-0" variant="outline" :disabled="!!runtimeSession" @click="prependTranscript">Prepend 50 messages</Button>
              <Button class="min-w-0" variant="outline" @click="loadTranscript(0)">Empty history</Button>
              <Button class="min-w-0" variant="outline" @click="loadTranscript(10000)">Load 10,000 messages</Button>
            </fieldset>
            <fieldset class="grid min-w-0 gap-2">
              <legend class="mb-2">Runtime transcript scenario</legend>
              <Button class="min-w-0" variant="outline" @click="startRuntime()">Start runtime scenario</Button>
              <Button class="min-w-0" variant="outline" @click="startRuntime(interactionScenario)">Start interaction scenario</Button>
              <template v-if="runtimeSession">
                <Button class="min-w-0" variant="outline" @click="runtimeRestore = createPlayerRuntimeRestorePoint(runtimeSession)">Capture runtime checkpoint</Button>
                <Button class="min-w-0" variant="outline" :disabled="!runtimeRestore" @click="restoreRuntime">Restore runtime checkpoint</Button>
              </template>
            </fieldset>
          </div>
    </template>
    <template #default="{ sidebarVisible }">
      <div class="player-composition relative">
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
        <Stage ref="stage"
          :media="stageFixtures[mediaFixture]"
          @media-aspect="mediaAspect = $event"
        >
          <template #right-rail>
            <StageRightRail v-if="isDevelopment">
              <template #timers>
                <TimerFixtureRegion :kind="timerKind" :count="timerCount" :reset="timerReset" :paused="timerPaused" />
              </template>
            </StageRightRail>
          </template>
        </Stage>

        <ConversationSurface @margin-wheel="transcript?.scrollFromMargin($event)">
          <template #default="{ bottomInset }">
            <Transcript ref="transcript" :bottom-inset="bottomInset" :key="runtimeSession ? `runtime-${runtimeGeneration}` : 'fixtures'" :entries="runtimeSession?.transcriptEntries ?? transcriptEntries" :speakers="runtimeSession?.speakers ?? transcriptFixtureSpeakers" :revision="runtimeSession?.transcriptRevision ?? 0" :design="transcriptDesign" />
          </template>
          <template #interaction><RuntimeInteraction v-model:session="runtimeSession" :reset="interactionReset" :preview="isDevelopment" @preview-submit="appendPreviewResponse" /></template>
        </ConversationSurface>
      </div>
    </template>
  </PlayerToolsShell>
</template>
