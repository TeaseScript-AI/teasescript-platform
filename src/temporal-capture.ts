/**
 * Host-side capture of the zone rules and presentation settings that `temporal.ts` computes with (#532). This is the
 * only temporal code that reads `Intl`; a host calls it when a session starts or continues, and the engine records the
 * result, so a restored or replayed session never consults host locale or time-zone data.
 */

import {
  presentationSettingsProblem,
  ZONE_RULES_END_MILLISECONDS,
  ZONE_RULES_START_MILLISECONDS,
  zoneRulesProblem,
  type HourCycle,
  type PresentationSettings,
  type ZoneRules,
} from "./temporal.js";

const MS_PER_SECOND = 1_000;
/**
 * Offsets are sampled daily and each change is located to the second. Two changes less than a day apart that cancel
 * each other out are not seen; current time-zone data has none within the captured window.
 */
const SCAN_STEP_MS = 86_400_000;

const capturedZones = new Map<string, ZoneRules>();

/**
 * The UTC offsets of an IANA time zone from 1970 up to 2100, as this host's time-zone data defines them. Throws a
 * `RangeError` for a name the host does not know. Results are cached: host zone data does not change while it runs.
 */
export function captureZoneRules(timeZone: string): ZoneRules {
  const cached = capturedZones.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
  const offsetAt = (moment: number): number => {
    const name = formatter
      .formatToParts(moment)
      .find((part) => part.type === "timeZoneName")?.value;
    // `GMT` for UTC itself, otherwise `GMT+02:00` or, for historical offsets, `GMT-00:44:30`.
    const match = /^GMT(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?$/u.exec(name ?? "");
    if (match === null)
      throw new RangeError(`Time zone ${timeZone} has an unreadable offset ${name}.`);
    if (match[1] === undefined) return 0;
    const seconds = Number(match[2]) * 3_600 + Number(match[3]) * 60 + Number(match[4] ?? 0);
    return match[1] === "-" ? -seconds : seconds;
  };
  const initialOffsetSeconds = offsetAt(ZONE_RULES_START_MILLISECONDS);
  const transitions: [number, number][] = [];
  let previousMoment = ZONE_RULES_START_MILLISECONDS;
  let previousOffset = initialOffsetSeconds;
  for (
    let moment = ZONE_RULES_START_MILLISECONDS + SCAN_STEP_MS;
    moment < ZONE_RULES_END_MILLISECONDS;
    moment += SCAN_STEP_MS
  ) {
    const offset = offsetAt(moment);
    if (offset !== previousOffset) {
      // The offset changed in (previousMoment, moment]; find the first whole second with the new offset.
      let before = previousMoment;
      let after = moment;
      while (after - before > MS_PER_SECOND) {
        const middle = Math.floor((before + after) / 2 / MS_PER_SECOND) * MS_PER_SECOND;
        if (offsetAt(middle) === previousOffset) before = middle;
        else after = middle;
      }
      transitions.push([after, offset]);
      previousOffset = offset;
    }
    previousMoment = moment;
  }
  const rules: ZoneRules = {
    name: formatter.resolvedOptions().timeZone,
    initialOffsetSeconds,
    transitions,
  };
  const problem = zoneRulesProblem(rules);
  if (problem !== null)
    throw new RangeError(`Time zone ${timeZone} cannot be captured: ${problem}`);
  capturedZones.set(timeZone, rules);
  return rules;
}

/**
 * How `locale` writes numeric dates and times, as this host's locale data defines it, with Latin digits and the
 * Gregorian calendar. No-break spaces become plain spaces. Throws a `RangeError` for a malformed locale tag or locale
 * data that the settings cannot represent; an unknown but well-formed tag falls back as `Intl` does.
 */
export function capturePresentationSettings(locale: string): PresentationSettings {
  const [canonical] = Intl.getCanonicalLocales(locale);
  if (canonical === undefined) throw new RangeError("A locale tag is required.");
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(canonical, {
      numberingSystem: "latn",
      calendar: "gregory",
      timeZone: "UTC",
      ...options,
    });
  const date = { year: "numeric", month: "numeric", day: "numeric" } as const;
  const time = { hour: "numeric", minute: "2-digit" } as const;
  const seconds = { second: "2-digit" } as const;
  const dateFormatter = format(date);
  const timeFormatter = format(time);
  // 2033-11-22 21:05:07 has distinct fields and an afternoon hour; 2033-01-05 01:05 shows single-digit padding.
  const distinct = Date.UTC(2033, 10, 22, 21, 5, 7);
  const singleDigits = Date.UTC(2033, 0, 5, 1, 5);
  const fieldLength = (formatter: Intl.DateTimeFormat, type: Intl.DateTimeFormatPartTypes) =>
    formatter.formatToParts(singleDigits).find((part) => part.type === type)?.value.length;
  const dayPeriod = (moment: number) =>
    timeFormatter.formatToParts(moment).find((part) => part.type === "dayPeriod")?.value;
  const hourCycle: HourCycle = timeFormatter.resolvedOptions().hourCycle ?? "h23";

  const settings: PresentationSettings = {
    date: template(dateFormatter, distinct),
    time: template(timeFormatter, distinct),
    timeWithSeconds: template(format({ ...time, ...seconds }), distinct),
    dateTime: template(format({ ...date, ...time }), distinct),
    dateTimeWithSeconds: template(format({ ...date, ...time, ...seconds }), distinct),
    padDay: fieldLength(dateFormatter, "day") === 2,
    padMonth: fieldLength(dateFormatter, "month") === 2,
    padHour: fieldLength(timeFormatter, "hour") === 2,
    hourCycle,
    dayPeriods: [
      plainText(dayPeriod(Date.UTC(2033, 0, 5, 9, 5)) ?? "AM"),
      plainText(dayPeriod(distinct) ?? "PM"),
    ],
  };
  const problem = presentationSettingsProblem(settings);
  if (problem !== null) throw new RangeError(`Locale ${locale} cannot be captured: ${problem}`);
  return settings;
}

const TEMPLATE_FIELDS: ReadonlySet<string> = new Set([
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
  "dayPeriod",
]);

/** The formatter's output for `moment` with each numeric field and day period replaced by its placeholder. */
function template(formatter: Intl.DateTimeFormat, moment: number): string {
  return formatter
    .formatToParts(moment)
    .map((part) => {
      if (TEMPLATE_FIELDS.has(part.type)) return `{${part.type}}`;
      if (part.type === "literal") return plainText(part.value);
      throw new RangeError(`Locale data uses an unsupported ${part.type} part.`);
    })
    .join("");
}

function plainText(text: string): string {
  return text.replace(/[\u00a0\u202f]/gu, " ");
}
