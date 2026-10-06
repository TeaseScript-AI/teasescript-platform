<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { useVModel } from "@vueuse/core";
import { cn } from "@/lib/utils";

const props = defineProps<{
  class?: HTMLAttributes["class"];
  defaultValue?: string | number;
  modelValue?: string | number;
}>();

const emits = defineEmits<{ (e: "update:modelValue", payload: string | number): void }>();

const modelValue = useVModel(props, "modelValue", emits, {
  passive: true,
  ...(props.defaultValue === undefined ? {} : { defaultValue: props.defaultValue }),
});
</script>

<template>
  <input
    v-model="modelValue"
    data-slot="input"
    :class="
      cn(
        'flex min-h-11 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
        props.class,
      )
    "
  />
</template>
