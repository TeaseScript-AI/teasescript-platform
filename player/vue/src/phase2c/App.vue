<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, provide, ref, shallowReactive, shallowRef, watch, type ComponentPublicInstance } from "vue";
import { onClickOutside, useEventListener, useResizeObserver, useStorage } from "@vueuse/core";
import { FlaskConical, Settings, ScanLine, Activity, SlidersHorizontal, PanelLeftOpen, PanelRightOpen, GripVertical } from "@lucide/vue";
import Sortable from "sortablejs";
import ToolLifetimeFixture from "./ToolLifetimeFixture.vue";
import ToolPanelHeader from "./ToolPanelHeader.vue";
import ToolPanelBody from "./ToolPanelBody.vue";
import LayoutDebug from "./LayoutDebug.vue";
import ThemeLab from "./ThemeLab.vue";
import { toolPanelSizes } from "./toolPanelSizes";
import Stage from "./Stage.vue";
import PlayerTopBar from "./PlayerTopBar.vue";
import Transcript from "./Transcript.vue";
import ConversationSurface from "./ConversationSurface.vue";
import RuntimeInteraction from "./RuntimeInteraction.vue";
import { transcriptFixtures, transcriptFixtureSpeakers } from "./transcriptFixtures";
import { createPlayerRuntimeSession, createPlayerRuntimeRestorePoint, restorePlayerRuntimeSession, type PlayerRuntimeSession, type PlayerRuntimeRestorePoint } from "../../../runtime-adapter.js";
import { runtimeScenario, interactionScenario } from "./runtimeScenario";
import { stageFixtures } from "./stageFixtures";
import type { PlayerTimerKind } from "../../../model.js";
import TimerFixtureRegion from "./TimerFixtureRegion.vue";
import StageRightRail from "./StageRightRail.vue";
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
// Opt-in browser-test content; never populate the normal settings surface with fixtures.
const toolStateFixture = isDevelopment && new URLSearchParams(window.location.search).has("tool-state-fixture");
const mediaFixture = ref<keyof typeof stageFixtures>("Landscape");
const longTitle = ref(false);
const timerKind = ref<PlayerTimerKind>("visible");
const timerCount = ref(1);
const timerReset = ref(0);
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
// Label modes change the menu and its reservation together. Do not let the
// shared Sidebar's width transition leave its background trailing the menu.
// Keep ordinary dock transitions and the preview's own animation intact.
watch(labelMode, () => {
  const dock = toolsSurface.value?.closest('[data-slot="sidebar"] > .fixed');
  for (const animation of dock?.getAnimations() ?? []) {
    if (animation instanceof CSSTransition && animation.transitionProperty === "width") animation.cancel();
  }
}, { flush: "post" });
const clickPreview = ref<boolean | null>(null);
const labelsVisible = computed(() => labelMode.value === "labels"
  || (labelMode.value === "preview" && (clickPreview.value === true
    || (clickPreview.value !== false && (hoverPreview.value || focusPreview.value)))));
provide("phase2c-menu-labels-visible", labelsVisible);

let hoverPreviewTimer: ReturnType<typeof setTimeout> | undefined;
function updateHoverPreview(event: PointerEvent) {
  const strip = menuSidebar.value?.getBoundingClientRect();
  // Follow the current pointer, including a mouse attached to a touch-first device.
  if (event.pointerType === "mouse") clickPreview.value = null;
  const overMenu = event.pointerType === "mouse"
    && !!strip && event.clientX >= strip.left && event.clientX < strip.right;
  if (!overMenu || labelMode.value !== "preview") {
    leaveMenu();
  } else if (!hoverPreview.value && hoverPreviewTimer === undefined) {
    hoverPreviewTimer = setTimeout(() => {
      hoverPreviewTimer = undefined;
      hoverPreview.value = true;
    }, 200);
  }
}

function leaveMenu() {
  clearTimeout(hoverPreviewTimer);
  hoverPreviewTimer = undefined;
  hoverPreview.value = false;
  if (clickPreview.value === false) clickPreview.value = null;
}

// Cancel pending hover when the launcher shell disappears or its mode changes.
watch([menuSidebar, labelMode], leaveMenu);
onBeforeUnmount(leaveMenu);

async function updateFocusPreview() {
  await nextTick();
  focusPreview.value = !!menuSidebar.value?.querySelector(":focus-visible:not([data-settings-trigger])");
  if (focusPreview.value) clickPreview.value = null;
}

onClickOutside(menuSidebar, () => { clickPreview.value = null; }, {
  ignore: ['[data-slot="dialog-content"]', '[data-slot="dialog-overlay"]'],
});

