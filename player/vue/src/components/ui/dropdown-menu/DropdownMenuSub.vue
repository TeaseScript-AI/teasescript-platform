<script setup lang="ts">
import type { DropdownMenuSubEmits, DropdownMenuSubProps } from "reka-ui"
import { DropdownMenuSub } from "reka-ui"
import { useVModel } from "@vueuse/core"
import { provide, ref } from "vue"
import { submenuTriggerHoveredKey } from "./submenuInteraction"

const props = withDefaults(defineProps<DropdownMenuSubProps>(), { open: undefined })
const emits = defineEmits<DropdownMenuSubEmits>()

const open = useVModel(props, "open", emits, {
  passive: props.open === undefined,
  defaultValue: props.defaultOpen ?? false,
})
const triggerHovered = ref(false)
provide(submenuTriggerHoveredKey, triggerHovered)

function updateOpen(value: boolean) {
  // Reka can close when re-highlighting its own trigger; keep pointer return open to avoid flicker.
  if (!value && triggerHovered.value) return
  open.value = value
}
</script>

<template>
  <DropdownMenuSub v-slot="slotProps" data-slot="dropdown-menu-sub" :open="open" @update:open="updateOpen">
    <slot v-bind="slotProps" />
  </DropdownMenuSub>
</template>
