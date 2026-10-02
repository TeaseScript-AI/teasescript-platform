<script setup lang="ts">
import { ref } from "vue";
import { Check } from "@lucide/vue";
import PlayerActionButton from "@/components/PlayerActionButton.vue";

const enabled = ref(false);
</script>

<template>
  <div class="background-controls-fixture">
    <PlayerActionButton>Repeat</PlayerActionButton>
    <PlayerActionButton :aria-pressed="enabled" @click="enabled = !enabled">
      <span>Extra challenge <span class="block font-normal">{{ enabled ? 'On' : 'Off' }}</span></span>
      <Check class="size-4 shrink-0" :class="{ invisible: !enabled }" aria-hidden="true" />
    </PlayerActionButton>
    <PlayerActionButton>Give me a hint</PlayerActionButton>
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
