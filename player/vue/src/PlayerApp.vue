<script setup lang="ts">
import { computed, onErrorCaptured, provide, ref, watch } from "vue";
import { useEventListener, useResizeObserver } from "@vueuse/core";
import { Bug } from "@lucide/vue";
import SidebarTrigger from "@/components/ui/sidebar/SidebarTrigger.vue";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import type { PlayerSpeakerPresentation } from "../../model.js";
import type { PlayerThemeIntent } from "../../theme/palette.js";
import DebugPanel from "./DebugPanel.vue";
import DebugStorage from "./DebugStorage.vue";
import DebugStatus from "./DebugStatus.vue";
import FloatingViewfinder, { type FloatingPlace } from "./FloatingViewfinder.vue";
import ImageCapture from "./ImageCapture.vue";
import PlayerComposition from "./PlayerComposition.vue";
import PlayerNotificationCenter from "./PlayerNotificationCenter.vue";
import PlayerToasts from "./PlayerToasts.vue";
import PlayerToolsShell, { type PlayerTool } from "./PlayerToolsShell.vue";
import PlayerTopBar from "./PlayerTopBar.vue";
import PermanentButtons from "./PermanentButtons.vue";
import RuntimeInteraction from "./RuntimeInteraction.vue";
import ScriptProblems, { type ScriptFailure } from "./ScriptProblems.vue";
import SessionActivation from "./SessionActivation.vue";
import Stage from "./Stage.vue";
import StageRightRail from "./StageRightRail.vue";
import TimerRegion from "./TimerRegion.vue";
import { speakerAvatarSource } from "./speakerAvatar";
import { enhancedTranscriptContrast } from "./transcriptContrast";
import { explainValues } from "./explainValues";
import { usePlayerDebug } from "./usePlayerDebug";
import { debugStageImage } from "./debugStageImage";
import { playerRuntimeDebugNow } from "../../runtime-adapter.js";
import DebugExportDialog from "./DebugExportDialog.vue";
import RuntimeFailure from "./RuntimeFailure.vue";
import { useDebugExport } from "./useDebugExport";
import { playerNoticeKeys, playerNotices } from "../../notices.js";
import { usePlayerKeyboardFocus } from "./usePlayerKeyboardFocus";
import { usePlayerNotifications } from "./usePlayerNotifications";
import { usePlayerPreference } from "./usePlayerPreference";
import type { PlayerSessionHost } from "./usePlayerSession";
import { defaultPlayerThemeIntents, usePlayerTheme } from "./usePlayerTheme";

// Product Player composition. The development preview supplies tools, a Stage media override, the right rail and an
// overlay only through these props and slots; production builds do not import it.
const props = withDefaults(
  defineProps<{
    player: PlayerSessionHost;
    title?: string;
    media?: { src: string; alt: string } | undefined;
    tools?: readonly PlayerTool[];
    /** Why the script cannot start; shown instead of Start. */
    failure?: ScriptFailure | null;
    /** How Debug starts: the Debug menu, and auto-skip once Debug runs. Both are off unless the host asks (`?dev`). */
    debug?: { readonly menu: boolean; readonly autoSkip: boolean };
  }>(),
  { title: "", tools: () => [], failure: null, debug: () => ({ menu: false, autoSkip: false }) },
);
// The camera view's window keeps the place the user gave it, and the view its mirroring, while the Player is mounted.
const floatingPlace = ref<FloatingPlace | null>(null);
const viewfinderMirrored = ref(true);
// An image request takes its photo in the camera window the script shows, otherwise on the Stage, where it shows the
// camera instead of any camera view the script shows there.
const capture = computed(() => props.player.imageCapture.view.value);
const captureInWindow = computed(
  () => capture.value !== null && props.player.viewfinderPlacement.value === "window",
);
const stageCamera = computed(() =>
  capture.value && !captureInWindow.value
    ? capture.value.track
    : props.player.viewfinderPlacement.value === "stage"
      ? props.player.viewfinder.value
      : null,
);
const themeIntent = defineModel<PlayerThemeIntent>("themeIntent", {
  default: () => defaultPlayerThemeIntents.light,
});

