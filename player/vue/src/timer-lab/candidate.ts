import type { LabTimerView } from "./clock.js";

export type TimerKind = "visible" | "mystery" | "hidden";
export type TimerLayout = "stack" | "compact";

export interface CandidateProps {
  timers: LabTimerView[];
  kind: TimerKind;
  layout: TimerLayout;
  /** Outer diameter in px for the stacked layout. */
  size: number;
  /** Whether the arc colour is allowed to warm up near completion. */
  urgency: boolean;
}

/** Radius used by every SVG candidate, in the shared 0 0 100 100 viewBox. */
export const RING_RADIUS = 45;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * 0 while the timer is ambient, easing to 1 over the closing stretch. The
 * window is the longer of 15% of the run and 20 seconds, so both a two-minute
 * scene beat and a twenty-minute background timer get a usable warning.
 */
export function urgency(view: LabTimerView, enabled: boolean): number {
  if (!enabled) return 0;
  const window = Math.max(view.totalSeconds * 0.15, 20);
  if (window <= 0 || view.remainingSeconds >= window) return 0;
  const raw = 1 - Math.max(0, view.remainingSeconds) / window;
  return raw * raw;
}

export function arcColor(view: LabTimerView, enabled: boolean): string {
  const ratio = Math.round(urgency(view, enabled) * 100);
  return `color-mix(in oklab, var(--tl-accent) ${ratio}%, var(--tl-arc-quiet))`;
}
