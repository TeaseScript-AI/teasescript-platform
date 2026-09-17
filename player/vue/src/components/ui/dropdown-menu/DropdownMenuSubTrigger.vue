<script setup lang="ts">
import { definedProps } from "@/lib/definedProps";
import type { DropdownMenuSubTriggerProps } from "reka-ui"
import { inject, ref, type HTMLAttributes } from "vue"
import { submenuTriggerHoveredKey } from "./submenuInteraction"
import { ChevronRight } from "@lucide/vue"
import { reactiveOmit } from "@vueuse/core"
import {
  DropdownMenuSubTrigger,
  useForwardProps,
} from "reka-ui"
import { cn } from "@/lib/utils"

const triggerHovered = inject(submenuTriggerHoveredKey, ref(false))

const props = defineProps<DropdownMenuSubTriggerProps & { class?: HTMLAttributes["class"], inset?: boolean }>()

const delegatedProps = reactiveOmit(props, "class", "inset")
const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <DropdownMenuSubTrigger
    @keydown.capture="triggerHovered = false"
    @pointerenter="(event: PointerEvent) => { triggerHovered = event.pointerType === 'mouse' }"
    @pointerleave="triggerHovered = false"
    data-slot="dropdown-menu-sub-trigger"
    v-bind="definedProps(forwardedProps)"
    :data-inset="inset ? '' : undefined"
    :class="cn(
      `relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:*:[svg]:text-destructive!`,
      props.class,
    )"
  >
    <slot />
    <ChevronRight class="ml-auto size-4" />
  </DropdownMenuSubTrigger>
</template>
