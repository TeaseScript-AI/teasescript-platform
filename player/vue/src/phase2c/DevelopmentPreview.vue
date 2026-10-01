<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";
import { Activity, FlaskConical, ScanLine, SlidersHorizontal } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { PlayerTimerKind } from "../../../model.js";
import {
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  submitPlayerRuntimeComposer,
  type PlayerRuntimeRestorePoint,
  type PlayerRuntimeSession,
} from "../../../runtime-adapter.js";
import type { PlayerThemeIntent } from "../../../theme/palette.js";
import BackgroundControlsFixture from "./BackgroundControlsFixture.vue";
import LayoutDebug from "./LayoutDebug.vue";
import PlayerApp from "./PlayerApp.vue";
import type { PlayerTool } from "./PlayerToolsShell.vue";
import {
  avatarScenario,
  buttonScenario,
  interactionScenario,
  runtimeScenario,
  spacingScenario,
} from "./runtimeScenario";
import { stageFixtures } from "./stageFixtures";
import StageRightRail from "./StageRightRail.vue";
import ThemeLab from "./ThemeLab.vue";
import TimerFixtureRegion from "./TimerFixtureRegion.vue";
import ToolLifetimeFixture from "./ToolLifetimeFixture.vue";
import {
  transcriptAuthoredFixtures,
  transcriptFixtures,
  transcriptFixtureSpeakers,
  transcriptMarkupFixtures,
  transcriptProseFixtures,
} from "./transcriptFixtures";
import { usePlayerSession } from "./usePlayerSession";
import { defaultPlayerThemeIntent } from "./usePlayerTheme";

// Development preview root; main.ts loads it on the development server or with `?dev`.
const tools: readonly PlayerTool[] = [
  { name: "Visual Lab", icon: FlaskConical },
  { name: "Layout Debug", icon: ScanLine },
  // Empty panels that exercise multi-panel arrangement and drawer behavior.
  { name: "Playback Diagnostics", icon: Activity },
  { name: "Media Playback Configuration", icon: SlidersHorizontal },
];
// Opt-in browser-test content; never populate the normal settings surface with fixtures.
const previewParams = new URLSearchParams(window.location.search);
const toolStateFixture = previewParams.has("tool-state-fixture");
const feedbackSample = previewParams.get("feedback-demo") === "composer";
const spacingSample = previewParams.has("spacing-sample") || feedbackSample;
const mediaFixture = ref<keyof typeof stageFixtures>("Landscape");
const longTitle = ref(false);
const timerKind = ref<PlayerTimerKind>("visible");
const timerCount = ref(1);
const timerReset = ref(0);
const timerPaused = ref(true);
const backgroundControlsReset = ref(0);
const themeIntent = ref<PlayerThemeIntent>(defaultPlayerThemeIntent);

const player = usePlayerSession();
const runtimeSession = player.session;
const runtimeRestore = shallowRef<PlayerRuntimeRestorePoint | null>(null);
function setRuntimeSession(session: PlayerRuntimeSession) {
  player.start(session);
  runtimeRestore.value = createPlayerRuntimeRestorePoint(session);
}
function startRuntime(source = runtimeScenario) {
  setRuntimeSession(createPlayerRuntimeSession(source));
}
function startSpacingSample() {
  const session = createPlayerRuntimeSession(spacingScenario);
  const reply = submitPlayerRuntimeComposer(session, "Let's see what is near the lighthouse.");
  if (!reply || reply.outcome.kind !== "completed") throw new Error("Spacing sample reply failed");
  setRuntimeSession(reply.session);
}
if (spacingSample) startSpacingSample();
else startRuntime(buttonScenario);
function restoreRuntime() {
  if (runtimeRestore.value) player.restore(runtimeRestore.value);
}

const transcriptEntries = ref(transcriptFixtures(0, 2000));
const previewTranscript = computed(() => ({
  entries: transcriptEntries.value,
  speakers: transcriptFixtureSpeakers,
}));
let nextMessage = 2000;
let firstMessage = 0;
function showFixtures(entries: typeof transcriptEntries.value) {
  player.clear();
  firstMessage = 0;
  transcriptEntries.value = entries;
  nextMessage = entries.length;
}
function appendTranscript() {
  transcriptEntries.value = [...transcriptEntries.value, ...transcriptFixtures(nextMessage++, 1)];
}
function appendPreviewResponse(text: string) {
  transcriptEntries.value = [
    ...transcriptEntries.value,
    { id: `message-${nextMessage++}`, kind: "message", speakerId: "user", text },
  ];
}
function prependTranscript() {
  firstMessage -= 50;
  transcriptEntries.value = [...transcriptFixtures(firstMessage, 50), ...transcriptEntries.value];
}
</script>

