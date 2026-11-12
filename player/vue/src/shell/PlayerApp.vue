<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onErrorCaptured, provide, ref, watch } from "vue";
import { useEventListener, useResizeObserver } from "@vueuse/core";
import { Bug, SquareSplitHorizontal } from "@lucide/vue";
import SidebarTrigger from "@/components/ui/sidebar/SidebarTrigger.vue";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import type { PlayerSpeakerPresentation } from "../../../presentation/model.js";
import type { PlayerThemeIntent } from "../../../theme/palette.js";
import { PHOTO_FAMILIES } from "../../../theme/photo-theme.js";
import AbTestsPanel from "./AbTestsPanel.vue";
import DebugPanel from "../debug/DebugPanel.vue";
import DebugStorage from "../debug/DebugStorage.vue";
import DebugStatus from "../debug/DebugStatus.vue";
import FloatingViewfinder, { type FloatingPlace } from "../stage/FloatingViewfinder.vue";
import ImageCapture from "../stage/ImageCapture.vue";
import PlayerComposition from "./PlayerComposition.vue";
import PlayerNotificationCenter from "../notifications/PlayerNotificationCenter.vue";
import PlayerToasts from "../notifications/PlayerToasts.vue";
import PlayerToolsShell, { type PlayerTool } from "./PlayerToolsShell.vue";
import PlayerTopBar from "./PlayerTopBar.vue";
import PermanentButtons from "../interaction/PermanentButtons.vue";
import RuntimeInteraction from "../interaction/RuntimeInteraction.vue";
import ScriptProblems, { type ScriptFailure } from "../start-and-end/ScriptProblems.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import SessionActivation from "../start-and-end/SessionActivation.vue";
import Stage from "../stage/Stage.vue";
import StageRightRail from "../stage/StageRightRail.vue";
import TimerRegion from "../interaction/TimerRegion.vue";
import { speakerAvatarFailure, speakerAvatarSource } from "../transcript/speakerAvatar";
import { enhancedTranscriptContrast } from "../transcript/transcriptContrast";
import { isRemovedEntry } from "../transcript/transcriptPresentation";
import { explainValues } from "../transcript/explainValues";
import { usePlayerDebug } from "../debug/usePlayerDebug";
import { debugStageImage } from "../debug/debugStageImage";
import { playerRuntimeCalls } from "../../../runtime/runtime-view.js";
import DebugExportDialog from "../debug/history/DebugExportDialog.vue";
import RuntimeFailure from "../start-and-end/RuntimeFailure.vue";
import SessionEndDialog from "../start-and-end/SessionEndDialog.vue";
import SessionErrorDialog from "../start-and-end/SessionErrorDialog.vue";
import RandomDrawPicker from "../debug/random/RandomDrawPicker.vue";
import { useRandomDrawGuard } from "../debug/random/useRandomDrawGuard";
import RewindInspection from "../debug/history/RewindInspection.vue";
import { rewindRows } from "../debug/history/rewindPresentation";
import { useDebugExport } from "../debug/history/useDebugExport";
import { playerNoticeKeys, playerNotices } from "../../../presentation/notices.js";
import { usePlayerKeyboardFocus } from "./usePlayerKeyboardFocus";
import { usePlayerNotifications } from "../notifications/usePlayerNotifications";
import { useMessageUpdateAnnouncements } from "../transcript/useMessageUpdateAnnouncements";
import {
  browserStorage,
  migratePhotoTransition,
  usePlayerNumberPreference,
  usePlayerPreference,
} from "./usePlayerPreference";
import type { PlayerSessionHost } from "../session/usePlayerSession";
import { defaultPlayerThemeIntents, usePlayerTheme } from "./usePlayerTheme";
import { usePhotoColour } from "../stage/usePhotoColour";
import { preloadStagePhotos, prepareStagePhoto, usePlanPhotoPreload } from "../stage/stagePhotos";
import { useStagePhoto } from "../stage/useStagePhoto";

