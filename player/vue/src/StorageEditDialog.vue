<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import Dialog from "@/components/ui/dialog/Dialog.vue";
import DialogContent from "@/components/ui/dialog/DialogContent.vue";
import DialogDescription from "@/components/ui/dialog/DialogDescription.vue";
import DialogHeader from "@/components/ui/dialog/DialogHeader.vue";
import DialogTitle from "@/components/ui/dialog/DialogTitle.vue";
import { Input } from "@/components/ui/input";
import Switch from "@/components/ui/switch/Switch.vue";
import { Textarea } from "@/components/ui/textarea";
import {
  validateScriptStorageEntries,
  type SerializableRuntimeValue,
} from "../../../src/index.js";
import { serializeValidatedRuntimeJson } from "../../../src/runtime/checkpoint.js";
import type { PlayerSessionHost, SavedDataEditResult } from "./usePlayerSession";

// Debug's editor for one saved value (DEBUGGER.md "Player Debug"): change it with its type, add a key, or delete one.
// The change is stored first; a running session's next `load` then returns it.
export type StorageEdit =
  | { readonly kind: "edit"; readonly key: string; readonly value: SerializableRuntimeValue }
  | { readonly kind: "add" }
  | { readonly kind: "delete"; readonly key: string; readonly value: SerializableRuntimeValue };

const props = defineProps<{ player: PlayerSessionHost; edit: StorageEdit | null }>();
const emit = defineEmits<{
  close: [];
  saved: [result: { key: string; live: boolean; deleted: boolean }];
}>();

type ValueType = "text" | "number" | "integer" | "boolean" | "advanced";
const typeLabels: Record<ValueType, string> = {
  text: "Text",
  number: "Number",
  integer: "Integer",
  boolean: "Yes/no",
  advanced: "Advanced (stored JSON)",
};
const key = ref("");
const type = ref<ValueType>("text");
const text = ref("");
const flag = ref(false);
const problem = ref<string | null>(null);
const saving = ref(false);

