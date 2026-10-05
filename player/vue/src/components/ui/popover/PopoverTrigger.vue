<script setup lang="ts">
import { definedProps } from "@/lib/definedProps";
import type { PopoverTriggerProps } from "reka-ui"
import { PopoverTrigger, useForwardProps } from "reka-ui"

const props = defineProps<PopoverTriggerProps>()

const forwardedProps = useForwardProps(props)
</script>

<template>
  <PopoverTrigger
    data-slot="popover-trigger"
    v-bind="definedProps(forwardedProps)"
  >
    <slot />
  </PopoverTrigger>
</template>
