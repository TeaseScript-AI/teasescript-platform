<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { Download } from "@lucide/vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import Dialog from "@/components/ui/dialog/Dialog.vue";
import DialogContent from "@/components/ui/dialog/DialogContent.vue";
import DialogDescription from "@/components/ui/dialog/DialogDescription.vue";
import DialogHeader from "@/components/ui/dialog/DialogHeader.vue";
import DialogTitle from "@/components/ui/dialog/DialogTitle.vue";
import DialogTrigger from "@/components/ui/dialog/DialogTrigger.vue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  gzipSupported,
  storageTransferFile,
  storageTransferFileName,
  storageTransferText,
  type StorageTransfer,
} from "../../storage-transfer.js";

// Exports this script's saved data, as one file or as text to copy, from a fresh read when the dialog opens. It is
// prepared first, so Download and Copy stay direct player actions; everything stays in this browser until then.
const props = defineProps<{
  /** The script's name for the file name; without one, the file is named after the storage scope. */
  name: string;
  read: () => Promise<{ readonly transfer: StorageTransfer; readonly missingPhotos: number }>;
}>();

const open = ref(false);
const tab = ref<"file" | "text">("file");
const gzip = gzipSupported();
type Prepared = {
  readonly transfer: StorageTransfer;
  readonly missingPhotos: number;
  readonly url: string;
  readonly size: number;
};
const state = shallowRef<"preparing" | "failed" | Prepared>("preparing");
const prepared = computed(() => (typeof state.value === "object" ? state.value : null));
const fileName = computed(() =>
  storageTransferFileName(props.name || (prepared.value?.transfer.scope ?? ""), gzip),
);
const text = ref<string | null>(null);
const copyStatus = ref<"" | "copied" | "failed">("");
const textArea = ref<InstanceType<typeof Textarea> | null>(null);
// Each opening gets its own preparation; a result for an earlier one is discarded.
let preparation = 0;

watch(open, async (isOpen) => {
  const current = ++preparation;
  release();
  if (!isOpen) return;
  tab.value = "file";
  try {
    const { transfer, missingPhotos } = await props.read();
    if (current !== preparation) return;
    const file = await storageTransferFile(transfer, gzip);
    if (current !== preparation) return;
    state.value = { transfer, missingPhotos, url: URL.createObjectURL(file), size: file.size };
  } catch {
    if (current === preparation) state.value = "failed";
  }
});
// The preparation whose text is being encoded, so switching tabs meanwhile does not encode it again.
let encoding = -1;
watch([tab, prepared], async ([selected, ready]) => {
  if (selected !== "text" || ready === null || text.value !== null || encoding === preparation) return;
  const current = (encoding = preparation);
  const result = await storageTransferText(ready.transfer, gzip).catch(() => null);
  if (current !== preparation) return;
  if (result !== null) text.value = result;
  else {
    URL.revokeObjectURL(ready.url);
    state.value = "failed";
  }
});
onBeforeUnmount(() => {
  preparation++;
  release();
});

// Frees the prepared file and text when the dialog closes, so private photos do not stay in memory.
function release() {
  if (prepared.value !== null) URL.revokeObjectURL(prepared.value.url);
  state.value = "preparing";
  text.value = null;
  copyStatus.value = "";
}

function textElement(): HTMLTextAreaElement | null {
  const element: unknown = textArea.value?.$el;
  return element instanceof HTMLTextAreaElement ? element : null;
}
function selectText() {
  const element = textElement();
  element?.focus();
  element?.select();
}
async function copyText() {
  if (text.value === null) return;
  const current = preparation;
  let copied: boolean;
  try {
    // Unavailable outside secure contexts and refusable; selecting the text then still lets the player copy it.
    await navigator.clipboard.writeText(text.value);
    copied = true;
  } catch {
    copied = false;
  }
  // A copy that settles after the dialog closed says nothing about a later export.
  if (current !== preparation) return;
  copyStatus.value = copied ? "copied" : "failed";
  if (!copied) selectText();
}

const count = (amount: number, one: string, many: string) => `${amount} ${amount === 1 ? one : many}`;
function formatSize(bytes: number): string {
  if (bytes < 1024) return count(bytes, "byte", "bytes");
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button variant="outline" size="sm" class="min-h-11" data-export-saved-data>Export…</Button>
    </DialogTrigger>
    <DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto" data-saved-data-export>
      <DialogHeader>
        <DialogTitle>Export saved data</DialogTitle>
        <DialogDescription>
          Takes this script's saved data, with its saved photos, to another browser or device. It is not a session
          checkpoint.
        </DialogDescription>
      </DialogHeader>
      <p v-if="state === 'preparing'" role="status" class="text-sm">Preparing the export…</p>
      <Alert v-else-if="state === 'failed'" variant="destructive">
        <AlertDescription>Could not read this script's saved data.</AlertDescription>
      </Alert>
      <template v-if="prepared">
        <div class="grid gap-1 text-sm">
          <p data-export-summary>
            {{ count(prepared.transfer.entries.length, "saved value", "saved values") }} ·
            {{ count(prepared.transfer.images.length, "photo", "photos") }}
          </p>
          <p v-if="prepared.missingPhotos > 0">
            {{ count(prepared.missingPhotos, "saved photo reference has", "saved photo references have") }} no stored
            photo; the export keeps them as text.
          </p>
          <p class="text-muted-foreground">The export can contain private photos; anyone who has it can see them.</p>
        </div>
        <Tabs v-model="tab">
          <TabsList class="h-auto w-full">
            <TabsTrigger value="file" class="min-h-11" data-export-tab="file">File</TabsTrigger>
            <TabsTrigger value="text" class="min-h-11" data-export-tab="text">Text</TabsTrigger>
          </TabsList>
          <TabsContent value="file">
            <div class="grid gap-3 text-sm">
              <p>One file with the values and photos. Import it in the Settings of the other Player.</p>
              <Button as-child class="min-h-11 justify-self-start">
                <a :href="prepared.url" :download="fileName" data-export-download>
                  <Download />
                  Download file
                </a>
              </Button>
              <p class="break-all text-muted-foreground">{{ fileName }} · {{ formatSize(prepared.size) }}</p>
              <p v-if="!gzip">This browser cannot compress, so the file is plain JSON.</p>
            </div>
          </TabsContent>
          <TabsContent value="text">
            <div class="grid gap-3 text-sm">
              <p>
                Copy this text and paste it into Import in the Settings of the other Player. With many photos, a file
                is easier to move.
              </p>
              <p v-if="text === null" role="status">Preparing the text…</p>
              <template v-else>
                <Textarea
                  ref="textArea"
                  :model-value="text"
                  readonly
                  rows="6"
                  aria-label="Exported saved data as text"
                  class="max-h-48 break-all"
                  data-export-text
                  @focus="selectText"
                />
                <div class="flex flex-wrap gap-2">
                  <Button class="min-h-11" data-export-copy @click="copyText">Copy</Button>
                  <Button variant="outline" class="min-h-11" @click="selectText">Select text</Button>
                </div>
                <p role="status" data-export-copy-status>
                  {{
                    copyStatus === "copied"
                      ? "Copied."
                      : copyStatus === "failed"
                        ? "Copying is not available here; the text is selected, so copy it with the browser."
                        : ""
                  }}
                </p>
              </template>
            </div>
          </TabsContent>
        </Tabs>
      </template>
    </DialogContent>
  </Dialog>
</template>
