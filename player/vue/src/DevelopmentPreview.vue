<script setup lang="ts">
import { ref, type ShallowRef } from "vue";
import { Activity, FlaskConical, ScanLine, SlidersHorizontal } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { CapturedMediaRepository } from "../../captured-media.js";
import type { KeptRoomStore, KeptSessionStore } from "../../kept-sessions.js";
import type { PlayerTimerKind } from "../../model.js";
import { playerNoticeKeys, playerNotices, type PlayerNotice } from "../../notices.js";
import { createPlayerRuntimeSession, playerTemporalContext } from "../../runtime-adapter.js";
import { browserSavedData } from "../../saved-data.js";
import { createLocalScriptStorage } from "../../script-storage.js";
import type { PlayerThemeIntent } from "../../theme/palette.js";
import BackgroundControlsFixture from "./BackgroundControlsFixture.vue";
import { prepareHostedScript, type ScriptHost, type ScriptIdentity } from "./hostedScript";
import LayoutDebug from "./LayoutDebug.vue";
import PlayerApp from "./PlayerApp.vue";
import type { PlayerTool } from "./PlayerToolsShell.vue";
import type { ScriptFailure } from "./ScriptProblems.vue";
import { resolveDemoAsset } from "./demoHost";
import { resolveDevelopmentAsset } from "./developmentMedia";
import {
  cameraScenarioSource,
  openingScenario,
  permanentButtonsScenarioSource,
  viewfinderScenarioSource,
} from "./runtimeScenario";
import PermanentButtons from "./PermanentButtons.vue";
import { stageFixtures } from "./stageFixtures";
import StageRightRail from "./StageRightRail.vue";
import ThemeLab from "./ThemeLab.vue";
import TimerFixtureRegion from "./TimerFixtureRegion.vue";
import TimerRegion from "./TimerRegion.vue";
import { browserStorage } from "./usePlayerPreference";
import { usePlayerSession, type PlayerSessionStart } from "./usePlayerSession";
import { defaultPlayerThemeIntents } from "./usePlayerTheme";

// Development preview root; main.ts loads it on the development server or with `?dev`.
// Visual Lab holds temporary Owner A/B settings only; runtime content comes from a real script.
const query = new URLSearchParams(window.location.search);
// The explicit `?dev` opt-in starts with the Debug menu on, also on the development server, unless `debug=off`, so that
// play stays in the script's own room; `time=skip` starts Debug with auto-skip on.
const debug = {
  menu: query.has("dev") && query.get("debug") !== "off",
  autoSkip: query.get("time") === "skip",
};
// The preview opens the debug room (DEBUGGER.md "Debug room") while it starts with the Debug menu on, since Debug on in
// the normal room goes on in the debug room, and with `room=debug`.
const room = debug.menu || query.get("room") === "debug" ? "debug" : "normal";
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

const props = defineProps<{
  capturedMediaRepository?: CapturedMediaRepository | null;
  keptSessions?: KeptSessionStore;
  debugRooms?: KeptRoomStore;
  /** The package `?package=<id>` selects; the preview plays it instead of a development scenario. */
  packageHost?: ScriptHost | null;
}>();
// `?scenario=camera` opens the camera scenario with the session camera capability and persistent script storage, so
// a saved photo is shown again in a later run. `?scenario=viewfinder` opens the viewfinder scenario with the camera,
// and `?scenario=buttons` the permanent buttons scenario.
const packageHost = props.packageHost ?? null;
const scenario = packageHost === null ? query.get("scenario") : null;
const cameraScenario = scenario === "camera";
const viewfinderScenario = scenario === "viewfinder";
const buttonsScenario = scenario === "buttons";
const player = usePlayerSession(
  packageHost !== null
    ? {
        resolveAsset: packageHost.resolveAsset,
        scriptStorage: createLocalScriptStorage(browserStorage(), packageHost.storageScope),
        // As in the default build: an image the script saves a reference to stays in this browser for later runs.
        capturedMedia: { repository: props.capturedMediaRepository ?? null },
        savedData: browserSavedData(
          browserStorage(),
          props.capturedMediaRepository ?? null,
          props.keptSessions,
        ),
        ...(props.keptSessions && { keptSessions: props.keptSessions }),
        ...(props.debugRooms && { debugRooms: props.debugRooms }),
        room,
        debugPackage: { id: packageHost.storageScope, version: null },
      }
    : {
        // The camera scenarios speak as the repository demo's Mistress and use its images and sounds.
        resolveAsset:
          cameraScenario || viewfinderScenario || buttonsScenario
            ? (path) => resolveDevelopmentAsset(path) ?? resolveDemoAsset(path)
            : resolveDevelopmentAsset,
        capabilities: { camera: cameraScenario || viewfinderScenario },
        ...(cameraScenario && {
          scriptStorage: createLocalScriptStorage(browserStorage(), "development-camera"),
          capturedMedia: { repository: props.capturedMediaRepository ?? null },
          savedData: browserSavedData(
            browserStorage(),
            props.capturedMediaRepository ?? null,
            props.keptSessions,
          ),
          ...(props.debugRooms && { debugRooms: props.debugRooms }),
          room,
        }),
      },
);

