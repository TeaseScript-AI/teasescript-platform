<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { onClickOutside } from "@vueuse/core";
import { FlaskConical, Settings, Pin, ScanLine } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import { Toggle } from "@/components/ui/toggle";
import SidebarMenu from "@/components/ui/sidebar/SidebarMenu.vue";
import SidebarMenuItem from "@/components/ui/sidebar/SidebarMenuItem.vue";
import SidebarMenuButton from "@/components/ui/sidebar/SidebarMenuButton.vue";
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
const sidebarVisible = ref(true);
const labelMode = ref<"icons" | "preview" | "labels">("preview");
const menuSidebar = ref<HTMLElement | null>(null);
const clickPreview = ref<boolean | null>(null);
onClickOutside(menuSidebar, () => { clickPreview.value = null; }, {
  ignore: ['[data-slot="dialog-content"]', '[data-slot="dialog-overlay"]'],
});

function clickMenuSpace(event: MouseEvent) {
  if (labelMode.value !== "preview" || (event.target as Element).closest("button, a, input, select, textarea, [role=button]")) return;
  clickPreview.value = clickPreview.value !== true;
}
type Tool = "Visual Lab" | "Layout Debug";
const pinnedTools = ref<Tool[]>([]);
const temporaryTool = ref<Tool | null>(null);
const openTools = computed(() => temporaryTool.value
  ? [...pinnedTools.value, temporaryTool.value] : pinnedTools.value);

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

async function toggleSidebarVisibility() {
  const keepTriggerFocus = document.activeElement?.matches("[data-sidebar=trigger]");
  sidebarVisible.value = !sidebarVisible.value;
  clickPreview.value = null;
  if (keepTriggerFocus) {
    await nextTick();
    document.querySelector<HTMLButtonElement>("[data-sidebar=trigger]")?.focus();
  }
}
</script>

<template>
  <SidebarProvider
    :style="{ '--tool-columns-width': `${openTools.length * 16}rem` }"
    :data-labels="labelMode"
    :data-click-preview="clickPreview"
    class="phase2c-sidebar h-dvh min-h-0 overflow-hidden"
    :open="sidebarVisible" :responsive="false" @update:open="toggleSidebarVisibility"
  >
    <Sidebar variant="sidebar" collapsible="offcanvas">
      <div class="relative flex h-full min-h-0">
        <div v-if="sidebarVisible" data-launcher-space class="relative shrink-0">
        <div v-if="sidebarVisible" ref="menuSidebar" data-launcher @click="clickMenuSpace" @mouseleave="clickPreview === false && (clickPreview = null)" class="relative flex h-full flex-col border-r bg-sidebar">
      <SidebarHeader>
        <SidebarTrigger
          class="size-8"
          aria-label="Hide sidebar"
          title="Hide sidebar"
        />
      </SidebarHeader>
      <nav aria-label="Tools" class="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Visual Lab" :tooltip-when-expanded="labelMode !== 'labels'" title="Visual Lab" aria-label="Visual Lab" :is-active="openTools.includes('Visual Lab')" @click="clickTool('Visual Lab', $event)" @dblclick="setPinned('Visual Lab', !pinnedTools.includes('Visual Lab'))">
              <FlaskConical /><span data-launcher-label>Visual Lab</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Layout Debug" :tooltip-when-expanded="labelMode !== 'labels'" title="Layout Debug" aria-label="Layout Debug" :is-active="openTools.includes('Layout Debug')" @click="clickTool('Layout Debug', $event)" @dblclick="setPinned('Layout Debug', !pinnedTools.includes('Layout Debug'))">
              <ScanLine /><span data-launcher-label>Layout Debug</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </nav>
      <div class="mt-auto p-2">
        <Dialog>
          <Tooltip>
            <TooltipTrigger as-child>
              <DialogTrigger as-child>
                <Button data-settings-trigger variant="ghost" aria-label="Settings" class="h-8 w-full justify-start gap-2 overflow-hidden px-2">
                  <Settings class="size-4 shrink-0" /><span data-launcher-label>Settings</span>
                </Button>
              </DialogTrigger>
            </TooltipTrigger>
            <TooltipContent v-if="labelMode !== 'labels'" side="right">Settings</TooltipContent>
          </Tooltip>
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
    <section v-for="tool in openTools" :key="tool" :aria-label="`${tool} panel`" class="flex w-64 shrink-0 flex-col border-r bg-neutral-50">
      <header class="flex min-h-12 items-center justify-between gap-2 border-b p-2">
        <h2 class="text-sm font-medium">{{ tool }}</h2>
        <Toggle
          :model-value="pinnedTools.includes(tool)"
          :aria-label="`Pin ${tool}`"
          :title="pinnedTools.includes(tool) ? `Unpin ${tool}` : `Pin ${tool}`"
          size="sm"
          class="shrink-0 data-[state=on]:bg-neutral-300"
          @update:model-value="setPinned(tool, $event)"
        >
          <Pin />
        </Toggle>
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
