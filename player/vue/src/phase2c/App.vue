<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, provide, ref, watch, type ObjectDirective } from "vue";
import { onClickOutside, useEventListener, useResizeObserver, useStorage } from "@vueuse/core";
import { FlaskConical, Settings, Pin, ScanLine, ChevronDown, Ellipsis, Activity, GripVertical, SlidersHorizontal } from "@lucide/vue";
import Sortable from "sortablejs";
import { Button } from "@/components/ui/button";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import { Toggle } from "@/components/ui/toggle";
import { DropdownMenuItem } from "reka-ui";
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

import DropdownMenu from "@/components/ui/dropdown-menu/DropdownMenu.vue";
import DropdownMenuTrigger from "@/components/ui/dropdown-menu/DropdownMenuTrigger.vue";
import DropdownMenuContent from "@/components/ui/dropdown-menu/DropdownMenuContent.vue";
import DropdownMenuRadioGroup from "@/components/ui/dropdown-menu/DropdownMenuRadioGroup.vue";
import DropdownMenuRadioItem from "@/components/ui/dropdown-menu/DropdownMenuRadioItem.vue";

import DropdownMenuSub from "@/components/ui/dropdown-menu/DropdownMenuSub.vue";
import DropdownMenuSubTrigger from "@/components/ui/dropdown-menu/DropdownMenuSubTrigger.vue";
import DropdownMenuSubContent from "@/components/ui/dropdown-menu/DropdownMenuSubContent.vue";

const isDevelopment = import.meta.env.DEV;
type LabelMode = "icons" | "preview" | "labels";
const labelMode = isDevelopment
  ? useStorage<LabelMode>("phase2c-menu-label-mode", "icons")
  : ref<LabelMode>("icons");
if (!["icons", "preview", "labels"].includes(labelMode.value)) labelMode.value = "icons";
const hoverPreview = ref(false);
const focusPreview = ref(false);
const menuSidebar = ref<HTMLElement | null>(null);
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
const toolPanelSizes = {
  Small: 14,
  Medium: 18,
  Large: 24,
  "Extra Large": 32,
} as const;
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
const narrow = computed(() => viewport.value.width < 380 + 6 * remSize.value + 4
  + (labelMode.value === "labels" ? permanentMenuWidth.value : 3 * remSize.value)
  + toolPanelSizes.Small * remSize.value + 1);
