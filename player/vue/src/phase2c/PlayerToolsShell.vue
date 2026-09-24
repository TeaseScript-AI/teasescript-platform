<script setup lang="ts">
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
import Sortable from "sortablejs";
import ToolPanelHeader from "./ToolPanelHeader.vue";
import ToolPanelBody from "./ToolPanelBody.vue";
import ResizeHandle from "./ResizeHandle.vue";
import { toolPanelSizes } from "./toolPanelSizes";
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
import {
  computed,
  nextTick,
  onBeforeUnmount,
  provide,
  ref,
  shallowReactive,
  watch,
  type ComponentPublicInstance,
} from "vue";
import { onClickOutside, useEventListener, useResizeObserver, useStorage } from "@vueuse/core";
import {
  FlaskConical,
  Settings,
  ScanLine,
  Activity,
  SlidersHorizontal,
  PanelLeftOpen,
  PanelRightOpen,
} from "@lucide/vue";

// Own tool interaction, panel lifetime and dock/drawer composition together.
// Callers supply tool contents and the Player composition through slots.
defineProps<{ stageHeight: number; mediaAspect: number }>();
const isDevelopment = import.meta.env.DEV;
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
const labelsVisible = computed(
  () =>
    labelMode.value === "labels" ||
    (labelMode.value === "preview" &&
      (clickPreview.value === true ||
        (clickPreview.value !== false && (hoverPreview.value || focusPreview.value)))),
);
provide("phase2c-menu-labels-visible", labelsVisible);

let hoverPreviewTimer: ReturnType<typeof setTimeout> | undefined;
function updateHoverPreview(event: PointerEvent) {
  const strip = menuSidebar.value?.getBoundingClientRect();
  // Follow the current pointer, including a mouse attached to a touch-first device.
  if (event.pointerType === "mouse") clickPreview.value = null;
  const overMenu =
    event.pointerType === "mouse" &&
    !!strip &&
    event.clientX >= strip.left &&
    event.clientX < strip.right;
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
  focusPreview.value = !!menuSidebar.value?.querySelector(
    ":focus-visible:not([data-settings-trigger])",
  );
  if (focusPreview.value) clickPreview.value = null;
}

onClickOutside(
  menuSidebar,
  () => {
    clickPreview.value = null;
  },
  { ignore: ['[data-slot="dialog-content"]', '[data-slot="dialog-overlay"]'] },
);

