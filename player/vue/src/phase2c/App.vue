<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, provide, ref, shallowRef, watch } from "vue";
import { onClickOutside, useEventListener, useResizeObserver, useStorage } from "@vueuse/core";
import { FlaskConical, Settings, ScanLine, Activity, SlidersHorizontal, PanelLeftOpen, PanelRightOpen } from "@lucide/vue";
import Sortable from "sortablejs";
import ToolPanelHeader from "./ToolPanelHeader.vue";
import { toolPanelSizes } from "./toolPanelSizes";
import Stage from "./Stage.vue";
import Transcript from "./Transcript.vue";
import RuntimeInteraction from "./RuntimeInteraction.vue";
import { transcriptFixtures, transcriptFixtureSpeakers } from "./transcriptFixtures";
import { createPlayerRuntimeSession, createPlayerRuntimeRestorePoint, restorePlayerRuntimeSession, type PlayerRuntimeSession, type PlayerRuntimeRestorePoint } from "../../../runtime-adapter.js";
import { runtimeScenario, interactionScenario } from "./runtimeScenario";
import { stageFixtures } from "./stageFixtures";
import { Button } from "@/components/ui/button";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import SidebarMenu from "@/components/ui/sidebar/SidebarMenu.vue";
import SidebarMenuItem from "@/components/ui/sidebar/SidebarMenuItem.vue";
import MenuSidebarButton from "./MenuSidebarButton.vue";
import Sheet from "@/components/ui/sheet/Sheet.vue";
import SheetContent from "@/components/ui/sheet/SheetContent.vue";
import SheetTitle from "@/components/ui/sheet/SheetTitle.vue";
import SheetDescription from "@/components/ui/sheet/SheetDescription.vue";
import Sidebar from "@/components/ui/sidebar/Sidebar.vue";
import SidebarHeader from "@/components/ui/sidebar/SidebarHeader.vue";
import SidebarInset from "@/components/ui/sidebar/SidebarInset.vue";
import SidebarProvider from "@/components/ui/sidebar/SidebarProvider.vue";
import SidebarTrigger from "@/components/ui/sidebar/SidebarTrigger.vue";

import Dialog from "@/components/ui/dialog/Dialog.vue";
import DialogTrigger from "@/components/ui/dialog/DialogTrigger.vue";
import DialogContent from "@/components/ui/dialog/DialogContent.vue";
import DialogHeader from "@/components/ui/dialog/DialogHeader.vue";
import DialogTitle from "@/components/ui/dialog/DialogTitle.vue";
import DialogDescription from "@/components/ui/dialog/DialogDescription.vue";

const isDevelopment = import.meta.env.DEV;
const mediaFixture = ref<keyof typeof stageFixtures>("Landscape");
const longTitle = ref(false);
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
function loadTranscript(count: number) {
  runtimeSession.value = null;
  firstMessage = 0;
  nextMessage = count;
  transcriptEntries.value = transcriptFixtures(0, count);
}
function appendTranscript() {
  transcriptEntries.value = [...transcriptEntries.value, ...transcriptFixtures(nextMessage++, 1)];
}
function prependTranscript() {
  firstMessage -= 50;
  transcriptEntries.value = [...transcriptFixtures(firstMessage, 50), ...transcriptEntries.value];
}
const stage = ref<InstanceType<typeof Stage> | null>(null);
const stageHeight = ref(0);
// Measurement only positions the ambient fade; it never controls layout geometry.
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
type LabelMode = "icons" | "preview" | "labels";
const labelMode = isDevelopment
  ? useStorage<LabelMode>("phase2c-menu-label-mode", "icons")
  : ref<LabelMode>("icons");
