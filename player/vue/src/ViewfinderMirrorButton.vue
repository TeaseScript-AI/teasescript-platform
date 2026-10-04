<script setup lang="ts">
import { FlipHorizontal } from "@lucide/vue";
import { Toggle } from "@/components/ui/toggle";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";

// Switches the viewfinder between a mirror (selfie) view and the camera's own view. Photos are never mirrored.
const mirrored = defineModel<boolean>({ required: true });
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <!-- The wrapper keeps the tooltip's state attribute off the toggle's own pressed state. -->
      <span class="inline-flex" @pointerdown.stop>
        <Toggle
          v-model="mirrored"
          data-viewfinder-mirror
          aria-label="Mirror camera preview"
          size="sm"
        >
          <FlipHorizontal />
        </Toggle>
      </span>
    </TooltipTrigger>
    <TooltipContent>{{ mirrored ? "Show unmirrored" : "Mirror preview" }}</TooltipContent>
  </Tooltip>
</template>
