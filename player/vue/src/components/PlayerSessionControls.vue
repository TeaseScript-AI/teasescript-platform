<script setup lang="ts">
import { computed, type CSSProperties } from "vue";
import type { PlayerRightControlPresentation } from "../../../model.js";
import { orderRightControls, readableControlText } from "../../../presentation.js";
import type {
  BusyControlTarget,
  BusyStyle,
  ScriptUpdateFeedback,
} from "../devtools/playerDevelopment.js";

const props = defineProps<{
  busyStyle: BusyStyle;
  busyTarget: BusyControlTarget;
  controls: readonly PlayerRightControlPresentation[];
  controlsDisabled: boolean;
  scriptUpdateControlId: string | null;
  scriptUpdateFeedback: ScriptUpdateFeedback | null;
}>();

defineEmits<{
  action: [controlId: string];
  select: [controlId: string, value: string];
  toggle: [controlId: string, checked: boolean];
}>();

const orderedControls = computed(() => orderRightControls(props.controls));

function authoredStyle(fill: string | undefined): CSSProperties | undefined {
  if (fill === undefined) return undefined;
  return {
    "--authored-control-fill": fill,
    "--authored-control-hover": `color-mix(in oklab, ${fill} 88%, black)`,
    "--authored-control-pressed": `color-mix(in oklab, ${fill} 76%, black)`,
    "--authored-control-text": readableControlText(fill),
  } as CSSProperties;
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
  <div class="action-scroll" role="group" aria-label="Background controls and status">
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
</template>
