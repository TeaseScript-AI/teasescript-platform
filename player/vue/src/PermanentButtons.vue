<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import PlayerActionButton from "@/components/PlayerActionButton.vue";
import type { PlayerPermanentButtonPresentation } from "../../model.js";

// The script's permanent buttons in creation order. A button whose block runs stays in place, inactive, and keeps
// keyboard focus; when a focused button is removed, focus moves to the button that takes its place.
const props = defineProps<{ buttons: readonly PlayerPermanentButtonPresentation[] }>();
const emit = defineEmits<{ press: [buttonId: number] }>();
const group = ref<HTMLElement | null>(null);

watch(
  () => props.buttons.map((button) => button.buttonId),
  async (ids) => {
    const shown = [
      ...(group.value?.querySelectorAll<HTMLElement>("[data-permanent-button]") ?? []),
    ];
    const index = shown.findIndex((element) => element === document.activeElement);
    if (index < 0 || ids.includes(Number(shown[index]!.dataset.permanentButton))) return;
    await nextTick();
    const remaining = group.value?.querySelectorAll<HTMLElement>("[data-permanent-button]") ?? [];
    remaining[Math.min(index, remaining.length - 1)]?.focus({ preventScroll: true });
  },
  // Before the update, while the removed button is still in the document and focused.
  { flush: "pre" },
);

function press(button: PlayerPermanentButtonPresentation) {
  if (!button.busy) emit("press", button.buttonId);
}
</script>

<template>
  <div ref="group" class="permanent-buttons">
    <PlayerActionButton
      v-for="button in buttons"
      :key="button.buttonId"
      :label="button.label"
      :inactive="button.busy"
      :data-permanent-button="button.buttonId"
      @click="press(button)"
    />
  </div>
</template>

<style scoped>
.permanent-buttons {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 6px;
}
</style>
