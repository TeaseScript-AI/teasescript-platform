<script setup lang="ts">
import { ref } from "vue";
import { Check } from "@lucide/vue";
import PlayerActionButton from "@/components/PlayerActionButton.vue";

// The preview's stand-in for a script's permanent buttons, held like them while a rewind switch is under way.
defineProps<{ held: boolean }>();
const enabled = ref(false);
</script>

<template>
  <div class="background-controls-fixture">
    <PlayerActionButton :inactive="held">Repeat</PlayerActionButton>
    <PlayerActionButton :inactive="held" :aria-pressed="enabled" @click="held || (enabled = !enabled)">
      <span>Extra challenge <span class="block font-normal">{{ enabled ? 'On' : 'Off' }}</span></span>
      <Check class="size-4 shrink-0" :class="{ invisible: !enabled }" aria-hidden="true" />
    </PlayerActionButton>
    <PlayerActionButton :inactive="held">Give me a hint</PlayerActionButton>
    <PlayerActionButton disabled>Not available</PlayerActionButton>
  </div>
</template>

<style scoped>
.background-controls-fixture {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 6px;
}
</style>
