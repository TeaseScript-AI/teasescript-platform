<script setup lang="ts">
import { computed, provide, ref, shallowRef } from "vue";
import { useEventListener, useResizeObserver } from "@vueuse/core";
import demoSource from "../../../demo.tease?raw";
import guideAvatarUrl from "../../../demo-assets/coastal-guide.svg?url";
import demoStageUrl from "../../../demo-assets/coast.svg?url";
import { createPlayerRuntimeSession } from "../../../runtime-adapter.js";
import type { PlayerThemeIntent } from "../../../theme/palette.js";
import { enhancedTranscriptContrast } from "./transcriptContrast";
import Stage from "./Stage.vue";
import PlayerComposition from "./PlayerComposition.vue";
import PlayerTopBar from "./PlayerTopBar.vue";
import RuntimeInteraction from "./RuntimeInteraction.vue";
import PlayerToolsShell from "./PlayerToolsShell.vue";
import SidebarTrigger from "@/components/ui/sidebar/SidebarTrigger.vue";
import { usePlayerTheme } from "./usePlayerTheme";
import { usePlayerKeyboardFocus } from "./usePlayerKeyboardFocus";
import { useRuntimeClock } from "./useRuntimeClock";
import { usePacingSkip } from "./usePacingSkip";

usePlayerKeyboardFocus();
const themeIntent = ref<PlayerThemeIntent>({
  mode: "light",
  contrast: "standard",
  surfaceHue: 70,
  surfaceTint: 0.5,
  surfaceMaxChroma: 8.5,
  monochrome: false,
  accentSeed: { l: 0.59208, c: 0.19138, h: 11.08 },
});
provide(enhancedTranscriptContrast, computed(() => themeIntent.value.contrast === "high"));
usePlayerTheme(themeIntent);
function toggleThemeMode() {
  themeIntent.value = {
    ...themeIntent.value,
    mode: themeIntent.value.mode === "dark" ? "light" : "dark",
  };
}

const runtimeSession = shallowRef(createPlayerRuntimeSession(demoSource));
const { resetOrigin } = useRuntimeClock(runtimeSession);
resetOrigin(runtimeSession.value);
const { skipFromBackground, skipFromComposer } = usePacingSkip(runtimeSession);
const speakers = computed(() =>
  Object.fromEntries(
    Object.entries(runtimeSession.value.speakers).map(([id, speaker]) => [
      id,
      speaker.avatarReference === "avatars/coastal-guide.svg"
        ? { ...speaker, avatarImageUrl: guideAvatarUrl }
        : speaker,
    ]),
  ),
);

const stage = ref<InstanceType<typeof Stage> | null>(null);
const stageHeight = ref(0);
const mediaAspect = ref(0);
useResizeObserver(
  computed(() => stage.value?.$el as HTMLElement | undefined),
  ([entry]) => {
    if (entry) stageHeight.value = entry.contentRect.height;
  },
);

const fullscreen = ref(document.fullscreenElement === document.documentElement);
const fullscreenSupported = document.fullscreenEnabled;
const fullscreenError = ref("");
useEventListener(document, "fullscreenchange", () => {
  fullscreen.value = document.fullscreenElement === document.documentElement;
});
async function toggleFullscreen() {
  fullscreenError.value = "";
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    document.querySelector<HTMLButtonElement>("[data-fullscreen-control]")?.focus({ preventScroll: true });
  } catch {
    fullscreenError.value = "Fullscreen could not be changed. Please try again.";
  }
}
</script>

<template>
  <PlayerToolsShell :stage-height="stageHeight" :media-aspect="mediaAspect" :fullscreen="fullscreen" :preview="false">
    <template #default="{ sidebarVisible }">
      <PlayerComposition @click="skipFromBackground" @keydown="skipFromComposer">
        <template #topbar>
          <PlayerTopBar
            title="Evening by the coast"
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
          <Stage ref="stage" :media="{ src: demoStageUrl, alt: 'Coast at dusk' }" @media-aspect="mediaAspect = $event" />
        </template>
        <RuntimeInteraction
          v-model:session="runtimeSession"
          :reset="0"
          transcript-key="demo"
          :entries="runtimeSession.transcriptEntries"
          :speakers="speakers"
          :revision="runtimeSession.transcriptRevision"
        />
      </PlayerComposition>
    </template>
  </PlayerToolsShell>
</template>
