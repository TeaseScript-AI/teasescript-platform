<script setup lang="ts">
import { computed, watch } from "vue";
import { useLabClock, type LabTimerView } from "./clock.js";
import type { TimerKind } from "./candidate.js";
import { CANDIDATES, GROUP_LABELS, type Candidate, type CandidateGroup } from "./catalogue.js";
import { remaining, scrubTo, totals } from "./session.js";
import TimerStack from "./TimerStack.vue";
import TimerCompact from "./TimerCompact.vue";

/**
 * Everything that changes per animation frame lives here, so the toolbar above
 * is not re-rendered sixty times a second. Patching the toolbar under an open
 * native dropdown made the highlighted option flicker under the pointer.
 */
export interface StageSettings {
  kind: TimerKind;
  count: number;
  size: number;
  urgency: boolean;
  labels: "authored" | "generic" | "none";
  running: boolean;
  speed: number;
  group: CandidateGroup | "all";
  /** Single candidate id, from `?only=`; isolates one column for review. */
  only: string | null;
  /** Fixed elapsed percentage from `?progress=`, or null to run freely. */
  progress: number | null;
}

const props = defineProps<{ settings: StageSettings }>();

const shown = computed<Candidate[]>(() => {
  if (props.settings.only) return CANDIDATES.filter((item) => item.id === props.settings.only);
  if (props.settings.group === "all") return CANDIDATES;
  return CANDIDATES.filter(
    (item) => item.group === props.settings.group || item.group === "baseline",
  );
});

/**
 * Sections keep the page scrolling the ordinary way. The baseline is repeated
 * at the head of every section so there is always one next to what you compare.
 */
const sections = computed(() => {
  const baseline = CANDIDATES.filter((item) => item.group === "baseline");
  const groups: CandidateGroup[] = ["refined", "radical", "elemental"];
  return groups
    .map((group) => ({
      group,
      label: GROUP_LABELS[group],
      items: [
        ...(props.settings.only ? [] : baseline),
        ...shown.value.filter((item) => item.group === group),
      ],
    }))
    .filter((section) => section.items.some((item) => item.group !== "baseline"));
});

const AUTHORED_LABELS = ["Warm-up", "Hold position", "Recovery"];

if (props.settings.progress !== null) scrubTo(props.settings.progress);

const now = useLabClock();
let previous = performance.now();

watch(now, (value) => {
  const deltaSeconds = Math.min(0.25, (value - previous) / 1000);
  previous = value;
  if (!props.settings.running) return;
  remaining.value = remaining.value.map((seconds, index) =>
    Math.max(0, seconds - deltaSeconds * props.settings.speed * (index === 2 ? 3 : 1)),
  );
});

const views = computed<LabTimerView[]>(() =>
  Array.from({ length: props.settings.count }, (_, index) => {
    const total = totals.value[index] ?? 180;
    const left = remaining.value[index] ?? 0;
    const label =
      props.settings.labels === "authored"
        ? (AUTHORED_LABELS[index] ?? `Beat ${index + 1}`)
        : props.settings.labels === "generic" || props.settings.count > 1
          ? `Timer ${index + 1}`
          : null;
    return {
      key: `timer-${index}`,
      label,
      totalSeconds: total,
      remainingSeconds: left,
      elapsed: total > 0 ? 1 - left / total : 1,
    };
  }),
);

</script>

<template>
  <div class="stage-body">
    <section v-for="section in sections" :key="section.group" class="section">
      <h2 class="section-title">{{ section.label }}</h2>
      <div class="grid">
        <article
          v-for="candidate in section.items"
          :key="candidate.id"
          class="cell"
          :data-candidate="candidate.id"
        >
          <div class="cell-rail" :style="{ minBlockSize: `${settings.size + 70}px` }">
            <component
              :is="candidate.component"
              v-if="candidate.component"
              :timers="views"
              :kind="settings.kind"
              layout="stack"
              :size="settings.size"
              :urgency="settings.urgency"
            />
            <TimerStack
              v-else
              :timers="views"
              :kind="settings.kind"
              :size="settings.size"
              :urgency="settings.urgency"
              :ring="candidate.ring!"
              :surface="candidate.surface ?? 'disc'"
            />
          </div>

          <div class="cell-compact">
            <component
              :is="candidate.component"
              v-if="candidate.component"
              :timers="views"
              :kind="settings.kind"
              layout="compact"
              :size="settings.size"
              :urgency="settings.urgency"
            />
            <TimerCompact
              v-else
              :timers="views"
              :kind="settings.kind"
              :urgency="settings.urgency"
              :ring="candidate.ring!"
            />
          </div>

          <h3 class="cell-name">{{ candidate.name }}</h3>
          <p class="cell-note">{{ candidate.note }}</p>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.stage-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 34px;
  padding-block: 28px 48px;
  min-inline-size: 0;
}

.section {
  padding-inline: 28px;
}

.section-title {
  margin: 0 0 16px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  opacity: 0.5;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 26px 18px;
}

.cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding-block-end: 8px;
  text-align: center;
}

.cell-rail,
.cell-compact {
  display: grid;
  place-items: center;
  inline-size: 100%;
}

.cell-compact {
  min-block-size: 64px;
  border-block-start: 1px solid color-mix(in oklab, currentColor 10%, transparent);
  padding-block-start: 12px;
}

.cell-name {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}

.cell-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  opacity: 0.6;
}
</style>
