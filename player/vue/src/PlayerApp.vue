<script setup lang="ts">
import { computed, provide, ref, watch } from "vue";
import { useEventListener, useResizeObserver } from "@vueuse/core";
import SidebarTrigger from "@/components/ui/sidebar/SidebarTrigger.vue";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import type { PlayerSpeakerPresentation } from "../../model.js";
import type { PlayerThemeIntent } from "../../theme/palette.js";
import PlayerComposition from "./PlayerComposition.vue";
import PlayerToolsShell, { type PlayerTool } from "./PlayerToolsShell.vue";
import PlayerTopBar from "./PlayerTopBar.vue";
import { playerRuntimeMedia } from "../../runtime-adapter.js";
import RuntimeInteraction from "./RuntimeInteraction.vue";
import ScriptProblems, { type ScriptFailure } from "./ScriptProblems.vue";
import SessionActivation from "./SessionActivation.vue";
import Stage from "./Stage.vue";
import StageRightRail from "./StageRightRail.vue";
import TimerRegion from "./TimerRegion.vue";
import { speakerAvatarSource } from "./speakerAvatar";
import { enhancedTranscriptContrast } from "./transcriptContrast";
import { usePlayerKeyboardFocus } from "./usePlayerKeyboardFocus";
import { usePlayerPreference } from "./usePlayerPreference";
import type { PlayerSessionHost } from "./usePlayerSession";
import { defaultPlayerThemeIntents, usePlayerTheme } from "./usePlayerTheme";

// Product Player composition. The development preview supplies tools, a Stage media override and the
// right rail only through these props and slots; production builds do not import it.
const props = withDefaults(
  defineProps<{
    player: PlayerSessionHost;
    title?: string;
    media?: { src: string; alt: string } | undefined;
    tools?: readonly PlayerTool[];
    /** Why the script cannot start; shown instead of Start. */
    failure?: ScriptFailure | null;
  }>(),
  { title: "", tools: () => [], failure: null },
);
const themeIntent = defineModel<PlayerThemeIntent>("themeIntent", {
  default: () => defaultPlayerThemeIntents.light,
});

usePlayerKeyboardFocus();
provide(
  enhancedTranscriptContrast,
  computed(() => themeIntent.value.contrast === "high"),
);
provide(speakerAvatarSource, props.player.resolveAsset);
usePlayerTheme(themeIntent);
// Each mode starts from its own default palette; the contrast choice carries over.
// Player Settings persist in this browser. Contrast is part of the theme intent; the
// title-bar A/B defaults to A.
const storedContrast = usePlayerPreference("player-contrast", ["standard", "high"], "standard");
const contrast = computed({
  get: () => themeIntent.value.contrast,
  set: (value) => (themeIntent.value = { ...themeIntent.value, contrast: value }),
});
// Sync both ways: Settings and Theme Lab edit the intent; another tab edits storage.
contrast.value = storedContrast.value;
watch(contrast, (value) => (storedContrast.value = value));
watch(storedContrast, (value) => {
  if (contrast.value !== value) contrast.value = value;
});
const titlebarOption = usePlayerPreference("player-titlebar-variant", ["left", "overlap"], "left");
function toggleThemeMode() {
  themeIntent.value = {
    ...defaultPlayerThemeIntents[themeIntent.value.mode === "dark" ? "light" : "dark"],
    contrast: themeIntent.value.contrast,
  };
}

const session = computed(() => props.player.session.value);
const savedData = computed(() =>
  props.player.hasScriptStorage
    ? {
        canClear: props.player.canClearScriptStorage.value,
        clear: props.player.clearScriptStorage,
      }
    : null,
);
const noSpeakers: Readonly<Record<string, PlayerSpeakerPresentation>> = Object.freeze({});
const transcript = computed(() =>
  session.value
    ? {
        key: `runtime-${props.player.generation.value}`,
        entries: session.value.transcriptEntries,
        speakers: session.value.speakers,
        revision: session.value.transcriptRevision,
      }
    : { key: "empty", entries: [], speakers: noSpeakers, revision: 0 },
);

// The Stage shows the runtime's Stage image; an authored image has no alternative text yet. A development
// override replaces it for layout comparison only.
const stageSource = computed(() => {
  const image = session.value ? playerRuntimeMedia(session.value.snapshot).stage.image : null;
  return image === null ? null : props.player.resolveAsset(image);
});
// Derived from the source string, so frequent observations keep the same object and the Stage does not reset its
// measured media aspect.
const runtimeStageMedia = computed(() =>
  stageSource.value === null ? undefined : { src: stageSource.value, alt: "" },
);
const stageMedia = computed(() => props.media ?? runtimeStageMedia.value);

const stage = ref<InstanceType<typeof Stage> | null>(null);
const stageHeight = ref(0);
const mediaAspect = ref(0);
// PlayerComposition owns Stage height. Its measurement positions the ambient fade and
// determines the contained image width; neither feeds back into the Stage track.
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
    // Full-document preview keeps body-portaled Reka surfaces in fullscreen too.
    // The production iframe must separately be granted fullscreen by its host.
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    document
      .querySelector<HTMLButtonElement>("[data-fullscreen-control]")
      ?.focus({ preventScroll: true });
  } catch {
    fullscreenError.value = "Fullscreen could not be changed. Please try again.";
  }
}
</script>

<template>
  <PlayerToolsShell
    :tools="tools"
    :stage-height="stageHeight"
    :media-aspect="mediaAspect"
    :fullscreen="fullscreen"
    :saved-data="savedData"
    v-model:contrast="contrast"
    v-model:titlebar-option="titlebarOption"
  >
    <template #tool="scope">
      <slot name="tool" v-bind="scope" />
    </template>
    <template #default="{ sidebarVisible }">
      <PlayerComposition>
        <template #topbar>
          <PlayerTopBar
            :title="title"
            :fullscreen="fullscreen"
            :fullscreen-supported="fullscreenSupported"
            :fullscreen-error="fullscreenError"
            :theme-mode="themeIntent.mode"
            :option="titlebarOption"
            @toggle-fullscreen="toggleFullscreen"
            @toggle-theme-mode="toggleThemeMode"
          >
            <template v-if="!sidebarVisible" #tools>
              <Tooltip>
                <TooltipTrigger as-child>
                  <SidebarTrigger class="size-8" aria-label="Show sidebar" />
                </TooltipTrigger>
                <TooltipContent side="bottom">Show sidebar</TooltipContent>
              </Tooltip>
            </template>
          </PlayerTopBar>
        </template>
        <template #stage>
          <Stage ref="stage" :media="stageMedia" @media-aspect="mediaAspect = $event" />
        </template>
        <template #overlay>
          <ScriptProblems v-if="failure" :failure="failure" />
          <SessionActivation v-else :activation="player.activation.value" @activate="player.activate" />
        </template>
        <template #right-rail>
          <!-- Runtime timers are runtime-owned content; the preview may add fixtures around them. -->
          <slot name="right-rail" :timers="player.timers.value">
            <StageRightRail v-if="player.timers.value.length">
              <template #timers>
                <TimerRegion :timers="player.timers.value" />
              </template>
            </StageRightRail>
          </slot>
        </template>

        <RuntimeInteraction
          :session="session"
          :reset="player.interactionReset.value"
          :transcript-key="transcript.key"
          :entries="transcript.entries"
          :speakers="transcript.speakers"
          :revision="transcript.revision"
          :observe-time="player.observe"
          :audio-blocked="player.audioBlocked.value"
          @retry-audio="player.retryAudio"
          @update:session="player.update"
        />
      </PlayerComposition>
    </template>
  </PlayerToolsShell>
</template>
