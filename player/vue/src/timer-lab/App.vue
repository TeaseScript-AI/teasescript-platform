<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { setLabClockInterval } from "./clock.js";
import { jumpToFinish, resetSession } from "./session.js";
import type { TimerKind } from "./candidate.js";
import type { CandidateGroup } from "./catalogue.js";
import LabProgress from "./LabProgress.vue";
import LabStage from "./LabStage.vue";

/**
 * Environments are deliberately neutral so the timer is judged on its own, with
 * the accepted warm Player theme available as a reality check and a photograph
 * for the case the timer actually has to survive: floating over media.
 */
const environments = {
  neutral: {
    label: "Neutral light",
    style: {
      background: "oklch(98.51% 0 0)",
      "--tl-fg": "oklch(21.03% 0 0)",
      "--tl-fg-muted": "oklch(55.17% 0 0)",
      "--tl-surface-base": "oklch(100% 0 0)",
      "--tl-quiet-lift": "0",
      "--tl-quiet-chroma": "0.42",
      "--tl-mark": "13%",
      "--tl-fill": "30%",
      "--tl-glyph": "none",
    },
  },
  dark: {
    label: "Neutral dark",
    style: {
      background: "oklch(17.85% 0 0)",
      "--tl-fg": "oklch(98.51% 0 0)",
      "--tl-fg-muted": "oklch(71.18% 0 0)",
      "--tl-surface-base": "oklch(24.52% 0 0)",
      "--tl-quiet-lift": "0.10",
      "--tl-quiet-chroma": "0.40",
      "--tl-mark": "16%",
      "--tl-fill": "34%",
      "--tl-glyph": "none",
    },
  },
  player: {
    // The accepted Player light-theme roles, straight from docs/ui/PLAYER-UI.md.
    label: "Player light theme",
    style: {
      background: "oklch(95.839% 0.01306 71.33)",
      "--tl-fg": "oklch(30.838% 0.01712 35.72)",
      "--tl-fg-muted": "oklch(52.649% 0.02679 41.27)",
      "--tl-surface-base": "oklch(99.199% 0.00734 80.72)",
      "--tl-quiet-lift": "0",
      "--tl-quiet-chroma": "0.42",
      "--tl-mark": "16%",
      "--tl-fill": "30%",
      "--tl-glyph": "none",
    },
  },
  media: {
    label: "Over media",
    style: {
      backgroundImage: "url('/demo-media/landscape-room.jpg')",
      backgroundSize: "cover",
      backgroundPosition: "center",
    },
  },
} as const;

/** Only meaningful over media: which way the floating surface leans. */
const veils = {
  dark: {
    label: "Dark veil",
    style: {
      "--tl-fg": "oklch(100% 0 0)",
      "--tl-fg-muted": "oklch(100% 0 0 / 0.74)",
      "--tl-surface-base": "oklch(16.52% 0 0)",
      "--tl-quiet-lift": "0.12",
      "--tl-quiet-chroma": "0.70",
      "--tl-mark": "34%",
      "--tl-fill": "58%",
      "--tl-glyph":
        "0 1px 2px oklch(0% 0 0 / 0.6), 0 2px 12px oklch(0% 0 0 / 0.5)",
    },
  },
  light: {
    label: "Light veil",
    style: {
      "--tl-fg": "oklch(21.91% 0 0)",
      "--tl-fg-muted": "oklch(44.44% 0 0)",
      "--tl-surface-base": "oklch(100% 0 0)",
      "--tl-quiet-lift": "-0.06",
      "--tl-quiet-chroma": "0.70",
      "--tl-mark": "30%",
      "--tl-fill": "52%",
      "--tl-glyph":
        "0 1px 2px oklch(100% 0 0 / 0.85), 0 2px 12px oklch(100% 0 0 / 0.75)",
    },
  },
} as const;

/** OKLCH keeps every accent on one perceptual footing; rose is the accepted one. */
const accents = {
  rose: "oklch(59.208% 0.19138 11.08)",
  amber: "oklch(68% 0.15 62)",
  violet: "oklch(56% 0.19 293)",
  teal: "oklch(62% 0.11 190)",
  blue: "oklch(58% 0.17 255)",
} as const;

/** How often the ring is allowed to move, in milliseconds between updates. */
const MOTION_INTERVALS = { smooth: 0, "12fps": 83, "1s step": 1000 } as const;

/**
 * Query parameters keep browser review and command-line screenshots on the same
 * addresses, for example `?bg=media&veil=light&only=bezel&progress=85`.
 */
const query = new URLSearchParams(window.location.search);

function pick<T extends Record<string, unknown>>(name: string, options: T, fallback: keyof T) {
  const value = query.get(name);
  return value !== null && value in options ? (value as keyof T) : fallback;
}

