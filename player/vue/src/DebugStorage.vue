<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import { Plus, RefreshCw } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isWellFormedCapturedMediaReference } from "../../captured-media.js";
import { capturedMediaReferences } from "../../captured-media-persistence.js";
import type { RuntimeScriptStorageEntrySnapshot } from "../../../src/index.js";
import StorageEditDialog, { type StorageEdit } from "./StorageEditDialog.vue";
import StoragePhoto from "./StoragePhoto.vue";
import StorageValue from "./StorageValue.vue";
import type { PlayerSessionHost } from "./usePlayerSession";

// Debug's Storage tab: the values this script saved in this browser, in key order, with their saved photos, and an
// editor that changes, adds, or deletes one. It reads them freshly when it opens, after this Player changed them, after
// another tab saved, and on Refresh.
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
const editing = shallowRef<StorageEdit | null>(null);
const savedNote = ref<string | null>(null);
function onSaved(result: { key: string; live: boolean; deleted: boolean }) {
  editing.value = null;
  const key = JSON.stringify(result.key);
  savedNote.value = result.deleted
    ? result.live
      ? `Deleted ${key}; the running session's next load gets its default.`
      : `Deleted ${key} for the next Start.`
    : result.live
      ? `Saved ${key}; the running session's next load returns it.`
      : `Saved ${key} for the next Start.`;
}
const canEdit = computed(() => props.player.savedDataEditing.value.available);
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
      What this script saved in this browser. An edit is stored here first; a running session's next load then returns
      it, while values the script already loaded stay as they are.
    </p>
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        class="min-h-11"
        :disabled="!canEdit || saved.state !== 'ready'"
        data-debug-storage-add
        @click="editing = { kind: 'add' }"
      >
        <Plus aria-hidden="true" />
        Add a value
      </Button>
      <Badge v-if="player.debugEdits.value" variant="secondary" data-debug-storage-edited>
        Edited while debugging
      </Badge>
    </div>
    <p v-if="!canEdit" class="text-muted-foreground">
      Saved values cannot be changed now: Continue the session first, or wait for an import or clear to finish.
    </p>
    <p v-if="savedNote" role="status" data-debug-storage-saved>{{ savedNote }}</p>
    <!-- Stacked rows: a narrow panel has no room for a key column beside nested values. -->
    <ul v-if="saved.state === 'ready' && saved.entries.length" class="grid divide-y border-y" aria-label="Saved values">
      <li v-for="entry in saved.entries" :key="entry.key" class="grid min-w-0 gap-1 py-2" data-debug-storage-row>
        <span class="break-words font-mono font-semibold" data-debug-storage-key>{{ JSON.stringify(entry.key) }}</span>
        <StorageValue :value="entry.value" :player="player" />
        <div class="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            class="min-h-11"
            :disabled="!canEdit"
            data-debug-storage-edit
            @click="editing = { kind: 'edit', key: entry.key, value: entry.value }"
          >
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            class="min-h-11"
            :disabled="!canEdit"
            data-debug-storage-delete
            @click="editing = { kind: 'delete', key: entry.key, value: entry.value }"
          >
            Delete
          </Button>
        </div>
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
    <StorageEditDialog :player="player" :edit="editing" @close="editing = null" @saved="onSaved" />
  </div>
</template>
