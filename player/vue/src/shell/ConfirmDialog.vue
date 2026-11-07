<script setup lang="ts">
import { Button } from "@/components/ui/button";
import Dialog from "@/components/ui/dialog/Dialog.vue";
import DialogContent from "@/components/ui/dialog/DialogContent.vue";
import DialogDescription from "@/components/ui/dialog/DialogDescription.vue";
import DialogHeader from "@/components/ui/dialog/DialogHeader.vue";
import DialogTitle from "@/components/ui/dialog/DialogTitle.vue";

// One question with two answers: Cancel, or the action it names. The confirming click may be the user activation that
// audible playback relies on, such as for a session it starts.
defineProps<{
  open: boolean;
  /** Names the dialog for automation. */
  name: string;
  title: string;
  description: string;
  action: string;
  destructive?: boolean;
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <Dialog :open="open" @update:open="(next) => !next && emit('cancel')">
    <DialogContent :show-close-button="false" :data-confirm-dialog="name">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ description }}</DialogDescription>
      </DialogHeader>
      <div class="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" class="min-h-11" @click="emit('cancel')">Cancel</Button>
        <Button
          type="button"
          :variant="destructive ? 'destructive' : 'default'"
          class="min-h-11"
          data-confirm-action
          @click="emit('confirm')"
        >
          {{ action }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
