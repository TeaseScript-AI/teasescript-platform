<script setup lang="ts">
import { FlipHorizontal, SwitchCamera } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";

// The camera view's controls sit in its lower left corner, which nothing of the Player covers: the Player's top controls
// lie over the top of the Stage, and the timer rail with the background controls along its right side. The mirror
// button flips the picture between a mirror (selfie) view and the camera's own view, as a plain push button: the
// picture itself shows which way it is. Photos are never mirrored. The switch opens the next camera.
const mirrored = defineModel<boolean>("mirrored", { required: true });
/** The camera switch's name, or `null` without another camera to switch to. */
defineProps<{ switchLabel: string | null }>();
const emit = defineEmits<{ switchCamera: [] }>();
</script>

<template>
  <div class="viewfinder-controls" data-viewfinder-controls>
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
    <Tooltip v-if="switchLabel !== null">
      <TooltipTrigger as-child>
        <Button
          data-viewfinder-switch
          variant="ghost"
          size="icon-xs"
          :aria-label="switchLabel"
          @pointerdown.stop
          @click="emit('switchCamera')"
        >
          <SwitchCamera class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ switchLabel }}</TooltipContent>
    </Tooltip>
  </div>
</template>

<style scoped>
/* Above anything the Player draws on the picture, such as the self-timer's countdown. */
.viewfinder-controls {
  position: absolute; left: 8px; bottom: 8px; z-index: 1; display: flex; gap: 2px;
  border: 1px solid var(--media-border); border-radius: 8px; color: var(--media-text);
  background: var(--media-surface); box-shadow: 0 1px 3px var(--media-shadow); backdrop-filter: blur(3px);
}
</style>
