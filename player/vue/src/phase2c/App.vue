<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { FlaskConical, PanelLeftOpen, PanelLeftClose, Pin, ScanLine } from "@lucide/vue";
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

const isDevelopment = import.meta.env.DEV;
const sidebarVisible = ref(true);
const showLabels = ref(true);
const labelMode = ref<"explicit" | "preview">("explicit");
const launcherHovered = ref(false);
const launcherFocused = ref(false);
const labelsRevealed = computed(() => showLabels.value || (
  isDevelopment && labelMode.value === "preview" && (launcherHovered.value || launcherFocused.value)
));

function onLauncherFocusOut(event: FocusEvent) {
  launcherFocused.value = (event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null);
}

type Tool = "Visual Lab" | "Layout Debug";
const pinnedTools = ref<Tool[]>([]);
const temporaryTool = ref<Tool | null>(null);
const openTools = computed(() => temporaryTool.value
  ? [...pinnedTools.value, temporaryTool.value] : pinnedTools.value);

function openTool(tool: Tool) {
  if (!pinnedTools.value.includes(tool)) temporaryTool.value = tool;
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
  launcherHovered.value = false;
  launcherFocused.value = false;
  if (keepTriggerFocus) {
    await nextTick();
    document.querySelector<HTMLButtonElement>("[data-sidebar=trigger]")?.focus();
  }
}
</script>

<template>
  <SidebarProvider :style="{ '--sidebar-width': `calc(${labelsRevealed ? '12rem' : 'var(--sidebar-width-icon)'} + ${openTools.length} * 16rem + 1px)` }" class="h-dvh min-h-0 overflow-hidden" :open="sidebarVisible" :responsive="false" @update:open="toggleSidebarVisibility">
    <Sidebar variant="sidebar" collapsible="offcanvas">
      <div class="flex h-full min-h-0 overflow-hidden">
        <div v-if="sidebarVisible" data-launcher class="flex shrink-0 flex-col border-r" :class="labelsRevealed ? 'w-48' : 'w-(--sidebar-width-icon)'"
          @mouseenter="launcherHovered = true" @mouseleave="launcherHovered = false"
          @focusin="launcherFocused = true" @focusout="onLauncherFocusOut">
      <SidebarHeader>
        <SidebarTrigger
          class="size-8"
          aria-label="Hide sidebar"
          title="Hide sidebar"
        />
      </SidebarHeader>
      <nav aria-label="Tools" class="mt-10 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Visual Lab" title="Visual Lab" aria-label="Visual Lab" :is-active="openTools.includes('Visual Lab')" @click="openTool('Visual Lab')">
              <FlaskConical /><span :class="{ 'sr-only': !labelsRevealed }">Visual Lab</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Layout Debug" title="Layout Debug" aria-label="Layout Debug" :is-active="openTools.includes('Layout Debug')" @click="openTool('Layout Debug')">
              <ScanLine /><span :class="{ 'sr-only': !labelsRevealed }">Layout Debug</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </nav>
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
      <label v-if="isDevelopment && tool === 'Visual Lab'" class="flex flex-col gap-2 p-3 text-sm">
        Sidebar label behavior
        <select v-model="labelMode" class="w-full rounded-md border bg-white p-2">
          <option value="explicit">A — Explicit only</option>
          <option value="preview">B — Explicit + preview</option>
        </select>
      </label>
    </section>
        </div>
      </div>
      <Tooltip v-if="sidebarVisible">
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="absolute right-2 top-12 z-20 size-8"
            :aria-label="showLabels ? 'Hide labels' : 'Show labels'"
            @click="showLabels = !showLabels"
          >
            <PanelLeftClose v-if="showLabels" />
            <PanelLeftOpen v-else />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">{{ showLabels ? 'Hide labels' : 'Show labels' }}</TooltipContent>
      </Tooltip>
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
