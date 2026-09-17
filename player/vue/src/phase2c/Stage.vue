<script setup lang="ts">
import { Maximize, Minimize } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";

defineProps<{
  title: string;
  media: { src: string; alt: string } | undefined;
  fullscreen: boolean;
  fullscreenSupported: boolean;
  fullscreenError: string;
}>();
defineEmits<{ toggleFullscreen: [] }>();
</script>

<template>
  <section class="player-stage" aria-label="Primary stage">
    <img v-if="media" :src="media.src" :alt="media.alt" class="stage-media" />
    <h1 class="stage-title">{{ title }}</h1>
    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          data-fullscreen-control
          variant="ghost"
          class="stage-fullscreen"
          :disabled="!fullscreenSupported"
          :aria-label="fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'"
          @click="$emit('toggleFullscreen')"
        >
          <Minimize v-if="fullscreen" class="size-4" />
          <Maximize v-else class="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ fullscreenSupported ? (fullscreen ? 'Exit fullscreen' : 'Enter fullscreen') : 'Fullscreen unavailable in this browser' }}</TooltipContent>
    </Tooltip>
    <p v-if="fullscreenError" role="alert" class="stage-fullscreen-error">{{ fullscreenError }}</p>
  </section>
</template>

<style scoped>
.player-stage {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.stage-media { display: block; width: 100%; height: 100%; object-fit: contain; }
.stage-title {
  position: absolute;
  /* Leave the existing global Tools toggle clear even when it floats over the Player. */
  top: 0.75rem; left: 2.75rem;
  max-width: min(28rem, calc(100% - 6.5rem));
  padding: 0.25rem 0.5rem;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 0.875rem; font-weight: 500;
  color: white; background: rgb(0 0 0 / 65%); border-radius: 0.375rem;
  pointer-events: none;
}
.stage-fullscreen {
  position: absolute; top: 0.5rem; right: 0.5rem;
  width: 2.75rem; height: 2.75rem;
  color: white; background: rgb(0 0 0 / 65%);
}
.stage-fullscreen:hover, .stage-fullscreen:focus-visible { color: white; background: rgb(0 0 0 / 85%); }
.stage-fullscreen-error {
  position: absolute; bottom: 0.5rem; inset-inline: 0.5rem;
  padding: 0.5rem; font-size: 0.75rem; color: white; background: #262626;
}
</style>