usePlayerKeyboardFocus();
const notifications = usePlayerNotifications(props.player.notices);
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
// The Debug menu adds the Debug panel first in the tools menu.
const debug = usePlayerDebug(props.player, props.debug);
// A debug export for a developer, from the failure card, its notice, or Settings (DEBUGGER.md "Debug export").
const debugExport = useDebugExport(
  props.player,
  () => props.title,
  () => ({
    player: {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      coarsePointer: window.matchMedia("(any-pointer: coarse)").matches,
      hover: window.matchMedia("(any-hover: hover)").matches,
      theme: themeIntent.value.mode,
      contrast: themeIntent.value.contrast,
      activation: props.player.activation.value,
      userAgent: navigator.userAgent,
      language: navigator.language,
    },
    // What the Player observed, as Debug's Now view and the notices show it, also with the Debug panel closed.
    host: {
      stage: (({ status, path }) => ({ status, path }))(
        debugStageImage(props.player, {
          covered: stageCamera.value !== null,
          overridden: props.media !== undefined,
        }),
      ),
      media: (session.value === null
        ? []
        : playerRuntimeDebugNow(session.value, props.player.sceneTimeMs.value).media
      ).map(({ mediaId, media, loaded, state, source }) => ({
        mediaId,
        media,
        loaded,
        state,
        source,
      })),
      notices: props.player.notices.value.map(({ key, level, message }) => ({
        key,
        level,
        message,
      })),
      debugLog: debug.log.value?.lines.value.map((line) => line.text) ?? null,
    },
  }),
);
// Each opening mounts the dialog anew: a dialog stacks by when it was mounted, so it then stays above one mounted since
// the page loaded, such as Settings in the narrow tools drawer, which it opens from.
const debugExportOpening = ref(0);
function openDebugExport() {
  if (!debugExport.open.value) debugExportOpening.value += 1;
  debugExport.open.value = true;
}
// An exception in the Player's own interface is a Player error: it is reported and can be exported, and still logged.
onErrorCaptured((error) => {
  props.player.reportHostError(error);
});
// After an error the notice offers the export too, until a new session starts.
watch(
  () => [session.value?.snapshot.failure ?? null, props.player.hostError.value] as const,
  ([failure, hostError]) => {
    if (failure === null && hostError === null)
      props.player.withdrawNotice(playerNoticeKeys.sessionError);
    else
      props.player.publishNotice(
        playerNotices.sessionError(failure === null ? "player" : "script", openDebugExport),
      );
  },
);
const debugTool: PlayerTool = { name: "Debug", icon: Bug };
const toolsShell = ref<InstanceType<typeof PlayerToolsShell> | null>(null);
// Explain values on a chat message opens the Debug panel on its Variables tab.
provide(explainValues, {
  offers: debug.offers,
  explain(entryId) {
    if (debug.explain(entryId)) void toolsShell.value?.showTool(debugTool.name);
  },
});
const tools = computed(() => (debug.menu.value ? [debugTool, ...props.tools] : props.tools));
const savedData = computed(() =>
  props.player.hasSavedData
    ? {
        export: props.player.savedScripts,
        import: {
          available: props.player.canImportSavedData.value,
          sessionInProgress: props.player.sessionInProgress.value,
          review: props.player.reviewSavedDataImport,
          commit: props.player.importSavedData,
        },
        clear: props.player.hasScriptStorage
          ? {
              available: props.player.canClearScriptStorage.value,
              run: props.player.clearScriptStorage,
            }
          : null,
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
  const image = props.player.stageImage.value;
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
    ref="toolsShell"
    :tools="tools"
    :stage-height="stageHeight"
    :media-aspect="mediaAspect"
    :fullscreen="fullscreen"
    :saved-data="savedData"
    :debug-export="{ available: debugExport.available.value, open: openDebugExport }"
    v-model:contrast="contrast"
    v-model:titlebar-option="titlebarOption"
    v-model:debug-menu="debug.menu.value"
  >
    <template #tool="scope">
      <DebugPanel
        v-if="scope.tool === debugTool.name && debug.log.value"
        v-model:active="debug.active.value"
        v-model:tab="debug.tab.value"
        :explained="debug.explained.value"
        :time="debug.time.value"
        :log="debug.log.value"
        :player="player"
        :stage-covered="stageCamera !== null"
        :stage-overridden="media !== undefined"
        :export-available="debugExport.available.value"
        @export="openDebugExport"
      >
        <template v-if="player.hasScriptStorage" #storage>
          <DebugStorage :player="player" />
        </template>
      </DebugPanel>
      <slot v-else name="tool" v-bind="scope" />
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
            <template #notifications>
              <PlayerNotificationCenter
                :notifications="notifications.notifications.value"
                :attention-level="notifications.attentionLevel.value"
                :attention-count="notifications.attentionCount.value"
                @dismiss="player.dismissNotice"
                @open="notifications.markSeen"
              />
            </template>
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
          <Stage
            ref="stage"
            v-model:camera-mirrored="viewfinderMirrored"
            :media="stageMedia"
            :camera="stageCamera"
            @media-aspect="mediaAspect = $event"
            @media-load="player.stageImageLoad"
            @media-failure="player.stageImageFailure"
          >
            <template v-if="capture && !captureInWindow" #camera>
              <ImageCapture
                :view="capture"
                @shutter="player.imageCapture.shutter"
                @retake="player.imageCapture.retake"
                @use="player.imageCapture.use"
                @retry="player.imageCapture.retry"
              />
            </template>
          </Stage>
        </template>
        <template #overlay>
          <FloatingViewfinder
            v-if="
              player.viewfinderPlacement.value === 'window' &&
              (captureInWindow || player.viewfinder.value)
            "
            v-model:place="floatingPlace"
            v-model:mirrored="viewfinderMirrored"
            :track="captureInWindow ? capture!.track : player.viewfinder.value"
          >
            <ImageCapture
              v-if="captureInWindow"
              :view="capture!"
              @shutter="player.imageCapture.shutter"
              @retake="player.imageCapture.retake"
              @use="player.imageCapture.use"
              @retry="player.imageCapture.retry"
            />
          </FloatingViewfinder>
          <ScriptProblems v-if="failure" :failure="failure" />
          <SessionActivation
            v-else
            :activation="player.activation.value"
            @activate="player.activate"
          />
          <DebugExportDialog
            :key="debugExportOpening"
            :exporter="debugExport"
            :photo-url="player.resolveAsset"
          />
          <PlayerToasts
            :notifications="notifications.notifications.value"
            :seen-sequence="notifications.seenSequence.value"
            :theme-mode="themeIntent.mode"
          />
          <DebugStatus v-if="debug.log.value" :time="debug.time.value" :log="debug.log.value" />
          <slot name="overlay" />
        </template>
        <template #right-rail>
          <!-- Runtime timers and buttons are runtime-owned content; the preview may add fixtures around them. -->
          <slot
            name="right-rail"
            :timers="player.timers.value"
            :buttons="player.permanentButtons.value"
            :press="player.pressPermanentButton"
          >
            <StageRightRail
              v-if="player.timers.value.length || player.permanentButtons.value.length"
            >
              <template v-if="player.timers.value.length" #timers>
                <TimerRegion :timers="player.timers.value" />
              </template>
              <template v-if="player.permanentButtons.value.length" #controls>
                <PermanentButtons
                  :buttons="player.permanentButtons.value"
                  @press="player.pressPermanentButton"
                />
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
          :images="player.images"
          :debug-countdown="debug.countdownText.value"
          @update:session="player.update"
        >
          <template #end>
            <RuntimeFailure
              v-if="!failure && player.activation.value === null"
              :snapshot="session?.snapshot ?? null"
              :host-error="player.hostError.value"
              @export="openDebugExport"
            />
          </template>
        </RuntimeInteraction>
      </PlayerComposition>
    </template>
  </PlayerToolsShell>
</template>
