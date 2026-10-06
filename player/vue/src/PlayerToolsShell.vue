<script lang="ts">
import type { Component } from "vue";

export interface PlayerTool {
  readonly name: string;
  readonly icon: Component;
}
</script>

<script setup lang="ts">
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
import Switch from "@/components/ui/switch/Switch.vue";
import Sortable from "sortablejs";
import ToolPanelHeader from "./ToolPanelHeader.vue";
import ToolPanelBody from "./ToolPanelBody.vue";
import ResizeHandle from "./ResizeHandle.vue";
import { toolPanelSizes } from "./toolPanelSizes";
import { providePlayerConditions } from "./usePlayerConditions";
import { usePlayerPreference } from "./usePlayerPreference";
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
import { onClickOutside, useResizeObserver } from "@vueuse/core";
import { Settings, PanelLeftOpen, PanelRightOpen } from "@lucide/vue";

// Own tool interaction, panel lifetime and dock/drawer composition together.
// Callers supply the tool list, tool contents and the Player composition through props/slots.
const props = defineProps<{
  tools: readonly PlayerTool[];
  stageHeight: number;
  mediaAspect: number;
  fullscreen: boolean;
  /** The script's saved data when the host persists it; clearing is possible only while no session runs. */
  savedData?: { readonly canClear: boolean; readonly clear: () => Promise<boolean> } | null;
}>();
// User-facing Player Settings: owned by PlayerApp and available in every build.
const contrast = defineModel<"standard" | "high">("contrast", { required: true });
const titlebarOption = defineModel<"left" | "overlap">("titlebarOption", { required: true });
// Testing: whether the tools menu offers the Debug panel. PlayerApp owns it; it is not a stored preference.
const debugMenu = defineModel<boolean>("debugMenu", { required: true });
type LabelMode = "icons" | "preview" | "labels";
const labelMode = usePlayerPreference<LabelMode>("player-menu-label-mode", ["icons", "preview", "labels"], "icons");
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
provide("player-menu-labels-visible", labelsVisible);

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
type Tool = string;
const toolSizes = ref<Record<Tool, keyof typeof toolPanelSizes>>({});
const toolSize = (tool: Tool) => toolSizes.value[tool] ?? "Medium";
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
// Existing provisional conversation width plus fixture margins/borders.
const protectedPlayerWidth = computed(() => 380 + 6 * remSize.value + 4);
const requiredDockWidth = computed(
  () =>
    Math.max(
      900,
      protectedPlayerWidth.value +
        (labelMode.value === "labels" ? permanentMenuWidth.value : compactMenuWidth.value) +
        toolPanelSizes.Small * remSize.value +
        1,
    ),
);
const conditions = providePlayerConditions(requiredDockWidth);
const { viewport, horizontalConstrained: narrow } = conditions;
// All compact presentation follows the same space constraints. The broad
// comfortable state may use the larger timer without another compact switch.
const timerSize = computed(() => {
  if (narrow.value || conditions.verticalConstrained.value) return 96;
  return viewport.value.width >= 2240 ? 192 : 128;
});
const timerRailWidth = computed(() => timerSize.value === 192 ? 192 : 156);
watch(viewport, () => {
  remSize.value = parseFloat(getComputedStyle(document.documentElement).fontSize);
});
const sidebarVisible = ref(!narrow.value);
const sidebarContentsPresent = ref(sidebarVisible.value);
const playerSettingsOpen = ref(false);
// Clearing saved script data asks for confirmation first and then reports its result.
const clearSavedData = ref<"idle" | "confirm" | "clearing" | "cleared" | "failed">("idle");
watch(playerSettingsOpen, () => (clearSavedData.value = "idle"));
const clearConfirmation = ref<HTMLElement | null>(null);
async function askToClearSavedData() {
  clearSavedData.value = "confirm";
  // The control that replaced Clear takes focus, so keyboard users keep their place.
  await nextTick();
  clearConfirmation.value?.querySelector("button")?.focus();
}
async function confirmClearSavedData() {
  clearSavedData.value = "clearing";
  clearSavedData.value = (await props.savedData?.clear()) ? "cleared" : "failed";
}
watch(
  [sidebarVisible, narrow],
  async ([open, isNarrow], _, onCleanup) => {
    let cancelled = false;
    onCleanup(() => { cancelled = true; });
    if (open) {
      sidebarContentsPresent.value = true;
      return;
    }
    const restoreFocus = !!document.activeElement?.closest(
      "[data-tools-surface], [data-tools-context]",
    );
    playerSettingsOpen.value = false;
    if (isNarrow) sidebarContentsPresent.value = false;
    await nextTick();
    if (cancelled) return;
    if (restoreFocus) focusToolsToggle();
    if (isNarrow) return;
    // Let the browser commit the new transition, including when reversing an
    // opening transition in the same frame.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (cancelled) return;
    // Keep the visible surface intact until its own motion ends. Cancelling or
    // disabling a transition also settles finished; reopening cancels this cleanup.
    const dock = toolsSurface.value?.closest('[data-slot="sidebar"]')
      ?.querySelector<HTMLElement>(":scope > .fixed");
    await Promise.allSettled(dock?.getAnimations().map((animation) => animation.finished) ?? []);
    if (!cancelled) sidebarContentsPresent.value = false;
  },
  { flush: "sync" },
);
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
    ?.querySelector<HTMLButtonElement>(
      sidebarVisible.value
        ? "[data-tools-surface] [data-sidebar=trigger]"
        : "[data-player-top-bar] [data-sidebar=trigger]",
    )
    ?.focus({ preventScroll: true });
}
// Reka's focus trap wraps with preventScroll; keep the wrapped control visible on short screens.
function revealFocusedSetting(event: FocusEvent) {
  if (event.target instanceof HTMLElement) event.target.scrollIntoView({ block: "nearest" });
}
function closeSettingsFocus(event: Event) {
  if (sidebarVisible.value) return;
  event.preventDefault();
  focusToolsToggle();
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
function closeDrawerFromTooltip(event: KeyboardEvent) {
  if (
    !narrow.value ||
    !sidebarVisible.value ||
    !document.querySelector('[data-slot="tooltip-content"]')
  ) return;
  event.preventDefault();
  event.stopPropagation();
  setSidebarVisible(false);
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
  const initialSize = tool ? toolSize(tool) : null;
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
        : panelSizeNames.indexOf(toolSize(tool)) + (event.key === "ArrowRight" ? 1 : -1);
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
// A tool the caller no longer supplies, such as Debug after the Debug menu is turned off, leaves every panel state and
// unmounts its content. Focus inside its panel moves to the tools toggle.
watch(
  () => props.tools.map((tool) => tool.name),
  async (names) => {
    const removed = (tool: Tool) => !names.includes(tool);
    const removedFocus = visitedTools.value.some(
      (tool) =>
        removed(tool) &&
        !!toolContentTargets[tool]?.closest("[data-tool]")?.contains(document.activeElement),
    );
    if (pendingToolClose && removed(pendingToolClose.tool)) cancelPendingClose();
    if (lastClosedTool && removed(lastClosedTool.tool)) lastClosedTool = null;
    if (narrowTool.value !== null && removed(narrowTool.value)) {
      narrowTool.value = null;
      narrowMenuVisible.value = true;
    }
    if (temporaryTool.value !== null && removed(temporaryTool.value)) temporaryTool.value = null;
    openTools.value = openTools.value.filter((tool) => !removed(tool));
    pinnedTools.value = pinnedTools.value.filter((tool) => !removed(tool));
    visitedTools.value = visitedTools.value.filter((tool) => !removed(tool));
    if (!removedFocus) return;
    await nextTick();
    focusToolsToggle();
  },
);
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
  openTools.value.reduce((width, tool) => width + toolPanelSizes[toolSize(tool)], 0),
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
    shellElement.value?.contains(document.activeElement) &&
    document.activeElement?.matches("[data-sidebar=trigger]");
  setSidebarVisible(open);
  if (keepTriggerFocus) {
    await nextTick();
    focusToolsToggle();
  }
}
</script>

<template>
  <div
    class="player-viewport-canvas"
    :style="{
      '--stage-height': `${stageHeight}px`,
      '--usable-width': `${viewport.width}px`,
      '--usable-height': `${viewport.height}px`,
      '--viewport-left': `${viewport.left}px`,
      '--viewport-top': `${viewport.top}px`,
      '--player-timer-size': `${timerSize}px`,
      '--player-timer-rail-width': `${timerRailWidth}px`,
    }"
  >
  <SidebarProvider
    id="player-shell"
    :tooltip-delay-duration="700"
    :tooltip-skip-delay-duration="0"
    :tooltip-ignore-non-keyboard-focus="true"
    :data-player-horizontal="narrow ? 'constrained' : 'comfortable'"
    :data-player-vertical="conditions.verticalConstrained.value ? 'constrained' : 'comfortable'"
    :data-player-touch="conditions.touchAvailable.value ? 'available' : 'unavailable'"
    :data-player-hover="conditions.hoverAvailable.value ? 'available' : 'unavailable'"
    :data-player-fullscreen="fullscreen ? 'active' : 'inactive'"
    :data-player-touch-edge="conditions.touchAtScreenEdge.value ? 'protected' : 'normal'"
    :data-player-keyboard="conditions.keyboardRaised.value ? 'raised' : 'closed'"
    :data-player-edge="conditions.edgeClearance.value ? 'protected' : 'normal'"
    :data-sidebar-visible="sidebarVisible"
    :data-menu-visible="narrowMenuVisible"
    :style="{
      '--media-aspect': mediaAspect,
      '--active-tool-width': `${toolPanelSizes[narrowTool ? toolSize(narrowTool) : 'Medium']}rem`,
      '--player-reserve': `${protectedPlayerWidth}px`,
      '--tool-columns-width': `${toolColumnsWidth}rem`,
      '--permanent-menu-width': `${menuWidthRem}rem`,
      '--measured-menu-width': `${measuredMenuWidth}px`,
    }"
    :data-resizing="resizing !== null"
    :data-labels="labelMode"
    :data-tools-open="openTools.length > 0"
    :data-labels-visible="labelsVisible"
    class="player-sidebar fixed inset-x-0 min-h-0 overflow-hidden"
    :open="sidebarVisible"
    :responsive="false"
    @update:open="updateSidebarVisibility"
  >
    <div ref="compactMenuRuler" class="player-menu-compact-ruler" aria-hidden="true" />
    <div ref="menuRuler" class="menu-width-ruler" aria-hidden="true">
      <span v-for="tool in tools" :key="tool.name">{{ tool.name }}</span>
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
        :portal-target="narrow ? '#player-shell' : undefined"
        :class="narrow ? 'tools-drawer' : undefined"
        @open-auto-focus="openDrawerFocus"
        @close-auto-focus="closeDrawerFocus"
        @keydown.esc.capture="closeDrawerFromTooltip"
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
          :inert="!sidebarVisible"
          class="relative flex h-full min-h-0"
          :class="{ 'flex-col': narrow }"
        >
          <div v-if="narrow" class="player-drawer-header flex shrink-0 items-center gap-2 border-b">
            <Tooltip>
              <TooltipTrigger as-child>
                <SidebarTrigger
                  data-tools-focus="toggle"
                  class="player-control-square"
                  aria-label="Hide sidebar"
                />
              </TooltipTrigger>
              <TooltipContent side="right">Hide sidebar</TooltipContent>
            </Tooltip>
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
            v-if="sidebarContentsPresent"
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
                <Tooltip>
                  <TooltipTrigger as-child>
                    <SidebarTrigger
                      class="player-control-square"
                      data-tools-focus="toggle"
                      aria-label="Hide sidebar"
                    />
                  </TooltipTrigger>
                  <TooltipContent side="right">Hide sidebar</TooltipContent>
                </Tooltip>
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
              <nav aria-label="Tools" class="player-edge-padding player-tool-menu">
                <SidebarMenu>
                  <SidebarMenuItem v-for="tool in tools" :key="tool.name">
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
                <Dialog v-model:open="playerSettingsOpen">
                  <DialogTrigger as-child>
                    <MenuSidebarButton
                      label="Settings"
                      data-tools-focus="player-settings"
                      data-settings-trigger
                    >
                      <Settings />
                    </MenuSidebarButton>
                  </DialogTrigger>
                  <DialogContent
                    data-tools-context
                    data-player-settings
                    @close-auto-focus="closeSettingsFocus"
                    @focusin="revealFocusedSetting"
                  >
                    <DialogHeader>
                      <DialogTitle>Player Settings</DialogTitle>
                      <DialogDescription>
                        Preferences for the Player interface{{ savedData ? " and this script's saved data" : "" }}.
                      </DialogDescription>
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
                    <label class="flex flex-col gap-2 text-sm">
                      Contrast
                      <select
                        v-model="contrast"
                        data-player-setting="contrast"
                        class="rounded-md border bg-background p-2"
                      >
                        <option value="standard">Standard</option>
                        <option value="high">High</option>
                      </select>
                    </label>
                    <fieldset class="grid gap-2 border-t pt-4 text-sm" data-player-setting="titlebar">
                      <legend class="font-medium">Title bar on short screens · A/B test</legend>
                      <label class="flex items-start gap-2">
                        <input v-model="titlebarOption" type="radio" name="titlebar-option" value="left" />
                        A · Always visible, controls left
                      </label>
                      <label class="flex items-start gap-2">
                        <input v-model="titlebarOption" type="radio" name="titlebar-option" value="overlap" />
                        B · Auto-hide, controls right
                      </label>
                    </fieldset>
                    <section class="grid gap-2 border-t pt-4 text-sm" data-player-setting="testing">
                      <h3 class="font-medium">Testing</h3>
                      <label class="flex min-h-11 items-center justify-between gap-4">
                        Debug menu
                        <Switch v-model="debugMenu" data-player-setting="debug-menu" />
                      </label>
                      <p class="text-muted-foreground">
                        Adds the Debug panel to the tools menu until the page is reloaded. It shows how the script
                        runs and may reveal what comes next.
                      </p>
                    </section>
                    <section
                      v-if="savedData"
                      class="grid gap-2 border-t pt-4 text-sm"
                      data-player-setting="saved-data"
                    >
                      <h3 class="font-medium">Saved script data</h3>
                      <p>What this script saved in this browser for its next runs.</p>
                      <template v-if="clearSavedData === 'confirm' || clearSavedData === 'clearing'">
                        <p>Clear all saved data for this script? This cannot be undone.</p>
                        <div ref="clearConfirmation" class="flex gap-2">
                          <Button
                            variant="destructive"
                            size="sm"
                            :disabled="clearSavedData === 'clearing'"
                            data-clear-saved-data-confirm
                            @click="confirmClearSavedData"
                          >
                            {{ clearSavedData === "clearing" ? "Clearing…" : "Clear" }}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            :disabled="clearSavedData === 'clearing'"
                            @click="clearSavedData = 'idle'"
                          >
                            Cancel
                          </Button>
                        </div>
                      </template>
                      <template v-else>
                        <Button
                          class="justify-self-start"
                          variant="outline"
                          size="sm"
                          :disabled="!savedData.canClear"
                          data-clear-saved-data
                          @click="askToClearSavedData"
                        >
                          Clear saved script data
                        </Button>
                        <p v-if="!savedData.canClear">Available before the session starts or after it ends.</p>
                        <p v-if="clearSavedData === 'cleared'" role="status">Saved script data cleared.</p>
                        <p v-if="clearSavedData === 'failed'" role="status">Could not clear saved script data.</p>
                      </template>
                    </section>
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
            v-if="sidebarContentsPresent"
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
              :style="{ width: `${toolPanelSizes[toolSize(tool)]}rem` }"
              class="relative flex min-h-0 shrink-0 bg-card"
            >
              <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                <ToolPanelHeader
                  :active="sidebarVisible"
                  :tool="tool"
                  :size="toolSize(tool)"
                  :pinned="pinnedTools.includes(tool)"
                  :can-move-left="openTools.indexOf(tool) > 0"
                  :can-move-right="openTools.indexOf(tool) < openTools.length - 1"
                  @restore-focus="focusToolsToggle"
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
                :aria-valuenow="toolPanelSizes[toolSize(tool)]"
                :aria-valuetext="toolSize(tool)"
                @pointerdown="startResize($event, tool)"
                @keydown="resizePanelKey($event, tool)"
              >
                <span v-if="resizing === tool" class="resize-size-label">{{
                  toolSize(tool)
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
  </div>
</template>
