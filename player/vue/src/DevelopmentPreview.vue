<script setup lang="ts">
import { ref } from "vue";
import { Activity, FlaskConical, ScanLine, SlidersHorizontal } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { CapturedMediaRepository } from "../../captured-media.js";
import type { PlayerTimerKind } from "../../model.js";
import { createPlayerRuntimeSession, playerTemporalContext } from "../../runtime-adapter.js";
import { createLocalScriptStorage } from "../../script-storage.js";
import type { PlayerThemeIntent } from "../../theme/palette.js";
import BackgroundControlsFixture from "./BackgroundControlsFixture.vue";
import LayoutDebug from "./LayoutDebug.vue";
import PlayerApp from "./PlayerApp.vue";
import type { PlayerTool } from "./PlayerToolsShell.vue";
import { resolveDemoAsset } from "./demoHost";
import { resolveDevelopmentAsset } from "./developmentMedia";
import { cameraScenarioSource, openingScenario } from "./runtimeScenario";
import { stageFixtures } from "./stageFixtures";
import StageRightRail from "./StageRightRail.vue";
import ThemeLab from "./ThemeLab.vue";
import TimerFixtureRegion from "./TimerFixtureRegion.vue";
import TimerRegion from "./TimerRegion.vue";
import { browserStorage } from "./usePlayerPreference";
import { usePlayerSession } from "./usePlayerSession";
import { defaultPlayerThemeIntents } from "./usePlayerTheme";

// Development preview root; main.ts loads it on the development server or with `?dev`.
// Visual Lab holds temporary Owner A/B settings only; runtime content comes from a real script.
const tools: readonly PlayerTool[] = [
  { name: "Visual Lab", icon: FlaskConical },
  { name: "Layout Debug", icon: ScanLine },
  // Panels that exercise multi-panel arrangement and drawer behavior; Playback Diagnostics also lists the Player's
  // developer diagnostics, such as why the session camera is unavailable.
  { name: "Playback Diagnostics", icon: Activity },
  { name: "Media Playback Configuration", icon: SlidersHorizontal },
];
// "Runtime" shows the scenario's own Stage image; a fixture overrides it for layout comparison.
const mediaFixture = ref<keyof typeof stageFixtures | "Runtime">("Runtime");
const timerKind = ref<PlayerTimerKind>("visible");
const timerCount = ref(1);
const timerReset = ref(0);
const timerPaused = ref(true);
const backgroundControlsReset = ref(0);
const themeIntent = ref<PlayerThemeIntent>(defaultPlayerThemeIntents.light);

const props = defineProps<{ capturedMediaRepository?: CapturedMediaRepository | null }>();
// `?scenario=camera` opens the camera scenario with the session camera capability and persistent script storage, so
// a saved photo is shown again in a later run.
const cameraScenario = new URLSearchParams(window.location.search).get("scenario") === "camera";
const player = usePlayerSession({
  // The camera scenario speaks as the repository demo's Mistress and uses its images and sounds.
  resolveAsset: cameraScenario
    ? (path) => resolveDevelopmentAsset(path) ?? resolveDemoAsset(path)
    : resolveDevelopmentAsset,
  capabilities: { camera: cameraScenario },
  ...(cameraScenario && {
    scriptStorage: createLocalScriptStorage(browserStorage(), "development-camera"),
    capturedMedia: { repository: props.capturedMediaRepository ?? null },
  }),
});
const startOptions = () => ({ temporalContext: playerTemporalContext(), wallClockMs: Date.now() });
if (cameraScenario)
  void player
    .loadScriptStorage()
    .then(() =>
      player.prepare(() =>
        createPlayerRuntimeSession(cameraScenarioSource, {
          ...player.scriptStorageOptions(),
          ...startOptions(),
        }),
      ),
    );
else player.prepare(() => createPlayerRuntimeSession(openingScenario, startOptions()));
</script>

<template>
  <PlayerApp
    v-model:theme-intent="themeIntent"
    :player="player"
    :tools="tools"
    title="Evening by the coast"
    :media="mediaFixture === 'Runtime' ? undefined : stageFixtures[mediaFixture]"
  >
    <template #tool="{ tool, player: playerElement }">
      <LayoutDebug v-if="tool === 'Layout Debug' && playerElement" :player="playerElement" />
      <ul
        v-if="tool === 'Playback Diagnostics' && player.diagnostics.value.length > 0"
        class="space-y-2 p-4 text-sm"
        data-player-diagnostics
      >
        <li v-for="(diagnostic, index) in player.diagnostics.value" :key="index">
          <code>{{ diagnostic.code }}</code
          >: {{ diagnostic.message }}
        </li>
      </ul>
      <div v-if="tool === 'Visual Lab'" class="space-y-4 p-4 text-sm">
        <ThemeLab v-model:intent="themeIntent" />
        <label class="grid gap-2">
          Stage media fixture
          <select v-model="mediaFixture" class="min-w-0 rounded border bg-card p-2">
            <option>Runtime</option>
            <option v-for="(_, name) in stageFixtures" :key="name">{{ name }}</option>
          </select>
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
      </div>
    </template>
    <template #right-rail="{ timers }">
      <StageRightRail>
        <!-- Fixtures fill the rail only while no runtime timer is presented. -->
        <template v-if="timers.length" #timers>
          <TimerRegion :timers="timers" />
        </template>
        <template v-else #timers>
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
