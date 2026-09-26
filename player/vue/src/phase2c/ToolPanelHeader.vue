<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { Pin, ChevronDown, Ellipsis, GripVertical } from "@lucide/vue";
import { toolPanelSizes, type ToolPanelSize } from "./toolPanelSizes";
import { Button } from "@/components/ui/button";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import { Toggle } from "@/components/ui/toggle";
import { DropdownMenuItem } from "reka-ui";
import DropdownMenu from "@/components/ui/dropdown-menu/DropdownMenu.vue";
import DropdownMenuTrigger from "@/components/ui/dropdown-menu/DropdownMenuTrigger.vue";
import DropdownMenuContent from "@/components/ui/dropdown-menu/DropdownMenuContent.vue";
import DropdownMenuRadioGroup from "@/components/ui/dropdown-menu/DropdownMenuRadioGroup.vue";
import DropdownMenuRadioItem from "@/components/ui/dropdown-menu/DropdownMenuRadioItem.vue";
import DropdownMenuSub from "@/components/ui/dropdown-menu/DropdownMenuSub.vue";
import DropdownMenuSubTrigger from "@/components/ui/dropdown-menu/DropdownMenuSubTrigger.vue";
import DropdownMenuSubContent from "@/components/ui/dropdown-menu/DropdownMenuSubContent.vue";

defineProps<{
  tool: string;
  size: ToolPanelSize;
  pinned: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
}>();
const emit = defineEmits<{
  resize: [size: ToolPanelSize];
  pin: [pinned: boolean];
  move: [direction: -1 | 1];
}>();
const panelSizeNames = Object.keys(toolPanelSizes) as ToolPanelSize[];
function selectSize(value: unknown) {
  const size = panelSizeNames.find((size) => size === value);
  if (size) emit("resize", size);
}
const header = ref<HTMLElement | null>(null);
const compactSettings = ref(false);
const truncatedTitle = ref(false);
let observer: ResizeObserver | undefined;
onMounted(() => {
  const element = header.value;
  if (!element) return;
  const title = element.querySelector<HTMLElement>("h2")!;
  // Measure the full title independently of its visible truncation and trigger presentation.
  const naturalTitle = title.cloneNode(true) as HTMLElement;
  naturalTitle.setAttribute("aria-hidden", "true");
  naturalTitle.removeAttribute("data-tools-focus");
  naturalTitle.style.cssText =
    "position:absolute;visibility:hidden;white-space:nowrap;width:max-content;pointer-events:none";
  element.append(naturalTitle);
  const controls = element.querySelector<HTMLElement>("[data-panel-controls]")!;
  const trigger = element.querySelector<HTMLElement>(".panel-settings-trigger")!;
  const fullLabel = element.querySelector<HTMLElement>(".panel-settings-expanded")!;
  const pin = element.querySelector<HTMLElement>("[data-panel-pin]")!;
  const grip = element.querySelector<HTMLElement>("[data-panel-drag]")!;
  const measure = () => {
    const headerStyle = getComputedStyle(element);
    const triggerStyle = getComputedStyle(trigger);
    const required =
      naturalTitle.getBoundingClientRect().width +
      fullLabel.getBoundingClientRect().width +
      pin.getBoundingClientRect().width +
      grip.getBoundingClientRect().width +
      parseFloat(triggerStyle.paddingLeft) +
      parseFloat(triggerStyle.paddingRight) +
      parseFloat(triggerStyle.borderLeftWidth) +
      parseFloat(triggerStyle.borderRightWidth) +
      parseFloat(getComputedStyle(controls).columnGap) +
      2 * parseFloat(headerStyle.columnGap) +
      parseFloat(headerStyle.paddingLeft) +
      parseFloat(headerStyle.paddingRight);
    compactSettings.value = required > element.clientWidth;
    truncatedTitle.value = title.scrollWidth > title.clientWidth;
  };
  observer = new ResizeObserver(measure);
  for (const observed of [element, title, naturalTitle, fullLabel, pin, grip])
    observer.observe(observed);

  measure();
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <header
    ref="header"
    :data-compact-settings="compactSettings"
    class="tool-panel-header flex items-center justify-between gap-2 border-b"
  >
    <span
      data-panel-drag
      class="inline-flex shrink-0 cursor-grab touch-none select-none items-center self-stretch rounded-sm px-0.5 hover:bg-accent active:cursor-grabbing"
      aria-hidden="true"
      title="Drag to reorder"
    >
      <GripVertical class="size-4" />
    </span>
    <Tooltip :disabled="!truncatedTitle">
      <TooltipTrigger as-child>
        <h2
          :data-tools-focus="`title:${tool}`"
          :tabindex="truncatedTitle ? 0 : undefined"
          class="mr-auto min-w-0 truncate rounded-sm text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {{ tool }}
        </h2>
      </TooltipTrigger>
      <TooltipContent>{{ tool }}</TooltipContent>
    </Tooltip>
    <div data-panel-controls class="flex shrink-0 items-center gap-1">
      <Tooltip :disabled="!compactSettings">
        <TooltipTrigger as-child>
          <span class="inline-flex">
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button
                  variant="ghost"
                  size="sm"
                  class="panel-settings-trigger group"
                  aria-label="Panel settings"
                  :data-tools-focus="`settings:${tool}`"
                >
                  <span
                    class="panel-settings-expanded inline-flex w-max shrink-0 items-center gap-1"
                  >
                    Panel settings
                    <ChevronDown
                      class="size-3 transition-transform group-data-[state=open]:rotate-180"
                    />
                  </span>
                  <Ellipsis class="panel-settings-compact size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent data-tools-context align="end">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Width</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent data-tools-context>
                    <DropdownMenuRadioGroup
                      :model-value="size"
                      @update:model-value="selectSize"
                      aria-label="Panel width"
                    >
                      <DropdownMenuRadioItem
                        v-for="size in panelSizeNames"
                        :key="size"
                        :value="size"
                      >
                        {{ size }}
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <template v-if="canMoveLeft || canMoveRight">
                  <DropdownMenuItem
                    :disabled="!canMoveLeft"
                    class="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                    @select="emit('move', -1)"
                    >Move left</DropdownMenuItem
                  >
                  <DropdownMenuItem
                    :disabled="!canMoveRight"
                    class="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                    @select="emit('move', 1)"
                    >Move right</DropdownMenuItem
                  >
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
              :data-tools-focus="`pin:${tool}`"
              :model-value="pinned"
              :aria-label="`Pin ${tool}`"
              size="sm"
              class="shrink-0"
              @update:model-value="emit('pin', $event)"
            >
              <Pin />
            </Toggle>
          </span>
        </TooltipTrigger>
        <TooltipContent>{{ pinned ? "Unpin panel" : "Pin panel" }}</TooltipContent>
      </Tooltip>
    </div>
  </header>
</template>