if (!["icons", "preview", "labels"].includes(labelMode.value)) labelMode.value = "icons";
const hoverPreview = ref(false);
const focusPreview = ref(false);
const menuSidebar = ref<HTMLElement | null>(null);
const shellElement = computed(() => menuRuler.value?.parentElement);
const toolsSurface = ref<HTMLElement | null>(null);
const clickPreview = ref<boolean | null>(null);
const labelsVisible = computed(() => labelMode.value === "labels"
  || (labelMode.value === "preview" && (clickPreview.value === true
    || (clickPreview.value !== false && (hoverPreview.value || focusPreview.value)))));
provide("phase2c-menu-labels-visible", labelsVisible);

function updateHoverPreview(event: PointerEvent) {
  const strip = menuSidebar.value?.parentElement?.getBoundingClientRect();
  hoverPreview.value = event.pointerType === "mouse"
    && matchMedia("(hover: hover) and (pointer: fine)").matches
    && !!strip && event.clientX >= strip.left && event.clientX < strip.right;
  if (!hoverPreview.value && clickPreview.value === false) clickPreview.value = null;
}

function leaveMenu() {
  hoverPreview.value = false;
  if (clickPreview.value === false) clickPreview.value = null;
}

async function updateFocusPreview() {
  await nextTick();
  focusPreview.value = !!menuSidebar.value?.querySelector(":focus-visible:not([data-settings-trigger])");
}

onClickOutside(menuSidebar, () => { clickPreview.value = null; }, {
  ignore: ['[data-slot="dialog-content"]', '[data-slot="dialog-overlay"]'],
});

function clickMenuSpace(event: MouseEvent) {
  if (labelMode.value !== "preview" || (event.target as Element).closest("button, a, input, select, textarea, [role=button]")) return;
  clickPreview.value = clickPreview.value !== true;
}
const tools = [
  { name: "Visual Lab", icon: FlaskConical, developmentOnly: false },
  { name: "Layout Debug", icon: ScanLine, developmentOnly: false },
  { name: "Playback Diagnostics", icon: Activity, developmentOnly: true },
  { name: "Media Playback Configuration", icon: SlidersHorizontal, developmentOnly: true },
] as const;
type Tool = typeof tools[number]["name"];
const launcherTools = tools.filter(tool => isDevelopment || !tool.developmentOnly);
const toolSizes = ref<Record<Tool, keyof typeof toolPanelSizes>>({
  "Visual Lab": "Medium",
  "Layout Debug": "Medium",
  "Playback Diagnostics": "Medium",
  "Media Playback Configuration": "Medium",
});
// The ruler shares menu typography/chrome; bounds follow the actual labels.
const menuRuler = ref<HTMLElement | null>(null);
const menuWidth = ref<number | null>(null);
const menuBounds = ref({ min: 112, max: 320 });
useResizeObserver(menuRuler, () => {
  const ruler = menuRuler.value;
  if (!ruler) return;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  menuBounds.value = {
    min: ruler.lastElementChild!.getBoundingClientRect().width,
    max: Math.min(ruler.getBoundingClientRect().width, 24 * rem),
  };
});
const permanentMenuWidth = computed(() => Math.max(menuBounds.value.min,
  Math.min(menuWidth.value ?? menuBounds.value.max, menuBounds.value.max)));
// Use the usable viewport, including browser keyboard resizing, without guessing keyboard height.
const viewport = ref({ width: window.innerWidth, height: window.innerHeight, left: 0, top: 0 });
const remSize = ref(parseFloat(getComputedStyle(document.documentElement).fontSize));
function updateViewport() {
  const visual = window.visualViewport;
  viewport.value = { width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight,
    left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0 };
  remSize.value = parseFloat(getComputedStyle(document.documentElement).fontSize);
}
updateViewport();
useEventListener(window, "resize", updateViewport);
useEventListener(window.visualViewport, "resize", updateViewport);
useEventListener(window.visualViewport, "scroll", updateViewport);
// Existing provisional conversation width plus fixture margins/borders.
const protectedPlayerWidth = computed(() => 380 + 6 * remSize.value + 4);
const narrow = computed(() => viewport.value.width < protectedPlayerWidth.value
  + (labelMode.value === "labels" ? permanentMenuWidth.value : 3 * remSize.value)
  + toolPanelSizes.Small * remSize.value + 1);
