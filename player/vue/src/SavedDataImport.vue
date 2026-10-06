<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { Upload } from "@lucide/vue";
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
  readStorageTransferFile,
  readStorageTransferText,
  StorageTransferError,
  type StorageTransfer,
} from "../../storage-transfer.js";
import type { ScriptStorageImportReview } from "./usePlayerSession";

// Imports saved data exported from another Player, as a file or pasted text. Everything is read and checked before the
// player confirms; only the confirmation replaces the saved data, and ends a session in progress first.
const props = defineProps<{
  /** Whether an import can begin now. */
  available: boolean;
  /** Whether confirming must end the current session. */
  endsSession: boolean;
  review: (transfer: StorageTransfer) => Promise<ScriptStorageImportReview>;
  commit: (review: ScriptStorageImportReview) => Promise<void>;
}>();

const open = ref(false);
const tab = ref<"file" | "text">("file");
const pasted = ref("");
const dragging = ref(false);
type Step =
  | { readonly kind: "input"; readonly problem: string | null }
  | { readonly kind: "reading" }
  | { readonly kind: "review"; readonly review: ScriptStorageImportReview; readonly problem: string | null }
  | { readonly kind: "importing"; readonly review: ScriptStorageImportReview }
  | { readonly kind: "done" };
const step = shallowRef<Step>({ kind: "input", problem: null });
const fileInput = ref<HTMLInputElement | null>(null);
const heading = ref<HTMLElement | null>(null);
// Each reading belongs to one opening of the dialog; a late result after Cancel or closing is discarded.
let attempt = 0;

watch(open, () => {
  attempt++;
  step.value = { kind: "input", problem: null };
  pasted.value = "";
  dragging.value = false;
});

const reviewed = computed(() =>
  step.value.kind === "review" || step.value.kind === "importing" ? step.value.review : null,
);

async function read(load: () => Promise<StorageTransfer>) {
  const current = ++attempt;
  step.value = { kind: "reading" };
  try {
    const review = await props.review(await load());
    if (current !== attempt) return;
    step.value = { kind: "review", review, problem: null };
    await nextTick();
    heading.value?.focus();
  } catch (error) {
    if (current !== attempt) return;
    step.value = {
      kind: "input",
      problem:
        error instanceof StorageTransferError ? error.message : "This saved data could not be read.",
    };
  }
}
function readFile(file: File) {
  void read(async () => readStorageTransferFile(new Uint8Array(await file.arrayBuffer())));
}
function chooseFile(event: Event) {
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  const file = input?.files?.[0];
  // Choosing the same file again must read it again.
  if (input) input.value = "";
  if (file) readFile(file);
}
function drop(event: DragEvent) {
  dragging.value = false;
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;
  if (files.length > 1) {
    // Refusing this drop also discards a reading that is still pending, so it cannot become the review.
    attempt++;
    step.value = { kind: "input", problem: "Drop one exported file." };
    return;
  }
  readFile(files[0]!);
}
function reviewText() {
  void read(() => readStorageTransferText(pasted.value));
}
function cancelReview() {
  attempt++;
  step.value = { kind: "input", problem: null };
}
async function confirm() {
  const current = step.value;
  if (current.kind !== "review") return;
  const confirmed = ++attempt;
  step.value = { kind: "importing", review: current.review };
  try {
    await props.commit(current.review);
    if (confirmed === attempt) step.value = { kind: "done" };
  } catch (error) {
    if (confirmed !== attempt) return;
    step.value = {
      kind: "review",
      review: current.review,
      problem: error instanceof StorageTransferError ? error.message : "The import failed. The saved data is unchanged.",
    };
  }
}

