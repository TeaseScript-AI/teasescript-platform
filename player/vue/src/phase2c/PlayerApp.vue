<script setup lang="ts">
import { computed, provide, ref } from "vue";
import { useEventListener, useResizeObserver } from "@vueuse/core";
import SidebarTrigger from "@/components/ui/sidebar/SidebarTrigger.vue";
import type { PlayerSpeakerPresentation, PlayerTranscriptEntryPresentation } from "../../../model.js";
import type { PlayerThemeIntent } from "../../../theme/palette.js";
import PlayerComposition from "./PlayerComposition.vue";
import PlayerToolsShell, { type PlayerTool } from "./PlayerToolsShell.vue";
import PlayerTopBar from "./PlayerTopBar.vue";
import RuntimeInteraction from "./RuntimeInteraction.vue";
import Stage from "./Stage.vue";
import { enhancedTranscriptContrast } from "./transcriptContrast";
import { usePlayerKeyboardFocus } from "./usePlayerKeyboardFocus";
import type { PlayerSessionHost } from "./usePlayerSession";
import { defaultPlayerThemeIntent, usePlayerTheme } from "./usePlayerTheme";

// Product Player composition. Development fixtures supply content only through these props and
// slots from DevelopmentPreview.vue, which production builds do not import.
const props = withDefaults(
  defineProps<{
    player: PlayerSessionHost;
    title?: string;
    media?: { src: string; alt: string } | undefined;
    tools?: readonly PlayerTool[];
    initialStageSize?: number;
    // Session-free transcript content whose composer replies are emitted as `preview-submit`.
    previewTranscript?: {
      readonly entries: readonly PlayerTranscriptEntryPresentation[];
      readonly speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
    };
  }>(),
  { title: "", tools: () => [], initialStageSize: 60 },
);
defineEmits<{ "preview-submit": [text: string] }>();
const themeIntent = defineModel<PlayerThemeIntent>("themeIntent", {
  default: () => defaultPlayerThemeIntent,
});

usePlayerKeyboardFocus();
provide(
  enhancedTranscriptContrast,
  computed(() => themeIntent.value.contrast === "high"),
);
usePlayerTheme(themeIntent);
function toggleThemeMode() {
  themeIntent.value = {
    ...themeIntent.value,
    mode: themeIntent.value.mode === "dark" ? "light" : "dark",
  };
}

const session = computed(() => props.player.session.value);
const noSpeakers: Readonly<Record<string, PlayerSpeakerPresentation>> = Object.freeze({});
const transcript = computed(() =>
  session.value
    ? {
        key: `runtime-${props.player.generation.value}`,
        entries: session.value.transcriptEntries,
        speakers: session.value.speakers,
        revision: session.value.transcriptRevision,
      }
    : {
        key: "preview",
        entries: props.previewTranscript?.entries ?? [],
        speakers: props.previewTranscript?.speakers ?? noSpeakers,
        revision: 0,
      },
);

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
  >
    <template #tool="scope">
      <slot name="tool" v-bind="scope" />
    </template>
    <template #default="{ sidebarVisible }">
      <PlayerComposition :initial-stage-size="initialStageSize">
        <template #topbar>
          <PlayerTopBar
            :title="title"
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
          <Stage ref="stage" :media="media" @media-aspect="mediaAspect = $event">
            <template #right-rail>
              <slot name="right-rail" />
            </template>
          </Stage>
        </template>

        <RuntimeInteraction
          :session="session"
          :reset="player.interactionReset.value"
          :preview="!!previewTranscript"
          :transcript-key="transcript.key"
          :entries="transcript.entries"
          :speakers="transcript.speakers"
          :revision="transcript.revision"
          @update:session="player.update"
          @preview-submit="$emit('preview-submit', $event)"
        />
      </PlayerComposition>
    </template>
  </PlayerToolsShell>
</template>