const sidebarVisible = ref(!narrow.value);
let transitionFocusKey: string | null = null;
watch(narrow, (isNarrow) => {
  const active = document.activeElement as HTMLElement | null;
  const inside = !!active?.closest("[data-tools-surface], [data-slot=sheet-content], [data-tools-context]")
    || toolStrip.value?.dataset.reordering === "true" || resizing.value !== null;
  transitionFocusKey = inside ? active?.getAttribute("data-tools-focus") ?? null : null;
  stopResize?.();
  // Do not cover the Player on a layout change unless tools own the active interaction.
  if (isNarrow) narrowMenuVisible.value = true;
  if (isNarrow && !inside) sidebarVisible.value = false;
  if (!isNarrow && inside && sidebarVisible.value) void nextTick(focusToolsToggle);
}, { flush: "pre" });
function focusToolsToggle() {
  shellElement.value?.querySelector<HTMLButtonElement>("[data-sidebar=trigger]")?.focus({ preventScroll: true });
}
function openDrawerFocus(event: Event) {
  event.preventDefault();
  const surface = toolsSurface.value;
  const target = transitionFocusKey
    ? Array.from(surface?.querySelectorAll<HTMLElement>("[data-tools-focus]") ?? [])
      .find(element => element.getAttribute("data-tools-focus") === transitionFocusKey)
    : null;
  // Focus the existing toggle, not a tool or input that could trigger a preview/keyboard.
  (target ?? surface?.querySelector<HTMLElement>("[data-sidebar=trigger]"))?.focus({ preventScroll: true });
  transitionFocusKey = null;
}
async function closeDrawerFocus(event: Event) {
  event.preventDefault();
  await nextTick();
  focusToolsToggle();
}
function setSidebarVisible(open: boolean) {
  sidebarVisible.value = open;
  if (open && narrow.value) narrowMenuVisible.value = true;
  clickPreview.value = null;
  hoverPreview.value = false;
  focusPreview.value = false;
}
type PanelSize = keyof typeof toolPanelSizes;
const panelSizeNames = Object.keys(toolPanelSizes) as PanelSize[];
const resizing = ref<"menu" | Tool | null>(null);
let stopResize: (() => void) | undefined;
function startResize(event: PointerEvent, tool?: Tool) {
  if (event.button !== 0 || !event.isPrimary) return;
  event.preventDefault();
  stopResize?.();
  const edge = event.currentTarget as HTMLElement;
  const startX = event.clientX;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const initialSize = tool ? toolSizes.value[tool] : null;
  const initialWidth = tool ? toolPanelSizes[toolSizes.value[tool]] * rem : permanentMenuWidth.value;
  resizing.value = tool ?? "menu";
  edge.setPointerCapture(event.pointerId);
  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== event.pointerId) return;
    const width = initialWidth + moveEvent.clientX - startX;
    if (tool) {
      toolSizes.value[tool] = panelSizeNames.reduce((nearest, size) =>
        Math.abs(toolPanelSizes[size] * rem - width) < Math.abs(toolPanelSizes[nearest] * rem - width) ? size : nearest);
    } else menuWidth.value = Math.max(menuBounds.value.min, Math.min(menuBounds.value.max, width));
  };
  const cancel = () => {
    if (tool && initialSize) toolSizes.value[tool] = initialSize;
    else menuWidth.value = initialWidth;
    finish();
  };
  const key = (keyEvent: KeyboardEvent) => { if (keyEvent.key === "Escape") cancel(); };
  const finish = () => {
    edge.removeEventListener("pointermove", move);
    edge.removeEventListener("pointerup", finish);
    edge.removeEventListener("pointercancel", cancel);
    edge.removeEventListener("lostpointercapture", finish);
    document.removeEventListener("keydown", key);
    if (edge.hasPointerCapture(event.pointerId)) edge.releasePointerCapture(event.pointerId);
    resizing.value = null;
    stopResize = undefined;
  };
  edge.addEventListener("pointermove", move);
  edge.addEventListener("pointerup", finish);
  edge.addEventListener("pointercancel", cancel);
  edge.addEventListener("lostpointercapture", finish);
  document.addEventListener("keydown", key);
  stopResize = finish;
}
onBeforeUnmount(() => stopResize?.());
function resizeMenuKey(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  menuWidth.value = event.key === "Home" ? menuBounds.value.min : event.key === "End" ? menuBounds.value.max
    : Math.max(menuBounds.value.min, Math.min(menuBounds.value.max, permanentMenuWidth.value + (event.key === "ArrowRight" ? 16 : -16)));
}
function resizePanelKey(event: KeyboardEvent, tool: Tool) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const index = event.key === "Home" ? 0 : event.key === "End" ? panelSizeNames.length - 1
    : panelSizeNames.indexOf(toolSizes.value[tool]) + (event.key === "ArrowRight" ? 1 : -1);
  const size = panelSizeNames[index];
  if (size) toolSizes.value[tool] = size;
}
const pinnedTools = ref<Tool[]>([]);
const temporaryTool = ref<Tool | null>(null);
// Visual order is independent of which tools are pinned.
const openTools = ref<Tool[]>([]);
// Narrow presentation selects from the same open tools; it does not own their lifetime.
const narrowTool = ref<Tool | null>(null);
const narrowMenuVisible = ref(true);
async function showToolMenu(event: MouseEvent) {
  narrowMenuVisible.value = true;
  await nextTick();
  // Touch must not synthesize a focused tool's tooltip/label preview on menu return.
  if (event.detail === 0) {
    const menu = menuSidebar.value;
    (menu?.querySelector<HTMLButtonElement>('[aria-current="true"]')
      ?? menu?.querySelector<HTMLButtonElement>("[data-sidebar=menu-button]"))?.focus({ preventScroll: true });
  } else focusToolsToggle();
}
let pendingToolClose: { tool: Tool; timer: ReturnType<typeof setTimeout> } | null = null;
let lastClosedTool: { tool: Tool; index: number; pinned: boolean } | null = null;
const toolStrip = ref<HTMLElement | null>(null);
let revealRequest = 0;

