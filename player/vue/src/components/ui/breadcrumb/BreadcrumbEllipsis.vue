<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { Ellipsis } from "@lucide/vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <span
    data-slot="breadcrumb-ellipsis"
    role="presentation"
    aria-hidden="true"
    :class="cn('flex size-9 items-center justify-center', props.class)"
  >
    <slot>
      <Ellipsis class="size-4" />
    </slot>
    <span class="sr-only">More</span>
  </span>
</template>
