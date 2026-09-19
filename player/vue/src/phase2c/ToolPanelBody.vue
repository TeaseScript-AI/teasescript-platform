<script setup lang="ts">
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
    <div ref="body" data-tool-body class="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain [overflow-wrap:anywhere]" @scroll="rememberScroll">
      <slot />
    </div>
  </Teleport>
</template>
