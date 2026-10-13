<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { useVModel } from "@vueuse/core";
import { cn } from "@/lib/utils";

const props = defineProps<{
  class?: HTMLAttributes["class"];
  /** `code` is the default field in a monospace font, for text such as data to copy. */
  variant?: "default" | "embedded" | "code";
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
  <textarea
    v-model="modelValue"
    :class="
      cn(
        'flex w-full bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        props.variant === 'embedded'
          ? 'min-h-0 rounded-none border-0 shadow-none focus-visible:ring-0'
          : 'min-h-[60px] rounded-md border border-input shadow-sm focus-visible:ring-1 focus-visible:ring-ring',
        props.variant === 'code' && 'font-mono',
        props.class,
      )
    "
  />
</template>
