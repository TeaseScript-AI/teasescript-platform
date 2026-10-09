<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { Download } from "@lucide/vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import Dialog from "@/components/ui/dialog/Dialog.vue";
import DialogContent from "@/components/ui/dialog/DialogContent.vue";
import DialogDescription from "@/components/ui/dialog/DialogDescription.vue";
import DialogHeader from "@/components/ui/dialog/DialogHeader.vue";
import DialogTitle from "@/components/ui/dialog/DialogTitle.vue";
import DialogTrigger from "@/components/ui/dialog/DialogTrigger.vue";
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  bundleSavedScripts,
  storageTransferFile,
  storageTransferFileName,
  storageTransferText,
  type SavedScript,
  type StorageBundle,
} from "../../storage-transfer.js";
import { gzipSupported } from "../../transfer-encoding.js";

// Exports the saved data of every script this browser keeps, or of the scripts the player keeps ticked, as one file or
// one text to copy (PLAYER-UI "Player Settings"). The list is read fresh when the dialog opens, and the file and text
// are prepared for the current choice, so Download and Copy stay direct player actions; nothing leaves the browser
// until then.
const props = defineProps<{
  read: () => Promise<readonly SavedScript[]>;
}>();

const open = ref(false);
const tab = ref<"file" | "text">("file");
const gzip = gzipSupported();
const scripts = shallowRef<readonly SavedScript[] | "reading" | "failed">("reading");
const listed = computed(() => (typeof scripts.value === "object" ? scripts.value : []));
const chosen = shallowRef<ReadonlySet<string>>(new Set());
const chosenScripts = computed(() => listed.value.filter((saved) => chosen.value.has(saved.script.scope)));
type Prepared = { readonly bundle: StorageBundle; readonly url: string; readonly size: number };
const state = shallowRef<"none" | "preparing" | "failed" | Prepared>("none");
const prepared = computed(() => (typeof state.value === "object" ? state.value : null));
const fileName = computed(() =>
  storageTransferFileName(
    chosenScripts.value.length === 1 ? label(chosenScripts.value[0]!) : "teasescript",
    gzip,
  ),
);
const text = ref<string | null>(null);
const copyStatus = ref<"" | "copied" | "failed">("");
const textArea = ref<InstanceType<typeof Textarea> | null>(null);
// Each opening and each choice gets its own preparation; a result for an earlier one is discarded.
let preparation = 0;

// Each opening reads the list once; a list read for an earlier opening is discarded.
let opening = 0;
watch(open, async (isOpen) => {
  const current = ++opening;
  scripts.value = "reading";
  chosen.value = new Set();
  if (!isOpen) return;
  tab.value = "file";
  try {
    const read = await props.read();
    if (current !== opening) return;
    scripts.value = read;
    // Everything is the default: every script is ticked.
    chosen.value = new Set(read.map((saved) => saved.script.scope));
  } catch {
    if (current === opening) scripts.value = "failed";
  }
});
watch(chosen, async () => {
  const current = ++preparation;
  release();
  if (chosenScripts.value.length === 0) return;
  state.value = "preparing";
  try {
    const bundle = await bundleSavedScripts(chosenScripts.value);
    if (current !== preparation) return;
    const file = await storageTransferFile(bundle, gzip);
    if (current !== preparation) return;
    state.value = { bundle, url: URL.createObjectURL(file), size: file.size };
  } catch {
    if (current === preparation) state.value = "failed";
  }
});
// The preparation whose text is being encoded, so switching tabs meanwhile does not encode it again.
let encoding = -1;
watch([tab, prepared], async ([selected, ready]) => {
  if (selected !== "text" || ready === null || text.value !== null || encoding === preparation) return;
  const current = (encoding = preparation);
  const result = await storageTransferText(ready.bundle, gzip).catch(() => null);
  if (current !== preparation) return;
  if (result !== null) text.value = result;
  else {
    URL.revokeObjectURL(ready.url);
    state.value = "failed";
  }
});
onBeforeUnmount(() => {
  opening++;
  preparation++;
  release();
});

// Frees the prepared file and text, so private photos do not stay in memory longer than needed.
function release() {
  if (prepared.value !== null) URL.revokeObjectURL(prepared.value.url);
  state.value = "none";
  text.value = null;
  copyStatus.value = "";
}

