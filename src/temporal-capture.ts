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
  type PresentationSettings,
  type ZoneRules,
} from "./temporal.js";

const MS_PER_SECOND = 1_000;
const MS_PER_DAY = 86_400_000;
/**
 * Offsets are sampled weekly and each change is located to the second. Two transitions less than a week apart that
 * cancel each other out are not seen; no zone currently has them.
 */
const SCAN_STEP_MS = 7 * MS_PER_DAY;

/**
 * The UTC offsets of an IANA time zone from 1970 up to 2100, as this host's time-zone data defines them. Throws a
 * `RangeError` for a name the host does not know.
 */
export function captureZoneRules(timeZone: string): ZoneRules {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const offsetAt = (moment: number): number => {
    const fields = new Map(formatter.formatToParts(moment).map((part) => [part.type, part.value]));
    const wall = Date.UTC(
      Number(fields.get("year")),
      Number(fields.get("month")) - 1,
      Number(fields.get("day")),
      Number(fields.get("hour")),
      Number(fields.get("minute")),
      Number(fields.get("second")),
    );
    return Math.round((wall - moment) / MS_PER_SECOND);
  };
  const initialOffsetSeconds = offsetAt(ZONE_RULES_START_MILLISECONDS);
  const transitions: [number, number][] = [];
  let previousMoment = ZONE_RULES_START_MILLISECONDS;
  let previousOffset = initialOffsetSeconds;
  for (
    let moment = ZONE_RULES_START_MILLISECONDS + SCAN_STEP_MS;
    moment < ZONE_RULES_END_MILLISECONDS + SCAN_STEP_MS;
    moment += SCAN_STEP_MS
  ) {
    const sampled = Math.min(moment, ZONE_RULES_END_MILLISECONDS);
    const offset = offsetAt(sampled);
    if (offset !== previousOffset) {
      // The offset changed in (previousMoment, sampled]; find the first whole second with the new offset.
      let before = previousMoment;
      let after = sampled;
      while (after - before > MS_PER_SECOND) {
        const middle = Math.floor((before + after) / 2 / MS_PER_SECOND) * MS_PER_SECOND;
        if (middle <= before) break;
        if (offsetAt(middle) === previousOffset) before = middle;
        else after = middle;
      }
      transitions.push([after, offset]);
      previousOffset = offset;
    }
    previousMoment = sampled;
  }
  const rules: ZoneRules = {
    name: formatter.resolvedOptions().timeZone,
    initialOffsetSeconds,
    transitions,
  };
  const problem = zoneRulesProblem(rules);
  if (problem !== null)
    throw new RangeError(`Time zone ${timeZone} cannot be captured: ${problem}`);
  return rules;
}

/**
 * How `locale` writes numeric dates and times, as this host's locale data defines it, with Latin digits. Throws a
 * `RangeError` for a malformed locale tag; an unknown but well-formed tag falls back as `Intl` does.
 */
export function capturePresentationSettings(locale: string): PresentationSettings {
  const [canonical] = Intl.getCanonicalLocales(locale);
  if (canonical === undefined) throw new RangeError("A locale tag is required.");
  const base = { numberingSystem: "latn", calendar: "gregory", timeZone: "UTC" } as const;
  const dateFormatter = new Intl.DateTimeFormat(canonical, {
    ...base,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  // 2033-11-22 has a distinct year, month, and day; 2033-01-05 shows whether one digit is padded.
  const dateParts = dateFormatter.formatToParts(Date.UTC(2033, 10, 22));
  const order = dateParts
    .filter((part) => part.type === "year" || part.type === "month" || part.type === "day")
    .map((part) => part.type[0])
    .join("");
  const shortParts = new Map(
    dateFormatter.formatToParts(Date.UTC(2033, 0, 5)).map((part) => [part.type, part.value]),
  );

  const clockFormatter = new Intl.DateTimeFormat(canonical, {
    ...base,
    hour: "numeric",
    minute: "2-digit",
  });
  const resolvedCycle = clockFormatter.resolvedOptions().hourCycle;
  const twelveHourFormatter = new Intl.DateTimeFormat(canonical, {
    ...base,
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
  });
  const morning = twelveHourFormatter.formatToParts(Date.UTC(2033, 0, 5, 9, 5));
  const afternoon = twelveHourFormatter.formatToParts(Date.UTC(2033, 0, 5, 21, 5));
  const morningPeriod = morning.findIndex((part) => part.type === "dayPeriod");
  const morningHour = morning.findIndex((part) => part.type === "hour");
  const clockParts = clockFormatter.formatToParts(Date.UTC(2033, 0, 5, 9, 5));

  const dateTimeParts = new Intl.DateTimeFormat(canonical, {
    ...base,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).formatToParts(Date.UTC(2033, 10, 22, 9, 5));
  const lastDatePart = dateTimeParts.findLastIndex((part) =>
    ["year", "month", "day"].includes(part.type),
  );
  const decimal = new Intl.NumberFormat(canonical, { numberingSystem: "latn" })
    .formatToParts(1.5)
    .find((part) => part.type === "decimal");

  const settings: PresentationSettings = {
    dateOrder: order === "dmy" || order === "mdy" ? order : "ymd",
    dateSeparator: literalAfter(
      dateParts,
      dateParts.findIndex((part) => part.type !== "literal"),
    ),
    padDay: shortParts.get("day")?.length === 2,
    padMonth: shortParts.get("month")?.length === 2,
    dateTimeSeparator: literalAfter(dateTimeParts, lastDatePart),
    hourCycle: resolvedCycle === "h11" || resolvedCycle === "h12" ? "h12" : "h23",
    padHour: clockParts.find((part) => part.type === "hour")?.value.length === 2,
    timeSeparator: literalAfter(
      clockParts,
      clockParts.findIndex((part) => part.type === "hour"),
    ),
    dayPeriods: [
      plainText(morning[morningPeriod]?.value ?? "AM"),
      plainText(afternoon.find((part) => part.type === "dayPeriod")?.value ?? "PM"),
    ],
    dayPeriodBeforeTime: morningPeriod >= 0 && morningPeriod < morningHour,
    dayPeriodSeparator:
      morningPeriod < 0
        ? " "
        : morningPeriod < morningHour
          ? literalAfter(morning, morningPeriod)
          : literalAfter(morning, morningPeriod - 2), // the literal before the marker
    decimalSeparator: decimal?.value ?? ".",
  };
  const problem = presentationSettingsProblem(settings);
  if (problem !== null) throw new RangeError(`Locale ${locale} cannot be captured: ${problem}`);
  return settings;
}

/** The literal text right after `parts[index]`, with no-break spaces as plain spaces. */
function literalAfter(parts: readonly Intl.DateTimeFormatPart[], index: number): string {
  const next = parts[index + 1];
  return next?.type === "literal" ? plainText(next.value) : "";
}

function plainText(text: string): string {
  return text.replace(/[\u00a0\u202f]/gu, " ");
}