async function revealTool(tool: Tool) {
  const request = ++revealRequest;
  if (narrow.value) {
    const focusFromMenu = narrowMenuVisible.value;
    narrowTool.value = tool;
    narrowMenuVisible.value = false;
    await nextTick();
    if (focusFromMenu) toolsSurface.value?.querySelector<HTMLButtonElement>("[data-show-tools]")?.focus({ preventScroll: true });
    return;
  }
  await nextTick();
  const strip = toolStrip.value;
  if (!strip) return;
  // Measure actual overflow after the dock finishes growing, not its intermediate width.
  const dock = strip.closest('[data-sidebar="sidebar"]')?.parentElement;
  const widthTransitions = dock?.getAnimations().filter(animation =>
    animation instanceof CSSTransition && animation.transitionProperty === "width") ?? [];
  await Promise.allSettled(widthTransitions.map(animation => animation.finished));
  if (request !== revealRequest || strip !== toolStrip.value) return;
  const panel = strip?.querySelector<HTMLElement>(`[data-tool="${tool}"]`);
  if (!strip || !panel) return;
  const viewport = strip.getBoundingClientRect();
  const bounds = panel.getBoundingClientRect();
  // Like native nearest scrolling: leave an already visible (or viewport-spanning) panel alone.
  if (bounds.left >= viewport.left && bounds.right <= viewport.right
    || bounds.left <= viewport.left && bounds.right >= viewport.right) return;
  const offset = bounds.width > strip.clientWidth || bounds.left < viewport.left
    ? bounds.left - viewport.left : bounds.right - viewport.right;
  strip.scrollBy({ left: offset, behavior: "instant" });
}

