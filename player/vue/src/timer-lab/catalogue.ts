import type { Component } from "vue";
import Hairline from "./candidates/Hairline.vue";
import TypeOnly from "./candidates/TypeOnly.vue";
import Horizon from "./candidates/Horizon.vue";
import Hourglass from "./candidates/Hourglass.vue";
import Column from "./candidates/Column.vue";
import QuietArc from "./rings/QuietArc.vue";
import OpenGauge from "./rings/OpenGauge.vue";
import Dial from "./rings/Dial.vue";
import Aperture from "./rings/Aperture.vue";
import Eclipse from "./rings/Eclipse.vue";
import BezelTicks from "./rings/BezelTicks.vue";
import Liquid from "./rings/Liquid.vue";
import Orbit from "./rings/Orbit.vue";
import Breath from "./rings/Breath.vue";
import Ember from "./rings/Ember.vue";
import SweepHand from "./rings/SweepHand.vue";
import LegacyRing from "./rings/LegacyRing.vue";

export type CandidateGroup = "baseline" | "refined" | "radical" | "elemental";

export interface Candidate {
  /** Stable id: also the `data-candidate` hook and the `?only=` value. */
  id: string;
  group: CandidateGroup;
  name: string;
  note: string;
  ring?: Component;
  component?: Component;
  surface?: "disc" | "scrim" | "none";
}

export const GROUP_LABELS: Record<CandidateGroup, string> = {
  baseline: "Baseline",
  refined: "Refined · the same circle, better made",
  radical: "Radical · a different object",
  elemental: "Elemental · light, matter and rhythm",
};

/**
 * One flat catalogue. Adding a direction means adding an entry here; the lab
 * shell, the screenshot hooks and the `?only=` route follow automatically.
 */
export const CANDIDATES: Candidate[] = [
  {
    id: "today",
    group: "baseline",
    name: "0 · Today",
    note: "The ring the Player ships now.",
    ring: LegacyRing,
  },
  {
    id: "quiet",
    group: "refined",
    name: "A · Quiet arc",
    note: "Hairline stroke, rounded tip, no seam.",
    ring: QuietArc,
  },
  {
    id: "gauge",
    group: "refined",
    name: "B · Open gauge",
    note: "270° arc with the gap under the label.",
    ring: OpenGauge,
    surface: "scrim",
  },
  {
    id: "dial",
    group: "refined",
    name: "C · Recessed dial",
    note: "A groove with a lit and a shaded edge.",
    ring: Dial,
  },
  {
    id: "aperture",
    group: "refined",
    name: "D · Aperture",
    note: "Arc fades in behind a travelling tip.",
    ring: Aperture,
  },
  {
    id: "hairline",
    group: "refined",
    name: "E · Hairline",
    note: "Numerals over a depleting rule.",
    component: Hairline,
  },
  {
    id: "eclipse",
    group: "radical",
    name: "F · Eclipse",
    note: "A lit disc a shadow crosses, like a lunar phase. Area, not outline.",
    ring: Eclipse,
    surface: "none",
  },
  {
    id: "bezel",
    group: "radical",
    name: "G · Bezel",
    note: "A ring of watch marks lighting up one at a time. Mechanical, jewelled.",
    ring: BezelTicks,
  },
  {
    id: "vessel",
    group: "radical",
    name: "H · Vessel",
    note: "The level drops as time runs out. Readable without reading digits.",
    ring: Liquid,
    surface: "none",
  },
  {
    id: "orbit",
    group: "radical",
    name: "I · Orbit",
    note: "No track and no arc. One point travelling around the numerals.",
    ring: Orbit,
    surface: "none",
  },
  {
    id: "type",
    group: "radical",
    name: "J · Type",
    note: "The type is the timer. It gains weight and presence as the end nears.",
    component: TypeOnly,
  },
  {
    id: "horizon",
    group: "radical",
    name: "K · Horizon",
    note: "Not an object but a line in the layout, with the numerals beneath it.",
    component: Horizon,
  },
  {
    id: "breath",
    group: "elemental",
    name: "L · Breath",
    note: "A field of light contracting toward the numerals while breathing at its own slow pace.",
    ring: Breath,
    surface: "none",
  },
  {
    id: "hourglass",
    group: "elemental",
    name: "M · Hourglass",
    note: "The one silhouette that already means being kept waiting.",
    component: Hourglass,
  },
  {
    id: "ember",
    group: "elemental",
    name: "N · Ember",
    note: "Light instead of geometry. It cools over the run and gathers heat at the end.",
    ring: Ember,
    surface: "none",
  },
  {
    id: "column",
    group: "elemental",
    name: "O · Column",
    note: "Takes the rail's own tall narrow shape and drains from the top.",
    component: Column,
  },
  {
    id: "sweep",
    group: "elemental",
    name: "P · Sweep hand",
    note: "One tapered hand, no dial. The oldest way to show time passing.",
    ring: SweepHand,
    surface: "none",
  },
];
