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
  sessionTransferFile,
  sessionTransferFileName,
  sessionTransferText,
  type SessionTransferMedium,
} from "../../session-transfer.js";
import {
  bundleSavedScripts,
  storageTransferFile,
  storageTransferFileName,
  storageTransferText,
  StorageTransferError,
  type SavedScript,
} from "../../storage-transfer.js";
import { gzipSupported } from "../../transfer-encoding.js";
import type { SessionExport } from "./usePlayerSession";

// Exports the saved data of every script this browser keeps, or of the scripts the player keeps ticked, or the session
// the player plays, as one file or one text to copy (PLAYER-UI "Player Settings"). The list is read fresh when the dialog
// opens, and the session each time it is chosen; the file and text are prepared for the current choice, so Download and
// Copy stay direct player actions, and nothing leaves the browser until then.
const props = defineProps<{
  read: () => Promise<readonly SavedScript[]>;
  /** The session's export, with why it is unavailable now, or `null` when it is available. */
  session: { readonly unavailable: string | null; readonly read: () => Promise<SessionExport> };
}>();

const open = ref(false);
// What the export takes: saved data, as by default, or the session.
const kind = ref<"savedData" | "session">("savedData");
const tab = ref<"file" | "text">("file");
const gzip = gzipSupported();
const scripts = shallowRef<readonly SavedScript[] | "reading" | "failed">("reading");
const listed = computed(() => (typeof scripts.value === "object" ? scripts.value : []));
const chosen = shallowRef<ReadonlySet<string>>(new Set());
const chosenScripts = computed(() => listed.value.filter((saved) => chosen.value.has(saved.script.scope)));
type Prepared = {
  readonly url: string;
  readonly size: number;
  readonly fileName: string;
  readonly text: () => Promise<string>;
};
const state = shallowRef<"none" | "preparing" | "failed" | Prepared>("none");
const prepared = computed(() => (typeof state.value === "object" ? state.value : null));
// Why the session could not be exported, when the Player said so.
const problem = ref<string | null>(null);
// The session as the export took it.
const exportedSession = shallowRef<SessionExport | null>(null);
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
  kind.value = "savedData";
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
watch([kind, chosen], () => void prepare());
async function prepare() {
  const current = ++preparation;
  release();
  if (!open.value) return;
  if (kind.value === "session") {
    if (props.session.unavailable !== null) return;
    state.value = "preparing";
    try {
      const read = await props.session.read();
      if (current !== preparation) return;
      const file = await sessionTransferFile(read.transfer, gzip);
      if (current !== preparation) return;
      exportedSession.value = read;
      state.value = {
        url: URL.createObjectURL(file),
        size: file.size,
        fileName: sessionTransferFileName(read.transfer.name ?? read.transfer.scope, gzip),
        text: () => sessionTransferText(read.transfer, gzip),
      };
    } catch (error) {
      if (current !== preparation) return;
      problem.value = error instanceof StorageTransferError ? error.message : null;
      state.value = "failed";
    }
    return;
  }
  const saved = chosenScripts.value;
  if (saved.length === 0) return;
  state.value = "preparing";
  try {
    const bundle = await bundleSavedScripts(saved);
    if (current !== preparation) return;
    const file = await storageTransferFile(bundle, gzip);
    if (current !== preparation) return;
    state.value = {
      url: URL.createObjectURL(file),
      size: file.size,
      fileName: storageTransferFileName(saved.length === 1 ? label(saved[0]!) : "teasescript", gzip),
      text: () => storageTransferText(bundle, gzip),
    };
  } catch {
    if (current === preparation) state.value = "failed";
  }
}
// The preparation whose text is being encoded, so switching tabs meanwhile does not encode it again.
let encoding = -1;
watch([tab, prepared], async ([selected, ready]) => {
  if (selected !== "text" || ready === null || text.value !== null || encoding === preparation) return;
  const current = (encoding = preparation);
  const result = await ready.text().catch(() => null);
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
  problem.value = null;
  exportedSession.value = null;
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
/** The session's values, photos, recordings, and files, as counts. */
function sessionContents(read: SessionExport): string {
  const media = read.transfer.media;
  const of = (kinds: readonly SessionTransferMedium["kind"][]) =>
    media.filter((medium) => kinds.includes(medium.kind)).length;
  const recordings = of(["audio", "video"]);
  const files = of(["file"]);
  return [
    count(read.transfer.entries.length, "saved value", "saved values"),
    count(of(["image"]), "photo", "photos"),
    ...(recordings > 0 ? [count(recordings, "recording", "recordings")] : []),
    ...(files > 0 ? [count(files, "file", "files")] : []),
  ].join(" · ");
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button variant="outline" size="sm" class="min-h-11" data-export-saved-data>Export…</Button>
    </DialogTrigger>
    <DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto" data-saved-data-export>
      <DialogHeader>
        <DialogTitle>Export</DialogTitle>
        <DialogDescription>Takes saved data, or the session you play, to another browser or device.</DialogDescription>
      </DialogHeader>
      <fieldset class="grid gap-1 text-sm" data-export-kind>
        <legend class="sr-only">What to export</legend>
        <label class="flex min-h-11 items-start gap-3 rounded-md px-2 py-2">
          <input v-model="kind" type="radio" name="export-kind" value="savedData" class="mt-1 size-4" />
          <span class="min-w-0">
            <span class="block font-medium">Saved data</span>
            <span class="block text-muted-foreground">
              What the scripts this browser has played saved, with their saved photos.
            </span>
          </span>
        </label>
        <label
          class="flex min-h-11 items-start gap-3 rounded-md px-2 py-2"
          :class="session.unavailable === null ? '' : 'text-muted-foreground'"
        >
          <input
            v-model="kind"
            type="radio"
            name="export-kind"
            value="session"
            class="mt-1 size-4"
            :disabled="session.unavailable !== null"
            data-export-kind-session
          />
          <span class="min-w-0">
            <span class="block font-medium">This session</span>
            <span class="block text-muted-foreground" data-export-session-note>
              {{
                session.unavailable ??
                "Where you are in this script now, with its saved data and photos, to continue it in another browser."
              }}
            </span>
          </span>
        </label>
      </fieldset>
      <template v-if="kind === 'savedData'">
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
                  <label
                    class="flex min-h-11 items-center gap-3 rounded-md px-2 py-1"
                    :data-export-script="saved.script.scope"
                  >
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
        </template>
      </template>
      <template v-else>
        <p v-if="state === 'preparing'" role="status" class="text-sm">Preparing the export…</p>
        <Alert v-else-if="state === 'failed'" variant="destructive" data-export-session-problem>
          <AlertDescription>{{ problem ?? "Could not prepare the export of this session." }}</AlertDescription>
        </Alert>
        <div v-else-if="exportedSession" class="grid gap-2 text-sm" data-export-session>
          <p>
            <span class="block break-all font-medium">
              {{ exportedSession.transfer.name ?? exportedSession.transfer.scope }}
            </span>
            <span class="block text-muted-foreground">{{ sessionContents(exportedSession) }}</span>
          </p>
          <p v-if="exportedSession.missing > 0">
            {{
              count(exportedSession.missing, "reference names a photo or file", "references name photos or files")
            }}
            this browser does not have. The export keeps them as text.
          </p>
          <p class="text-muted-foreground">
            The export contains the session's messages and answers and can contain private photos. Anyone who has it can
            see them.
          </p>
        </div>
      </template>
      <Tabs v-if="prepared" v-model="tab">
        <TabsList class="h-auto w-full">
          <TabsTrigger value="file" class="min-h-11" data-export-tab="file">File</TabsTrigger>
          <TabsTrigger value="text" class="min-h-11" data-export-tab="text">Text</TabsTrigger>
        </TabsList>
        <TabsContent value="file">
          <div class="grid gap-3 text-sm">
            <p v-if="kind === 'session'">
              One file with the session, its saved data, and its photos. Import it in the Settings of this script's
              Player in the other browser, then press Continue.
            </p>
            <p v-else>One file with the values and photos. Import it in the Settings of the other Player.</p>
            <Button as-child class="min-h-11 justify-self-start">
              <a :href="prepared.url" :download="prepared.fileName" data-export-download>
                <Download />
                Download file
              </a>
            </Button>
            <p class="break-all text-muted-foreground">{{ prepared.fileName }} · {{ formatSize(prepared.size) }}</p>
            <p v-if="!gzip">This browser cannot compress, so the file is plain JSON.</p>
          </div>
        </TabsContent>
        <TabsContent value="text">
          <div class="grid gap-3 text-sm">
            <p v-if="kind === 'session'">
              Copy this text and paste it into Import in the Settings of this script's Player in the other browser. With
              many photos, a file is easier to move.
            </p>
            <p v-else>
              Copy this text and paste it into Import in the Settings of the other Player. With many photos, a file is
              easier to move.
            </p>
            <p v-if="text === null" role="status">Preparing the text…</p>
            <template v-else>
              <Textarea
                ref="textArea"
                :model-value="text"
                readonly
                rows="6"
                :aria-label="kind === 'session' ? 'Exported session as text' : 'Exported saved data as text'"
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
    </DialogContent>
  </Dialog>
</template>
