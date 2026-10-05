<script setup lang="ts">
import { FlipHorizontal } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";

// Flips the viewfinder between a mirror (selfie) view and the camera's own view, as a plain push button: the picture
// itself shows which way it is. Photos are never mirrored.
const mirrored = defineModel<boolean>({ required: true });
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <Button
        data-viewfinder-mirror
        variant="ghost"
        size="icon-xs"
        aria-label="Flip camera preview"
        @pointerdown.stop
        @click="mirrored = !mirrored"
      >
        <FlipHorizontal class="size-3.5" />
      </Button>
    </TooltipTrigger>
    <TooltipContent>Flip preview</TooltipContent>
  </Tooltip>
</template>
