<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { Upload } from "@lucide/vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
import Dialog from "@/components/ui/dialog/Dialog.vue";
import DialogContent from "@/components/ui/dialog/DialogContent.vue";
import DialogDescription from "@/components/ui/dialog/DialogDescription.vue";
import DialogHeader from "@/components/ui/dialog/DialogHeader.vue";
import DialogTitle from "@/components/ui/dialog/DialogTitle.vue";
import DialogTrigger from "@/components/ui/dialog/DialogTrigger.vue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  readPlayerTransferFile,
  readPlayerTransferText,
  type PlayerTransfer,
  type SessionTransfer,
  type SessionTransferMedium,
} from "../../session-transfer.js";
import { StorageTransferError, type StorageBundle } from "../../storage-transfer.js";
import type { SavedDataImportReview, SessionImportReview } from "./usePlayerSession";

// Imports saved data or a session exported from another Player, as a file or pasted text. Saved data goes into the
// scope of each script in it, or of the ones the player keeps ticked; a session continues the script this Player shows.
// Everything is read and checked before the player confirms; only the confirmation replaces saved data, and it ends a
// session in progress first when its script is among them.
const props = defineProps<{
  /** Whether an import can begin now. */
  available: boolean;
  /** Whether a session of the shown script is in progress, which importing that script ends. */
  sessionInProgress: boolean;
  review: (bundle: StorageBundle) => Promise<SavedDataImportReview>;
  commit: (review: SavedDataImportReview, chosen: ReadonlySet<string>) => Promise<void>;
  reviewSession: (transfer: SessionTransfer) => Promise<SessionImportReview>;
  commitSession: (review: SessionImportReview) => Promise<void>;
}>();

const open = ref(false);
const tab = ref<"file" | "text">("file");
const pasted = ref("");
const dragging = ref(false);
type Step =
  | { readonly kind: "input"; readonly problem: string | null }
  | { readonly kind: "reading" }
  | { readonly kind: "review"; readonly review: SavedDataImportReview; readonly problem: string | null }
  | { readonly kind: "importing"; readonly review: SavedDataImportReview }
  | { readonly kind: "sessionReview"; readonly review: SessionImportReview; readonly problem: string | null }
  | { readonly kind: "sessionImporting"; readonly review: SessionImportReview }
  | { readonly kind: "done"; readonly session: boolean };
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
const reviewedSession = computed(() =>
  step.value.kind === "sessionReview" || step.value.kind === "sessionImporting" ? step.value.review : null,
);
// The scripts to import; all of them unless the player unticks some.
const chosen = shallowRef<ReadonlySet<string>>(new Set());
const endsSession = computed(
  () =>
    props.sessionInProgress &&
    (reviewed.value?.scripts.some((script) => script.shown && chosen.value.has(script.scope)) ?? false),
);
function choose(scope: string, on: boolean) {
  const next = new Set(chosen.value);
  if (on) next.add(scope);
  else next.delete(scope);
  chosen.value = next;
}

async function read(load: () => Promise<PlayerTransfer>) {
  const current = ++attempt;
  step.value = { kind: "reading" };
  try {
    const transfer = await load();
    if (transfer.kind === "session") {
      const review = await props.reviewSession(transfer.session);
      if (current !== attempt) return;
      step.value = { kind: "sessionReview", review, problem: null };
    } else {
      const review = await props.review(transfer.bundle);
      if (current !== attempt) return;
      chosen.value = new Set(review.scripts.map((script) => script.scope));
      step.value = { kind: "review", review, problem: null };
    }
    await nextTick();
    heading.value?.focus();
  } catch (error) {
    if (current !== attempt) return;
    step.value = {
      kind: "input",
      problem: error instanceof StorageTransferError ? error.message : "This file or text could not be read.",
    };
  }
}
function readFile(file: File) {
  void read(async () => readPlayerTransferFile(new Uint8Array(await file.arrayBuffer())));
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
  void read(() => readPlayerTransferText(pasted.value));
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
    await props.commit(current.review, chosen.value);
    if (confirmed === attempt) step.value = { kind: "done", session: false };
  } catch (error) {
    if (confirmed !== attempt) return;
    step.value = {
      kind: "review",
      review: current.review,
      problem:
        error instanceof StorageTransferError
          ? error.message
          : "The import failed; scripts it did not reach keep their saved data.",
    };
  }
}

async function confirmSession() {
  const current = step.value;
  if (current.kind !== "sessionReview") return;
  const confirmed = ++attempt;
  step.value = { kind: "sessionImporting", review: current.review };
  try {
    await props.commitSession(current.review);
    if (confirmed === attempt) step.value = { kind: "done", session: true };
  } catch (error) {
    if (confirmed !== attempt) return;
    step.value = {
      kind: "sessionReview",
      review: current.review,
      problem: error instanceof StorageTransferError ? error.message : "The import of the session failed.",
    };
  }
}

