<script setup lang="ts">
import { computed } from "vue";
import { ChevronDown, Download } from "@lucide/vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import Collapsible from "@/components/ui/collapsible/Collapsible.vue";
import CollapsibleContent from "@/components/ui/collapsible/CollapsibleContent.vue";
import CollapsibleTrigger from "@/components/ui/collapsible/CollapsibleTrigger.vue";
import Dialog from "@/components/ui/dialog/Dialog.vue";
import DialogContent from "@/components/ui/dialog/DialogContent.vue";
import DialogDescription from "@/components/ui/dialog/DialogDescription.vue";
import DialogHeader from "@/components/ui/dialog/DialogHeader.vue";
import DialogTitle from "@/components/ui/dialog/DialogTitle.vue";
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
import Switch from "@/components/ui/switch/Switch.vue";
import { REPLAY_PREREQUISITES, type DebugCategory } from "../../debug-export-assembly.js";
import type { DebugExportState } from "./useDebugExport";

// Lets the player download a debug export for a developer, choosing what personal content it includes
// (DEBUGGER.md "Debug export"). Every choice starts off, and the preview shows what the file holds.
const props = defineProps<{
  exporter: DebugExportState;
  /** Resolves a photo reference to a URL this page can show, or `null`. */
  photoUrl: (reference: string) => string | null;
}>();

const categories: readonly {
  readonly key: DebugCategory;
  readonly label: string;
  readonly help: string;
}[] = [
  {
    key: "savedValues",
    label: "Saved script values",
    help: "What this session saved for later runs; it can contain earlier answers.",
  },
  {
    key: "answers",
    label: "Submitted answers",
    help: "Exactly what was typed or chosen, and which request it answered.",
  },
  {
    key: "sessionText",
    label: "Session text and debug details",
    help: "Recent chat messages and the kinds of recent events; with saved values and answers too, every event detail.",
  },
  {
    key: "replay",
    label: "Engine replay data",
    help: "Everything the script holds, and every step since an earlier point, so a developer can replay the error exactly.",
  },
  {
    key: "photos",
    label: "Photos used by this session",
    help: "Original files, including any personal image metadata such as a location.",
  },
  {
    key: "player",
    label: "Player and browser details",
    help: "Settings, screen size, and browser and system details.",
  },
];

const choices = computed(() => props.exporter.choices.value);
const prepared = computed(() =>
  typeof props.exporter.prepared.value === "object" ? props.exporter.prepared.value : null,
);
const replayBlocked = computed(() => !REPLAY_PREREQUISITES.every((key) => choices.value[key]));
const photos = computed(() => props.exporter.candidate.value?.photos ?? []);

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
function uses(photo: (typeof photos.value)[number]): string {
  const relations = {
    capture: "photo taken",
    imageAnswer: "image answer",
    savedValue: "saved value",
  } as const;
  return photo.usedBy
    .map(
      (use) =>
        `${relations[use.relation]}${use.operation === null ? "" : ` (step ${use.operation})`}`,
    )
    .join(", ");
}
</script>

