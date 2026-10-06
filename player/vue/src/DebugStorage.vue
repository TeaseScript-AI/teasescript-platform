<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { RefreshCw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { isWellFormedCapturedMediaReference } from "../../captured-media.js";
import { capturedMediaReferences } from "../../captured-media-persistence.js";
import type { RuntimeScriptStorageEntrySnapshot } from "../../../src/index.js";
import StoragePhoto from "./StoragePhoto.vue";
import StorageValue from "./StorageValue.vue";
import type { PlayerSessionHost } from "./usePlayerSession";

// Debug's Storage tab, read-only: the values this script saved in this browser, in key order, with their saved photos.
// It reads them freshly when it opens, after this Player changed them, after another tab saved, and on Refresh.
const props = defineProps<{ player: PlayerSessionHost }>();

type Saved =
  | { readonly state: "loading" }
  | { readonly state: "unavailable" }
  | { readonly state: "ready"; readonly entries: readonly RuntimeScriptStorageEntrySnapshot[] };
const saved = shallowRef<Saved>({ state: "loading" });
let request = 0;
async function refresh() {
  const issued = ++request;
  let next: Saved;
  try {
    const entries = await props.player.readSavedData();
    // UTF-16 code unit order, as keys compare in the script.
    next = { state: "ready", entries: [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) };
  } catch {
    next = { state: "unavailable" };
  }
  // A later read replaces an earlier one that finishes after it.
  if (issued === request) saved.value = next;
}
onMounted(refresh);
watch(props.player.savedDataRevision, refresh);
// Another tab of this browser changed this script's saved values: its storage keys name the script's scope. Several
// changes at once read once.
const scope = props.player.savedDataScope === null ? null : JSON.stringify(props.player.savedDataScope);
let refreshQueued = false;
useEventListener(window, "storage", (event: StorageEvent) => {
  if (scope === null || refreshQueued) return;
  if (event.key !== null && !(event.key.startsWith("player-storage") && event.key.includes(scope))) return;
  refreshQueued = true;
  queueMicrotask(() => {
    refreshQueued = false;
    void refresh();
  });
});

// Each text shaped like a photo reference once, with the keys whose values contain it; whether it names a saved photo,
// the media store says when its thumbnail comes into view.
const photos = computed(() => {
  if (saved.value.state !== "ready") return [];
  const keys = new Map<string, string[]>();
  for (const entry of saved.value.entries)
    for (const reference of capturedMediaReferences(entry.value)) {
      if (!isWellFormedCapturedMediaReference(reference)) continue;
      const usedBy = keys.get(reference);
      if (usedBy) usedBy.push(entry.key);
      else keys.set(reference, [entry.key]);
    }
  return [...keys].map(([reference, usedBy]) => ({ reference, usedBy }));
});
const refreshing = ref(false);
async function refreshNow() {
  refreshing.value = true;
  try {
    await refresh();
  } finally {
    refreshing.value = false;
  }
}
</script>

<template>
  <div class="grid gap-3" data-debug-storage>
    <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <p data-debug-storage-summary>
        <template v-if="saved.state === 'ready'">
          Saved data · {{ saved.entries.length }} {{ saved.entries.length === 1 ? "key" : "keys" }}
        </template>
        <template v-else-if="saved.state === 'loading'">Reading saved data…</template>
        <template v-else>This browser's saved data cannot be read.</template>
      </p>
      <Button
        variant="outline"
        size="sm"
        class="min-h-11"
        :disabled="refreshing"
        data-debug-storage-refresh
        @click="refreshNow"
      >
        <RefreshCw aria-hidden="true" />
        Refresh
      </Button>
    </div>
    <p class="text-muted-foreground">
      What this script saved in this browser. The running session loaded its own copy at Start; the script checks a
      value's type when it loads it.
    </p>
    <!-- Stacked rows: a narrow panel has no room for a key column beside nested values. -->
    <ul v-if="saved.state === 'ready' && saved.entries.length" class="grid divide-y border-y" aria-label="Saved values">
      <li v-for="entry in saved.entries" :key="entry.key" class="grid min-w-0 gap-1 py-2" data-debug-storage-row>
        <span class="break-words font-mono font-semibold" data-debug-storage-key>{{ JSON.stringify(entry.key) }}</span>
        <StorageValue :value="entry.value" :player="player" />
      </li>
    </ul>
    <p v-else-if="saved.state === 'ready'" class="text-muted-foreground">Nothing saved yet.</p>
    <section v-if="photos.length" aria-labelledby="debug-storage-photos" class="grid gap-2">
      <h4 id="debug-storage-photos" class="font-semibold">Photo references</h4>
      <ul class="grid gap-2" data-debug-storage-photos>
        <li v-for="photo in photos" :key="photo.reference" class="flex min-w-0 items-center gap-2">
          <StoragePhoto :key="photo.reference" :reference="photo.reference" :player="player" />
          <span class="min-w-0 break-all">Used by {{ photo.usedBy.map((key) => JSON.stringify(key)).join(", ") }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