const sidebarVisible = ref(!narrow.value);
let transitionFocusLabel: string | null = null;
watch(narrow, (isNarrow) => {
  const active = document.activeElement as HTMLElement | null;
  const inside = !!active?.closest("[data-tools-surface], [data-slot=sheet-content], [data-tools-context]")
    || !!document.querySelector(".tool-panel-strip[data-reordering]") || resizing.value !== null;
  transitionFocusLabel = inside ? active?.getAttribute("aria-label") ?? null : null;
  stopResize?.();
  // Do not cover the Player on a layout change unless tools own the active interaction.
  if (isNarrow && !inside) sidebarVisible.value = false;
  if (!isNarrow && inside && sidebarVisible.value) void nextTick(focusToolsToggle);
}, { flush: "pre" });
function focusToolsToggle() {
  document.querySelector<HTMLButtonElement>("[data-sidebar=trigger]")?.focus({ preventScroll: true });
}
function openDrawerFocus(event: Event) {
  event.preventDefault();
  const surface = document.querySelector("[data-slot=sheet-content]");
  const target = transitionFocusLabel
    ? Array.from(surface?.querySelectorAll<HTMLElement>("[aria-label]") ?? [])
      .find(element => element.getAttribute("aria-label") === transitionFocusLabel)
    : null;
  // Focus the existing toggle, not a tool or input that could trigger a preview/keyboard.
  (target ?? surface?.querySelector<HTMLElement>("[data-sidebar=trigger]"))?.focus({ preventScroll: true });
  transitionFocusLabel = null;
}
async function closeDrawerFocus(event: Event) {
  event.preventDefault();
  await nextTick();
  focusToolsToggle();
}
function setSidebarVisible(open: boolean) {
  sidebarVisible.value = open;
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
let pendingToolClose: { tool: Tool; timer: ReturnType<typeof setTimeout> } | null = null;
let lastClosedTool: { tool: Tool; index: number; pinned: boolean } | null = null;
const toolStrip = ref<HTMLElement | null>(null);
let revealRequest = 0;

async function revealTool(tool: Tool) {
  const request = ++revealRequest;
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
  if (!strip) return;
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

// Measure intrinsic content, never the current compact/expanded button width.
const compactPanelSettings = ref<Partial<Record<Tool, boolean>>>({});
const truncatedTitles = ref<Partial<Record<Tool, boolean>>>({});
const headerObservers = new WeakMap<HTMLElement, ResizeObserver>();
const vFitPanelSettings: ObjectDirective<HTMLElement, Tool> = {
  mounted(header, { value: tool }) {
    const title = header.querySelector<HTMLElement>("h2")!;
    // Measure the full title independently of its visible truncation and trigger presentation.
    const naturalTitle = title.cloneNode(true) as HTMLElement;
    naturalTitle.setAttribute("aria-hidden", "true");
    naturalTitle.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;width:max-content;pointer-events:none";
    header.append(naturalTitle);
    const controls = header.querySelector<HTMLElement>("[data-panel-controls]")!;
    const trigger = header.querySelector<HTMLElement>(".panel-settings-trigger")!;
    const fullLabel = header.querySelector<HTMLElement>(".panel-settings-expanded")!;
    const pin = header.querySelector<HTMLElement>("[data-panel-pin]")!;
    const grip = header.querySelector<HTMLElement>("[data-panel-drag]")!;
    const measure = () => {
      const headerStyle = getComputedStyle(header);
      const triggerStyle = getComputedStyle(trigger);
      const required = naturalTitle.getBoundingClientRect().width
        + fullLabel.getBoundingClientRect().width + pin.getBoundingClientRect().width + grip.getBoundingClientRect().width
        + parseFloat(triggerStyle.paddingLeft) + parseFloat(triggerStyle.paddingRight)
        + parseFloat(triggerStyle.borderLeftWidth) + parseFloat(triggerStyle.borderRightWidth)
        + parseFloat(getComputedStyle(controls).columnGap) + 2 * parseFloat(headerStyle.columnGap)
        + parseFloat(headerStyle.paddingLeft) + parseFloat(headerStyle.paddingRight);
      compactPanelSettings.value[tool] = required > header.clientWidth;
      truncatedTitles.value[tool] = title.scrollWidth > title.clientWidth;
    };
    const observer = new ResizeObserver(measure);
    for (const element of [header, title, naturalTitle, fullLabel, pin, grip]) observer.observe(element);
    headerObservers.set(header, observer);
    measure();
  },
  unmounted(header) {
    headerObservers.get(header)?.disconnect();
    headerObservers.delete(header);
  },
};

async function toggleSidebarVisibility() {
  const keepTriggerFocus = document.activeElement?.matches("[data-sidebar=trigger]");
  setSidebarVisible(!sidebarVisible.value);
  if (keepTriggerFocus) {
    await nextTick();
    document.querySelector<HTMLButtonElement>("[data-sidebar=trigger]")?.focus();
  }
}
</script>

<template>
  <SidebarProvider
    id="phase2c-shell"
    :data-narrow="narrow"
    :style="{ '--tool-columns-width': `${toolColumnsWidth}rem`, '--permanent-menu-width': `${permanentMenuWidth}px`, '--usable-width': `${viewport.width}px`, '--usable-height': `${viewport.height}px`, '--viewport-left': `${viewport.left}px`, '--viewport-top': `${viewport.top}px` }"
    :data-resizing="resizing !== null"
    :data-labels="labelMode"
    :data-tools-open="openTools.length > 0"
    :data-labels-visible="labelsVisible"
    class="phase2c-sidebar relative h-dvh min-h-0 overflow-hidden"
    :open="sidebarVisible" :responsive="false" @update:open="toggleSidebarVisibility"
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
      <div data-tools-surface class="relative flex h-full min-h-0">
        <div v-if="sidebarVisible" data-launcher-space class="relative shrink-0">
        <div ref="menuSidebar" data-launcher @click="clickMenuSpace" @pointerenter="updateHoverPreview" @pointermove="updateHoverPreview" @pointerleave="leaveMenu" @focusin="updateFocusPreview" @focusout="updateFocusPreview" class="relative flex h-full flex-col border-r bg-sidebar">
      <SidebarHeader>
        <SidebarTrigger
          class="size-8"
          aria-label="Hide sidebar"
          title="Hide sidebar"
        />
      </SidebarHeader>
      <nav aria-label="Tools" class="min-h-0 overflow-y-auto p-2">
        <SidebarMenu>
          <SidebarMenuItem v-for="tool in launcherTools" :key="tool.name">
            <MenuSidebarButton :label="tool.name" :is-active="openTools.includes(tool.name)" @click="clickTool(tool.name, $event)" @dblclick="toggleToolPin(tool.name)">
              <component :is="tool.icon" />
            </MenuSidebarButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </nav>
      <div class="mt-auto p-2">
        <Dialog>
          <DialogTrigger as-child>
            <MenuSidebarButton label="Settings" data-settings-trigger>
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
              <select v-model="labelMode" class="rounded-md border bg-background p-2">
                <option value="icons">Icons only</option>
                <option value="preview">Icons + preview</option>
                <option value="labels">Icons + labels</option>
              </select>
            </label>
          </DialogContent>
        </Dialog>
      </div>
        </div>
        <div v-if="labelMode === 'labels'" class="resize-edge menu-resize-edge" role="separator" tabindex="0" aria-label="Menu Sidebar width" aria-orientation="vertical"
          :aria-valuemin="Math.round(menuBounds.min)" :aria-valuemax="Math.round(menuBounds.max)" :aria-valuenow="Math.round(permanentMenuWidth)"
          @pointerdown="startResize($event)" @keydown="resizeMenuKey" />
        </div>
        <div v-if="sidebarVisible" ref="toolStrip" role="region" aria-label="Tool Panels" :tabindex="openTools.length ? 0 : undefined" class="tool-panel-strip flex min-w-0 flex-1 overflow-x-auto overscroll-x-contain focus-visible:outline-2 focus-visible:-outline-offset-2">
    <section v-for="tool in openTools" :key="tool" :data-tool="tool" :aria-label="`${tool} panel`" :style="{ width: `${toolPanelSizes[toolSizes[tool]]}rem` }" class="relative flex min-h-0 shrink-0 flex-col border-r bg-neutral-50">
      <header v-fit-panel-settings="tool" :data-compact-settings="compactPanelSettings[tool]" class="flex min-h-12 items-center justify-between gap-2 border-b p-2">
        <span data-panel-drag class="inline-flex shrink-0 cursor-grab touch-none select-none items-center self-stretch rounded-sm px-0.5 hover:bg-neutral-200 active:cursor-grabbing" aria-hidden="true" title="Drag to reorder">
          <GripVertical class="size-4" />
        </span>
        <Tooltip :disabled="!truncatedTitles[tool]">
          <TooltipTrigger as-child>
            <h2 :tabindex="truncatedTitles[tool] ? 0 : undefined" class="mr-auto min-w-0 truncate rounded-sm text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2">{{ tool }}</h2>
          </TooltipTrigger>
          <TooltipContent>{{ tool }}</TooltipContent>
        </Tooltip>
        <div data-panel-controls class="flex shrink-0 items-center gap-1">
          <Tooltip :disabled="!compactPanelSettings[tool]">
            <TooltipTrigger as-child>
              <span class="inline-flex">
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button variant="ghost" size="sm" class="panel-settings-trigger group h-8 gap-1 px-2 hover:bg-neutral-200 active:bg-neutral-300 data-[state=open]:bg-neutral-200" aria-label="Panel settings">
                      <span class="panel-settings-expanded inline-flex w-max shrink-0 items-center gap-1">
                        Panel settings
                        <ChevronDown class="size-3 transition-transform group-data-[state=open]:rotate-180" />
                      </span>
                      <Ellipsis class="panel-settings-compact size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent data-tools-context align="end">
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>Width</DropdownMenuSubTrigger>
                      <DropdownMenuSubContent data-tools-context>
                        <DropdownMenuRadioGroup v-model="toolSizes[tool]" aria-label="Panel width">
                          <DropdownMenuRadioItem v-for="size in Object.keys(toolPanelSizes)" :key="size" :value="size">
                            {{ size }}
                          </DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <template v-if="openTools.length > 1">
                      <DropdownMenuItem
                        :disabled="openTools.indexOf(tool) === 0"
                        class="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                        @select="moveTool(tool, -1)"
                      >Move left</DropdownMenuItem>
                      <DropdownMenuItem
                        :disabled="openTools.indexOf(tool) === openTools.length - 1"
                        class="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                        @select="moveTool(tool, 1)"
                      >Move right</DropdownMenuItem>
                    </template>
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            </TooltipTrigger>
            <TooltipContent>Panel settings</TooltipContent>
          </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <span class="inline-flex">
        <Toggle
          data-panel-pin
          :model-value="pinnedTools.includes(tool)"
          :aria-label="`Pin ${tool}`"
          size="sm"
          class="shrink-0 data-[state=on]:bg-neutral-300"
          @update:model-value="setPinned(tool, $event)"
        >
          <Pin />
        </Toggle>
            </span>
          </TooltipTrigger>
          <TooltipContent>{{ pinnedTools.includes(tool) ? "Unpin panel" : "Pin panel" }}</TooltipContent>
        </Tooltip>
        </div>
      </header>
      <div data-tool-body class="min-h-0 flex-1 overflow-y-auto" />
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
      <div v-if="isDevelopment" class="m-4 flex min-h-0 flex-1 flex-col gap-4 border border-dashed border-neutral-400 p-4">
        <section class="shrink-0">
          <h2 class="mb-2 text-sm font-medium">Stage · 16:9 · max-height: 40% of viewport</h2>
          <div class="mx-auto flex aspect-video w-[min(100%,71.111dvh)] items-center justify-center border-2 border-neutral-400 bg-neutral-100 text-sm text-neutral-500">
            Media placeholder
          </div>
        </section>

        <section class="mx-auto flex min-h-0 w-full max-w-[920px] flex-1 flex-col gap-3 border-x border-dashed border-neutral-400 px-4">
          <h2 class="shrink-0 text-sm font-medium">Transcript · max-width: 920px</h2>
          <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          <p class="text-sm leading-relaxed"><strong>Mistress:</strong> Take a moment to look around. This is a simple test scene.</p>
          <p class="ml-auto max-w-[75%] rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-3 text-sm">I am ready. What happens next?</p>
          <p class="text-sm leading-relaxed"><strong>Mistress:</strong> This deliberately longer message helps us see how the conversation wraps when the sidebar opens, closes, or changes its presentation, and how much room remains for the scene and your response.</p>
          </div>
          <div class="flex min-w-0 shrink-0 gap-2 pt-2">
            <input aria-label="Test response" placeholder="Type your response..." class="min-w-0 flex-1 rounded border border-neutral-400 bg-white px-3 py-2 text-sm" />
            <button type="button" class="shrink-0 rounded border border-neutral-400 bg-neutral-100 px-4 py-2 text-sm">Send</button>
          </div>
        </section>
      </div>
    </SidebarInset>
  </SidebarProvider>
</template>
