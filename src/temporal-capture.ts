/**
 * Host-side capture of the zone rules and presentation settings that `temporal.ts` computes with (#532). This is the
 * only temporal code that reads `Intl` or the host's `Temporal`; a host calls it when a session starts or continues, and
 * the engine records the result, so a restored or replayed session never consults host locale or time-zone data.
 */

import {
  presentationSettingsProblem,
  ZONE_RULES_END_MILLISECONDS,
  ZONE_RULES_START_MILLISECONDS,
  zoneRulesProblem,
  type HourCycle,
  type PresentationSettings,
  type TemporalContext,
  type ZoneRules,
} from "./temporal.js";

const MS_PER_SECOND = 1_000;
const SCAN_STEP_MS = 86_400_000;

const capturedZones = new Map<string, ZoneRules>();

/** The zone rules and presentation of a player's IANA time zone and locale, for a session to record. */
export function captureTemporalContext(timeZone: string, locale: string): TemporalContext {
  return { zone: captureZoneRules(timeZone), presentation: capturePresentationSettings(locale) };
}

/**
 * The UTC offsets of an IANA time zone from 1970 up to 2100, as this host's time-zone data defines them. Throws a
 * `RangeError` for a name the host does not know. Results are cached: host zone data does not change while it runs.
 */
export function captureZoneRules(timeZone: string): ZoneRules {
  const cached = capturedZones.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
  const name = formatter.resolvedOptions().timeZone;
  const formatted = formattedOffsets(formatter, timeZone);
  const rules = scannedZoneRules(name, nativeOffsets(name, formatted) ?? formatted);
  const problem = zoneRulesProblem(rules);
  if (problem !== null)
    throw new RangeError(`Time zone ${timeZone} cannot be captured: ${problem}`);
  capturedZones.set(timeZone, rules);
  return rules;
}

/** A zone's UTC offset in seconds at a moment in epoch milliseconds. */
type OffsetAt = (moment: number) => number;

/** The offsets as `formatter` writes them, which every host has. */
function formattedOffsets(formatter: Intl.DateTimeFormat, timeZone: string): OffsetAt {
  return (moment) => {
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
}

/**
 * The offsets from the host's own transition list (`Temporal.ZonedDateTime.prototype.getTimeZoneTransition`), which
 * reads the same zone data in a few calls instead of a formatter call per day; `null` when the host lacks it or its list
 * is not one the scan can read as it reads `formatted`. Its last two checks compare the final year with `formatted`, so
 * a host whose list ends early falls back.
 */
function nativeOffsets(name: string, formatted: OffsetAt): OffsetAt | null {
  // EVIDENCE: invariant: the method is checked below, every other use is within the `try`, and any throw falls back.
  const temporal = (globalThis as { Temporal?: NativeTemporal }).Temporal;
  if (typeof temporal?.ZonedDateTime?.prototype?.getTimeZoneTransition !== "function") return null;
  try {
    let cursor = temporal.Instant.fromEpochMilliseconds(
      ZONE_RULES_START_MILLISECONDS,
    ).toZonedDateTimeISO(name);
    const initialOffset = wholeSeconds(cursor.offsetNanoseconds);
    if (initialOffset === null) return null;
    const moments: number[] = [];
    const offsets: number[] = [];
    for (;;) {
      const next = cursor.getTimeZoneTransition("next");
      if (next === null) break;
      const nanoseconds = next.epochNanoseconds;
      if (nanoseconds % NANOSECONDS_PER_SECOND !== 0n) return null;
      const moment = Number(nanoseconds / NANOSECONDS_PER_MILLISECOND);
      if (moment <= (moments.at(-1) ?? ZONE_RULES_START_MILLISECONDS)) return null;
      if (moment >= ZONE_RULES_END_MILLISECONDS) break;
      const offset = wholeSeconds(next.offsetNanoseconds);
      if (offset === null) return null;
      moments.push(moment);
      offsets.push(offset);
      cursor = next;
    }
    const offsetAt: OffsetAt = (moment) => {
      // The offset after the last transition at or before `moment`.
      let low = 0;
      let high = moments.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (moments[middle]! <= moment) low = middle + 1;
        else high = middle;
      }
      return low === 0 ? initialOffset : offsets[low - 1]!;
    };
    for (const moment of FINAL_YEAR_CHECKS) if (offsetAt(moment) !== formatted(moment)) return null;
    return offsetAt;
  } catch {
    // A name the formatter knows but this host's Temporal does not, such as `SystemV/EST5`.
    return null;
  }
}

/** January and July of the window's last year, one in each half of a year with summer time. */
const FINAL_YEAR_CHECKS = [Date.UTC(2099, 0, 15), Date.UTC(2099, 6, 15)];
const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/** `nanoseconds` in whole seconds, or `null` when it is not a whole number of them. */
function wholeSeconds(nanoseconds: number): number | null {
  return Number.isSafeInteger(nanoseconds) && nanoseconds % 1e9 === 0 ? nanoseconds / 1e9 : null;
}

/** The part of the host's Temporal that `nativeOffsets` reads. */
interface NativeTemporal {
  readonly Instant: {
    fromEpochMilliseconds(epochMilliseconds: number): {
      toZonedDateTimeISO(timeZone: string): NativeZonedDateTime;
    };
  };
  readonly ZonedDateTime?: { readonly prototype?: { readonly getTimeZoneTransition?: unknown } };
}

interface NativeZonedDateTime {
  readonly epochNanoseconds: bigint;
  readonly offsetNanoseconds: number;
  getTimeZoneTransition(direction: "next"): NativeZonedDateTime | null;
}

/**
 * The zone's rules as `offsetAt` gives its offsets: sampled daily, each change located to the second. Two changes less
 * than a day apart that cancel each other out are not seen; current time-zone data has none within the captured window.
 */
function scannedZoneRules(name: string, offsetAt: OffsetAt): ZoneRules {
  const initialOffsetSeconds = offsetAt(ZONE_RULES_START_MILLISECONDS);
  const transitions: [number, number][] = [];
  let previousMoment = ZONE_RULES_START_MILLISECONDS;
  let previousOffset = initialOffsetSeconds;
  // The last sample is the window's final whole second, so a change on its last day is seen too.
  const lastSecond = ZONE_RULES_END_MILLISECONDS - MS_PER_SECOND;
  for (
    let moment = Math.min(ZONE_RULES_START_MILLISECONDS + SCAN_STEP_MS, lastSecond);
    previousMoment < lastSecond;
    moment = Math.min(moment + SCAN_STEP_MS, lastSecond)
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
  return { name, initialOffsetSeconds, transitions };
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
