<script setup lang="ts">
import { ref, useId } from "vue";
import { Eye, EyeOff } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { keepOneLine, passwordAttributes } from "./passwordText";

// A password field (V30 §13 and §20): masked, with an eye button that shows the text while the person typing chooses
// to, a warning while Caps Lock is on, and the field's error under it, which the field names as its description. What it
// holds never leaves the Player's memory as typed. While the Player works with it (`busy`) it is read-only but keeps
// focus, so the busy state is read where the person is.
const props = defineProps<{
  label: string;
  /** A sentence under the label that says what the password is for, or none. */
  description?: string;
  busy?: boolean;
  /** Why the field's text does not do, shown under it, or none. */
  error?: string | null;
}>();
const model = defineModel<string>({ required: true });

const id = useId();
const statusId = useId();
const descriptionId = useId();
const shown = ref(false);
const capsLock = ref(false);
const input = ref<InstanceType<typeof Textarea> | null>(null);

// Only a key event says whether Caps Lock is on; a field that has seen none shows no warning.
function readCapsLock(event: KeyboardEvent) {
  capsLock.value = event.getModifierState("CapsLock");
}
function focus() {
  (input.value?.$el as HTMLTextAreaElement | undefined)?.focus();
}
// Enter submits the dialog's form, as in a text input; it never types a line break. A held Enter is the form's to stop.
function submitOnEnter(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  if (!event.repeat) (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
}
defineExpose({ focus });
</script>

<template>
  <div class="grid gap-1.5" data-password-field>
    <label :for="id" class="text-sm font-medium">{{ props.label }}</label>
    <p v-if="props.description" :id="descriptionId" class="text-sm text-muted-foreground">
      {{ props.description }}
    </p>
    <div class="flex items-center gap-2">
      <!-- A one-line textarea masked by style, as the composer's: see passwordText.ts. -->
      <Textarea
        :id="id"
        ref="input"
        v-model="model"
        rows="1"
        variant="line"
        :class="['min-w-0', shown ? undefined : '[-webkit-text-security:disc]']"
        v-bind="passwordAttributes"
        :readonly="props.busy"
        :aria-invalid="props.error ? 'true' : undefined"
        :aria-describedby="props.description ? `${descriptionId} ${statusId}` : statusId"
        data-password-input
        @input.capture="keepOneLine"
        @keydown="
          submitOnEnter($event);
          readCapsLock($event);
        "
        @keyup="readCapsLock"
        @blur="capsLock = false"
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        class="size-11 shrink-0"
        :aria-label="shown ? 'Hide password' : 'Show password'"
        :title="shown ? 'Hide password' : 'Show password'"
        :aria-disabled="props.busy ? 'true' : undefined"
        data-password-toggle
        @click="props.busy || (shown = !shown)"
      >
        <EyeOff v-if="shown" />
        <Eye v-else />
      </Button>
    </div>
    <!-- One line stays reserved for the field's error and the Caps Lock warning, so nothing moves when one appears. -->
    <p :id="statusId" role="status" class="min-h-5 text-sm" data-password-status>
      <span v-if="props.error" class="block text-destructive" data-password-error>{{
        props.error
      }}</span>
      <span v-if="capsLock" class="block text-muted-foreground" data-password-caps-lock
        >Caps Lock is on</span
      >
    </p>
  </div>
</template>