const toolColumnsWidth = computed(() => openTools.value.reduce(
  (width, tool) => width + toolPanelSizes[toolSizes.value[tool]], 0,
));

function cancelPendingClose() {
  if (pendingToolClose) clearTimeout(pendingToolClose.timer);
  pendingToolClose = null;
}

onBeforeUnmount(cancelPendingClose);

function closeTool(tool: Tool) {
  if (narrowTool.value === tool) {
    narrowTool.value = null;
    narrowMenuVisible.value = true;
  }
  lastClosedTool = { tool, index: openTools.value.indexOf(tool), pinned: pinnedTools.value.includes(tool) };
  openTools.value = openTools.value.filter(item => item !== tool);
  pinnedTools.value = pinnedTools.value.filter(item => item !== tool);
  if (temporaryTool.value === tool) temporaryTool.value = null;
}

function clickTool(tool: Tool, event: MouseEvent) {
  if (event.detail > 1) return;
  lastClosedTool = null;
  if (pendingToolClose) {
    const previous = pendingToolClose.tool;
    cancelPendingClose();
    closeTool(previous);
  }
  if (narrow.value && openTools.value.includes(tool) && narrowTool.value !== tool) {
    void revealTool(tool);
    return;
  }
  if (openTools.value.includes(tool)) {
    if (event.detail === 0) closeTool(tool);
    else {
      // Defer pointer closing so a double-click can toggle pin without unmounting the panel.
      pendingToolClose = { tool, timer: setTimeout(() => {
        pendingToolClose = null;
        closeTool(tool);
      }, 200) };
    }
    return;
  }
  const index = temporaryTool.value ? openTools.value.indexOf(temporaryTool.value) : -1;
  if (index >= 0) openTools.value.splice(index, 1, tool);
  else openTools.value.push(tool);
  temporaryTool.value = tool;
  void revealTool(tool);
}

function setPinned(tool: Tool, pinned: boolean) {
  if (pendingToolClose?.tool === tool) cancelPendingClose();
  if (pinned) {
    if (!pinnedTools.value.includes(tool)) pinnedTools.value.push(tool);
    if (!openTools.value.includes(tool)) openTools.value.push(tool);
    if (temporaryTool.value === tool) temporaryTool.value = null;
  } else {
    if (temporaryTool.value && temporaryTool.value !== tool) {
      openTools.value = openTools.value.filter(item => item !== temporaryTool.value);
    }
    pinnedTools.value = pinnedTools.value.filter(item => item !== tool);
    temporaryTool.value = tool;
  }
  void revealTool(tool);
}

function toggleToolPin(tool: Tool) {
  cancelPendingClose();
  // Respect a browser-recognized double-click even when its interval exceeds our close delay.
  if (!openTools.value.includes(tool) && lastClosedTool?.tool === tool) {
    openTools.value.splice(lastClosedTool.index, 0, tool);
    setPinned(tool, !lastClosedTool.pinned);
    lastClosedTool = null;
    return;
  }
  setPinned(tool, !pinnedTools.value.includes(tool));
}

function moveTool(tool: Tool, direction: -1 | 1) {
  const index = openTools.value.indexOf(tool);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= openTools.value.length) return;
  const reordered = [...openTools.value];
  reordered.splice(index, 1);
  reordered.splice(destination, 0, tool);
  openTools.value = reordered;
  void revealTool(tool);
}

