<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { FlaskConical, Pin, ScanLine } from "@lucide/vue";
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
const sidebarState = ref<"hidden" | "icon" | "expanded">("expanded");

type Tool = "Visual Lab" | "Layout Debug";
const pinnedTools = ref<Tool[]>([]);
const temporaryTool = ref<Tool | null>(null);
const openTools = computed(() => temporaryTool.value
  ? [...pinnedTools.value, temporaryTool.value] : pinnedTools.value);

function openTool(tool: Tool) {
  sidebarState.value = "expanded";
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

async function cycleSidebar() {
  const keepTriggerFocus = document.activeElement?.matches("[data-sidebar=trigger]");
  sidebarState.value = sidebarState.value === "expanded" ? "icon"
    : sidebarState.value === "icon" ? "hidden" : "expanded";
  if (keepTriggerFocus) {
    await nextTick();
    document.querySelector<HTMLButtonElement>("[data-sidebar=trigger]")?.focus();
  }
}
</script>

<template>
  <SidebarProvider :style="{ '--sidebar-width': `calc(var(--sidebar-width-icon) + ${openTools.length} * 16rem + 1px)` }" class="h-dvh min-h-0 overflow-hidden" :open="sidebarState === 'expanded'" :responsive="false" @update:open="cycleSidebar">
    <Sidebar variant="sidebar" :collapsible="sidebarState === 'hidden' ? 'offcanvas' : 'icon'">
      <div class="flex h-full min-h-0 overflow-hidden">
        <div v-if="sidebarState !== 'hidden'" class="flex w-(--sidebar-width-icon) shrink-0 flex-col border-r">
      <SidebarHeader>
        <SidebarTrigger
          class="size-8"
          :aria-label="`Sidebar: ${sidebarState}. Switch to ${sidebarState === 'expanded' ? 'icon-only' : 'hidden'}`"
          :title="`Sidebar: ${sidebarState} — click to cycle`"
        />
      </SidebarHeader>
      <nav aria-label="Tools" class="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Visual Lab" title="Visual Lab" aria-label="Visual Lab" :is-active="openTools.includes('Visual Lab')" @click="openTool('Visual Lab')">
              <FlaskConical /><span class="sr-only">Visual Lab</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Layout Debug" title="Layout Debug" aria-label="Layout Debug" :is-active="openTools.includes('Layout Debug')" @click="openTool('Layout Debug')">
              <ScanLine /><span class="sr-only">Layout Debug</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </nav>
        </div>
        <div v-if="sidebarState === 'expanded'" class="flex min-w-0 flex-1">
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
      v-if="sidebarState === 'hidden'"
      class="fixed left-2 top-2 z-40 size-8 bg-sidebar"
      aria-label="Show sidebar"
      title="Show sidebar"
    />
    <SidebarInset class="min-h-0 min-w-0">
      <section
        v-if="isDevelopment"
        aria-label="Sidebar development controls"
        class="fixed right-4 top-4 z-40 flex max-w-[calc(100vw-5rem)] flex-wrap items-end gap-3 rounded-lg border bg-background/95 p-3 text-sm shadow-sm"
      >
        <div class="basis-full text-xs font-medium text-muted-foreground">
          Phase 2C · Sidebar preview
        </div>
        <label class="flex min-w-0 flex-col gap-1">
          Sidebar state
          <select v-model="sidebarState" class="h-9 max-w-full rounded-md border bg-background px-2">
            <option value="hidden">Hidden / off-canvas</option>
            <option value="icon">Icon-only</option>
            <option value="expanded">Expanded</option>
          </select>
        </label>
      </section>
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
