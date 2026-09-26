<script setup lang="ts">
import { inject, ref, type ComputedRef } from "vue";
import { useResizeObserver } from "@vueuse/core";
import SidebarMenuButton from "@/components/ui/sidebar/SidebarMenuButton.vue";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";

defineOptions({ inheritAttrs: false });
defineProps<{ label: string }>();
const labelsVisible = inject<ComputedRef<boolean>>("phase2c-menu-labels-visible");
const labelElement = ref<HTMLElement | null>(null);
const truncated = ref(false);
useResizeObserver(labelElement, () => {
  const element = labelElement.value;
  truncated.value = !!element && element.scrollWidth > element.clientWidth;
});
</script>

<template>
  <Tooltip :disabled="!!labelsVisible && !truncated">
    <TooltipTrigger as-child>
      <SidebarMenuButton v-bind="$attrs" :aria-label="label">
        <slot /><span ref="labelElement" data-launcher-label>{{ label }}</span>
      </SidebarMenuButton>
    </TooltipTrigger>
    <TooltipContent side="right">{{ label }}</TooltipContent>
  </Tooltip>
</template>
