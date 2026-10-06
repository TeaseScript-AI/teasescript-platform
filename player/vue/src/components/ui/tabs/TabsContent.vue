<script setup lang="ts">
import { definedProps } from "@/lib/definedProps";
import type { TabsContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { TabsContent } from "reka-ui"
import { cn } from "@/lib/utils"

const props = defineProps<TabsContentProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <TabsContent
    data-slot="tabs-content"
    :class="cn('flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring', props.class)"
    v-bind="definedProps(delegatedProps)"
  >
    <slot />
  </TabsContent>
</template>
