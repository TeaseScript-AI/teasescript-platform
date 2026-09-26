<script setup lang="ts">
import type { DropdownMenuSubEmits, DropdownMenuSubProps } from "reka-ui"
import { DropdownMenuSub } from "reka-ui"
import { useVModel } from "@vueuse/core"
import { provide, ref } from "vue"
import { submenuTriggerHoveredKey } from "./submenuInteraction"

const props = withDefaults(defineProps<Omit<DropdownMenuSubProps, "open"> & { open?: boolean | undefined }>(), { open: undefined })
const emits = defineEmits<DropdownMenuSubEmits>()

const open = props.open === undefined
  ? useVModel(props, "open", emits, { passive: true, defaultValue: props.defaultOpen ?? false })
  : useVModel(props, "open", emits, { passive: false, defaultValue: props.defaultOpen ?? false })
const triggerHovered = ref(false)
provide(submenuTriggerHoveredKey, triggerHovered)

function updateOpen(value: boolean) {
  // Reka can close when re-highlighting its own trigger; keep pointer return open to avoid flicker.
  if (!value && triggerHovered.value) return
  open.value = value
}
</script>

<template>
  <DropdownMenuSub v-slot="slotProps" data-slot="dropdown-menu-sub" :open="open ?? false" @update:open="updateOpen">
    <slot v-bind="slotProps" />
  </DropdownMenuSub>
</template>