function clickMenuSpace(event: MouseEvent) {
  // Only direct touch/pen activation latches labels; mouse and keyboard already
  // have hover/focus preview. Ignore synthetic/keyboard clicks without a pointer.
  if (!(event instanceof PointerEvent) || !["touch", "pen"].includes(event.pointerType)) return;
  if (
    labelMode.value !== "preview" ||
    (event.target as Element).closest("button, a, input, select, textarea, [role=button]")
  )
    return;
  clickPreview.value = clickPreview.value !== true;
}
const tools = [
  { name: "Visual Lab", icon: FlaskConical, developmentOnly: false },
  { name: "Layout Debug", icon: ScanLine, developmentOnly: false },
  { name: "Playback Diagnostics", icon: Activity, developmentOnly: true },
  { name: "Media Playback Configuration", icon: SlidersHorizontal, developmentOnly: true },
] as const;
type Tool = (typeof tools)[number]["name"];
const launcherTools = tools.filter((tool) => isDevelopment || !tool.developmentOnly);
const toolSizes = ref<Record<Tool, keyof typeof toolPanelSizes>>({
  "Visual Lab": "Medium",
  "Layout Debug": "Medium",
  "Playback Diagnostics": "Medium",
  "Media Playback Configuration": "Medium",
});
// Preview measures content; the permanent label width is a session-only rem choice.
const menuRuler = ref<HTMLElement | null>(null);
const measuredMenuWidth = ref(0);
const compactMenuRuler = ref<HTMLElement | null>(null);
const compactMenuWidth = ref(0);
useResizeObserver(compactMenuRuler, () => {
  compactMenuWidth.value = compactMenuRuler.value?.getBoundingClientRect().width ?? 0;
});
const menuWidths = { min: 13, default: 16, max: 24 };
const menuWidthRem = ref(menuWidths.default);
const remSize = ref(parseFloat(getComputedStyle(document.documentElement).fontSize));
const menuBounds = computed(() => ({
  min: menuWidths.min * remSize.value,
  max: menuWidths.max * remSize.value,
}));
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
  viewport.value = {
    width: visual?.width ?? window.innerWidth,
    height: visual?.height ?? window.innerHeight,
    left: visual?.offsetLeft ?? 0,
    top: visual?.offsetTop ?? 0,
  };
  remSize.value = parseFloat(getComputedStyle(document.documentElement).fontSize);
}
updateViewport();
useEventListener(window, "resize", updateViewport);
useEventListener(window.visualViewport, "resize", updateViewport);
useEventListener(window.visualViewport, "scroll", updateViewport);
// Existing provisional conversation width plus fixture margins/borders.
const protectedPlayerWidth = computed(() => 380 + 6 * remSize.value + 4);
const narrow = computed(
  () =>
    viewport.value.width <
    protectedPlayerWidth.value +
      (labelMode.value === "labels" ? permanentMenuWidth.value : compactMenuWidth.value) +
      toolPanelSizes.Small * remSize.value +
      1,
);
const sidebarVisible = ref(!narrow.value);
let transitionFocusKey: string | null = null;
watch(
  narrow,
  (isNarrow) => {
    const active = document.activeElement as HTMLElement | null;
    const inside =
      !!active?.closest("[data-tools-surface], [data-slot=sheet-content], [data-tools-context]") ||
      toolStrip.value?.dataset.reordering === "true" ||
      resizing.value !== null;
    transitionFocusKey = inside ? (active?.getAttribute("data-tools-focus") ?? null) : null;
    stopResize?.();
    // Do not cover the Player on a layout change unless tools own the active interaction.
    if (isNarrow) narrowMenuVisible.value = true;
    if (isNarrow && !inside) sidebarVisible.value = false;
    if (!isNarrow && inside && sidebarVisible.value) void nextTick(focusToolsToggle);
  },
  { flush: "pre" },
);
function focusToolsToggle() {
  shellElement.value
    ?.querySelector<HTMLButtonElement>("[data-sidebar=trigger]")
    ?.focus({ preventScroll: true });
}
function openDrawerFocus(event: Event) {
  event.preventDefault();
  const surface = toolsSurface.value;
  const target = transitionFocusKey
    ? Array.from(surface?.querySelectorAll<HTMLElement>("[data-tools-focus]") ?? []).find(
        (element) => element.getAttribute("data-tools-focus") === transitionFocusKey,
      )
    : null;
  // Focus the existing toggle, not a tool or input that could trigger a preview/keyboard.
  (target ?? surface?.querySelector<HTMLElement>("[data-sidebar=trigger]"))?.focus({
    preventScroll: true,
  });
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
  const initialWidth = tool
    ? edge.parentElement!.getBoundingClientRect().width
    : (initialMenuMode === "icons" ? compactMenuWidth.value : initialMenuWidth * rem);
  // Halfway across the unused gap keeps the minimum label width easy to select.
  const menuSnapWidth = (compactMenuWidth.value / rem + menuWidths.min) / 2;
  resizing.value = tool ?? "menu";
  edge.setPointerCapture(event.pointerId);
  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== event.pointerId) return;
    const width = initialWidth + moveEvent.clientX - startX;
    if (tool) {
      toolSizes.value[tool] = panelSizeNames.reduce((nearest, size) =>
        Math.abs(toolPanelSizes[size] * rem - width) <
        Math.abs(toolPanelSizes[nearest] * rem - width)
          ? size
          : nearest,
      );
    } else {
      labelMode.value = width / rem < menuSnapWidth ? "icons" : "labels";
      // Collapsing preserves the prior width. An outward drag restores it;
      // ordinary resizing from labels continues to follow the pointer.
      menuWidthRem.value =
        labelMode.value === "icons" || initialMenuMode === "icons"
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
  const key = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key === "Escape") cancel();
  };
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
    menuWidthRem.value =
      event.key === "Home"
        ? menuWidths.min
        : event.key === "End"
          ? menuWidths.max
          : Math.max(
              menuWidths.min,
              Math.min(menuWidths.max, menuWidthRem.value + (event.key === "ArrowRight" ? 1 : -1)),
            );
  }
}
function resizePanelKey(event: KeyboardEvent, tool: Tool) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const index =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? panelSizeNames.length - 1
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
watch(
  () => [...openTools.value],
  (tools) => {
    for (const tool of tools) if (!visitedTools.value.includes(tool)) visitedTools.value.push(tool);
  },
);
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
    (
      menu?.querySelector<HTMLButtonElement>('[aria-current="true"]') ??
      menu?.querySelector<HTMLButtonElement>("[data-sidebar=menu-button]")
    )?.focus({ preventScroll: true });
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
    if (focusFromMenu)
      toolsSurface.value
        ?.querySelector<HTMLButtonElement>("[data-show-tools]")
        ?.focus({ preventScroll: true });
    return;
  }
  await nextTick();
  const strip = toolStrip.value;
  if (!strip) return;
  if (request !== revealRequest || strip !== toolStrip.value) return;
  const panel = strip?.querySelector<HTMLElement>(`[data-tool="${tool}"]`);
  if (!strip || !panel) return;
  const viewport = strip.getBoundingClientRect();
  const bounds = panel.getBoundingClientRect();
  // Like native nearest scrolling: leave an already visible (or viewport-spanning) panel alone.
  if (
    (bounds.left >= viewport.left && bounds.right <= viewport.right) ||
    (bounds.left <= viewport.left && bounds.right >= viewport.right)
  )
    return;
  const offset =
    bounds.width > strip.clientWidth || bounds.left < viewport.left
      ? bounds.left - viewport.left
      : bounds.right - viewport.right;
  strip.scrollBy({ left: offset, behavior: "instant" });
}

