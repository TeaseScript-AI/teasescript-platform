<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId } from "vue";
import type {
  VisualLabActionTarget,
  VisualLabControl,
  VisualLabControlValue,
  VisualLabRegistry,
  VisualLabState,
  VisualLabValueControl,
} from "../devtools/visual-lab.js";

const props = defineProps<{ registry: VisualLabRegistry; state: VisualLabState }>();

const emit = defineEmits<{
  action: [controlId: string, target: VisualLabActionTarget];
  change: [controlId: string, value: VisualLabControlValue];
}>();

const openDescriptionId = ref<string | null>(null);
const instanceId = `visual-lab-${useId()}`;
function descriptionId(control: VisualLabControl): string {
  return `${instanceId}-description-${control.id}`;
}
function handleDocumentClick(event: MouseEvent): void {
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest(`[data-visual-lab-instance="${instanceId}"]`) !== null
  )
    return;
  openDescriptionId.value = null;
}
function handleDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") openDescriptionId.value = null;
}
onMounted(() => {
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleDocumentKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", handleDocumentClick);
  document.removeEventListener("keydown", handleDocumentKeydown);
});

function controlValue(control: VisualLabValueControl): VisualLabControlValue {
  const value = props.state.values[control.id];
  if (value === undefined) throw new Error(`Visual Lab state is missing control: ${control.id}`);
  return value;
}

function numberValue(control: VisualLabValueControl): number {
  const value = controlValue(control);
  if (typeof value !== "number")
    throw new Error(`Visual Lab control is not numeric: ${control.id}`);
  return value;
}

function stringValue(control: VisualLabValueControl): string {
  const value = controlValue(control);
  if (typeof value !== "string")
    throw new Error(`Visual Lab control is not textual: ${control.id}`);
  return value;
}

function booleanValue(control: VisualLabValueControl): boolean {
  const value = controlValue(control);
  if (typeof value !== "boolean")
    throw new Error(`Visual Lab control is not boolean: ${control.id}`);
  return value;
}

function emitNumber(control: VisualLabValueControl, event: Event): void {
  // EVIDENCE: this handler is attached only to native input elements rendered below.
  const input = event.target as HTMLInputElement;
  if (Number.isFinite(input.valueAsNumber)) emit("change", control.id, input.valueAsNumber);
}

function toggleDescription(control: VisualLabControl): void {
  openDescriptionId.value = openDescriptionId.value === control.id ? null : control.id;
}

function handleCopyClick(control: VisualLabControl, event: MouseEvent): void {
  if (event.target instanceof Element && event.target.closest(".lab-option-info-trigger") !== null)
    return;
  toggleDescription(control);
}
</script>

<template>
  <form
    :data-visual-lab-instance="instanceId"
    class="lab-content"
    autocomplete="off"
    @submit.prevent
  >
    <div class="lab-options">
      <div
        v-for="control in registry.filter((candidate) => candidate.kind !== 'tuning')"
        :key="control.id"
        class="lab-option"
      >
        <span class="lab-option-copy" @click="handleCopyClick(control, $event)">
          <span class="lab-option-title">{{ control.label }}</span>
          <span class="lab-option-info" :data-open="openDescriptionId === control.id || undefined">
            <button
              type="button"
              class="lab-option-info-trigger"
              :aria-label="`About ${control.label}`"
              :aria-expanded="openDescriptionId === control.id"
              :aria-describedby="descriptionId(control)"
              @click="toggleDescription(control)"
            >
              i
            </button>
            <span :id="descriptionId(control)" class="lab-option-note" role="tooltip">
              {{ control.description }}
            </span>
          </span>
        </span>

        <label v-if="control.kind === 'toggle'" class="switch">
          <input
            type="checkbox"
            :aria-label="control.label"
            :checked="booleanValue(control)"
            @change="emit('change', control.id, ($event.target as HTMLInputElement).checked)"
          />
          <span class="switch-ui" aria-hidden="true"></span>
        </label>

        <select
          v-else-if="control.kind === 'select'"
          class="lab-select"
          :aria-label="control.label"
          :value="stringValue(control)"
          @change="emit('change', control.id, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="option in control.options" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>

        <input
          v-else-if="control.kind === 'numeric'"
          class="lab-tuning-input"
          type="number"
          :aria-label="control.label"
          :min="control.min"
          :max="control.max"
          :step="control.step"
          :value="numberValue(control)"
          @change="emitNumber(control, $event)"
        />

        <span v-else-if="control.kind === 'range'" class="lab-tuning-field">
          <input
            type="range"
            :aria-label="control.label"
            :min="control.min"
            :max="control.max"
            :step="control.step"
            :value="numberValue(control)"
            @input="emitNumber(control, $event)"
          />
          <output :aria-label="`${control.label} value`">{{ numberValue(control) }}</output>
        </span>

        <button
          v-else
          class="lab-reset"
          type="button"
          @click="emit('action', control.id, control.target)"
        >
          {{ control.label }}
        </button>
      </div>
    </div>

    <div class="lab-tuning">
      <div
        v-for="control in registry.filter((candidate) => candidate.kind === 'tuning')"
        :key="control.id"
        class="lab-tuning-row"
      >
        <span class="lab-option-copy" @click="handleCopyClick(control, $event)">
          <span class="lab-option-title">{{ control.label }}</span>
          <span class="lab-option-info" :data-open="openDescriptionId === control.id || undefined">
            <button
              type="button"
              class="lab-option-info-trigger"
              :aria-label="`About ${control.label}`"
              :aria-expanded="openDescriptionId === control.id"
              :aria-describedby="descriptionId(control)"
              @click="toggleDescription(control)"
            >
              i
            </button>
            <span :id="descriptionId(control)" class="lab-option-note" role="tooltip">
              {{ control.description }}
            </span>
          </span>
        </span>
        <span class="lab-tuning-field">
          <input
            class="lab-tuning-input"
            type="number"
            :aria-label="
              control.unit.length === 0 ? control.label : `${control.label} (${control.unit})`
            "
            :min="control.min"
            :max="control.max"
            :step="control.step"
            :value="numberValue(control)"
            @change="emitNumber(control, $event)"
          />
          <span v-if="control.unit.length > 0" class="lab-tuning-unit">{{ control.unit }}</span>
        </span>
      </div>
    </div>
  </form>
</template>