const count = (amount: number, one: string, many: string) => `${amount} ${amount === 1 ? one : many}`;
/** The session's values, photos, recordings, and files, as counts. */
function sessionContents(review: SessionImportReview): string {
  const media = review.transfer.media;
  const of = (kinds: readonly SessionTransferMedium["kind"][]) =>
    media.filter((medium) => kinds.includes(medium.kind)).length;
  const recordings = of(["audio", "video"]);
  const files = of(["file"]);
  return [
    count(review.transfer.entries.length, "value", "values"),
    count(of(["image"]), "photo", "photos"),
    ...(recordings > 0 ? [count(recordings, "recording", "recordings")] : []),
    ...(files > 0 ? [count(files, "file", "files")] : []),
  ].join(" · ");
}
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
        <DialogTitle>Import</DialogTitle>
        <DialogDescription>
          Brings saved data or a session from another browser or device.
        </DialogDescription>
      </DialogHeader>

      <template v-if="step.kind === 'input' || step.kind === 'reading'">
        <Alert v-if="step.kind === 'input' && step.problem" variant="destructive" data-import-problem>
          <AlertDescription>{{ step.problem }}</AlertDescription>
        </Alert>
        <p v-if="step.kind === 'reading'" role="status" class="text-sm">Checking what was exported…</p>
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
                aria-label="Exported saved data or session as text"
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
          Replace the saved data of the ticked scripts? This cannot be undone.
        </h3>
        <p data-import-summary>
          {{ chosen.size }} of {{ count(reviewed.scripts.length, "script", "scripts") }} ticked. Unticked scripts keep
          their saved data.
        </p>
        <ScrollArea class="max-h-64 rounded-md border">
          <ul class="grid p-1">
            <li v-for="script in reviewed.scripts" :key="script.scope">
              <label class="flex min-h-11 items-center gap-3 rounded-md px-2 py-1" :data-import-script="script.scope">
                <Checkbox
                  :model-value="chosen.has(script.scope)"
                  :disabled="step.kind === 'importing'"
                  @update:model-value="(on) => choose(script.scope, on === true)"
                />
                <span class="min-w-0 grow">
                  <span class="block break-all font-medium">{{ script.name ?? script.scope }}</span>
                  <span v-if="script.name" class="block break-all text-muted-foreground">{{ script.scope }}</span>
                  <span class="block text-muted-foreground">
                    {{ count(script.values, "value", "values") }} · {{ count(script.photos, "photo", "photos") }}
                    <template v-if="script.currentValues > 0">
                      · replaces {{ count(script.currentValues, "value", "values") }}
                    </template>
                  </span>
                </span>
                <span class="flex flex-col items-end gap-1">
                  <Badge :variant="script.currentValues > 0 ? 'secondary' : 'outline'" data-import-status>
                    {{ script.currentValues > 0 ? "Replaces saved data" : "New" }}
                  </Badge>
                  <Badge v-if="script.shown" variant="outline">This script</Badge>
                </span>
              </label>
            </li>
          </ul>
        </ScrollArea>
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
            :disabled="step.kind === 'importing' || chosen.size === 0"
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

      <section v-else-if="reviewedSession" class="grid gap-3 text-sm" data-import-session-review>
        <h3 ref="heading" tabindex="-1" class="font-medium outline-none">
          Import this session? This cannot be undone.
        </h3>
        <p>
          <span class="block break-all font-medium">{{ reviewedSession.name ?? reviewedSession.transfer.scope }}</span>
          <span class="block text-muted-foreground">{{ sessionContents(reviewedSession) }}</span>
        </p>
        <p data-import-session-replaces>
          {{
            reviewedSession.currentValues > 0
              ? `It replaces this script's ${count(reviewedSession.currentValues, "saved value", "saved values")} and any session kept for it in this browser.`
              : "It replaces any session kept for this script in this browser."
          }}
        </p>
        <p class="text-muted-foreground">To keep what is saved now, export it first.</p>
        <p v-if="sessionInProgress" data-import-ends-session>
          This ends the current session. Progress it has not saved is lost.
        </p>
        <Alert v-if="step.kind === 'sessionReview' && step.problem" variant="destructive" data-import-problem>
          <AlertDescription>{{ step.problem }}</AlertDescription>
        </Alert>
        <div class="flex flex-wrap gap-2">
          <Button
            variant="destructive"
            class="min-h-11"
            :disabled="step.kind === 'sessionImporting'"
            data-import-confirm
            @click="confirmSession"
          >
            {{
              step.kind === "sessionImporting"
                ? "Importing…"
                : sessionInProgress
                  ? "End session and import"
                  : "Import session"
            }}
          </Button>
          <Button
            variant="outline"
            class="min-h-11"
            :disabled="step.kind === 'sessionImporting'"
            @click="cancelReview"
          >
            Cancel
          </Button>
        </div>
      </section>

      <section v-else-if="step.kind === 'done'" class="grid gap-3 text-sm" data-import-done>
        <p role="status">
          {{
            step.session
              ? "Session imported. Continue goes on where it was exported."
              : "Saved data imported. Each script uses it from its next Start."
          }}
        </p>
        <Button class="min-h-11 justify-self-start" @click="open = false">Close</Button>
      </section>
    </DialogContent>
  </Dialog>
</template>
