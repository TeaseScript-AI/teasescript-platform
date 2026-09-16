<script setup lang="ts">
import { computed, nextTick, provide, ref, type ObjectDirective } from "vue";
import { onClickOutside, useStorage } from "@vueuse/core";
import { FlaskConical, Settings, Pin, ScanLine, ChevronDown, Ellipsis, Activity } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import { Toggle } from "@/components/ui/toggle";
import SidebarMenu from "@/components/ui/sidebar/SidebarMenu.vue";
import SidebarMenuItem from "@/components/ui/sidebar/SidebarMenuItem.vue";
import MenuSidebarButton from "./MenuSidebarButton.vue";
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
const sidebarVisible = ref(true);
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
  { name: "Visual Lab", icon: FlaskConical },
  { name: "Layout Debug", icon: ScanLine },
  { name: "Playback Diagnostics", icon: Activity },
] as const;
type Tool = typeof tools[number]["name"];
const launcherTools = tools.filter(tool => isDevelopment || tool.name !== "Playback Diagnostics");
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
});
const pinnedTools = ref<Tool[]>([]);
const temporaryTool = ref<Tool | null>(null);
const openTools = computed(() => temporaryTool.value
  ? [...pinnedTools.value, temporaryTool.value] : pinnedTools.value);

const toolColumnsWidth = computed(() => openTools.value.reduce(
  (width, tool) => width + toolPanelSizes[toolSizes.value[tool]], 0,
));

function clickTool(tool: Tool, event: MouseEvent) {
  // The browser sends two clicks before dblclick; apply the single-click action only once.
  if (event.detail > 1 || pinnedTools.value.includes(tool)) return;
  temporaryTool.value = temporaryTool.value === tool ? null : tool;
}

function setPinned(tool: Tool, pinned: boolean) {
  if (pinned) {
    pinnedTools.value.push(tool);
    if (temporaryTool.value === tool) temporaryTool.value = null;
  } else {
    pinnedTools.value = pinnedTools.value.filter(item => item !== tool);
    temporaryTool.value = tool;
  }
}

// Measure intrinsic content, never the current compact/expanded button width.
const compactPanelSettings = ref<Partial<Record<Tool, boolean>>>({});
const headerObservers = new WeakMap<HTMLElement, ResizeObserver>();
const vFitPanelSettings: ObjectDirective<HTMLElement, Tool> = {
  mounted(header, { value: tool }) {
    const title = header.querySelector<HTMLElement>("h2")!;
    // A hidden intrinsic-width copy leaves the visible title's overflow behavior alone.
    const naturalTitle = title.cloneNode(true) as HTMLElement;
    naturalTitle.setAttribute("aria-hidden", "true");
    naturalTitle.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;width:max-content;pointer-events:none";
    header.append(naturalTitle);
    const controls = header.querySelector<HTMLElement>("[data-panel-controls]")!;
    const trigger = header.querySelector<HTMLElement>(".panel-settings-trigger")!;
    const fullLabel = header.querySelector<HTMLElement>(".panel-settings-expanded")!;
    const pin = header.querySelector<HTMLElement>("[data-panel-pin]")!;
    const measure = () => {
      const headerStyle = getComputedStyle(header);
      const triggerStyle = getComputedStyle(trigger);
      const required = naturalTitle.getBoundingClientRect().width
        + fullLabel.getBoundingClientRect().width + pin.getBoundingClientRect().width
        + parseFloat(triggerStyle.paddingLeft) + parseFloat(triggerStyle.paddingRight)
        + parseFloat(triggerStyle.borderLeftWidth) + parseFloat(triggerStyle.borderRightWidth)
        + parseFloat(getComputedStyle(controls).columnGap) + parseFloat(headerStyle.columnGap)
        + parseFloat(headerStyle.paddingLeft) + parseFloat(headerStyle.paddingRight);
      compactPanelSettings.value[tool] = required > header.clientWidth;
    };
    const observer = new ResizeObserver(measure);
    for (const element of [header, naturalTitle, fullLabel, pin]) observer.observe(element);
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
  sidebarVisible.value = !sidebarVisible.value;
  clickPreview.value = null;
  hoverPreview.value = false;
  focusPreview.value = false;
  if (keepTriggerFocus) {
    await nextTick();
    document.querySelector<HTMLButtonElement>("[data-sidebar=trigger]")?.focus();
  }
}
</script>

<template>
  <SidebarProvider
    :style="{ '--tool-columns-width': `${toolColumnsWidth}rem` }"
    :data-labels="labelMode"
    :data-labels-visible="labelsVisible"
    class="phase2c-sidebar h-dvh min-h-0 overflow-hidden"
    :open="sidebarVisible" :responsive="false" @update:open="toggleSidebarVisibility"
  >
    <Sidebar variant="sidebar" collapsible="offcanvas">
      <div class="relative flex h-full min-h-0">
        <div v-if="sidebarVisible" data-launcher-space class="relative shrink-0">
        <div ref="menuSidebar" data-launcher @click="clickMenuSpace" @pointerenter="updateHoverPreview" @pointermove="updateHoverPreview" @pointerleave="leaveMenu" @focusin="updateFocusPreview" @focusout="updateFocusPreview" class="relative flex h-full flex-col border-r bg-sidebar">
      <SidebarHeader>
        <SidebarTrigger
          class="size-8"
          aria-label="Hide sidebar"
          title="Hide sidebar"
        />
      </SidebarHeader>
      <nav aria-label="Tools" class="p-2">
        <SidebarMenu>
          <SidebarMenuItem v-for="tool in launcherTools" :key="tool.name">
            <MenuSidebarButton :label="tool.name" :is-active="openTools.includes(tool.name)" @click="clickTool(tool.name, $event)" @dblclick="setPinned(tool.name, !pinnedTools.includes(tool.name))">
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
          <DialogContent>
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
        </div>
        <div v-if="sidebarVisible" class="flex min-w-0 flex-1">
    <section v-for="tool in openTools" :key="tool" :aria-label="`${tool} panel`" :style="{ width: `${toolPanelSizes[toolSizes[tool]]}rem` }" class="flex shrink-0 flex-col border-r bg-neutral-50">
      <header v-fit-panel-settings="tool" :data-compact-settings="compactPanelSettings[tool]" class="flex min-h-12 items-center justify-between gap-2 border-b p-2">
        <h2 class="text-sm font-medium">{{ tool }}</h2>
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
                  <DropdownMenuContent align="end">
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>Width</DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <DropdownMenuRadioGroup v-model="toolSizes[tool]" aria-label="Panel width">
                          <DropdownMenuRadioItem v-for="size in Object.keys(toolPanelSizes)" :key="size" :value="size">
                            {{ size }}
                          </DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            </TooltipTrigger>
            <TooltipContent>Panel settings</TooltipContent>
          </Tooltip>
        <Toggle
          data-panel-pin
          :model-value="pinnedTools.includes(tool)"
          :aria-label="`Pin ${tool}`"
          :title="pinnedTools.includes(tool) ? `Unpin ${tool}` : `Pin ${tool}`"
          size="sm"
          class="shrink-0 data-[state=on]:bg-neutral-300"
          @update:model-value="setPinned(tool, $event)"
        >
          <Pin />
        </Toggle>
        </div>
      </header>
    </section>
        </div>
      </div>
    </Sidebar>
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