function clickMenuSpace(event: MouseEvent) {
  // Only direct touch/pen activation latches labels; mouse and keyboard already
  // have hover/focus preview. Ignore synthetic/keyboard clicks without a pointer.
  if (!(event instanceof PointerEvent) || !["touch", "pen"].includes(event.pointerType)) return;
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
// Preview measures content; the permanent label width is a session-only rem choice.
const menuRuler = ref<HTMLElement | null>(null);
const measuredMenuWidth = ref(0);
const menuWidths = { icons: 3, min: 13, default: 16, max: 24 };
const menuWidthRem = ref(menuWidths.default);
const remSize = ref(parseFloat(getComputedStyle(document.documentElement).fontSize));
const menuBounds = computed(() => ({ min: menuWidths.min * remSize.value, max: menuWidths.max * remSize.value }));
useResizeObserver(menuRuler, () => {
  const ruler = menuRuler.value;
  if (!ruler) return;
  measuredMenuWidth.value = ruler.getBoundingClientRect().width;
  remSize.value = parseFloat(getComputedStyle(document.documentElement).fontSize);
});
const permanentMenuWidth = computed(() => menuWidthRem.value * remSize.value);
// Use the usable viewport, including browser keyboard resizing, without guessing keyboard height.
const viewport = ref({ width: window.innerWidth, height: window.innerHeight, left: 0, top: 0 });
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
  const initialMenuMode = labelMode.value;
  const initialMenuWidth = menuWidthRem.value;
  // A capped preset must shrink from its visible edge, not the stored preset width.
  const initialWidth = tool ? edge.parentElement!.getBoundingClientRect().width
    : (initialMenuMode === "icons" ? menuWidths.icons : initialMenuWidth) * rem;
  // Halfway across the unused gap keeps the minimum label width easy to select.
  const menuSnapWidth = (menuWidths.icons + menuWidths.min) / 2;
  resizing.value = tool ?? "menu";
  edge.setPointerCapture(event.pointerId);
  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== event.pointerId) return;
    const width = initialWidth + moveEvent.clientX - startX;
    if (tool) {
      toolSizes.value[tool] = panelSizeNames.reduce((nearest, size) =>
        Math.abs(toolPanelSizes[size] * rem - width) < Math.abs(toolPanelSizes[nearest] * rem - width) ? size : nearest);
    } else {
      labelMode.value = width / rem < menuSnapWidth ? "icons" : "labels";
      // Collapsing preserves the prior width. An outward drag restores it;
      // ordinary resizing from labels continues to follow the pointer.
      menuWidthRem.value = labelMode.value === "icons" || initialMenuMode === "icons"
        ? initialMenuWidth
        : Math.max(menuWidths.min, Math.min(menuWidths.max, width / rem));
    }
  };
  const cancel = () => {
    if (tool && initialSize) toolSizes.value[tool] = initialSize;
    else {
      menuWidthRem.value = initialMenuWidth;
      labelMode.value = initialMenuMode;
    }
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
  if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
  event.preventDefault();
  if (event.key === "Enter") {
    labelMode.value = labelMode.value === "icons" ? "labels" : "icons";
  } else if (labelMode.value === "icons") {
    if (event.key === "ArrowRight" || event.key === "End") labelMode.value = "labels";
  } else {
    menuWidthRem.value = event.key === "Home" ? menuWidths.min : event.key === "End" ? menuWidths.max
      : Math.max(menuWidths.min, Math.min(menuWidths.max, menuWidthRem.value + (event.key === "ArrowRight" ? 1 : -1)));
  }
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
// Visible order is separate from content lifetime. Mount lazily, then retain each
// visited tool until this Player unmounts; hiding/replacing a panel never resets it.
const visitedTools = ref<Tool[]>([]);
watch(() => [...openTools.value], tools => {
  for (const tool of tools) if (!visitedTools.value.includes(tool)) visitedTools.value.push(tool);
});
const toolContentParking = ref<HTMLElement | null>(null);
const toolContentTargets = shallowReactive<Partial<Record<Tool, HTMLElement>>>({});
function setToolContentTarget(tool: Tool, element: Element | ComponentPublicInstance | null) {
  if (element instanceof HTMLElement) toolContentTargets[tool] = element;
  else delete toolContentTargets[tool];
}
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
    :data-sidebar-visible="sidebarVisible"
    :data-menu-visible="narrowMenuVisible"
    :style="{ '--stage-height': `${stageHeight}px`, '--media-aspect': mediaAspect, '--active-tool-width': `${toolPanelSizes[narrowTool ? toolSizes[narrowTool] : 'Medium']}rem`, '--player-reserve': `${protectedPlayerWidth}px`, '--tool-columns-width': `${toolColumnsWidth}rem`, '--permanent-menu-width': `${menuWidthRem}rem`, '--measured-menu-width': `${measuredMenuWidth}px`, '--usable-width': `${viewport.width}px`, '--usable-height': `${viewport.height}px`, '--viewport-left': `${viewport.left}px`, '--viewport-top': `${viewport.top}px` }"
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
    <div ref="toolContentParking" hidden inert />
    <template v-if="toolContentParking">
      <ToolPanelBody v-for="tool in visitedTools" :key="tool"
        :target="toolContentTargets[tool] ?? toolContentParking"
        :visible="sidebarVisible && openTools.includes(tool) && (!narrow || (!narrowMenuVisible && narrowTool === tool))">
          <ToolLifetimeFixture v-if="toolStateFixture && tool === 'Layout Debug'" />
          <LayoutDebug v-else-if="isDevelopment && tool === 'Layout Debug' && shellElement" :player="shellElement" />
          <div v-if="isDevelopment && tool === 'Visual Lab'" class="space-y-4 p-4 text-sm">
            <ThemeLab />
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
              <Button variant="outline" @click="timerReset++">Reset timers</Button>
            </fieldset>
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
      </ToolPanelBody>
    </template>
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
        <div v-if="labelMode !== 'preview' && !narrow" class="resize-edge menu-resize-edge" role="separator" tabindex="0" aria-orientation="vertical"
          :aria-valuemin="menuWidths.icons * remSize" :aria-valuemax="Math.round(menuBounds.max)" :aria-valuenow="labelMode === 'icons' ? menuWidths.icons * remSize : Math.round(permanentMenuWidth)"
          :aria-valuetext="labelMode === 'icons' ? 'Icons only' : `${menuWidthRem}rem, icons and labels`"
          aria-label="Menu Sidebar width" aria-description="Drag to resize or switch between icons and labels. Press Enter to toggle labels."
          @pointerdown="startResize($event)" @keydown="resizeMenuKey">
          <GripVertical class="menu-resize-grip" aria-hidden="true" />
        </div>
        </div>
        <div v-if="sidebarVisible" v-show="!narrow || !narrowMenuVisible" ref="toolStrip" role="region" aria-label="Tool Panels" :tabindex="openTools.length ? 0 : undefined" class="tool-panel-strip flex min-w-0 flex-1 overflow-x-auto overscroll-x-contain focus-visible:outline-2 focus-visible:-outline-offset-2">
    <section v-for="tool in openTools" :key="tool" v-show="!narrow || tool === narrowTool" :data-tool="tool" :aria-label="`${tool} panel`" :style="{ width: `${toolPanelSizes[toolSizes[tool]]}rem` }" class="relative flex min-h-0 shrink-0 flex-col border-r bg-[var(--surface-component)]">
      <ToolPanelHeader :tool="tool" :size="toolSizes[tool]" :pinned="pinnedTools.includes(tool)"
        :can-move-left="openTools.indexOf(tool) > 0" :can-move-right="openTools.indexOf(tool) < openTools.length - 1"
        @resize="toolSizes[tool] = $event" @pin="setPinned(tool, $event)" @move="moveTool(tool, $event)" />
      <div :ref="element => setToolContentTarget(tool, element)" class="contents" />
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
    <SidebarInset class="min-h-0 min-w-0 bg-transparent">
      <div class="player-composition relative">
        <PlayerTopBar
          :title="longTitle ? 'An evening by the coast — a quiet moment before the journey begins' : 'Evening by the coast'"
          :fullscreen="fullscreen"
          :fullscreen-supported="fullscreenSupported"
          :fullscreen-error="fullscreenError"
          @toggle-fullscreen="toggleFullscreen"
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
                <TimerFixtureRegion :kind="timerKind" :count="timerCount" :reset="timerReset" />
              </template>
            </StageRightRail>
          </template>
        </Stage>

        <ConversationSurface>
          <template #default="{ bottomInset }">
            <Transcript :bottom-inset="bottomInset" :key="runtimeSession ? `runtime-${runtimeGeneration}` : 'fixtures'" :entries="runtimeSession?.transcriptEntries ?? transcriptEntries" :speakers="runtimeSession?.speakers ?? transcriptFixtureSpeakers" :revision="runtimeSession?.transcriptRevision ?? 0" />
          </template>
          <template #interaction><RuntimeInteraction v-model:session="runtimeSession" :reset="interactionReset" /></template>
        </ConversationSurface>
      </div>
    </SidebarInset>
  </SidebarProvider>
</template>
