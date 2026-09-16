<script setup lang="ts">
import { inject, type ComputedRef } from "vue";
import SidebarMenuButton from "@/components/ui/sidebar/SidebarMenuButton.vue";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";

defineOptions({ inheritAttrs: false });
defineProps<{ label: string }>();
const labelsVisible = inject<ComputedRef<boolean>>("phase2c-menu-labels-visible");
</script>

<template>
  <Tooltip :disabled="labelsVisible">
    <TooltipTrigger as-child>
      <SidebarMenuButton v-bind="$attrs" :aria-label="label">
        <slot /><span data-launcher-label>{{ label }}</span>
      </SidebarMenuButton>
    </TooltipTrigger>
    <TooltipContent side="right">{{ label }}</TooltipContent>
  </Tooltip>
</template>
