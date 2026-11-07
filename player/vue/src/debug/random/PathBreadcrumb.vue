<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useResizeObserver } from "@vueuse/core";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

// A package path as a breadcrumb, not clickable, from `root`, the package's name, when there is one: in full while it
// fits on one line; otherwise the parts after the first collapse into an ellipsis, from the second on, until it fits,
// and when even that does not fit, the first part ends in "…". Hovering the ellipsis names the hidden parts, which a
// screen reader hears. With `wrap`, it wraps onto more lines instead.
const props = defineProps<{ path: string; root?: string | null; wrap?: boolean }>();

const parts = computed(() => [...(props.root ? [props.root] : []), ...props.path.split("/")]);
const hidden = ref(0);
const cut = ref(false);
const shown = computed(() => {
  const all = parts.value;
  const count = Math.min(hidden.value, Math.max(0, all.length - 2));
  return count === 0
    ? { first: all.slice(0, -1), hidden: [], rest: [], file: all.at(-1)! }
    : {
        first: all.slice(0, 1),
        hidden: all.slice(1, 1 + count),
        rest: all.slice(1 + count, -1),
        file: all.at(-1)!,
      };
});
const breadcrumb = ref<InstanceType<typeof Breadcrumb> | null>(null);
let fitting = 0;
async function fit() {
  const run = ++fitting;
  hidden.value = 0;
  cut.value = false;
  if (props.wrap) return;
  await nextTick();
  const list = (breadcrumb.value?.$el as HTMLElement | undefined)?.querySelector("ol");
  const overflows = () => list !== null && list !== undefined && list.scrollWidth > list.clientWidth;
  while (run === fitting && overflows() && hidden.value < parts.value.length - 2) {
    hidden.value += 1;
    await nextTick();
  }
  if (run === fitting && overflows()) cut.value = true;
}
useResizeObserver(
  () => breadcrumb.value?.$el as HTMLElement | undefined,
  () => void fit(),
);
watch(parts, () => void fit());
</script>

<template>
  <Breadcrumb ref="breadcrumb" class="min-w-0">
    <BreadcrumbList :class="wrap ? 'flex-wrap' : 'flex-nowrap overflow-hidden'">
      <template v-for="(part, index) in shown.first" :key="`first-${index}`">
        <BreadcrumbItem :class="cut && index === 0 ? 'min-w-0' : 'shrink-0'">
          <span :class="{ 'min-w-0 truncate': cut && index === 0 }">{{ part }}</span>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
      </template>
      <template v-if="shown.hidden.length">
        <BreadcrumbItem class="shrink-0" :title="shown.hidden.join(' / ')">
          <BreadcrumbEllipsis class="size-5" />
          <span class="sr-only">{{ shown.hidden.join(" / ") }}</span>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
      </template>
      <template v-for="(part, index) in shown.rest" :key="`rest-${index}`">
        <BreadcrumbItem class="shrink-0">{{ part }}</BreadcrumbItem>
        <BreadcrumbSeparator />
      </template>
      <BreadcrumbItem class="shrink-0">
        <BreadcrumbPage>{{ shown.file }}</BreadcrumbPage>
      </BreadcrumbItem>
    </BreadcrumbList>
  </Breadcrumb>
</template>
