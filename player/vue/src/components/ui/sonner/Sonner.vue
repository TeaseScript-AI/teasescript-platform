<script lang="ts" setup>
import type { ToasterProps } from "vue-sonner";
import { CircleAlert, CircleCheck, Info, Loader2, TriangleAlert, X } from "@lucide/vue";
import { Toaster as Sonner } from "vue-sonner";
import "vue-sonner/style.css";
import { definedProps } from "@/lib/definedProps";
import { cn } from "@/lib/utils";

// shadcn-vue's Sonner wrapper (new-york-v4), with this repository's theme tokens and the Player's level icons; the
// registry's unstyled `toaster` marker class is left out.
const props = defineProps<ToasterProps>();
</script>

<template>
  <Sonner
    :class="cn('group', props.class)"
    :style="{
      '--normal-bg': 'var(--color-popover)',
      '--normal-text': 'var(--color-popover-foreground)',
      '--normal-border': 'var(--color-border)',
      '--border-radius': 'var(--radius-lg)',
    }"
    v-bind="definedProps(props)"
  >
    <template #success-icon>
      <CircleCheck class="size-4" />
    </template>
    <template #info-icon>
      <Info class="size-4" />
    </template>
    <template #warning-icon>
      <TriangleAlert class="size-4" />
    </template>
    <template #error-icon>
      <CircleAlert class="size-4" />
    </template>
    <template #loading-icon>
      <div>
        <Loader2 class="size-4 animate-spin" />
      </div>
    </template>
    <template #close-icon>
      <X class="size-4" />
    </template>
  </Sonner>
</template>