<template>
  <PlayerApp
    v-model:theme-intent="themeIntent"
    :player="player"
    :tools="tools"
    :title="
      longTitle
        ? 'An evening by the coast — a quiet moment before the journey begins'
        : 'Evening by the coast'
    "
    :media="stageFixtures[mediaFixture]"
    :initial-stage-size="spacingSample ? 45 : 60"
    :preview-transcript="previewTranscript"
    @preview-submit="appendPreviewResponse"
  >
    <template #tool="{ tool, player: playerElement }">
      <ToolLifetimeFixture v-if="toolStateFixture && tool === 'Layout Debug'" />
      <LayoutDebug v-else-if="tool === 'Layout Debug' && playerElement" :player="playerElement" />
      <div v-if="tool === 'Visual Lab'" class="space-y-4 p-4 text-sm">
        <ThemeLab v-model:intent="themeIntent" />
        <label class="grid gap-2">
          Stage media fixture
          <select v-model="mediaFixture" class="min-w-0 rounded border bg-card p-2">
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
            <select
              v-model="timerKind"
              data-timer-fixture-kind
              class="min-w-0 rounded border bg-card p-2"
            >
              <option value="visible">Visible</option>
              <option value="mystery">Mystery</option>
              <option value="hidden">Hidden</option>
            </select>
          </label>
          <label class="grid gap-2">
            Timers
            <select
              v-model.number="timerCount"
              data-timer-fixture-count
              class="min-w-0 rounded border bg-card p-2"
            >
              <option :value="1">One</option>
              <option :value="3">Three</option>
            </select>
          </label>
          <label class="flex items-center gap-2">
            <input v-model="timerPaused" type="checkbox" /> Pause timer fixtures
          </label>
          <Button class="min-w-0" variant="outline" @click="timerReset++">Reset timers</Button>
          <Button class="min-w-0" variant="outline" @click="backgroundControlsReset++"
            >Reset background buttons</Button
          >
        </fieldset>
        <fieldset class="grid min-w-0 gap-2">
          <legend class="mb-2">Transcript fixtures</legend>
          <Button
            class="min-w-0"
            variant="outline"
            :disabled="!!runtimeSession"
            @click="appendTranscript"
            >Append message</Button
          >
          <Button
            class="min-w-0"
            variant="outline"
            :disabled="!!runtimeSession"
            @click="prependTranscript"
            >Prepend 50 messages</Button
          >
          <Button class="min-w-0" variant="outline" @click="showFixtures(transcriptFixtures(0, 0))"
            >Empty history</Button
          >
          <Button class="min-w-0" variant="outline" @click="showFixtures(transcriptFixtures(0, 2000))"
            >Load 2,000 messages</Button
          >
          <Button class="min-w-0" variant="outline" @click="showFixtures(transcriptFixtures(0, 10000))"
            >Load 10,000 messages</Button
          >
          <Button class="min-w-0" variant="outline" @click="showFixtures(transcriptMarkupFixtures())">Markup sample</Button>
          <Button class="min-w-0" variant="outline" @click="showFixtures(transcriptProseFixtures())">Prose sample</Button>
          <Button class="min-w-0" variant="outline" @click="showFixtures(transcriptAuthoredFixtures())"
            >Authored colour sample</Button
          >
        </fieldset>
        <fieldset class="grid min-w-0 gap-2">
          <legend class="mb-2">Runtime transcript scenario</legend>
          <Button class="min-w-0" variant="outline" @click="startSpacingSample"
            >Start spacing sample</Button
          >
          <Button class="min-w-0" variant="outline" @click="startRuntime()"
            >Start runtime scenario</Button
          >
          <Button class="min-w-0" variant="outline" @click="startRuntime(buttonScenario)"
            >Start button demo</Button
          >
          <Button class="min-w-0" variant="outline" @click="startRuntime(interactionScenario)"
            >Start interaction scenario</Button
          >
          <Button class="min-w-0" variant="outline" @click="startRuntime(avatarScenario)"
            >Start avatar sample</Button
          >
          <template v-if="runtimeSession">
            <Button
              class="min-w-0"
              variant="outline"
              @click="runtimeRestore = createPlayerRuntimeRestorePoint(runtimeSession)"
              >Capture runtime checkpoint</Button
            >
            <Button
              class="min-w-0"
              variant="outline"
              :disabled="!runtimeRestore"
              @click="restoreRuntime"
              >Restore runtime checkpoint</Button
            >
          </template>
        </fieldset>
      </div>
    </template>
    <template #right-rail>
      <StageRightRail>
        <template #timers>
          <TimerFixtureRegion
            :kind="timerKind"
            :count="timerCount"
            :reset="timerReset"
            :paused="timerPaused"
          />
        </template>
        <template #controls>
          <BackgroundControlsFixture :key="backgroundControlsReset" />
        </template>
      </StageRightRail>
    </template>
  </PlayerApp>
</template>
