<script setup lang="ts">
import { definedProps } from "@/lib/definedProps";
import type { DropdownMenuSubContentEmits, DropdownMenuSubContentProps } from "reka-ui"
import { inject, ref, type HTMLAttributes } from "vue"
import { submenuTriggerHoveredKey } from "./submenuInteraction"
import { reactiveOmit } from "@vueuse/core"
import {
  DropdownMenuSubContent,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"

const triggerHovered = inject(submenuTriggerHoveredKey, ref(false))

const props = defineProps<DropdownMenuSubContentProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<DropdownMenuSubContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <DropdownMenuSubContent
    @keydown.capture="triggerHovered = false"
    data-slot="dropdown-menu-sub-content"
    v-bind="definedProps(forwarded)"
    :class="cn('bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] max-w-(--reka-dropdown-menu-content-available-width) origin-(--reka-dropdown-menu-content-transform-origin) overflow-hidden rounded-md border p-1 shadow-lg', props.class)"
  >
    <slot />
  </DropdownMenuSubContent>
</template>