watch(toolStrip, (strip, _, onCleanup) => {
  if (!strip || narrow.value) return;
  let originalNextSibling: ChildNode | null = null;
  const sortable = new Sortable(strip, {
    draggable: "[data-tool]",
    handle: "[data-panel-drag]",
    direction: "horizontal",
    animation: 150,
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: 5,
    ghostClass: "tool-panel-drag-placeholder",
    fallbackClass: "tool-panel-dragging",
    scroll: strip,
    bubbleScroll: false,
    forceAutoScrollFallback: true,
    onStart(event) {
      originalNextSibling = event.item.nextSibling;
      strip.dataset.reordering = "true";
    },
    onEnd(event) {
      delete strip.dataset.reordering;
      // Undo Sortable's DOM move before Vue applies the authoritative keyed-list update.
      strip.insertBefore(event.item, originalNextSibling);
      if (event.oldIndex === undefined || event.newIndex === undefined) return;
      const reordered = [...openTools.value];
      const [tool] = reordered.splice(event.oldIndex, 1);
      if (!tool) return;
      reordered.splice(event.newIndex, 0, tool);
      openTools.value = reordered;
      void revealTool(tool);
    },
  });
  onCleanup(() => sortable.destroy());
}, { flush: "post" });

async function updateSidebarVisibility(open: boolean) {
  const keepTriggerFocus = shellElement.value?.querySelector("[data-sidebar=trigger]") === document.activeElement;
  setSidebarVisible(open);
  if (keepTriggerFocus) {
    await nextTick();
    shellElement.value?.querySelector<HTMLButtonElement>("[data-sidebar=trigger]")?.focus();
  }
}
</script>

