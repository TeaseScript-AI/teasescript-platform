<script setup lang="ts">
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
import { nextTick, ref, watch } from "vue";

const props = defineProps<{ target: HTMLElement; visible: boolean }>();
const body = ref<HTMLElement | null>(null);
let scrollTop = 0;
function rememberScroll() {
  // Hiding/reparenting can emit a zero scroll event. Only record visible scrolling.
  if (props.visible && body.value?.clientHeight) scrollTop = body.value.scrollTop;
}
watch(() => [props.target, props.visible], async () => {
  await nextTick();
  if (props.visible && body.value) body.value.scrollTop = scrollTop;
}, { flush: "post" });
</script>

<template>
  <Teleport :to="target">
    <ScrollArea class="flex-1" viewport-class="overscroll-y-contain [overflow-wrap:anywhere]"
      :viewport-attrs="{ 'data-tool-body': '', onScroll: rememberScroll }" @viewport="body = $event">
      <slot />
    </ScrollArea>
  </Teleport>
</template>