// Product Player composition. The development preview supplies tools, a Stage media override, the right rail and an
// overlay only through these props and slots; production builds do not import it.
const props = withDefaults(
  defineProps<{
    player: PlayerSessionHost;
    /** The script's title and author for the title bar, each empty when unknown. */
    title?: string;
    author?: string;
    /** The package's name from its host, empty when unknown. */
    packageName?: string;
    media?: { src: string; alt: string } | undefined;
    tools?: readonly PlayerTool[];
    /** Why the script cannot start; shown instead of Start. */
    failure?: ScriptFailure | null;
    /**
     * How Debug starts: the Debug menu, and auto-skip once Debug runs. Both are off unless the host asks (`?dev`); the
     * debug room starts with the menu on.
     */
    debug?: { readonly menu: boolean; readonly autoSkip: boolean };
  }>(),
  {
    title: "",
    author: "",
    packageName: "",
    tools: () => [],
    failure: null,
    debug: () => ({ menu: false, autoSkip: false }),
  },
);
// The camera view's window keeps the place the user gave it while the Player is mounted.
const floatingPlace = ref<FloatingPlace | null>(null);
// An image request's camera step shows its viewfinder in the camera window the script shows, otherwise on the Stage,
// where it shows the camera instead of any camera view the script shows there. Its first step shows the preview on the
// Stage, over the Stage image and any camera view there.
const imageSteps = computed(() => props.player.imageCapture.view.value);
const capture = computed(() =>
  imageSteps.value !== null && imageSteps.value.phase !== "choose" ? imageSteps.value : null,
);
const imagePreview = computed(() =>
  imageSteps.value?.phase === "choose" && imageSteps.value.preview !== null
    ? { src: imageSteps.value.preview, alt: "Preview of your image" }
    : null,
);
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
const messageUpdateAnnouncement = useMessageUpdateAnnouncements(props.player);
provide(
  enhancedTranscriptContrast,
  computed(() => themeIntent.value.contrast === "high"),
);
provide(speakerAvatarSource, props.player.resolveAsset);
provide(speakerAvatarFailure, props.player.avatarFailed);
// Each mode starts from its own default palette; the contrast choice carries over.
// Player Settings and the A/B tests panel persist in this browser. Contrast is part of the theme intent.
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
// The A/B tests (owner decisions 2026-10-14): the title bar defaults to A, the photo accent to B, the theme's, the
// photo colour family to Vibrant when its swatch covers at least 3 % of the photo, else Muted, the photo colour fade
// time to B, 0.3 s, and the blending to A, Oklab.
const titlebarOption = usePlayerPreference("player-titlebar-variant", ["left", "overlap"], "left");
// A new key: until B became the default, every browser stored the default A on its first load.
const photoAccentOption = usePlayerPreference(
  "player-photo-accent-v2",
  ["photo", "theme"],
  "theme",
);
const photoFamily = usePlayerPreference("player-photo-family", PHOTO_FAMILIES, "large-vibrant");
const photoFamilyShare = usePlayerNumberPreference(
  "player-photo-family-share",
  { min: 0, max: 100 },
  3,
);
migratePhotoTransition(browserStorage());
const photoFadeTime = usePlayerPreference("player-photo-fade-time", ["0.6s", "0.3s"], "0.3s");
const photoBlending = usePlayerPreference("player-photo-blending", ["oklab", "srgb"], "oklab");
// Settings' switch for the A/B tests panel, on unless turned off.
const storedAbTestsMenu = usePlayerPreference("player-ab-tests-menu", ["on", "off"], "on");
const abTestsMenu = computed({
  get: () => storedAbTestsMenu.value === "on",
  set: (on) => (storedAbTestsMenu.value = on ? "on" : "off"),
});
function toggleThemeMode() {
  themeIntent.value = {
    ...defaultPlayerThemeIntents[themeIntent.value.mode === "dark" ? "light" : "dark"],
    contrast: themeIntent.value.contrast,
  };
}