const count = (amount: number, one: string, many: string) => `${amount} ${amount === 1 ? one : many}`;
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button variant="outline" size="sm" class="min-h-11" :disabled="!available" data-import-saved-data>
        Import…
      </Button>
    </DialogTrigger>
    <!-- A file dropped anywhere on the dialog must not open in the browser; only the drop area imports. -->
    <DialogContent
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      data-saved-data-import
      @dragover.prevent
      @drop.prevent
    >
      <DialogHeader>
        <DialogTitle>Import saved data</DialogTitle>
        <DialogDescription>
          Replaces this script's saved data, with its saved photos, by data exported from another browser or device.
        </DialogDescription>
      </DialogHeader>

      <template v-if="step.kind === 'input' || step.kind === 'reading'">
        <Alert v-if="step.kind === 'input' && step.problem" variant="destructive" data-import-problem>
          <AlertDescription>{{ step.problem }}</AlertDescription>
        </Alert>
        <p v-if="step.kind === 'reading'" role="status" class="text-sm">Checking the saved data…</p>
        <Tabs v-model="tab">
          <TabsList class="h-auto w-full">
            <TabsTrigger value="file" class="min-h-11" data-import-tab="file">File</TabsTrigger>
            <TabsTrigger value="text" class="min-h-11" data-import-tab="text">Text</TabsTrigger>
          </TabsList>
          <TabsContent value="file">
            <div
              class="grid justify-items-center gap-3 rounded-lg border border-dashed p-6 text-center text-sm"
              :class="dragging ? 'border-primary bg-accent' : ''"
              data-import-drop
              @dragenter.prevent="dragging = true"
              @dragover.prevent="dragging = true"
              @dragleave="dragging = false"
              @drop.prevent="drop"
            >
              <Upload aria-hidden="true" />
              <p>Drop an exported file here, or choose it.</p>
              <Button
                class="min-h-11"
                :disabled="step.kind === 'reading'"
                data-import-choose
                @click="fileInput?.click()"
              >
                Choose file…
              </Button>
              <input
                ref="fileInput"
                type="file"
                class="sr-only"
                tabindex="-1"
                aria-hidden="true"
                data-import-file
                @change="chooseFile"
              />
            </div>
          </TabsContent>
          <TabsContent value="text">
            <div class="grid gap-3 text-sm">
              <Textarea
                v-model="pasted"
                rows="6"
                aria-label="Exported saved data as text"
                placeholder="Paste the exported text here"
                class="max-h-48 break-all"
                data-import-text
              />
              <Button
                class="min-h-11 justify-self-start"
                :disabled="pasted.trim() === '' || step.kind === 'reading'"
                data-import-review
                @click="reviewText"
              >
                Review import
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </template>

      <section v-else-if="reviewed" class="grid gap-3 text-sm" data-import-review-step>
        <h3 ref="heading" tabindex="-1" class="font-medium outline-none">
          Replace all saved data for this script? This cannot be undone.
        </h3>
        <p data-import-summary>
          Imports {{ count(reviewed.transfer.entries.length, "saved value", "saved values") }} ·
          {{ count(reviewed.transfer.images.length, "photo", "photos") }}, replacing
          {{ count(reviewed.currentCount, "saved value", "saved values") }}.
        </p>
        <div v-if="reviewed.removedKeys.length > 0" class="grid gap-1">
          <p>{{ count(reviewed.removedKeys.length, "saved key is", "saved keys are") }} removed:</p>
          <ul class="max-h-32 overflow-y-auto rounded-md border p-2 break-all" data-import-removed>
            <li v-for="key in reviewed.removedKeys" :key="key">{{ key === "" ? "(empty key)" : key }}</li>
          </ul>
        </div>
        <p class="text-muted-foreground">To keep what is saved now, export it first.</p>
        <p v-if="endsSession" data-import-ends-session>
          This ends the current session. Progress it has not saved is lost; afterwards, Start begins a new session with the
          imported data.
        </p>
        <Alert v-if="step.kind === 'review' && step.problem" variant="destructive" data-import-problem>
          <AlertDescription>{{ step.problem }}</AlertDescription>
        </Alert>
        <div class="flex flex-wrap gap-2">
          <Button
            variant="destructive"
            class="min-h-11"
            :disabled="step.kind === 'importing'"
            data-import-confirm
            @click="confirm"
          >
            {{
              step.kind === "importing"
                ? "Importing…"
                : endsSession
                  ? "End session and replace data"
                  : "Replace saved data"
            }}
          </Button>
          <Button variant="outline" class="min-h-11" :disabled="step.kind === 'importing'" @click="cancelReview">
            Cancel
          </Button>
        </div>
      </section>

      <section v-else class="grid gap-3 text-sm" data-import-done>
        <p role="status">Saved data imported. Start to use it.</p>
        <Button class="min-h-11 justify-self-start" @click="open = false">Close</Button>
      </section>
    </DialogContent>
  </Dialog>
</template>
