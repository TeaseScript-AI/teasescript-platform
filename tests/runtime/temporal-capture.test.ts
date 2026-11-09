import assert from "node:assert/strict";
import test from "node:test";

import { ZONE_RULES_END_MILLISECONDS, ZONE_RULES_START_MILLISECONDS } from "../../src/temporal.js";

// Zone capture reads the host's own transition list where it has one, through the same daily scan as the formatter
// (#1707): the rules a session records stay exactly what the portable scan captures, and every host without a usable
// list falls back to that scan.

type Capture = typeof import("../../src/temporal-capture.js");

/** The part of the host's Temporal these tests use; ES2023's library has no Temporal types. */
interface Zoned {
  readonly epochMilliseconds: number;
  readonly epochNanoseconds: bigint;
  readonly offsetNanoseconds: number;
  readonly timeZoneId: string;
  getTimeZoneTransition(direction: "next"): Zoned | null;
}
interface HostTemporal {
  readonly Instant: {
    fromEpochMilliseconds(moment: number): { toZonedDateTimeISO(zone: string): Zoned };
  };
  readonly ZonedDateTime: { readonly prototype: Zoned };
}
/** A host's Temporal as a test gives it, whose method may be missing. */
interface GivenTemporal {
  readonly Instant: HostTemporal["Instant"];
  readonly ZonedDateTime: { readonly prototype: { readonly getTimeZoneTransition?: unknown } };
}

// EVIDENCE: invariant: the repository's Node (.nvmrc) ships Temporal, so the native route is the one CI runs.
const realTemporal = (globalThis as { Temporal?: HostTemporal }).Temporal!;
const zonedPrototype = realTemporal.ZonedDateTime.prototype;
const realTransition = zonedPrototype.getTimeZoneTransition;
const realFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;

const calls = { formatToParts: 0, transitions: 0 };
let fresh = 0;

/**
 * `run` with the host's `Temporal` replaced by `temporal` (deleted for `undefined`), the calls of both APIs counted, on
 * a fresh instance of the capture module, so that no zone it cached under another host is reused.
 */
async function withHost<T>(
  temporal: GivenTemporal | undefined,
  run: (capture: Capture) => T,
): Promise<T> {
  const url = new URL("../../src/temporal-capture.js", import.meta.url);
  url.search = `?host=${(fresh += 1)}`;
  // EVIDENCE: invariant: the URL names the module this file imports statically for its type, with a query of its own.
  const capture = (await import(url.href)) as Capture;
  const replace = (
    target: typeof globalThis | Intl.DateTimeFormat | Zoned,
    name: string,
    value: unknown,
  ) => Object.defineProperty(target, name, { configurable: true, writable: true, value });
  if (temporal === undefined) Reflect.deleteProperty(globalThis, "Temporal");
  else replace(globalThis, "Temporal", temporal);
  replace(
    Intl.DateTimeFormat.prototype,
    "formatToParts",
    function (this: Intl.DateTimeFormat, moment?: number | Date) {
      calls.formatToParts += 1;
      return realFormatToParts.call(this, moment);
    },
  );
  replace(zonedPrototype, "getTimeZoneTransition", function (this: Zoned, direction: "next") {
    calls.transitions += 1;
    return realTransition.call(this, direction);
  });
  try {
    return run(capture);
  } finally {
    replace(globalThis, "Temporal", realTemporal);
    replace(Intl.DateTimeFormat.prototype, "formatToParts", realFormatToParts);
    replace(zonedPrototype, "getTimeZoneTransition", realTransition);
  }
}

/** The rules `capture` records for `zone`, with how many calls of each host API that took. */
function counted(capture: Capture, zone: string) {
  calls.formatToParts = 0;
  calls.transitions = 0;
  const rules = JSON.stringify(capture.captureZoneRules(zone));
  return { rules, formatToParts: calls.formatToParts, transitions: calls.transitions };
}

// More formatter calls than any successful native capture makes: the daily scan makes one per day of the window.
const SCANNED = 40_000;