function choose(scope: string, on: boolean) {
  const next = new Set(chosen.value);
  if (on) next.add(scope);
  else next.delete(scope);
  chosen.value = next;
}
function chooseAll(on: boolean) {
  chosen.value = new Set(on ? listed.value.map((saved) => saved.script.scope) : []);
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
    // Unavailable outside secure contexts and refusable; the selected text then copies the older way where the browser
    // allows it, and otherwise stays selected so the player copies it with the browser.
    await navigator.clipboard.writeText(text.value);
    copied = true;
  } catch {
    copied = false;
  }
  // A copy that settles after the dialog closed or the choice changed says nothing about the current export.
  if (current !== preparation) return;
  if (!copied) {
    const focused = document.activeElement;
    selectText();
    copied = document.execCommand("copy");
    if (copied && focused instanceof HTMLElement) focused.focus();
  }
  copyStatus.value = copied ? "copied" : "failed";
}

function label(saved: SavedScript): string {
  return saved.script.name ?? saved.script.scope;
}
const count = (amount: number, one: string, many: string) => `${amount} ${amount === 1 ? one : many}`;
function formatSize(bytes: number): string {
  if (bytes < 1024) return count(bytes, "byte", "bytes");
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const missingPhotos = computed(() =>
  chosenScripts.value.reduce((total, saved) => total + saved.missingPhotos, 0),
);
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
          Takes the saved data of the scripts this browser has played, with their saved photos, to another browser or
          device. It is not a session checkpoint.
        </DialogDescription>
      </DialogHeader>
      <p v-if="scripts === 'reading'" role="status" class="text-sm">Reading the saved data…</p>
      <Alert v-else-if="scripts === 'failed'" variant="destructive">
        <AlertDescription>Could not read the saved data in this browser.</AlertDescription>
      </Alert>
      <p v-else-if="listed.length === 0" class="text-sm" data-export-empty>
        No script has saved data in this browser yet.
      </p>
      <template v-else>
        <fieldset class="grid gap-2 text-sm">
          <legend class="sr-only">Scripts to export</legend>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p data-export-summary>{{ chosenScripts.length }} of {{ count(listed.length, "script", "scripts") }}</p>
            <div class="flex gap-2">
              <Button variant="outline" size="sm" class="min-h-11" data-export-all @click="chooseAll(true)">
                Select all
              </Button>
              <Button variant="outline" size="sm" class="min-h-11" data-export-none @click="chooseAll(false)">
                Select none
              </Button>
            </div>
          </div>
          <ScrollArea class="max-h-64 rounded-md border">
            <ul class="grid p-1">
              <li v-for="saved in listed" :key="saved.script.scope">
                <label class="flex min-h-11 items-center gap-3 rounded-md px-2 py-1" :data-export-script="saved.script.scope">
                  <Checkbox
                    :model-value="chosen.has(saved.script.scope)"
                    @update:model-value="(on) => choose(saved.script.scope, on === true)"
                  />
                  <span class="min-w-0">
                    <span class="block break-all font-medium">{{ label(saved) }}</span>
                    <span v-if="saved.script.name" class="block break-all text-muted-foreground">
                      {{ saved.script.scope }}
                    </span>
                    <span class="block text-muted-foreground">
                      {{ count(saved.script.entries.length, "value", "values") }} ·
                      {{ count(saved.photos.length, "photo", "photos") }} · {{ formatSize(saved.size) }}
                    </span>
                  </span>
                </label>
              </li>
            </ul>
          </ScrollArea>
          <p v-if="missingPhotos > 0">
            {{ count(missingPhotos, "saved photo reference has", "saved photo references have") }} no stored photo;
            the export keeps them as text.
          </p>
          <p class="text-muted-foreground">The export can contain private photos; anyone who has it can see them.</p>
        </fieldset>
        <p v-if="chosenScripts.length === 0" class="text-sm">Tick at least one script to export.</p>
        <p v-else-if="state === 'preparing'" role="status" class="text-sm">Preparing the export…</p>
        <Alert v-else-if="state === 'failed'" variant="destructive">
          <AlertDescription>Could not prepare the export of these scripts.</AlertDescription>
        </Alert>
        <Tabs v-if="prepared" v-model="tab">
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
                        ? "Copying is not available here. The text is selected, so copy it with the browser."
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
