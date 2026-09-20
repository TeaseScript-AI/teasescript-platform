<script setup lang="ts">
import { ScrollAreaCorner, ScrollAreaRoot, ScrollAreaViewport, type ScrollAreaRootProps } from "reka-ui";
import { ref, watch, type HTMLAttributes } from "vue";
import ScrollBar from "./ScrollBar.vue";

// shadcn-vue ScrollArea composition, with viewport access for virtualized and
// retained content. Reka owns dragging, wheel/touch input and thumb measurement.
withDefaults(defineProps<{
  type?: ScrollAreaRootProps["type"];
  orientation?: "vertical" | "horizontal";
  viewportClass?: HTMLAttributes["class"];
  viewportAttrs?: Record<string, unknown>;
  contentClass?: HTMLAttributes["class"];
}>(), { orientation: "vertical", type: "hover" });
const emit = defineEmits<{ viewport: [element: HTMLDivElement | null] }>();
const viewport = ref<InstanceType<typeof ScrollAreaViewport> | null>(null);
watch(() => viewport.value?.viewportElement, element => {
  emit("viewport", element instanceof HTMLDivElement ? element : null);
}, { flush: "post" });
</script>

<template>
  <ScrollAreaRoot class="relative min-h-0 min-w-0 overflow-hidden" :type="type" data-slot="scroll-area">
    <ScrollAreaViewport ref="viewport" class="size-full rounded-[inherit] outline-none"
      :class="viewportClass" v-bind="viewportAttrs" as-child>
      <div :class="contentClass"><slot /></div>
    </ScrollAreaViewport>
    <ScrollBar :orientation="orientation" :reveal-on-hover="type === 'scroll'" />
    <ScrollAreaCorner />
  </ScrollAreaRoot>
</template>

<style scoped>
:deep([data-reka-scroll-area-viewport]:focus-visible) {
  outline: 2px solid var(--focus-ring); outline-offset: -2px;
}
</style>