function typeOf(value: SerializableRuntimeValue): ValueType {
  if (typeof value === "string") return "text";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  return "advanced";
}
function textFor(value: SerializableRuntimeValue, as: ValueType): string {
  if (as === "advanced") return serializeValidatedRuntimeJson(value);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
watch(
  () => props.edit,
  (edit) => {
    problem.value = null;
    saving.value = false;
    if (edit === null) return;
    key.value = edit.kind === "add" ? "" : edit.key;
    const value = edit.kind === "add" ? "" : edit.value;
    type.value = typeOf(value);
    shownType = type.value;
    text.value = textFor(value, type.value);
    flag.value = value === true;
  },
  { immediate: true },
);

// A change of type carries the draft over in the new type's form, so nothing typed is lost unseen: text and numbers
// keep their text, the stored JSON form becomes or gives up a plain value where it is one, and Yes/no takes "true".
let shownType: ValueType = type.value;
function convertDraft() {
  const from = shownType;
  const to = type.value;
  shownType = to;
  if (to === "boolean") {
    flag.value = text.value.trim() === "true";
    return;
  }
  if (from === "boolean") {
    text.value = to === "advanced" ? JSON.stringify(flag.value) : String(flag.value);
    return;
  }
  if (to === "advanced" && from !== "advanced") {
    const number = Number(text.value.trim());
    text.value = JSON.stringify(
      from !== "text" && NUMBER.test(text.value.trim()) && Number.isFinite(number)
        ? number
        : text.value,
    );
    return;
  }
  if (from === "advanced" && to !== "advanced") {
    let plain: unknown;
    try {
      plain = JSON.parse(text.value);
    } catch {
      return;
    }
    if (typeof plain === "string" || typeof plain === "number") text.value = String(plain);
  }
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;
/** The value as typed, or why it is not one. */
function parsed(): { value: SerializableRuntimeValue } | { problem: string } {
  switch (type.value) {
    case "text":
      return { value: text.value };
    case "boolean":
      return { value: flag.value };
    case "number":
    case "integer": {
      const literal = text.value.trim();
      const number = Number(literal);
      if (!NUMBER.test(literal) || !Number.isFinite(number))
        return { problem: "Enter a number, such as 3 or 2.5." };
      if (type.value === "integer" && !Number.isInteger(number))
        return { problem: "Enter a whole number." };
      return { value: number };
    }
    case "advanced": {
      let value: unknown;
      try {
        value = JSON.parse(text.value);
      } catch {
        return { problem: "This is not JSON." };
      }
      if (value === null)
        return { problem: "A saved value cannot be null; delete the key instead." };
      const failure = validateScriptStorageEntries([{ key: key.value, value }], "value");
      // EVIDENCE: validation: validateScriptStorageEntries accepted the parsed value.
      return failure === null ? { value: value as SerializableRuntimeValue } : { problem: failure };
    }
  }
}

const live = computed(() => props.player.savedDataEditing.value.live);
const scriptSaving = computed(() => props.player.savedDataEditing.value.scriptSaving);
const title = computed(() =>
  props.edit?.kind === "add"
    ? "Add a saved value"
    : props.edit?.kind === "delete"
      ? `Delete ${JSON.stringify(props.edit.key)}?`
      : `Edit ${JSON.stringify(props.edit?.key ?? "")}`,
);

async function submit() {
  const edit = props.edit;
  if (edit === null || saving.value) return;
  problem.value = null;
  let value: SerializableRuntimeValue;
  let expected: SerializableRuntimeValue | undefined;
  if (edit.kind === "delete") {
    value = null;
    expected = edit.value;
  } else {
    const result = parsed();
    if ("problem" in result) {
      problem.value = result.problem;
      return;
    }
    value = result.value;
    expected = edit.kind === "edit" ? edit.value : undefined;
  }
  saving.value = true;
  let result: SavedDataEditResult;
  try {
    result = await props.player.editSavedData({ key: key.value, value, expected });
  } finally {
    saving.value = false;
  }
  if (result.kind === "saved")
    emit("saved", { key: key.value, live: result.live, deleted: value === null });
  else if (result.kind === "busy") problem.value = "The script is saving… try again in a moment.";
  else if (result.kind === "overtaken")
    problem.value = "The script saved this value meanwhile; its value stands.";
  else if (result.kind === "changed")
    problem.value =
      edit.kind === "add"
        ? "This key exists now. Close this and edit its value instead."
        : "This value changed meanwhile. Close this and open it again to edit the current value.";
  else problem.value = result.message;
}
</script>

<template>
  <Dialog :open="edit !== null" @update:open="(open) => !open && !saving && emit('close')">
    <!-- Within the viewport, scrolling, so the fields and Save stay reachable on a short screen. -->
    <DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto" data-storage-editor>
      <DialogHeader>
        <DialogTitle class="break-all">{{ title }}</DialogTitle>
        <DialogDescription>
          <template v-if="live">
            Stored in this browser first; the running session's next load then returns it. Values the script already
            loaded do not change.
          </template>
          <template v-else>Stored in this browser; the next Start loads it.</template>
        </DialogDescription>
      </DialogHeader>
      <form class="grid gap-4 text-sm" novalidate @submit.prevent="submit">
        <template v-if="edit?.kind === 'delete'">
          <p>The script's next load of this key gets its default. Saved photos stay until no saved value uses them.</p>
        </template>
        <template v-else>
          <label v-if="edit?.kind === 'add'" class="grid gap-2">
            Key
            <Input v-model="key" autocomplete="off" spellcheck="false" data-storage-editor-key />
          </label>
          <label class="grid gap-2">
            Type
            <select
              v-model="type"
              class="min-h-11 rounded-md border bg-background p-2"
              data-storage-editor-type
              @change="convertDraft"
            >
              <option v-for="(label, name) in typeLabels" :key="name" :value="name">{{ label }}</option>
            </select>
          </label>
          <label v-if="type === 'boolean'" class="flex min-h-11 items-center justify-between gap-4">
            Value
            <Switch v-model="flag" data-storage-editor-flag />
          </label>
          <label v-else-if="type === 'number' || type === 'integer'" class="grid gap-2">
            Value
            <Input
              v-model="text"
              :inputmode="type === 'integer' ? 'numeric' : 'decimal'"
              autocomplete="off"
              data-storage-editor-value
            />
          </label>
          <label v-else class="grid gap-2">
            Value
            <Textarea v-model="text" spellcheck="false" data-storage-editor-value />
            <span v-if="type === 'advanced'" class="text-muted-foreground">
              The stored form: a list is <code>{"kind":"list","items":[1,"two"]}</code>, an object
              <code>{"kind":"object","properties":[{"name":"level","value":2}]}</code>.
            </span>
          </label>
          <p class="text-muted-foreground">The script checks the type when it loads the value.</p>
        </template>
        <p v-if="scriptSaving" class="text-muted-foreground" role="status" data-storage-editor-busy>
          The script is saving… try again in a moment.
        </p>
        <Alert v-if="problem" variant="destructive" data-storage-editor-problem>
          <AlertDescription>{{ problem }}</AlertDescription>
        </Alert>
        <div class="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" class="min-h-11" :disabled="saving" @click="emit('close')">
            Cancel
          </Button>
          <Button
            type="submit"
            :variant="edit?.kind === 'delete' ? 'destructive' : 'default'"
            class="min-h-11"
            :disabled="saving || scriptSaving"
            data-storage-editor-save
          >
            {{ saving ? "Saving…" : edit?.kind === "delete" ? "Delete" : "Save" }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>
