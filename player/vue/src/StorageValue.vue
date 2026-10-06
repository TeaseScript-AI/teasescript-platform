<script setup lang="ts">
import { computed } from "vue";
import { ChevronDown, ChevronUp } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Collapsible from "@/components/ui/collapsible/Collapsible.vue";
import CollapsibleContent from "@/components/ui/collapsible/CollapsibleContent.vue";
import CollapsibleTrigger from "@/components/ui/collapsible/CollapsibleTrigger.vue";
import type { SerializableRuntimeValue } from "../../../src/index.js";
import { storageMembers, storagePreview } from "../../storage-preview.js";
import StoragePhoto from "./StoragePhoto.vue";
import type { PlayerSessionHost } from "./usePlayerSession";

// One saved value in Debug's Storage tab: its type and a short preview, a saved photo's thumbnail, and for a list, set,
// object or dict its members, rendered only once expanded.
const props = defineProps<{ value: SerializableRuntimeValue; player: PlayerSessionHost }>();
const preview = computed(() => storagePreview(props.value));
</script>

<template>
  <div class="grid min-w-0 gap-1">
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <Badge variant="outline">{{ preview.type }}</Badge>
      <StoragePhoto v-if="preview.photo" :reference="preview.photo" :player="player" />
      <span class="min-w-0 break-words font-mono" data-storage-preview>{{ preview.text }}</span>
    </div>
    <Collapsible v-if="preview.size" v-slot="{ open }" class="grid gap-1">
      <CollapsibleTrigger as-child>
        <Button variant="ghost" size="xs" class="justify-self-start" data-storage-expand>
          {{ open ? "Hide" : "Show" }} members
          <component :is="open ? ChevronUp : ChevronDown" aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul class="grid gap-2 border-s ps-3">
          <li v-for="(member, index) in storageMembers(value)" :key="index" class="grid min-w-0 gap-1">
            <span class="break-all font-mono text-muted-foreground">{{ member.label }}</span>
            <StorageValue :value="member.value" :player="player" />
          </li>
        </ul>
      </CollapsibleContent>
    </Collapsible>
  </div>
</template>
