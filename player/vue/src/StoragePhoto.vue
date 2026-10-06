<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useElementVisibility } from "@vueuse/core";
import type { PlayerSessionHost } from "./usePlayerSession";

// A saved photo's thumbnail in Debug's Storage tab. It is read from this browser's storage only once it scrolls into
// view, so a long list of saved photos loads nothing it does not show.
const props = defineProps<{ reference: string; player: PlayerSessionHost }>();
const root = ref<HTMLElement | null>(null);
const seen = ref(false);
watch(useElementVisibility(root), (visible) => {
  if (visible) seen.value = true;
});
const photo = computed(() =>
  seen.value ? props.player.savedPhoto(props.reference) : { state: "loading" as const },
);
</script>

<template>
  <span ref="root" class="inline-flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted" data-storage-photo :data-state="photo.state">
    <img v-if="photo.state === 'ready'" :src="photo.url" alt="Saved photo" class="size-full object-cover" />
    <span v-else class="p-1 text-center text-muted-foreground">{{ photo.state === "missing" ? "Unavailable" : "…" }}</span>
  </span>
</template>