<template>
  <SidebarProvider
    id="phase2c-shell"
    :data-narrow="narrow"
    :data-menu-visible="narrowMenuVisible"
    :style="{ '--player-reserve': `${protectedPlayerWidth}px`, '--tool-columns-width': `${toolColumnsWidth}rem`, '--permanent-menu-width': `${permanentMenuWidth}px`, '--usable-width': `${viewport.width}px`, '--usable-height': `${viewport.height}px`, '--viewport-left': `${viewport.left}px`, '--viewport-top': `${viewport.top}px` }"
    :data-resizing="resizing !== null"
    :data-labels="labelMode"
    :data-tools-open="openTools.length > 0"
    :data-labels-visible="labelsVisible"
    class="phase2c-sidebar relative h-dvh min-h-0 overflow-hidden"
    :open="sidebarVisible" :responsive="false" @update:open="updateSidebarVisibility"
  >
    <div ref="menuRuler" class="menu-width-ruler" aria-hidden="true">
      <span v-for="tool in launcherTools" :key="tool.name">{{ tool.name }}</span>
      <span>Settings</span>
    </div>
    <!-- The local Sheet owns responsiveness; disable the provider’s independent mobile state. -->
    <Sheet :open="narrow && sidebarVisible" @update:open="setSidebarVisible">
    <component :is="narrow ? SheetContent : Sidebar" side="left" variant="sidebar" collapsible="offcanvas"
      :portal-target="narrow ? '#phase2c-shell' : undefined"
      :class="narrow ? 'tools-drawer' : undefined"
      @open-auto-focus="openDrawerFocus" @close-auto-focus="closeDrawerFocus">
      <template v-if="narrow">
        <SheetTitle class="sr-only">Tools Sidebar</SheetTitle>
        <SheetDescription class="sr-only">Open, arrange and resize Player tools.</SheetDescription>
      </template>
      <div ref="toolsSurface" data-tools-surface class="relative flex h-full min-h-0" :class="{ 'flex-col': narrow }">
        <div v-if="narrow" class="flex h-12 shrink-0 items-center gap-2 border-b px-2">
          <SidebarTrigger data-tools-focus="toggle" class="size-8" aria-label="Hide sidebar" title="Hide sidebar" />
          <Button v-if="!narrowMenuVisible" data-show-tools data-tools-focus="show-menu" variant="ghost" size="sm" @click="showToolMenu">
            <PanelLeftOpen class="size-4" /> Tools
          </Button>
        </div>
        <div v-if="sidebarVisible" v-show="!narrow || narrowMenuVisible" data-launcher-space class="relative shrink-0">
        <div ref="menuSidebar" data-launcher @click="clickMenuSpace" @pointerenter="updateHoverPreview" @pointermove="updateHoverPreview" @pointerleave="leaveMenu" @focusin="updateFocusPreview" @focusout="updateFocusPreview" class="relative flex h-full flex-col border-r bg-sidebar">
      <SidebarHeader v-if="!narrow">
        <SidebarTrigger
          class="size-8"
          data-tools-focus="toggle"
          aria-label="Hide sidebar"
          title="Hide sidebar"
        />
      </SidebarHeader>
      <div v-if="narrow && narrowTool && openTools.includes(narrowTool)" class="px-2 pt-2">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="size-8" data-tools-focus="back-to-tool" aria-label="Back to active tool" @click="revealTool(narrowTool)">
              <PanelRightOpen class="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Back to active tool</TooltipContent>
        </Tooltip>
      </div>
      <nav aria-label="Tools" class="min-h-0 overflow-y-auto p-2">
        <SidebarMenu>
          <SidebarMenuItem v-for="tool in launcherTools" :key="tool.name">
            <MenuSidebarButton :label="tool.name" :data-tools-focus="`launcher:${tool.name}`" :is-active="narrow ? narrowTool === tool.name : openTools.includes(tool.name)" :aria-current="narrow && narrowTool === tool.name ? 'true' : undefined" @click="clickTool(tool.name, $event)" @dblclick="toggleToolPin(tool.name)">
              <component :is="tool.icon" />
            </MenuSidebarButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </nav>
      <div class="mt-auto p-2">
        <Dialog>
          <DialogTrigger as-child>
            <MenuSidebarButton label="Settings" data-tools-focus="player-settings" data-settings-trigger>
              <Settings />
            </MenuSidebarButton>
          </DialogTrigger>
          <DialogContent data-tools-context>
            <DialogHeader>
              <DialogTitle>Player Settings</DialogTitle>
              <DialogDescription>Preferences for the Player interface.</DialogDescription>
            </DialogHeader>
            <label class="flex flex-col gap-2 text-sm">
              Menu Sidebar labels
              <select data-tools-focus="label-mode" v-model="labelMode" class="rounded-md border bg-background p-2">
                <option value="icons">Icons only</option>
                <option value="preview">Icons + preview</option>
                <option value="labels">Icons + labels</option>
              </select>
            </label>
          </DialogContent>
        </Dialog>
      </div>
        </div>
        <div v-if="labelMode === 'labels' && !narrow" class="resize-edge menu-resize-edge" role="separator" tabindex="0" aria-label="Menu Sidebar width" aria-orientation="vertical"
          :aria-valuemin="Math.round(menuBounds.min)" :aria-valuemax="Math.round(menuBounds.max)" :aria-valuenow="Math.round(permanentMenuWidth)"
          @pointerdown="startResize($event)" @keydown="resizeMenuKey" />
        </div>
        <div v-if="sidebarVisible" v-show="!narrow || !narrowMenuVisible" ref="toolStrip" role="region" aria-label="Tool Panels" :tabindex="openTools.length ? 0 : undefined" class="tool-panel-strip flex min-w-0 flex-1 overflow-x-auto overscroll-x-contain focus-visible:outline-2 focus-visible:-outline-offset-2">
    <section v-for="tool in openTools" :key="tool" v-show="!narrow || tool === narrowTool" :data-tool="tool" :aria-label="`${tool} panel`" :style="{ width: `${toolPanelSizes[toolSizes[tool]]}rem` }" class="relative flex min-h-0 shrink-0 flex-col border-r bg-[var(--surface-component)]">
      <ToolPanelHeader :tool="tool" :narrow="narrow" :size="toolSizes[tool]" :pinned="pinnedTools.includes(tool)"
        :can-move-left="openTools.indexOf(tool) > 0" :can-move-right="openTools.indexOf(tool) < openTools.length - 1"
        @resize="toolSizes[tool] = $event" @pin="setPinned(tool, $event)" @move="moveTool(tool, $event)" />
      <div data-tool-body class="min-h-0 flex-1 overflow-y-auto">
        <div v-if="isDevelopment && tool === 'Visual Lab'" class="space-y-4 p-4 text-sm">
          <label class="grid gap-2">
            Stage media fixture
            <select v-model="mediaFixture" class="min-w-0 rounded border bg-[var(--surface-component)] p-2">
              <option v-for="(_, name) in stageFixtures" :key="name">{{ name }}</option>
            </select>
          </label>
          <label class="flex items-center gap-2">
            <input v-model="longTitle" type="checkbox" /> Long stage title
          </label>
          <fieldset class="grid gap-2">
            <legend class="mb-2">Transcript fixtures</legend>
            <Button variant="outline" :disabled="!!runtimeSession" @click="appendTranscript">Append message</Button>
            <Button variant="outline" :disabled="!!runtimeSession" @click="prependTranscript">Prepend 50 messages</Button>
            <Button variant="outline" @click="loadTranscript(0)">Empty history</Button>
            <Button variant="outline" @click="loadTranscript(10000)">Load 10,000 messages</Button>
          </fieldset>
          <fieldset class="grid gap-2">
            <legend class="mb-2">Runtime transcript scenario</legend>
            <Button variant="outline" @click="startRuntime()">Start runtime scenario</Button>
            <Button variant="outline" @click="startRuntime(interactionScenario)">Start interaction scenario</Button>
            <template v-if="runtimeSession">
              <Button variant="outline" @click="runtimeRestore = createPlayerRuntimeRestorePoint(runtimeSession)">Capture runtime checkpoint</Button>
              <Button variant="outline" :disabled="!runtimeRestore" @click="restoreRuntime">Restore runtime checkpoint</Button>
            </template>
          </fieldset>
        </div>
      </div>
      <div class="resize-edge" :data-panel-resize="tool" role="separator" tabindex="0" aria-orientation="vertical" :aria-label="`${tool} width`"
        :aria-valuemin="toolPanelSizes.Small" :aria-valuemax="toolPanelSizes['Extra Large']" :aria-valuenow="toolPanelSizes[toolSizes[tool]]" :aria-valuetext="toolSizes[tool]"
        @pointerdown="startResize($event, tool)" @keydown="resizePanelKey($event, tool)">
        <span v-if="resizing === tool" class="resize-size-label">{{ toolSizes[tool] }}</span>
      </div>
    </section>
        </div>
      </div>
    </component>
    </Sheet>
    <SidebarTrigger
      v-if="!sidebarVisible"
      class="fixed left-2 top-2 z-40 size-8 bg-sidebar"
      aria-label="Show sidebar"
      title="Show sidebar"
    />
    <SidebarInset class="min-h-0 min-w-0">
      <div class="player-composition" :style="{ '--stage-height': `${stageHeight}px` }">
        <Stage ref="stage"
          :title="longTitle ? 'An evening by the coast — a quiet moment before the journey begins' : 'Evening by the coast'"
          :media="stageFixtures[mediaFixture]"
          :fullscreen="fullscreen"
          :fullscreen-supported="fullscreenSupported"
          :fullscreen-error="fullscreenError"
          @toggle-fullscreen="toggleFullscreen"
        />

        <section class="player-conversation mx-auto flex min-h-0 w-full max-w-[920px] flex-1 flex-col gap-3 px-4">
          <Transcript :key="runtimeSession ? `runtime-${runtimeGeneration}` : 'fixtures'" :entries="runtimeSession?.transcriptEntries ?? transcriptEntries" :speakers="runtimeSession?.speakers ?? transcriptFixtureSpeakers" :revision="runtimeSession?.transcriptRevision ?? 0" />
          <RuntimeInteraction v-model:session="runtimeSession" :reset="interactionReset" />
        </section>
      </div>
    </SidebarInset>
  </SidebarProvider>
</template>
