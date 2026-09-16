<script setup lang="ts">
import { elapsedPercent } from "./session.js";
</script>

<template>
  <label class="progress">Progress
    <input v-model.number="elapsedPercent" type="range" min="0" max="100" step="1" />
    <span class="progress-value">{{ elapsedPercent }}%</span>
  </label>
</template>

<style scoped>
.progress input {
  inline-size: 130px;
}

.progress-value {
  min-inline-size: 36px;
  font-variant-numeric: tabular-nums;
}
</style>
