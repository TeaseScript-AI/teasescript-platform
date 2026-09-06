<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from "vue";
import type {
  PlayerForegroundOptionPresentation,
  PlayerForegroundPresentation,
} from "../../../model.js";
import { readableControlText } from "../../../presentation.js";

const props = defineProps<{
  foreground: PlayerForegroundPresentation | null;
}>();

defineEmits<{
  activate: [label: string];
}>();

const choiceScroller = ref<HTMLElement | null>(null);
const overflow = ref(false);
let observer: ResizeObserver | null = null;

watch(() => props.foreground, async () => {
  await nextTick();
  observeScroller();
}, { deep: true });

onMounted(observeScroller);
onBeforeUnmount(() => observer?.disconnect());

function observeScroller(): void {
  observer?.disconnect();
  const element = choiceScroller.value;
  if (element === null) {
    overflow.value = false;
    return;
  }
  const sync = (): void => {
    overflow.value = element.scrollWidth > element.clientWidth + 1;
  };
  observer = new ResizeObserver(sync);
  observer.observe(element);
  for (const child of element.children) observer.observe(child);
  sync();
}

function authoredStyle(fill: string | undefined): CSSProperties | undefined {
  if (fill === undefined) return undefined;
  return {
    "--authored-control-fill": fill,
    "--authored-control-hover": `color-mix(in oklab, ${fill} 88%, black)`,
    "--authored-control-pressed": `color-mix(in oklab, ${fill} 76%, black)`,
    "--authored-control-text": readableControlText(fill),
  } as CSSProperties;
}

function optionStyle(option: PlayerForegroundOptionPresentation): CSSProperties | undefined {
  return authoredStyle(option.authoredFill);
}
</script>

<template>
  <section
    v-if="foreground !== null && (foreground.kind === 'show-button' || foreground.kind === 'choose')"
    class="foreground-controls"
    aria-label="Foreground interaction"
    :data-foreground-kind="foreground.kind"
  >
    <div class="foreground-shell">
      <button
        v-if="foreground.kind === 'show-button'"
        class="foreground-button"
        type="button"
        data-foreground-button
        :data-authored-fill="foreground.authoredFill === undefined ? undefined : ''"
        :aria-label="foreground.accessibleName"
        :style="authoredStyle(foreground.authoredFill)"
        @click="$emit('activate', foreground.label)"
      >
        {{ foreground.label }}
      </button>

      <div
        v-else
        ref="choiceScroller"
        class="foreground-choice-buttons"
        role="group"
        :aria-label="foreground.accessibleName"
        :data-overflow="String(overflow)"
      >
        <span
          v-for="option in foreground.options"
          :key="option.id"
          class="foreground-choice-item"
        >
          <button
            class="foreground-button"
            type="button"
            :data-authored-fill="option.authoredFill === undefined ? undefined : ''"
            :style="optionStyle(option)"
            @click="$emit('activate', option.label)"
          >
            {{ option.label }}
          </button>
        </span>
      </div>
    </div>
  </section>
</template>
