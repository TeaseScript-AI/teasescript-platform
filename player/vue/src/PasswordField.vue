<script setup lang="ts">
import { ref, useId } from "vue";
import { Eye, EyeOff } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// A password field (V30 §13 and §20): masked, with an eye button that shows the text while the person typing chooses
// to, and a warning while Caps Lock is on. What it holds never leaves the Player's memory as typed.
const props = defineProps<{
  label: string;
  /** `new-password` where a password is chosen, `current-password` where one is given. */
  autocomplete: "new-password" | "current-password";
  disabled?: boolean;
  invalid?: boolean;
}>();
const model = defineModel<string>({ required: true });

const id = useId();
const shown = ref(false);
const capsLock = ref(false);
const input = ref<InstanceType<typeof Input> | null>(null);

// Only a key event says whether Caps Lock is on; a field that has seen none shows no warning.
function readCapsLock(event: KeyboardEvent) {
  capsLock.value = event.getModifierState("CapsLock");
}
function focus() {
  (input.value?.$el as HTMLInputElement | undefined)?.focus();
}
defineExpose({ focus });
</script>

<template>
  <div class="grid gap-1.5" data-password-field>
    <label :for="id" class="text-sm font-medium">{{ props.label }}</label>
    <div class="flex items-center gap-2">
      <Input
        :id="id"
        ref="input"
        v-model="model"
        :type="shown ? 'text' : 'password'"
        :autocomplete="props.autocomplete"
        :disabled="props.disabled"
        :aria-invalid="props.invalid ? 'true' : undefined"
        autocapitalize="off"
        spellcheck="false"
        data-password-input
        @keydown="readCapsLock"
        @keyup="readCapsLock"
        @blur="capsLock = false"
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        class="size-11 shrink-0"
        :aria-label="shown ? 'Hide password' : 'Show password'"
        :aria-pressed="shown"
        :disabled="props.disabled"
        data-password-toggle
        @click="shown = !shown"
      >
        <EyeOff v-if="shown" />
        <Eye v-else />
      </Button>
    </div>
    <p role="status" class="min-h-5 text-sm text-muted-foreground" data-password-caps-lock>
      {{ capsLock ? "Caps Lock is on" : "" }}
    </p>
  </div>
</template>
