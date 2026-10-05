<script setup lang="ts">
import { Button } from "@/components/ui/button";
import type { DevelopmentTime } from "./useDevelopmentTime";

// Development time controls (#615), only in the Player with `?dev`; see `useDevelopmentTime`.
defineProps<{ time: DevelopmentTime }>();
</script>

<template>
  <div class="space-y-4 p-4 text-sm" data-development-time>
    <div class="grid gap-2">
      <label class="flex items-center justify-between gap-2 font-medium">
        <span>Enable time controls</span>
        <input v-model="time.enabled.value" type="checkbox" role="switch" data-development-time-enable />
      </label>
      <label class="flex items-center justify-between gap-2">
        <span>Auto-skip</span>
        <input
          v-model="time.autoSkip.value"
          type="checkbox"
          role="switch"
          :disabled="!time.enabled.value"
          aria-describedby="development-time-auto-skip"
        />
      </label>
      <p id="development-time-auto-skip" class="text-muted-foreground">
        Waits, timers and pacing pauses complete at once; while the script waits for your input, time runs normally.
      </p>
    </div>
    <div class="grid gap-2">
      <Button
        class="min-w-0"
        variant="outline"
        data-development-time-action="skip"
        :disabled="!time.canSkip.value"
        @click="time.skip()"
      >
        Skip to next timed event
      </Button>
      <div class="grid grid-cols-2 gap-2">
        <Button
          class="min-w-0"
          variant="outline"
          data-development-time-action="advance-10s"
          :disabled="!time.canAdvance.value"
          @click="time.advanceBy(10_000)"
        >
          +10 s
        </Button>
        <Button
          class="min-w-0"
          variant="outline"
          data-development-time-action="advance-1min"
          :disabled="!time.canAdvance.value"
          @click="time.advanceBy(60_000)"
        >
          +1 min
        </Button>
      </div>
      <p class="text-muted-foreground">+10 s and +1 min advance time while the script waits for your input.</p>
    </div>
    <section v-if="time.jumps.value.length" aria-labelledby="development-time-jumps" class="grid gap-1">
      <h3 id="development-time-jumps" class="font-medium">Jumps</h3>
      <ol class="grid gap-1 text-muted-foreground" data-development-time-jumps>
        <li v-for="jump in time.jumps.value" :key="jump.id">{{ jump.text }}</li>
      </ol>
    </section>
  </div>
</template>
