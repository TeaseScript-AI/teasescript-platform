<script setup lang="ts">
import { ref, useId } from "vue";
import { Star } from "@lucide/vue";
import { RadioGroupItem, RadioGroupRoot } from "reka-ui";
import { Button } from "@/components/ui/button";
import Dialog from "@/components/ui/dialog/Dialog.vue";
import DialogContent from "@/components/ui/dialog/DialogContent.vue";
import DialogDescription from "@/components/ui/dialog/DialogDescription.vue";
import DialogHeader from "@/components/ui/dialog/DialogHeader.vue";
import DialogTitle from "@/components/ui/dialog/DialogTitle.vue";
import { Textarea } from "@/components/ui/textarea";

// The pop-up an ordinary end of the session opens (PLAYER-UI "Session end and failure"). Only Close, which takes focus,
// and Escape close it, not a click beside it, and leave the conversation to read, with Play again on the end line. The
// review is a placeholder until TeaseScript has its website: a rating and a text the player can fill in, but nothing is
// sent or stored.
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ returnFocus: [] }>();

const rating = ref(0);
const review = ref("");
const reviewId = useId();
const closeButton = ref<InstanceType<typeof Button> | null>(null);
function focusClose(event: Event) {
  event.preventDefault();
  (closeButton.value?.$el as HTMLElement | undefined)?.focus();
}
// Opened without a trigger, the dialog returns focus to the end line, where Play again stays.
function returnFocus(event: Event) {
  event.preventDefault();
  emit("returnFocus");
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      :show-close-button="false"
      data-session-end-dialog
      @interact-outside.prevent
      @open-auto-focus="focusClose"
      @close-auto-focus="returnFocus"
    >
      <DialogHeader>
        <DialogTitle>The end</DialogTitle>
      </DialogHeader>

      <div class="grid gap-3" data-session-end-review>
        <RadioGroupRoot
          v-model="rating"
          orientation="horizontal"
          aria-label="Rating"
          class="flex gap-1"
          data-session-end-rating
        >
          <RadioGroupItem
            v-for="star in 5"
            :key="star"
            :value="star"
            :aria-label="star === 1 ? '1 star' : `${star} stars`"
            class="grid size-11 place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-session-end-star
          >
            <Star
              class="size-7"
              :class="star <= rating ? 'fill-primary text-primary' : 'text-muted-foreground'"
              aria-hidden="true"
            />
          </RadioGroupItem>
        </RadioGroupRoot>
        <div class="grid gap-2">
          <label :for="reviewId" class="text-sm font-medium">Write a review (optional)</label>
          <Textarea :id="reviewId" v-model="review" data-session-end-review-text />
        </div>
        <div class="grid justify-items-start gap-1">
          <Button variant="outline" class="min-h-11" disabled data-session-end-send>
            Send review
          </Button>
          <DialogDescription data-session-end-review-note>
            Sending reviews will be possible once TeaseScript has its website.
          </DialogDescription>
        </div>
      </div>

      <div class="flex flex-wrap justify-end gap-2">
        <Button ref="closeButton" class="min-h-11" data-session-end-close @click="open = false"
          >Close</Button
        >
      </div>
    </DialogContent>
  </Dialog>
</template>
