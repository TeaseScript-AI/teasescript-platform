<script setup lang="ts">
import { Loader2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";

// Debug's rewind switches over the Player's lifetime (DEBUGGER.md "Rewind"), so also with Debug off: a polite live
// region names the switch under way, a small loading animation shows once it has lasted (`indicator`), and a failed
// return to the session offers its retry. No visible text but the retry.
defineProps<{
  busy: boolean;
  announcement: string;
  indicator: boolean;
  returnFailed: boolean;
}>();
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="rewind-status" :aria-busy="busy" data-rewind-status>
    <span role="status" class="sr-only" data-rewind-announcement>{{ announcement }}</span>
    <Loader2
      v-if="indicator"
      class="size-6 animate-spin text-muted-foreground"
      aria-hidden="true"
      data-rewind-switch-indicator
    />
    <Button v-if="returnFailed" class="min-h-11" data-rewind-retry @click="emit('retry')">
      Retry return to session
    </Button>
  </div>
</template>

<style scoped>
.rewind-status {
  display: grid;
  justify-items: center;
  padding-bottom: 8px;
}
.rewind-status > * {
  pointer-events: auto;
}
</style>