test("native transitions give exactly the rules the daily scan captures, without the scan", async () => {
  // Summer time, a half-hour summer time, a 5:45 offset, seconds before 1972, Ramadan pauses, abolished summer time,
  // a skipped day, a fixed offset, an alias, and UTC.
  const zones = [
    "Europe/Amsterdam",
    "Australia/Lord_Howe",
    "Asia/Kathmandu",
    "Africa/Monrovia",
    "Africa/Cairo",
    "America/Sao_Paulo",
    "Pacific/Apia",
    "Asia/Gaza",
    "Etc/GMT-14",
    "Asia/Calcutta",
    "UTC",
  ];
  const scanned = await withHost(undefined, (capture) =>
    zones.map((zone) => counted(capture, zone)),
  );
  const native = await withHost(realTemporal, (capture) =>
    zones.map((zone) => counted(capture, zone)),
  );
  zones.forEach((zone, index) => {
    const [scan, read] = [scanned[index]!, native[index]!];
    assert.ok(scan.formatToParts > SCANNED && scan.transitions === 0, `${zone} scanned`);
    // Only the two checks of the window's last year read the formatter.
    assert.equal(read.formatToParts, 2, `${zone} read natively`);
    assert.ok(read.transitions > 0, zone);
    assert.equal(read.rules, scan.rules, zone);
  });
});

test("a zone the formatter knows and this host's Temporal does not, or an unusable list, falls back to the scan", async () => {
  const reference = await withHost(undefined, (capture) => ({
    amsterdam: counted(capture, "Europe/Amsterdam").rules,
    est5: counted(capture, "SystemV/EST5").rules,
  }));
  const est5 = await withHost(realTemporal, (capture) => counted(capture, "SystemV/EST5"));
  assert.ok(est5.formatToParts > SCANNED);
  assert.equal(est5.rules, reference.est5);

  // Hosts whose list the scan cannot read as it reads the formatter, each over the real list.
  interface Change {
    readonly next?: (next: Zoned, from: Zoned, wrap: (inner: Zoned) => Zoned) => Zoned | null;
    readonly nanoseconds?: (value: bigint) => bigint;
    readonly offset?: (value: number, at: Zoned) => number;
  }
  const listed = (change: Change): GivenTemporal => {
    const wrap = (inner: Zoned): Zoned => ({
      epochMilliseconds: inner.epochMilliseconds,
      epochNanoseconds: (change.nanoseconds ?? ((value) => value))(inner.epochNanoseconds),
      offsetNanoseconds: (change.offset ?? ((value) => value))(inner.offsetNanoseconds, inner),
      timeZoneId: inner.timeZoneId,
      getTimeZoneTransition: (direction) => {
        const next = inner.getTimeZoneTransition(direction);
        if (next === null) return null;
        return change.next ? change.next(next, inner, wrap) : wrap(next);
      },
    });
    return {
      Instant: {
        fromEpochMilliseconds: (moment: number) => ({
          toZonedDateTimeISO: (zone: string) =>
            wrap(realTemporal.Instant.fromEpochMilliseconds(moment).toZonedDateTimeISO(zone)),
        }),
      },
      ZonedDateTime: { prototype: { getTimeZoneTransition() {} } },
    };
  };
  const hosts = {
    "without the method": { Instant: realTemporal.Instant, ZonedDateTime: { prototype: {} } },
    "that throws": {
      Instant: {
        fromEpochMilliseconds() {
          throw new TypeError("unavailable");
        },
      },
      ZonedDateTime: { prototype: { getTimeZoneTransition() {} } },
    },
    "that repeats a moment": listed({ next: (_next, from, wrap) => wrap(from) }),
    "with a transition between whole seconds": listed({ nanoseconds: (value) => value + 1n }),
    "with an offset between whole seconds": listed({ offset: (value) => value + 1 }),
    "whose list ends in 2037": listed({
      next: (next, _from, wrap) =>
        next.epochMilliseconds >= Date.UTC(2038, 0, 1) ? null : wrap(next),
    }),
    "whose last year disagrees with the formatter": listed({
      offset: (value, at) =>
        at.epochMilliseconds >= Date.UTC(2099, 0, 1) ? value + 1_800e9 : value,
    }),
  } satisfies Record<string, GivenTemporal>;
  for (const [name, temporal] of Object.entries(hosts)) {
    const read = await withHost(temporal, (capture) => counted(capture, "Europe/Amsterdam"));
    assert.ok(read.formatToParts > SCANNED, `a host ${name} is scanned`);
    assert.equal(read.rules, reference.amsterdam, `a host ${name}`);
  }

  for (const temporal of [undefined, realTemporal])
    await withHost(temporal, (capture) =>
      assert.throws(() => capture.captureZoneRules("Mars/Olympus_Mons"), RangeError),
    );
});