const session = computed(() => props.player.session.value);
// The Debug menu adds the Debug panel first in the tools menu.
const debug = usePlayerDebug(props.player, props.debug);
// The draw the session is paused at while Debug chooses random outcomes, with its site and source for the picker.
const randomPicker = computed(() => {
  const random = debug.random.value;
  const draw = random?.draw.value ?? null;
  if (random === null || draw === null) return null;
  const site = random.sites.value.get(draw.site) ?? null;
  return {
    random,
    draw,
    site,
    // The breadcrumb starts at the package, by its name, else by the script's title.
    root: props.packageName || props.title || null,
  };
});
useRandomDrawGuard(() => randomPicker.value !== null);
// A debug export for a developer, from the error dialog, Settings, or the Debug panel (DEBUGGER.md "Debug export").
const debugExport = useDebugExport(
  props.player,
  () => props.title,
  // Read as the export's capture is delivered: what derives from a session reads `shown`, the store's matching view.
  (shown) => ({
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
          session: shown,
        }),
      ),
      // The active media, as Debug's Now view lists them, from the critical view.
      media: (shown === null ||
      (shown.state.status !== "running" && shown.state.status !== "waiting")
        ? []
        : shown.state.media
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
const debugTool: PlayerTool = { name: "Debug", icon: Bug };
const abTestsTool: PlayerTool = { name: "A/B tests", icon: SquareSplitHorizontal };
const toolsShell = ref<InstanceType<typeof PlayerToolsShell> | null>(null);
// Session end and failure (PLAYER-UI "Session end and failure"). An ordinary end opens the end dialog by itself; the
// error dialog opens only from the error line or its notice, which stays until a new session starts. Like the debug
// export, each opening of either dialog mounts it anew, so it stays above Settings or the notification panel.
const runtimeEnd = ref<InstanceType<typeof RuntimeFailure> | null>(null);
const endDialogOpen = ref(false);
const endDialogOpening = ref(0);
watch(props.player.endings, () => {
  if (props.player.hostError.value !== null) return;
  if (!endDialogOpen.value) endDialogOpening.value += 1;
  endDialogOpen.value = true;
});
// The start page (PLAYER-UI "Session start and user activation") shows while no session is shown, or one waits for its
// Start or Continue. After `exit` the session stays behind the end dialog, so its last messages stay visible; closing
// the dialog returns to the start page, whose Start then takes focus.
const onStartPage = computed(
  () => props.player.session.value === null || props.player.activation.value !== null,
);
const startPage = ref<InstanceType<typeof SessionActivation> | null>(null);
// Turning Debug on in the normal room (DEBUGGER.md "Debug room") goes on in the debug room, with a copy of the normal
// session that runs. Overwriting a debug session with it is confirmed first, the only confirmation; it stacks above
// Settings, which it opens from, as the debug export dialog does.
const overwritingDebugSession = ref(false);
const overwriteOpening = ref(0);
function setDebugMenu(on: boolean) {
  const rooms = props.player.rooms;
  if (on && rooms.copies.value && rooms.debugSessionExists.value) {
    overwriteOpening.value += 1;
    overwritingDebugSession.value = true;
  } else debug.menu.value = on;
}
function overwriteDebugSession() {
  overwritingDebugSession.value = false;
  debug.menu.value = true;
}
// A reload stays in the room shown: once play goes on in the debug room, the address says so.
watch(
  () => props.player.rooms.current.value,
  (room) => {
    if (room !== "debug" || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("room") === "debug") return;
    url.searchParams.set("room", "debug");
    window.history.replaceState(window.history.state, "", url);
  },
  { immediate: true },
);
watch(endDialogOpen, (open, wasOpen) => {
  if (wasOpen && !open)
    void props.player.toStartPage().then(async () => {
      await nextTick();
      startPage.value?.focus();
    });
});
const errorDialogOpen = ref(false);
const errorDialogOpening = ref(0);
function showErrorDetails() {
  if (!errorDialogOpen.value) errorDialogOpening.value += 1;
  errorDialogOpen.value = true;
}
watch(
  () => [session.value?.state.failure ?? null, props.player.hostError.value] as const,
  ([failure, hostError]) => {
    if (failure === null && hostError === null) {
      errorDialogOpen.value = false;
      props.player.withdrawNotice(playerNoticeKeys.sessionError);
    } else
      props.player.publishNotice(
        playerNotices.sessionError(failure === null ? "player" : "script", showErrorDetails),
      );
  },
);
// The calls a script error happened in, for the error dialog while it is open with a failure: its session's call view,
// which the stop froze with it, or the shown session's from the first publication with it on.
const failureShown = computed(() => errorDialogOpen.value && !!session.value?.state.failure);
let failureCallView: { release(): void } | null = null;
watch(
  failureShown,
  (shown) => {
    if (shown) failureCallView ??= props.player.demandCallView();
    else {
      failureCallView?.release();
      failureCallView = null;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => failureCallView?.release());
const failureCalls = computed(() =>
  failureShown.value && session.value ? (playerRuntimeCalls(session.value) ?? []) : [],
);
// Open in Debug shows the Debug panel's Now tab, which names the error and its statement, and focuses the tab.
async function openFailureInDebug() {
  debug.tab.value = "now";
  await toolsShell.value?.showTool(debugTool.name);
  document.querySelector<HTMLElement>('[data-debug-tab="now"]')?.focus({ preventScroll: true });
}
// Explain values on a chat message opens the Debug panel on its Variables tab.
provide(explainValues, {
  offers: debug.offers,
  explain(entryId) {
    if (debug.explain(entryId)) void toolsShell.value?.showTool(debugTool.name);
  },
});
// Debug's rewind (DEBUGGER.md "Rewind"): each answer to a point before the state shown offers Back to here.
const rewindPoints = computed(() => {
  const state = debug.rewind.value?.state.value;
  const leading = state?.inspection?.points ?? state?.points.length ?? 0;
  const rows = new Map<string, number>();
  for (const point of state?.points.slice(0, leading) ?? [])
    if (point.response?.rowId) rows.set(point.response.rowId, point.id);
  return rows;
});
provide(rewindRows, {
  offers: (entryId) =>
    rewindPoints.value.has(entryId) &&
    props.player.rewind.canRewind.value &&
    debug.rewind.value?.busy.value === false,
  back(entryId) {
    const point = rewindPoints.value.get(entryId);
    if (point !== undefined) void debug.rewind.value?.back(point);
  },
});
// While a restored state is inspected, the messages of the state Forward restores follow it, grey.
const rewindFuture = computed(() =>
  props.player.rewind.inspecting.value ? (debug.rewind.value?.future.value ?? null) : null,
);
const tools = computed(() => [
  ...(debug.menu.value ? [debugTool] : []),
  ...(abTestsMenu.value ? [abTestsTool] : []),
  ...props.tools,
]);
const savedData = computed(() =>
  props.player.hasSavedData
    ? {
        export: props.player.savedScripts,
        session: {
          unavailable: props.player.sessionExportUnavailable.value,
          read: props.player.exportSession,
        },
        import: {
          available: props.player.canImportSavedData.value,
          sessionInProgress: props.player.sessionInProgress.value,
          read: props.player.readTransfer,
          review: props.player.reviewSavedDataImport,
          commit: props.player.importSavedData,
          reviewSession: props.player.reviewSessionImport,
          discardSession: props.player.discardSessionReview,
          commitSession: props.player.importSession,
          losses: props.player.connectionLosses.value,
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
const transcript = computed(() => {
  if (!session.value)
    return {
      key: "empty",
      entries: [],
      speakers: noSpeakers,
      revision: 0,
      jumpedRevision: -1,
      removedRows: [],
    };
  const future = rewindFuture.value;
  const reached = session.value.transcriptEntries.length;
  return {
    key: `runtime-${props.player.generation.value}`,
    entries:
      future === null
        ? session.value.transcriptEntries
        : [...session.value.transcriptEntries, ...future.entries],
    removedRows:
      future === null
        ? session.value.transcriptRemovedRows
        : [
            ...session.value.transcriptRemovedRows,
            ...future.entries.flatMap((entry, index) =>
              isRemovedEntry(entry) ? [reached + index] : [],
            ),
          ],
    speakers:
      future === null ? session.value.speakers : { ...future.speakers, ...session.value.speakers },
    revision: session.value.transcriptRevision,
    jumpedRevision: props.player.jumpedRevision.value,
  };
});

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
const stageElement = computed(() => stage.value?.$el as HTMLElement | undefined);
const stageHeight = ref(0);
const mediaAspect = ref(0);
// PlayerComposition owns Stage height. Its measurement determines the contained image
// width; it does not feed back into the Stage track.
useResizeObserver(stageElement, ([entry]) => {
  if (entry) stageHeight.value = entry.contentRect.height;
});

// Photo colours (PLAYER-UI "Stage and media presentation"): the photo the Stage shows colours the
// Player. A new photo and its colour arrive together; while the photo is prepared, the previous photo
// and its colour stay. Without a photo, also after an image failed, the theme's colours apply. Which
// swatch family colours it, and whether the accent follows the photo, are A/B tests.
const stagePhoto = useStagePhoto(stageMedia, prepareStagePhoto);
// Every Stage image the script names is downloaded and measured in the background once its session runs.
usePlanPhotoPreload(
  () => props.player.session.value,
  props.player.resolveAsset,
  preloadStagePhotos,
);
const shownMedia = computed(() => {
  const photo = stagePhoto.shown.value;
  return photo === null ? undefined : { ...photo.media, src: photo.url, source: photo.media.src };
});
const failedPhoto = ref<string | null>(null);
function stageImageLoaded(src: string | null) {
  props.player.stageImageLoad(src);
}
function stageImageFailed(src: string | null) {
  props.player.stageImageFailure(src);
  failedPhoto.value = src;
}
const photoColours = usePhotoColour(
  stagePhoto.shown,
  computed(() =>
    stagePhoto.shown.value === null || stagePhoto.shown.value.media.src === failedPhoto.value
      ? null
      : stagePhoto.swatches.value,
  ),
  computed(() => themeIntent.value.mode),
  computed(() => ({ family: photoFamily.value, minShare: photoFamilyShare.value / 100 })),
  photoFadeTime,
  { canvas: computed(() => toolsShell.value?.$el as HTMLElement | undefined), stage: stageElement },
);
usePlayerTheme(
  computed(() => {
    const accent = photoAccentOption.value === "photo" ? photoColours.value?.accent : null;
    return accent ? { ...themeIntent.value, accentSeed: accent } : themeIntent.value;
  }),
  computed(() => photoColours.value?.surfaces ?? null),
  photoBlending,
);
const fullscreen = ref(document.fullscreenElement === document.documentElement);
const fullscreenSupported = document.fullscreenEnabled;
const fullscreenError = ref("");
useEventListener(document, "fullscreenchange", () => {
  fullscreen.value = document.fullscreenElement === document.documentElement;
});
async function toggleFullscreen() {
  fullscreenError.value = "";
  // Focus that the change leaves on nothing returns to where it was: the control pressed from the keyboard, or the
  // composer that a mouse press gave it to (RuntimeInteraction.vue).
  const focused = document.activeElement;
  try {
    // Full-document preview keeps body-portaled Reka surfaces in fullscreen too.
    // The production iframe must separately be granted fullscreen by its host.
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    if (
      (document.activeElement === null || document.activeElement === document.body) &&
      focused instanceof HTMLElement
    )
      focused.focus({ preventScroll: true });
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
    v-model:ab-tests-menu="abTestsMenu"
    :debug-menu="debug.menu.value"
    @update:debug-menu="setDebugMenu"
  >
    <template #tool="scope">
      <DebugPanel
        v-if="scope.tool === debugTool.name && debug.log.value"
        v-model:active="debug.active.value"
        v-model:tab="debug.tab.value"
        :explained="debug.explained.value"
        :time="debug.time.value"
        :random="debug.random.value"
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
      <AbTestsPanel
        v-else-if="scope.tool === abTestsTool.name"
        v-model:titlebar="titlebarOption"
        v-model:photo-accent="photoAccentOption"
        v-model:photo-family="photoFamily"
        v-model:photo-family-share="photoFamilyShare"
        v-model:photo-fade-time="photoFadeTime"
        v-model:photo-blending="photoBlending"
      />
      <slot v-else name="tool" v-bind="scope" />
    </template>
    <template #default="{ sidebarVisible }">
      <PlayerComposition :start-page="onStartPage">
        <template #topbar>
          <PlayerTopBar
            :title="title"
            :author="author"
            :debug-room="player.rooms.current.value === 'debug'"
            :debug-on="debug.on.value"
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
            v-model:camera-mirrored="player.cameraChoice.mirrored.value"
            :media="shownMedia"
            :camera="stageCamera"
            :preview="imagePreview"
            :camera-switch-label="player.cameraChoice.switchLabel.value"
            @switch-camera="player.cameraChoice.switchCamera"
            @camera-stalled="player.cameraChoice.stalled"
            @media-aspect="mediaAspect = $event"
            @media-load="stageImageLoaded"
            @media-failure="stageImageFailed"
          >
            <template v-if="capture && !captureInWindow" #camera>
              <ImageCapture :view="capture" />
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
            v-model:mirrored="player.cameraChoice.mirrored.value"
            :track="captureInWindow ? capture!.track : player.viewfinder.value"
            :switch-label="player.cameraChoice.switchLabel.value"
            @switch-camera="player.cameraChoice.switchCamera"
            @stalled="player.cameraChoice.stalled"
          >
            <ImageCapture v-if="captureInWindow" :view="capture!" />
          </FloatingViewfinder>
          <ScriptProblems v-if="failure" :failure="failure" />
          <SessionActivation
            v-else-if="onStartPage"
            ref="startPage"
            :activation="player.activation.value"
            :outdated="player.outdatedSession.value"
            :title="title"
            :author="author"
            :debug-room="player.rooms.current.value === 'debug'"
            :start-anew="player.rooms.debugHasData.value"
            :recovery="player.recovery.value?.where === 'page' ? player.recovery.value.offer : null"
            @activate="player.activate"
            @reload="void player.rooms.reloadDebug()"
            @reset="void player.rooms.resetDebug()"
          />
          <ConfirmDialog
            :key="overwriteOpening"
            :open="overwritingDebugSession"
            name="debug-session-overwrite"
            title="Overwrite the debug session?"
            description="A copy of your normal session replaces the debug session and what it saved. Your normal session stays as it is."
            action="Overwrite"
            destructive
            @confirm="overwriteDebugSession"
            @cancel="overwritingDebugSession = false"
          />
          <DebugExportDialog
            :key="debugExportOpening"
            :exporter="debugExport"
            :photo-url="player.resolveAsset"
          />
          <SessionEndDialog :key="endDialogOpening" v-model:open="endDialogOpen" />
          <SessionErrorDialog
            :key="errorDialogOpening"
            v-model:open="errorDialogOpen"
            :failure="session?.state.failure ?? null"
            :host-error="player.hostError.value"
            :source="
              session?.state.failure ? player.scriptSource(session.state.failure.path) : null
            "
            :calls="failureCalls"
            :debug-available="debug.time.value !== null && !!session?.state.failure"
            @export="openDebugExport"
            @debug="void openFailureInDebug()"
            @return-focus="runtimeEnd?.focus()"
          />
          <RandomDrawPicker
            v-if="randomPicker"
            :key="randomPicker.random.drawKey.value ?? ''"
            :draw-key="randomPicker.random.drawKey.value ?? ''"
            :draw="randomPicker.draw"
            :site="randomPicker.site"
            :code="randomPicker.random.code.value"
            :history="randomPicker.random.historyLines.value"
            :root="randomPicker.root"
            :next="randomPicker.random.next(randomPicker.draw.site)"
            :tried="randomPicker.random.tried(randomPicker.draw.site)"
            @update:next="randomPicker.random.setNext(randomPicker.draw.site, $event)"
            @resolve="randomPicker.random.resolve($event)"
            @untried="randomPicker.random.resolveLeastTried()"
          />
          <PlayerToasts
            :notifications="notifications.notifications.value"
            :seen-sequence="notifications.seenSequence.value"
            :theme-mode="themeIntent.mode"
          />
          <DebugStatus v-if="debug.log.value" :time="debug.time.value" :log="debug.log.value" />
          <!-- A message changed in place may be offscreen or already read, so its new text is spoken. -->
          <span role="status" class="sr-only" data-message-update-announcement>{{
            messageUpdateAnnouncement
          }}</span>
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

        <!-- A session a Player error stopped takes no input; its transcript stays. -->
        <RuntimeInteraction
          :session="player.stopped.value ? null : session"
          :reset="player.interactionReset.value"
          :chat="player.chat.value"
          :terminal="player.terminal.value"
          :epoch="player.epoch"
          :input-epoch="player.inputEpoch"
          :on-epoch="player.onEpoch"
          :stopped-session="player.stopped.value ? session : null"
          :transcript-key="transcript.key"
          :entries="transcript.entries"
          :speakers="transcript.speakers"
          :revision="transcript.revision"
          :jumped-revision="transcript.jumpedRevision"
          :removed-rows="transcript.removedRows"
          :input-section="player.inputSection"
          :prepare-input="player.prepareInput"
          :hold-form-drafts="player.rewind.inspecting.value"
          :images="player.images"
          :capture="player.imageCapture"
          :debug-countdown="debug.countdownText.value"
          :popup-modal="debug.time.value === null"
          :lock="player.lock"
          @update:session="player.update"
        >
          <template #end>
            <RuntimeFailure
              v-if="!failure && player.activation.value === null"
              ref="runtimeEnd"
              :state="session?.state ?? null"
              :host-error="player.hostError.value"
              :recovery="
                player.recovery.value?.where === 'line' ? player.recovery.value.offer : null
              "
              @details="showErrorDetails"
              @activate="player.activate"
            />
            <!-- Closest to the composer, also below a failure the inspected state shows. -->
            <RewindInspection
              v-if="debug.rewind.value && player.rewind.inspecting.value"
              :rewind="debug.rewind.value"
              :adopting="player.rewind.adopting.value"
              :working="player.rewind.working.value"
            />
          </template>
        </RuntimeInteraction>
      </PlayerComposition>
    </template>
  </PlayerToolsShell>
</template>