function pickNumber(name: string, fallback: number): number {
  const value = Number(query.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const requestedGroup = query.get("group");

const settings = reactive({
  environment: pick("bg", environments, "media"),
  veil: pick("veil", veils, "dark"),
  accent: pick("accent", accents, "rose"),
  motion: pick("motion", MOTION_INTERVALS, "smooth"),
  kind: pick("kind", { visible: 1, mystery: 1, hidden: 1 }, "visible") as TimerKind,
  count: pickNumber("timers", 1),
  size: pickNumber("size", 132),
  urgency: query.get("urgency") !== "off",
  labels: "authored" as "authored" | "generic" | "none",
  running: query.get("running") !== "off",
  speed: 1,
  group: (requestedGroup === "refined" || requestedGroup === "radical"
    || requestedGroup === "elemental"
    ? requestedGroup
    : "all") as CandidateGroup | "all",
  only: query.get("only"),
  /** Optional fixed elapsed percentage, so a screenshot is reproducible. */
  progress: query.has("progress") ? pickNumber("progress", 38) : null,
});

watch(
  () => settings.motion,
  (motion) => setLabClockInterval(MOTION_INTERVALS[motion]),
  { immediate: true },
);

const stageStyle = computed<Record<string, string>>(() => {
  const style: Record<string, string> = {
    ...(environments[settings.environment].style as Record<string, string>),
    ...(settings.environment === "media"
      ? (veils[settings.veil].style as Record<string, string>)
      : {}),
    "--tl-accent": accents[settings.accent],
  };
  style.color = style["--tl-fg"] ?? "inherit";
  return style;
});
</script>

<template>
  <div class="lab">
    <header class="bar">
      <strong class="bar-title">Timer lab</strong>

      <label>Show
        <select v-model="settings.group">
          <option value="all">All</option>
          <option value="refined">Refined (A–E)</option>
          <option value="radical">Radical (F–K)</option>
          <option value="elemental">Elemental (L–P)</option>
        </select>
      </label>

      <label>Background
        <select v-model="settings.environment">
          <option v-for="(value, key) in environments" :key="key" :value="key">{{ value.label }}</option>
        </select>
      </label>

      <label v-if="settings.environment === 'media'">Veil
        <select v-model="settings.veil">
          <option v-for="(value, key) in veils" :key="key" :value="key">{{ value.label }}</option>
        </select>
      </label>

      <label>Accent
        <select v-model="settings.accent">
          <option v-for="(_value, key) in accents" :key="key" :value="key">{{ key }}</option>
        </select>
      </label>

      <label>Presentation
        <select v-model="settings.kind">
          <option value="visible">visible</option>
          <option value="mystery">mystery</option>
          <option value="hidden">hidden</option>
        </select>
      </label>

      <label>Timers
        <select v-model.number="settings.count">
          <option :value="1">1</option>
          <option :value="2">2</option>
          <option :value="3">3</option>
        </select>
      </label>

      <label>Labels
        <select v-model="settings.labels">
          <option value="authored">authored</option>
          <option value="generic">generic</option>
          <option value="none">none</option>
        </select>
      </label>

      <label>Size
        <input v-model.number="settings.size" type="range" min="56" max="200" step="2" />
        <span class="bar-value">{{ settings.size }}px</span>
      </label>

      <label>Speed
        <select v-model.number="settings.speed">
          <option :value="1">1×</option>
          <option :value="10">10×</option>
          <option :value="60">60×</option>
        </select>
      </label>

      <LabProgress />

      <label>Motion
        <select v-model="settings.motion">
          <option v-for="(_value, key) in MOTION_INTERVALS" :key="key" :value="key">{{ key }}</option>
        </select>
      </label>

      <label class="bar-check">
        <input v-model="settings.urgency" type="checkbox" />
        Warm arc near the end
      </label>

      <button type="button" @click="settings.running = !settings.running">
        {{ settings.running ? "Pause" : "Run" }}
      </button>
      <button type="button" @click="jumpToFinish()">Last 12s</button>
      <button type="button" @click="resetSession()">Reset</button>
    </header>

    <main class="stage" :style="stageStyle">
      <LabStage :settings="settings" />
    </main>
  </div>
</template>

<style scoped>
.lab {
  min-block-size: 100dvh;
  display: flex;
  flex-direction: column;
}

.bar {
  position: sticky;
  inset-block-start: 0;
  z-index: 10;

  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  padding: 10px 16px;
  border-block-end: 1px solid oklch(92.19% 0 0);
  background: oklch(98.51% 0 0);
  color: oklch(20.46% 0 0);
  font-size: 12px;
  /* Separates the bar once candidates start scrolling underneath it. */
  box-shadow: 0 6px 16px -12px oklch(0% 0 0 / 0.55);
}

.bar-title {
  font-size: 13px;
}

.bar label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: oklch(43.86% 0 0);
}

.bar select,
.bar button {
  border: 1px solid oklch(86.99% 0 0);
  border-radius: 6px;
  background: oklch(100% 0 0);
  padding: 3px 7px;
  font: inherit;
  color: oklch(20.46% 0 0);
}

.bar button {
  cursor: pointer;
}

.bar-value {
  min-inline-size: 42px;
  font-variant-numeric: tabular-nums;
}

.bar-check {
  gap: 5px;
}

.stage {
  flex: 1;
  display: flex;
  flex-direction: column;
}
</style>