test("both ways read the window's edges and a change undone within a day as the scan does", async () => {
  const at = (iso: string) => Date.parse(`${iso}Z`);
  const lastSecond = ZONE_RULES_END_MILLISECONDS - 1_000;
  // A synthetic zone: +1:00 from the window's first moment, summer time once, a change undone within a day, a change
  // at the window's last second, and one at its end.
  const changes: readonly (readonly [number, number])[] = [
    [ZONE_RULES_START_MILLISECONDS, 3_600],
    [at("1990-03-25T01:00:00"), 7_200],
    [at("1990-10-28T01:00:00"), 3_600],
    [at("2000-06-01T01:00:00"), 7_200],
    [at("2000-06-01T07:00:00"), 3_600],
    [lastSecond, 0],
    [ZONE_RULES_END_MILLISECONDS, 1_800],
  ];
  const offsetAt = (moment: number) => changes.findLast(([from]) => from <= moment)?.[1] ?? 0;
  const zone = "Test/Edges";
  const zoned = (moment: number): Zoned => ({
    epochMilliseconds: moment,
    epochNanoseconds: BigInt(moment) * 1_000_000n,
    offsetNanoseconds: offsetAt(moment) * 1e9,
    timeZoneId: zone,
    getTimeZoneTransition: () => {
      const next = changes.find(([from]) => from > moment);
      return next === undefined ? null : zoned(next[0]);
    },
  });
  const temporal = {
    Instant: {
      fromEpochMilliseconds: (moment: number) => ({ toZonedDateTimeISO: () => zoned(moment) }),
    },
    ZonedDateTime: { prototype: { getTimeZoneTransition() {} } },
  };
  const longOffset = (seconds: number) => {
    if (seconds === 0) return "GMT";
    const magnitude = Math.abs(seconds);
    const two = (value: number) => String(value).padStart(2, "0");
    return `GMT${seconds < 0 ? "-" : "+"}${two(Math.floor(magnitude / 3_600))}:${two(Math.floor(magnitude / 60) % 60)}`;
  };
  // The formatter for the synthetic zone, from the same offsets; every other zone is the host's.
  const RealFormat = Intl.DateTimeFormat;
  class EdgesFormat extends RealFormat {
    readonly #edges: boolean;
    constructor(locales?: string, options?: Intl.DateTimeFormatOptions) {
      const edges = options?.timeZone === zone;
      super(locales, edges ? { ...options, timeZone: "UTC" } : options);
      this.#edges = edges;
    }
    override resolvedOptions() {
      const resolved = super.resolvedOptions();
      return this.#edges ? { ...resolved, timeZone: zone } : resolved;
    }
    override formatToParts(moment?: number | Date): Intl.DateTimeFormatPart[] {
      if (!this.#edges) return super.formatToParts(moment);
      calls.formatToParts += 1;
      return [{ type: "timeZoneName", value: longOffset(offsetAt(Number(moment))) }];
    }
  }
  const expected = JSON.stringify({
    name: zone,
    initialOffsetSeconds: 3_600,
    transitions: [
      [at("1990-03-25T01:00:00"), 7_200],
      [at("1990-10-28T01:00:00"), 3_600],
      [lastSecond, 0],
    ],
  });
  for (const [host, native] of [
    [undefined, false],
    [temporal, true],
  ] as const) {
    const read = await withHost(host, (capture) => {
      const format = (value: typeof RealFormat | typeof EdgesFormat) =>
        Object.defineProperty(Intl, "DateTimeFormat", {
          configurable: true,
          writable: true,
          value,
        });
      format(EdgesFormat);
      try {
        return counted(capture, zone);
      } finally {
        format(RealFormat);
      }
    });
    assert.equal(read.rules, expected, native ? "native" : "scanned");
    if (native) assert.equal(read.formatToParts, 2);
    else assert.ok(read.formatToParts > SCANNED);
  }
});
