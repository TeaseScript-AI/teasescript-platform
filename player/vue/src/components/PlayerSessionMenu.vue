<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { PopoverClose, PopoverContent, PopoverRoot, PopoverTrigger } from "reka-ui";

const props = defineProps<{ boundary: HTMLElement | null; controlsAvailable: boolean }>();

const open = defineModel<boolean>("open", { required: true });
const collisionPadding = ref({ top: 12, right: 12, bottom: 12, left: 12 });

function syncCollisionPadding(): void {
  if (props.boundary === null) return;
  const style = getComputedStyle(props.boundary);
  const inset = (name: string): number =>
    Math.max(0, Number.parseFloat(style.getPropertyValue(name)) || 0) + 12;
  collisionPadding.value = {
    top: inset("--safe-top"),
    right: inset("--safe-right"),
    bottom: inset("--safe-bottom-reserve"),
    left: inset("--safe-left"),
  };
}
watch(open, syncCollisionPadding);
onMounted(() => {
  window.addEventListener("resize", syncCollisionPadding);
  window.visualViewport?.addEventListener("resize", syncCollisionPadding);
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", syncCollisionPadding);
  window.visualViewport?.removeEventListener("resize", syncCollisionPadding);
});
</script>

<template>
  <div v-if="controlsAvailable" class="session-menu">
    <PopoverRoot v-model:open="open">
      <PopoverTrigger class="session-trigger" aria-label="Session controls">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h4l3-7 3 14 3-7h3" /></svg>
        <span>Session</span>
      </PopoverTrigger>
      <PopoverContent
        class="session-popover"
        side="right"
        align="end"
        :side-offset="8"
        :collision-boundary="boundary"
        :collision-padding="collisionPadding"
        aria-label="Session controls"
      >
        <header class="session-heading">
          <h2>Session controls</h2>
          <PopoverClose class="icon-button" aria-label="Close session controls">×</PopoverClose>
        </header>
        <slot />
      </PopoverContent>
    </PopoverRoot>
  </div>
</template>