const toolColumnsWidth = computed(() =>
  openTools.value.reduce((width, tool) => width + toolPanelSizes[toolSizes.value[tool]], 0),
);

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
  lastClosedTool = {
    tool,
    index: openTools.value.indexOf(tool),
    pinned: pinnedTools.value.includes(tool),
  };
  openTools.value = openTools.value.filter((item) => item !== tool);
  pinnedTools.value = pinnedTools.value.filter((item) => item !== tool);
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
      pendingToolClose = {
        tool,
        timer: setTimeout(() => {
          pendingToolClose = null;
          closeTool(tool);
        }, 200),
      };
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
      openTools.value = openTools.value.filter((item) => item !== temporaryTool.value);
    }
    pinnedTools.value = pinnedTools.value.filter((item) => item !== tool);
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

watch(
  toolStrip,
  (strip, _, onCleanup) => {
    if (!strip || narrow.value) return;
    let originalNextSibling: ChildNode | null = null;
    const content = strip.firstElementChild as HTMLElement;
    const sortable = new Sortable(content, {
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
        content.insertBefore(event.item, originalNextSibling);
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
  },
  { flush: "post" },
);

async function updateSidebarVisibility(open: boolean) {
  const keepTriggerFocus =
    shellElement.value?.querySelector("[data-sidebar=trigger]") === document.activeElement;
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
    :style="{
      '--stage-height': `${stageHeight}px`,
      '--media-aspect': mediaAspect,
      '--active-tool-width': `${toolPanelSizes[narrowTool ? toolSizes[narrowTool] : 'Medium']}rem`,
      '--player-reserve': `${protectedPlayerWidth}px`,
      '--tool-columns-width': `${toolColumnsWidth}rem`,
      '--permanent-menu-width': `${menuWidthRem}rem`,
      '--measured-menu-width': `${measuredMenuWidth}px`,
      '--usable-width': `${viewport.width}px`,
      '--usable-height': `${viewport.height}px`,
      '--viewport-left': `${viewport.left}px`,
      '--viewport-top': `${viewport.top}px`,
    }"
    :data-resizing="resizing !== null"
    :data-labels="labelMode"
    :data-tools-open="openTools.length > 0"
    :data-labels-visible="labelsVisible"
    class="phase2c-sidebar relative h-dvh min-h-0 overflow-hidden"
    :open="sidebarVisible"
    :responsive="false"
    @update:open="updateSidebarVisibility"
  >
    <div ref="compactMenuRuler" class="player-menu-compact-ruler" aria-hidden="true" />
    <div ref="menuRuler" class="menu-width-ruler" aria-hidden="true">
      <span v-for="tool in launcherTools" :key="tool.name">{{ tool.name }}</span>
      <span>Settings</span>
    </div>
    <div ref="toolContentParking" hidden inert />
    <template v-if="toolContentParking">
      <ToolPanelBody
        v-for="tool in visitedTools"
        :key="tool"
        :target="toolContentTargets[tool] ?? toolContentParking"
        :visible="
          sidebarVisible &&
          openTools.includes(tool) &&
          (!narrow || (!narrowMenuVisible && narrowTool === tool))
        "
      >
        <slot name="tool" :tool="tool" :player="shellElement" />
      </ToolPanelBody>
    </template>
    <!-- The local Sheet owns responsiveness; disable the provider’s independent mobile state. -->
    <Sheet :open="narrow && sidebarVisible" @update:open="setSidebarVisible">
      <component
        :is="narrow ? SheetContent : Sidebar"
        side="left"
        variant="sidebar"
        collapsible="offcanvas"
        :portal-target="narrow ? '#phase2c-shell' : undefined"
        :class="narrow ? 'tools-drawer' : undefined"
        @open-auto-focus="openDrawerFocus"
        @close-auto-focus="closeDrawerFocus"
      >
        <template v-if="narrow">
          <SheetTitle class="sr-only">Tools Sidebar</SheetTitle>
          <SheetDescription class="sr-only"
            >Open, arrange and resize Player tools.</SheetDescription
          >
        </template>
        <div
          ref="toolsSurface"
          data-tools-surface
          class="relative flex h-full min-h-0"
          :class="{ 'flex-col': narrow }"
        >
          <div v-if="narrow" class="player-drawer-header flex shrink-0 items-center gap-2 border-b">
            <SidebarTrigger
              data-tools-focus="toggle"
              class="player-control-square"
              aria-label="Hide sidebar"
              title="Hide sidebar"
            />
            <Button
              v-if="!narrowMenuVisible"
              data-show-tools
              data-tools-focus="show-menu"
              variant="ghost"
              size="sm"
              @click="showToolMenu"
            >
              <PanelLeftOpen class="size-4" /> Tools
            </Button>
          </div>
          <div
            v-if="sidebarVisible"
            v-show="!narrow || narrowMenuVisible"
            data-launcher-space
            class="relative flex shrink-0 bg-sidebar"
          >
            <div
              ref="menuSidebar"
              data-launcher
              @click="clickMenuSpace"
              @pointerenter="updateHoverPreview"
              @pointermove="updateHoverPreview"
              @pointerleave="leaveMenu"
              @focusin="updateFocusPreview"
              @focusout="updateFocusPreview"
              class="relative flex h-full min-w-0 flex-col bg-sidebar"
              :class="{ 'flex-1': labelMode !== 'preview', 'border-r': labelMode === 'preview' }"
            >
              <SidebarHeader v-if="!narrow" class="player-edge-padding">
                <SidebarTrigger
                  class="player-control-square"
                  data-tools-focus="toggle"
                  aria-label="Hide sidebar"
                  title="Hide sidebar"
                />
              </SidebarHeader>
              <div v-if="narrow && narrowTool && openTools.includes(narrowTool)" class="player-edge-padding">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="player-control-square"
                      data-tools-focus="back-to-tool"
                      aria-label="Back to active tool"
                      @click="revealTool(narrowTool)"
                    >
                      <PanelRightOpen class="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Back to active tool</TooltipContent>
                </Tooltip>
              </div>
              <ScrollArea class="min-h-0" :viewport-attrs="{ 'aria-label': 'Tools' }">
              <nav aria-label="Tools" class="player-edge-padding">
                <SidebarMenu>
                  <SidebarMenuItem v-for="tool in launcherTools" :key="tool.name">
                    <MenuSidebarButton
                      :label="tool.name"
                      :data-tools-focus="`launcher:${tool.name}`"
                      :is-active="narrow ? narrowTool === tool.name : openTools.includes(tool.name)"
                      :aria-current="narrow && narrowTool === tool.name ? 'true' : undefined"
                      @click="clickTool(tool.name, $event)"
                      @dblclick="toggleToolPin(tool.name)"
                    >
                      <component :is="tool.icon" />
                    </MenuSidebarButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </nav>
              </ScrollArea>
              <div class="mt-auto player-edge-padding">
                <Dialog>
                  <DialogTrigger as-child>
                    <MenuSidebarButton
                      label="Settings"
                      data-tools-focus="player-settings"
                      data-settings-trigger
                    >
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
                      <select
                        data-tools-focus="label-mode"
                        v-model="labelMode"
                        class="rounded-md border bg-background p-2"
                      >
                        <option value="icons">Icons only</option>
                        <option value="preview">Icons + preview</option>
                        <option value="labels">Icons + labels</option>
                      </select>
                    </label>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
            <ResizeHandle
              v-if="labelMode !== 'preview' && !narrow"
              class="menu-resize-edge"
              role="separator"
              tabindex="0"
              aria-orientation="vertical"
              :data-active="resizing === 'menu' ? '' : undefined"
              :aria-valuemin="compactMenuWidth"
              :aria-valuemax="Math.round(menuBounds.max)"
              :aria-valuenow="
                labelMode === 'icons' ? compactMenuWidth : Math.round(permanentMenuWidth)
              "
              :aria-valuetext="
                labelMode === 'icons' ? 'Icons only' : `${menuWidthRem}rem, icons and labels`
              "
              aria-label="Menu Sidebar width"
              aria-description="Drag to resize or switch between icons and labels. Press Enter to toggle labels."
              @pointerdown="startResize($event)"
              @keydown="resizeMenuKey"
            />
          </div>
          <ScrollArea
            v-if="sidebarVisible"
            v-show="!narrow || !narrowMenuVisible"
            orientation="horizontal"
            class="flex-1"
            content-class="tool-panel-content flex h-full min-w-0"
            @viewport="toolStrip = $event"
            :viewport-attrs="{ role: 'region', 'aria-label': 'Tool Panels', tabindex: openTools.length ? 0 : -1 }"
            viewport-class="tool-panel-strip min-w-0 overscroll-x-contain focus-visible:outline-2 focus-visible:-outline-offset-2"
          >
            <section
              v-for="tool in openTools"
              :key="tool"
              v-show="!narrow || tool === narrowTool"
              :data-tool="tool"
              :aria-label="`${tool} panel`"
              :style="{ width: `${toolPanelSizes[toolSizes[tool]]}rem` }"
              class="relative flex min-h-0 shrink-0 bg-card"
            >
              <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                <ToolPanelHeader
                  :tool="tool"
                  :size="toolSizes[tool]"
                  :pinned="pinnedTools.includes(tool)"
                  :can-move-left="openTools.indexOf(tool) > 0"
                  :can-move-right="openTools.indexOf(tool) < openTools.length - 1"
                  @resize="toolSizes[tool] = $event"
                  @pin="setPinned(tool, $event)"
                  @move="moveTool(tool, $event)"
                />
                <div :ref="(element) => setToolContentTarget(tool, element)" class="contents" />
              </div>
              <ResizeHandle
                :data-panel-resize="tool"
                role="separator"
                tabindex="0"
                aria-orientation="vertical"
                :aria-label="`${tool} width`"
                :data-active="resizing === tool ? '' : undefined"
                :aria-valuemin="toolPanelSizes.Small"
                :aria-valuemax="toolPanelSizes['Extra Large']"
                :aria-valuenow="toolPanelSizes[toolSizes[tool]]"
                :aria-valuetext="toolSizes[tool]"
                @pointerdown="startResize($event, tool)"
                @keydown="resizePanelKey($event, tool)"
              >
                <span v-if="resizing === tool" class="resize-size-label">{{
                  toolSizes[tool]
                }}</span>
              </ResizeHandle>
            </section>
          </ScrollArea>
        </div>
      </component>
    </Sheet>
    <SidebarInset class="min-h-0 min-w-0 bg-transparent">
      <slot :sidebar-visible="sidebarVisible" />
    </SidebarInset>
  </SidebarProvider>
</template>
