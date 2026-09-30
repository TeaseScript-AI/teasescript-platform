<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type CSSProperties,
} from "vue";
import type {
  PlayerRightControlPresentation,
  PlayerTimerKind,
  PlayerTimerPresentation,
} from "../../../model.js";
import { orderRightControls, readableControlText } from "../../../presentation.js";
import { allocateRightRailPaneHeights } from "../../../right-rail-layout.js";
import type {
  BusyControlTarget,
  BusyStyle,
  ScriptUpdateFeedback,
} from "../devtools/playerDevelopment.js";
import PlayerTimer from "./PlayerTimer.vue";

const props = defineProps<{
  compactTimers: boolean;
  busyStyle: BusyStyle;
  busyTarget: BusyControlTarget;
  controls: readonly PlayerRightControlPresentation[];
  controlsDisabled: boolean;
  scriptUpdateControlId: string | null;
  scriptUpdateFeedback: ScriptUpdateFeedback | null;
  timer: PlayerTimerPresentation;
  timerCount: number;
  timerKind: PlayerTimerKind;
}>();

defineEmits<{
  action: [controlId: string];
  select: [controlId: string, value: string];
  toggle: [controlId: string, checked: boolean];
}>();

const rightZone = ref<HTMLElement | null>(null);
const actionPane = ref<HTMLElement | null>(null);
const timerPaneSize = ref(0);
const orderedControls = computed(() => orderRightControls(props.controls));
let observer: ResizeObserver | null = null;

watch(
  () => [props.compactTimers, props.controls, props.timerCount, props.timerKind] as const,
  async () => {
    await nextTick();
    observePaneElements();
    syncPaneAllocation();
  },
  { deep: true },
);

onMounted(() => {
  observer = new ResizeObserver(syncPaneAllocation);
  observePaneElements();
  syncPaneAllocation();
});
onBeforeUnmount(() => observer?.disconnect());

function observePaneElements(): void {
  observer?.disconnect();
  if (rightZone.value !== null) observer?.observe(rightZone.value);
  const timer = rightZone.value?.querySelector<HTMLElement>(":scope > .timer-wrap") ?? null;
  if (timer !== null) observer?.observe(timer);
  const timerList = timer?.querySelector<HTMLElement>(".timer-list") ?? null;
  if (timerList !== null) observer?.observe(timerList);
  if (actionPane.value !== null) observer?.observe(actionPane.value);
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

function syncPaneAllocation(): void {
  const zone = rightZone.value;
  if (zone === null || props.compactTimers) {
    timerPaneSize.value = 0;
    return;
  }
  const timer = zone.querySelector<HTMLElement>(":scope > .timer-wrap");
  const actions = actionPane.value;
  const timerList = timer?.querySelector<HTMLElement>(".timer-list") ?? null;
  const timerRequired =
    timer === null || timerList === null
      ? 0
      : naturalStackBlockSize(timerList) + verticalPadding(timer);
  const actionsRequired = actions === null ? 0 : naturalStackBlockSize(actions);
  timerPaneSize.value = allocateRightRailPaneHeights(
    zone.clientHeight,
    timerRequired,
    actionsRequired,
  ).timers;
}

function naturalStackBlockSize(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const children = [...element.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.getClientRects().length > 0,
  );
  const childrenHeight = children.reduce(
    (total, child) => total + child.getBoundingClientRect().height,
    0,
  );
  const gap = children.length > 1 ? finitePixel(style.rowGap) * (children.length - 1) : 0;
  return childrenHeight + gap + verticalPadding(element);
}

function verticalPadding(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return finitePixel(style.paddingTop) + finitePixel(style.paddingBottom);
}

function finitePixel(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function busy(kind: BusyControlTarget): boolean {
  return props.busyStyle !== "off" && props.busyTarget === kind;
}

function scriptUpdateMarker(controlId: string): "highlight" | undefined {
  return controlId === props.scriptUpdateControlId &&
    (props.scriptUpdateFeedback === "highlight" || props.scriptUpdateFeedback === "toast-highlight")
    ? "highlight"
    : undefined;
}
</script>

<template>
  <aside
    id="rightZone"
    ref="rightZone"
    class="right-zone"
    aria-label="Timer and background controls"
    :style="{ '--timer-pane-size': `${timerPaneSize}px` }"
  >
    <PlayerTimer
      v-if="!compactTimers"
      :timer="timer"
      :timer-count="timerCount"
      :timer-kind="timerKind"
    />

    <div
      ref="actionPane"
      class="action-scroll"
      role="group"
      aria-label="Background controls and status"
    >
      <template v-for="control in orderedControls" :key="control.id">
        <button
          v-if="control.kind === 'action'"
          class="action-button right-control"
          type="button"
          :data-action-id="control.id"
          :data-authored-fill="control.authoredFill === undefined ? undefined : ''"
          :data-busy-style="busy('action') ? busyStyle : undefined"
          :data-script-update-feedback="scriptUpdateMarker(control.id)"
          :aria-busy="busy('action') || undefined"
          :disabled="controlsDisabled"
          :style="authoredStyle(control.authoredFill)"
          @click="$emit('action', control.id)"
        >
          {{ control.label }}
        </button>

        <label
          v-else-if="control.kind === 'toggle'"
          class="right-control right-toggle-control"
          :data-control-id="control.id"
          :data-busy-style="busy('toggle') ? busyStyle : undefined"
          :data-script-update-feedback="scriptUpdateMarker(control.id)"
          :aria-busy="busy('toggle') || undefined"
        >
          <span class="right-control-label">{{ control.label }}</span>
          <input
            type="checkbox"
            role="switch"
            :aria-label="control.label"
            :checked="control.value"
            :disabled="controlsDisabled"
            @change="$emit('toggle', control.id, ($event.target as HTMLInputElement).checked)"
          />
          <span class="right-switch-ui" aria-hidden="true"></span>
        </label>

        <label
          v-else-if="control.kind === 'select'"
          class="right-control right-select-control"
          :data-control-id="control.id"
          :data-busy-style="busy('select') ? busyStyle : undefined"
          :data-script-update-feedback="scriptUpdateMarker(control.id)"
          :aria-busy="busy('select') || undefined"
        >
          <span class="right-control-label">{{ control.label }}</span>
          <select
            :aria-label="control.label"
            :value="control.value"
            :disabled="controlsDisabled"
            @change="$emit('select', control.id, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="option in control.options" :key="option[0]" :value="option[0]">
              {{ option[1] }}
            </option>
          </select>
        </label>

        <div v-else class="right-control right-status" :data-control-id="control.id" role="status">
          <span class="right-control-label">{{ control.label }}</span>
          <span class="right-status-detail">{{ control.detail }}</span>
          <progress
            v-if="control.progress !== undefined"
            class="right-status-progress"
            max="1"
            :value="Math.max(0, Math.min(1, control.progress))"
            :aria-label="`${control.label} progress`"
          ></progress>
        </div>
      </template>
    </div>
  </aside>
</template>
