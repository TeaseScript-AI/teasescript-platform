<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";
import { ChevronDown, ChevronRight } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SerializableRuntimeValue } from "../../../src/index.js";
import { STORAGE_MEMBER_PAGE, storageOutline } from "../../storage-preview.js";
import StoragePhoto from "./StoragePhoto.vue";
import type { PlayerSessionHost } from "./usePlayerSession";

// One saved value in Debug's Storage tab, as a flat outline: its type and a short preview, and for each expanded list,
// set, object or dict its members, a page at a time. The outline is one list without nested components, so a deep
// value neither recurses while it renders nor when it goes. Text shaped like a photo reference shows the photo when the
// media store has it, and says so when not; the text itself stays visible.
const props = defineProps<{ value: SerializableRuntimeValue; player: PlayerSessionHost }>();
const expanded = shallowRef<ReadonlySet<string>>(new Set());
const pages = ref(new Map<string, number>());
const rows = computed(() => storageOutline(props.value, expanded.value, pages.value));
// Depth shows as indentation up to a few levels, and as a number beyond them.
const INDENT_LEVELS = 6;

function toggle(path: string) {
  const next = new Set(expanded.value);
  if (!next.delete(path)) next.add(path);
  expanded.value = next;
}
function showMore(path: string) {
  pages.value = new Map(pages.value).set(path, (pages.value.get(path) ?? 1) + 1);
}
</script>

<template>
  <ul class="grid min-w-0 gap-1">
    <li
      v-for="row in rows"
      :key="`${row.kind}:${row.path}`"
      class="grid min-w-0 gap-1"
      :style="{ paddingInlineStart: `${Math.min(row.depth, INDENT_LEVELS) * 0.75}rem` }"
    >
      <template v-if="row.kind === 'value'">
        <span v-if="row.label !== null" class="break-all font-mono text-muted-foreground">
          <template v-if="row.depth > INDENT_LEVELS">{{ row.depth }} · </template>{{ row.label }}
        </span>
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant="outline">{{ row.preview.type }}</Badge>
          <span class="min-w-0 break-words font-mono" data-storage-preview>{{ row.preview.text }}</span>
          <StoragePhoto v-if="row.preview.photo" :key="row.preview.photo" :reference="row.preview.photo" :player="player" />
        </div>
        <Button
          v-if="row.preview.size"
          variant="ghost"
          size="sm"
          class="min-h-11 justify-self-start"
          :aria-expanded="row.expanded"
          data-storage-expand
          @click="toggle(row.path)"
        >
          <component :is="row.expanded ? ChevronDown : ChevronRight" aria-hidden="true" />
          {{ row.expanded ? "Hide members" : "Show members" }}
        </Button>
      </template>
      <Button
        v-else
        variant="ghost"
        size="sm"
        class="min-h-11 justify-self-start"
        data-storage-more
        @click="showMore(row.path)"
      >
        Show {{ Math.min(STORAGE_MEMBER_PAGE, row.size - row.shown) }} more of {{ row.size }}
      </Button>
    </li>
  </ul>
</template>
