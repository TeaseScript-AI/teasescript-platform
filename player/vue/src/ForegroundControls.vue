<script setup lang="ts">
import { useResizeObserver } from "@vueuse/core";
import { computed, nextTick, ref, watch } from "vue";
import PlayerActionButton from "./components/PlayerActionButton.vue";
import type { PlayerForegroundPresentation } from "../../model.js";
const props = defineProps<{ foreground: PlayerForegroundPresentation | null; disabled: boolean }>();
const emit = defineEmits<{ activate: [optionId: string | null] }>();
const group = ref<HTMLElement | null>(null);
const balanceLastRow = ref(false);
const choiceRows = computed(() => {
  const options = props.foreground?.kind === "choose" ? props.foreground.options : [];
  return balanceLastRow.value && options.length >= 3
    ? [options.slice(0, -2), options.slice(-2)]
    : [options];
});

function syncChoiceRows() {
  const element = group.value;
  const options = props.foreground?.kind === "choose" ? props.foreground.options : [];
  if (!element || options.length < 3) {
    balanceLastRow.value = false;
    return;
  }
  const buttons = [...element.querySelectorAll<HTMLButtonElement>("button")];
  if (buttons.length !== options.length) return;
  const available = element.clientWidth;
  const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
  const widths = buttons.map((button) => button.getBoundingClientRect().width);
  const rowCounts: number[] = [];
  let rowWidth = 0;
  let rowCount = 0;
  for (const width of widths) {
    if (rowCount && rowWidth + gap + width > available + 1) {
      rowCounts.push(rowCount);
      rowWidth = 0;
      rowCount = 0;
    }
    rowWidth += (rowCount ? gap : 0) + width;
    rowCount++;
  }
  rowCounts.push(rowCount);
  // Keep authored order, but avoid leaving the final choice alone when a pair fits.
  balanceLastRow.value =
    rowCounts.length > 1 &&
    rowCounts.at(-1) === 1 &&
    (rowCounts.at(-2) ?? 0) >= 2 &&
    (widths.at(-2) ?? 0) + gap + (widths.at(-1) ?? 0) <= available + 1;
}

useResizeObserver(group, syncChoiceRows);
watch(() => props.foreground, async () => {
  balanceLastRow.value = false;
  await nextTick();
  syncChoiceRows();
}, { immediate: true });
</script>
<template>
  <div
    ref="group"
    data-foreground-controls
    v-if="foreground?.kind === 'choose' || foreground?.kind === 'show-button'"
    role="group"
    :aria-label="foreground.accessibleName"
    class="flex min-w-0 flex-col items-center"
  >
    <template v-if="foreground.kind === 'choose'">
      <div v-for="(row, index) in choiceRows" :key="index" class="flex w-full min-w-0 flex-wrap justify-center gap-2">
        <PlayerActionButton
          v-for="option in row"
          :key="option.id"
          :authored-fill="option.authoredFill"
          :disabled="disabled"
          :label="option.label"
          @width-change="syncChoiceRows"
          @click="emit('activate', option.id)"
        />
      </div>
    </template>
    <PlayerActionButton
      v-else
      :authored-fill="foreground.authoredFill"
      :aria-label="foreground.accessibleName"
      :disabled="disabled"
      :label="foreground.label"
      @click="emit('activate', null)"
    />
  </div>
</template>
<style scoped>
[data-foreground-controls] {
  gap: 8px;
  padding-block-start: var(--player-entry-gap);
}
</style>