// Notice preview: the Player's own wording for real conditions, plus an error sample that no condition reports yet.
const sampleNotices: readonly PlayerNotice[] = [
  { key: "preview-error", level: "error", message: "The camera stopped unexpectedly." },
  playerNotices.storageUnavailable(),
  playerNotices.audioBlocked(() => player.withdrawNotice(playerNoticeKeys.audioBlocked)),
  playerNotices.storageWriteFailed(),
];
function showSampleNotices() {
  for (const notice of sampleNotices) player.publishNotice(notice);
}
function clearSampleNotices() {
  for (const notice of sampleNotices) player.withdrawNotice(notice.key);
}
const startOptions = (recording: Parameters<PlayerSessionStart>[0]) => ({
  ...recording,
  temporalContext: playerTemporalContext(),
  wallClockMs: Date.now(),
});
// A package is compiled and prepared like in the default build; a scenario is a fixed development script.
let failure: ShallowRef<ScriptFailure | null> | null = null;
let identity: ShallowRef<ScriptIdentity> | null = null;
if (packageHost !== null) ({ failure, identity } = prepareHostedScript(player, packageHost));
else if (cameraScenario)
  void player
    .loadScriptStorage()
    .then(() =>
      player.prepare((recording) =>
        createPlayerRuntimeSession(cameraScenarioSource, {
          ...player.scriptStorageOptions(),
          ...startOptions(recording),
        }),
      ),
    );
else if (viewfinderScenario)
  player.prepare((recording) =>
    createPlayerRuntimeSession(viewfinderScenarioSource, startOptions(recording)),
  );
else if (buttonsScenario)
  player.prepare((recording) =>
    createPlayerRuntimeSession(permanentButtonsScenarioSource, startOptions(recording)),
  );
else
  player.prepare((recording) =>
    createPlayerRuntimeSession(openingScenario, startOptions(recording)),
  );
</script>

<template>
  <PlayerApp
    v-model:theme-intent="themeIntent"
    :player="player"
    :tools="tools"
    :title="packageHost === null ? 'Evening by the coast' : (identity?.title ?? '')"
    :author="identity?.author ?? ''"
    :failure="failure ?? null"
    :media="mediaFixture === 'Runtime' ? undefined : stageFixtures[mediaFixture]"
    :debug="debug"
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
        <fieldset class="grid min-w-0 gap-2" data-notice-preview>
          <legend class="mb-2">Player notices</legend>
          <Button class="min-w-0" variant="outline" @click="showSampleNotices"
            >Show every notice level</Button
          >
          <Button class="min-w-0" variant="outline" @click="clearSampleNotices"
            >Clear notices</Button
          >
        </fieldset>
      </div>
    </template>
    <template #right-rail="{ timers, buttons, press }">
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
        <!-- Likewise the fixture buttons, only while the script shows no permanent button. -->
        <template v-if="buttons.length" #controls>
          <PermanentButtons :buttons="buttons" @press="press" />
        </template>
        <template v-else #controls>
          <BackgroundControlsFixture :key="backgroundControlsReset" />
        </template>
      </StageRightRail>
    </template>
  </PlayerApp>
</template>
