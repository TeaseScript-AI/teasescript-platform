<script setup lang="ts">
import { ref } from "vue";
import { Button } from "@/components/ui/button";
import Dialog from "@/components/ui/dialog/Dialog.vue";
import DialogContent from "@/components/ui/dialog/DialogContent.vue";
import DialogHeader from "@/components/ui/dialog/DialogHeader.vue";
import DialogTitle from "@/components/ui/dialog/DialogTitle.vue";

// A script's popup (`showPopup`, PLAYER-UI "Foreground interaction presentation"): its message, which names the
// dialog, and one button outside the chat. Like the end dialog, only the button, which takes focus, and Escape close it,
// not a click beside it; closing it continues the script. While Debug runs it is not modal, so the Debug panel and its
// rewind stay usable beside it, and Escape closes it only from inside. A key held down since before it opened, such as
// the Enter that answered the question before it, does not close it, and neither does anything while an answer is under
// way (`busy`).
const props = defineProps<{
  message: string;
  buttonText: string;
  modal: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const button = ref<InstanceType<typeof Button> | null>(null);
function focusButton(event: Event) {
  event.preventDefault();
  (button.value?.$el as HTMLElement | undefined)?.focus();
}
// Opened by the script, the dialog has no trigger to return focus to; the next interaction takes it.
function keepFocus(event: Event) {
  event.preventDefault();
}
function escape(event: KeyboardEvent) {
  if (event.repeat || (!props.modal && !document.activeElement?.closest("[data-popup-dialog]")))
    event.preventDefault();
}
// A repeated Enter would click the button, and a repeated Space would arm it for the key's release.
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
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      :show-close-button="false"
      :aria-describedby="undefined"
      data-popup-dialog
      @interact-outside.prevent
      @escape-key-down="escape"
      @open-auto-focus="focusButton"
      @close-auto-focus="keepFocus"
    >
      <DialogHeader>
        <DialogTitle class="leading-snug break-words whitespace-pre-line" data-popup-message>{{
          message
        }}</DialogTitle>
      </DialogHeader>
      <div class="flex flex-wrap justify-end gap-2">
        <Button
          ref="button"
          class="min-h-11 whitespace-normal break-words"
          data-popup-button
          @keydown="heldKey"
          @click="close"
          >{{ buttonText }}</Button
        >
      </div>
    </DialogContent>
  </Dialog>
</template>
