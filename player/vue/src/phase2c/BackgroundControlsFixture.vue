<script setup lang="ts">
import { ref } from "vue";
import { Check } from "@lucide/vue";
import PlayerActionButton from "@/components/PlayerActionButton.vue";

const enabled = ref(false);
const hintVisible = ref(true);
const repetitions = ref(0);
const feedback = ref("");

function requestHint() {
  hintVisible.value = false;
  feedback.value = "Take your time. There is no rush.";
}
</script>

<template>
  <div class="background-controls-fixture">
    <PlayerActionButton @click="repetitions++; feedback = `Repeated ${repetitions} time${repetitions === 1 ? '' : 's'}.`">
      Repeat
    </PlayerActionButton>
    <PlayerActionButton :aria-pressed="enabled" @click="enabled = !enabled">
      <span>Extra challenge <span class="block font-normal">{{ enabled ? 'On' : 'Off' }}</span></span>
      <Check class="size-4 shrink-0" :class="{ invisible: !enabled }" aria-hidden="true" />
    </PlayerActionButton>
    <PlayerActionButton v-if="hintVisible" @click="requestHint">Give me a hint</PlayerActionButton>
    <PlayerActionButton disabled>Not available</PlayerActionButton>
    <p role="status" class="fixture-feedback">{{ feedback }}</p>
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
.fixture-feedback {
  margin: 0;
  color: var(--theme-text-primary);
  font-size: 12px;
  text-align: center;
  overflow-wrap: anywhere;
}
.fixture-feedback:empty { display: none; }
</style>
