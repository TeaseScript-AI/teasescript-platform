import { DEFAULT_PRESENTATION_SETTINGS, type TemporalContext } from "../../src/temporal.js";

export function utc(text: string): number {
  return Date.parse(`${text}Z`);
}

/**
 * Europe/Amsterdam in 2026 under the EU rule (summer time from 29 March to 25 October, both at 01:00 UTC), shown
 * day first with a 24-hour clock. Hand-written, so the expectations do not depend on host locale data.
 */
export const AMSTERDAM: TemporalContext = {
  zone: {
    name: "Europe/Amsterdam",
    initialOffsetSeconds: 3_600,
    transitions: [
      [utc("2026-03-29T01:00:00"), 7_200],
      [utc("2026-10-25T01:00:00"), 3_600],
    ],
  },
  presentation: {
    ...DEFAULT_PRESENTATION_SETTINGS,
    date: "{day}-{month}-{year}",
    dateTime: "{day}-{month}-{year}, {hour}:{minute}",
    dateTimeWithSeconds: "{day}-{month}-{year}, {hour}:{minute}:{second}",
    padDay: false,
    padMonth: false,
  },
};
