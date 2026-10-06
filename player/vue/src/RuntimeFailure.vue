<script setup lang="ts">
import { computed } from "vue";
import { Download } from "@lucide/vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { RuntimeSnapshot } from "../../../src/index.js";

// How a session ended, above the composer (PLAYER-UI "Session end and failure"): after an error it says so, names the
// error and where it happened, and offers a debug export; an ordinary end is only noted. The transcript and Stage stay.
const props = defineProps<{
  snapshot: RuntimeSnapshot | null;
  /** The error name of an exception of the Player itself. */
  hostError: string | null;
}>();
const emit = defineEmits<{ export: [] }>();

const failure = computed(() => props.snapshot?.failure ?? null);
const ended = computed(() => props.snapshot?.status === "halted" && props.hostError === null);
</script>

<template>
  <div v-if="failure || hostError || ended" class="runtime-end" data-runtime-end>
    <div v-if="failure || hostError" class="rounded-lg shadow-lg">
      <Alert variant="destructive" data-runtime-failure>
        <AlertDescription>
          <div class="grid gap-2">
            <p class="font-medium">
              {{ failure ? "The session stopped because of an error." : "The Player ran into an error." }}
            </p>
            <p v-if="failure" class="font-mono text-xs" data-runtime-failure-location>
              {{ failure.code }} · {{ failure.path }}, line {{ failure.span.start.line + 1 }}
            </p>
            <p v-else class="font-mono text-xs">{{ hostError }}</p>
            <Button
              variant="outline"
              class="min-h-11 justify-self-start"
              data-runtime-failure-export
              @click="emit('export')"
            >
              <Download />
              Download debug export
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    </div>
    <p v-else class="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm" role="status">
      Session ended.
    </p>
  </div>
</template>

<style scoped>
/* In the conversation overlay above the composer, which is measured, so the transcript scrolls clear of it. */
.runtime-end {
  display: grid;
  justify-items: center;
  padding-bottom: 8px;
}
.runtime-end > * {
  max-width: 36rem;
  pointer-events: auto;
}
</style>
