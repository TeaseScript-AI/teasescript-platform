<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useElementBounding } from "@vueuse/core";
import { Copy, Download } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import Dialog from "@/components/ui/dialog/Dialog.vue";
import DialogContent from "@/components/ui/dialog/DialogContent.vue";
import DialogHeader from "@/components/ui/dialog/DialogHeader.vue";
import DialogTitle from "@/components/ui/dialog/DialogTitle.vue";
import { Textarea } from "@/components/ui/textarea";

// A script's `exportText` (PLAYER-UI "Foreground interaction presentation"): its title and its text in a read-only code
// field, with Copy, Download, and Close. Copy and Download are the player's own actions and leave the dialog open; only
// Close, which the script waits for, closes it. Copy copies the whole text; where the browser refuses or cannot, the
// text is selected for copying by hand and a hint points to Download. Download saves the text as a UTF-8 file named
// `fileName`, made only when the player asks for it. As for a popup, a click beside the dialog does not close it, a key
// held down since before it opened does nothing, and while Debug runs the dialog is not modal: it stands in the middle
// of the session's `area`, and Escape closes it only from inside.
const props = defineProps<{
  title: string;
  text: string;
  fileName: string;
  modal: boolean;
  busy: boolean;
  /** The session's area, which a dialog that is not modal centres on instead of the window. */
  area?: HTMLElement | null;
}>();
const emit = defineEmits<{ close: [] }>();

const copyButton = ref<InstanceType<typeof Button> | null>(null);
const textArea = ref<InstanceType<typeof Textarea> | null>(null);
const copyStatus = ref<"" | "copied" | "failed">("");
const bounds = useElementBounding(() => (props.modal ? null : (props.area ?? null)));
const placement = computed(() =>
  props.modal || !props.area
    ? undefined
    : {
        left: `${bounds.left.value + bounds.width.value / 2}px`,
        top: `${bounds.top.value + bounds.height.value / 2}px`,
        maxWidth: `min(42rem, ${Math.max(0, bounds.width.value - 32)}px)`,
      },
);
// A copy that settles after the dialog closed says nothing about it.
let mounted = true;
let fileUrl: string | null = null;
onBeforeUnmount(() => {
  mounted = false;
  if (fileUrl !== null) URL.revokeObjectURL(fileUrl);
});

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
  copyStatus.value = "";
  let copied: boolean;
  try {
    // Unavailable outside secure contexts, refusable, and limited in size on some systems; the selected text then
    // copies the older way where the browser allows it, and otherwise stays selected for the player.
    await navigator.clipboard.writeText(props.text);
    copied = true;
  } catch {
    copied = false;
  }
  if (!mounted) return;
  if (!copied) {
    const focused = document.activeElement;
    selectText();
    copied = document.execCommand("copy");
    if (copied && focused instanceof HTMLElement) focused.focus();
  }
  copyStatus.value = copied ? "copied" : "failed";
}
function download() {
  fileUrl ??= URL.createObjectURL(new Blob([props.text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = fileUrl;
  link.download = props.fileName;
  link.click();
}

function focusCopy(event: Event) {
  event.preventDefault();
  (copyButton.value?.$el as HTMLElement | undefined)?.focus();
}
// Opened by the script, the dialog has no trigger to return focus to; the next interaction takes it.
function keepFocus(event: Event) {
  event.preventDefault();
}
function escape(event: KeyboardEvent) {
  if (
    event.repeat ||
    (!props.modal && !document.activeElement?.closest("[data-export-text-dialog]"))
  )
    event.preventDefault();
}
// A repeated Enter would click a button, and a repeated Space would arm it for the key's release.
function heldKey(event: KeyboardEvent) {
  if (event.repeat) event.preventDefault();
}
function close() {
  if (!props.busy) emit("close");
}
</script>

<template>
  <Dialog :open="true" :modal="modal" @update:open="(open) => !open && close()">
    <DialogContent
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
      :class="{ 'z-[38]': !modal }"
      :style="placement"
      :show-close-button="false"
      :aria-describedby="undefined"
      data-export-text-dialog
      @interact-outside.prevent
      @escape-key-down="escape"
      @open-auto-focus="focusCopy"
      @close-auto-focus="keepFocus"
    >
      <DialogHeader>
        <DialogTitle class="leading-snug break-words whitespace-pre-line" data-export-text-title>{{
          title
        }}</DialogTitle>
      </DialogHeader>
      <Textarea
        ref="textArea"
        :model-value="text"
        readonly
        rows="8"
        spellcheck="false"
        :aria-label="title"
        variant="code"
        class="max-h-[50dvh] break-all"
        data-export-text-field
      />
      <div class="flex flex-wrap items-center gap-2" @keydown="heldKey">
        <Button ref="copyButton" class="min-h-11" data-export-text-copy @click="copyText">
          <Copy />
          Copy
        </Button>
        <Button variant="outline" class="min-h-11" data-export-text-download @click="download">
          <Download />
          Download
        </Button>
        <Button variant="outline" class="min-h-11 sm:ms-auto" data-export-text-close @click="close">
          Close
        </Button>
      </div>
      <p role="status" class="text-sm" data-export-text-status>
        {{
          copyStatus === "copied"
            ? "Copied."
            : copyStatus === "failed"
              ? "Copying did not work here. The text is selected, so copy it yourself or use Download."
              : ""
        }}
      </p>
    </DialogContent>
  </Dialog>
</template>