<template>
  <Dialog v-model:open="exporter.open.value">
    <DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto" data-debug-export>
      <DialogHeader>
        <DialogTitle>Download debug export</DialogTitle>
        <DialogDescription>
          A file that helps a developer find what went wrong. Attachments to a public issue can be
          read by anyone, so choose what to include.
        </DialogDescription>
      </DialogHeader>

      <div class="grid gap-3 text-sm">
        <div class="flex min-h-11 items-center justify-between gap-4">
          <div>
            <p class="font-medium">Technical report</p>
            <p class="text-muted-foreground">
              Versions, the error and where it happened, and the kinds of recent events.
            </p>
          </div>
          <Badge variant="secondary">Included</Badge>
        </div>
        <label
          v-for="category in categories"
          :key="category.key"
          class="flex min-h-11 items-center justify-between gap-4"
          :data-debug-export-category="category.key"
        >
          <span>
            <span class="block font-medium">{{ category.label }}</span>
            <span class="block text-muted-foreground">{{ category.help }}</span>
            <span
              v-if="category.key === 'replay' && replayBlocked"
              class="block text-muted-foreground"
            >
              Turn on saved values, answers, and session text first: the engine state holds copies
              of them.
            </span>
          </span>
          <Switch
            :model-value="choices[category.key]"
            :disabled="
              exporter.candidate.value === null || (category.key === 'replay' && replayBlocked)
            "
            @update:model-value="(on: boolean) => exporter.choose(category.key, on)"
          />
        </label>

        <fieldset v-if="choices.photos" class="grid gap-2" data-debug-export-photos>
          <legend class="font-medium">Photos to include</legend>
          <p v-if="photos.length === 0" class="text-muted-foreground">
            This session used no photos.
          </p>
          <label
            v-for="photo in photos"
            :key="photo.reference"
            class="flex min-h-11 items-center gap-3"
            :data-debug-export-photo="photo.reference"
          >
            <Checkbox
              :model-value="choices.photoReferences.has(photo.reference)"
              @update:model-value="(on) => exporter.choosePhoto(photo.reference, on === true)"
            />
            <img
              v-if="photoUrl(photo.reference)"
              :src="photoUrl(photo.reference)!"
              alt=""
              class="size-11 rounded-md border object-cover"
            />
            <span class="min-w-0">
              <span class="block">{{ uses(photo) }}</span>
              <span class="block text-muted-foreground"
                >{{ photo.mimeType }} · {{ size(photo.byteLength) }}</span
              >
            </span>
          </label>
        </fieldset>

        <Alert>
          <AlertDescription>
            The file is not encrypted. Credentials and file paths found in the chosen text are
            removed, but that cannot catch everything: check the preview before sharing.
          </AlertDescription>
        </Alert>

        <p v-if="exporter.prepared.value === 'preparing'" role="status">Preparing the export…</p>
        <Alert v-else-if="exporter.prepared.value === 'failed'" variant="destructive">
          <AlertDescription>The export could not be prepared.</AlertDescription>
        </Alert>
        <template v-if="prepared">
          <p data-debug-export-summary>
            {{ size(prepared.size) }} ·
            {{
              prepared.replay === "complete"
                ? exporter.candidate.value?.hostError
                  ? "A developer can replay the recorded engine calls; the Player's own error is described, not replayed."
                  : "A developer can replay the error exactly."
                : prepared.replay === "incomplete"
                  ? "Replay data is incomplete."
                  : "Without replay data, a developer can read the report but not replay it."
            }}
          </p>
          <Alert v-if="prepared.problem" variant="destructive">
            <AlertDescription>{{ prepared.problem }}</AlertDescription>
          </Alert>
          <Collapsible>
            <CollapsibleTrigger as-child>
              <Button
                variant="outline"
                class="min-h-11 w-full justify-between"
                data-debug-export-preview-toggle
              >
                What the file contains
                <ChevronDown />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div class="grid gap-2 pt-2">
                <ul class="grid gap-1" data-debug-export-parts>
                  <li v-for="part in prepared.parts" :key="part.name">
                    <span class="font-medium">{{ part.name }}:</span> {{ part.detail }}
                  </li>
                  <li
                    v-for="omission in prepared.omissions"
                    :key="omission"
                    class="text-muted-foreground"
                  >
                    {{ omission }}
                  </li>
                </ul>
                <ScrollArea class="h-48 rounded-md border">
                  <pre
                    class="p-2 text-xs break-all whitespace-pre-wrap"
                    data-debug-export-preview
                    >{{ prepared.preview }}</pre>
                </ScrollArea>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </template>

        <div class="flex flex-wrap justify-end gap-2">
          <Button variant="outline" class="min-h-11" @click="exporter.open.value = false"
            >Cancel</Button
          >
          <Button v-if="prepared && !prepared.problem" as-child class="min-h-11">
            <a :href="prepared.url" :download="exporter.fileName.value" data-debug-export-download>
              <Download />
              Download debug export
            </a>
          </Button>
          <Button v-else class="min-h-11" disabled>
            <Download />
            Download debug export
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
