import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import type { InstructionPlan } from "../src/plan/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { recordContinueCapture } from "../src/runtime/operations/continue-capture.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { RuntimeSnapshot } from "../src/runtime/state.js";
import type { TemporalContext, ZoneRules } from "../src/temporal.js";
import { captureTemporalContext } from "../src/temporal-capture.js";
import { playerTemporalContext } from "../player/runtime-adapter.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { assertCheckpointRejected } from "./helpers/checkpoint-rejection.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { AMSTERDAM, utc } from "./helpers/temporal-fixtures.js";

/** Hides a value's type and value from the compiler, so a check reaches the runtime. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

/**
 * America/New_York in 2026 under the US rule: daylight time from 8 March 07:00 UTC to 1 November 06:00 UTC.
 * Hand-written, like `AMSTERDAM`, so the expectations do not depend on host time-zone data.
 */
const NEW_YORK_ZONE: ZoneRules = {
  name: "America/New_York",
  initialOffsetSeconds: -18_000,
  transitions: [
    [utc("2026-03-08T07:00:00"), -14_400],
    [utc("2026-11-01T06:00:00"), -18_000],
  ],
};

/** A player in New York whose script names Amsterdam. */
const NEW_YORK_PLAYER: TemporalContext = {
  zone: NEW_YORK_ZONE,
  presentation: AMSTERDAM.presentation,
  namedZones: [AMSTERDAM.zone],
};

/** A player in Amsterdam whose script names New York. */
const AMSTERDAM_PLAYER: TemporalContext = { ...AMSTERDAM, namedZones: [NEW_YORK_ZONE] };

/** Sunday 4 October 2026, 16:00 UTC. */
const NOW = utc("2026-10-04T16:00:00");

/** Runs `source` with the context's rules of the zones the script names, as the Player records them. */
function start(source: string, context: TemporalContext) {
  const plan = compileValidPlan(source);
  const namedZones = (context.namedZones ?? []).filter((zone) =>
    plan.timeZones.includes(zone.name),
  );
  const temporalContext = { zone: context.zone, presentation: context.presentation, namedZones };
  return {
    plan,
    result: run(
      plan,
      createImmediatePacingRuntimeSnapshot(plan, { temporalContext, wallClockMs: NOW }),
    ),
  };
}

function says(lines: readonly string[], temporalContext = NEW_YORK_PLAYER): string[] {
  const { result } = start([...lines, "exit"].join("\n"), temporalContext);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return result.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

function failure(lines: readonly string[], temporalContext = NEW_YORK_PLAYER) {
  const { result } = start([...lines, "exit"].join("\n"), temporalContext);
  const failed = result.snapshot.failure;
  assert.ok(failed !== null, `${lines.join("\n")} must fail`);
  return [failed.code, failed.message];
}

function diagnostics(lines: readonly string[]): [string, string][] {
  return compileSource([...lines, "exit"].join("\n")).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
  ]);
}

test("anchored conversions and add count in a named zone, the player's zone, or UTC", () => {
  const plan = compileValidPlan(
    'say toDateTime("2026-02-04T12:00").toAbsoluteDateTime(zone: "Europe/Amsterdam")\nsay getAbsoluteDateTime().toDateTime(zone: "UTC")\nexit',
  );
  // UTC needs no rules, so only Amsterdam is recorded with the player's zone.
  assert.deepEqual(plan.timeZones, ["Europe/Amsterdam"]);
  assert.deepEqual(
    says([
      'let local = toDateTime("2026-02-04T12:00")',
      'let start = local.toAbsoluteDateTime(zone: "Europe/Amsterdam")',
      "say start.toISO()",
      // The player is in New York, which the conversions use without `zone:`.
      "say local.toAbsoluteDateTime().toISO()",
      "let span = 1 calendar month + 1 day",
      'let elapsed = span.toDuration(from: start, zone: "Europe/Amsterdam")',
      'say "${elapsed / 1 h} ${elapsed / 2} ${elapsed / 1 day}"',
      'let deadline = start.add(span, zone: "Europe/Amsterdam")',
      "say deadline == start + elapsed",
      'say deadline.toDateTime(zone: "Europe/Amsterdam").toISO()',
      'say deadline.toDateTime(zone: "UTC").toISO()',
      "say deadline.toDateTime().toISO()",
      'say local.toAbsoluteDateTime(zone: "UTC").toISO()',
      // A duration moves an absolute date and time like '+', and a calendar month counts in the player's zone, which
      // leaves daylight time on 1 November.
      "say getAbsoluteDateTime().add(2 h).toISO()",
      "say getAbsoluteDateTime().add(1 calendar month).toISO()",
      "say getAbsoluteDateTime().add(-1 calendar day).toISO()",
    ]),
    [
      "2026-02-04T11:00:00Z",
      "2026-02-04T17:00:00Z",
      "696 14 days 12 hours 29",
      "true",
      "2026-03-05T12:00",
      "2026-03-05T11:00",
      "2026-03-05T06:00",
      "2026-02-04T12:00:00Z",
      "2026-10-04T18:00:00Z",
      "2026-11-04T17:00:00Z",
      "2026-10-03T16:00:00Z",
    ],
  );
});

test("a calendar duration measures from a date and time or a moment, and a skipped start resolves first", () => {
  assert.deepEqual(
    says([
      'let local = toDateTime("2026-02-04T12:00")',
      'let fromLocal = (1 calendar month).toDuration(from: local, zone: "Europe/Amsterdam")',
      'let fromMoment = (1 calendar month).toDuration(from: local.toAbsoluteDateTime(zone: "Europe/Amsterdam"), zone: "Europe/Amsterdam")',
      'say "${fromLocal / 1 h} ${fromMoment / 1 h}"',
      // Across the spring and autumn changes a calendar day is 23 and 25 hours; a day is always 24.
      'let spring = toDateTime("2026-03-28T12:00")',
      'say (1 calendar day).toDuration(from: spring, zone: "Europe/Amsterdam") / 1 h',
      'say (1 day + 0 calendar days).toDuration(from: spring, zone: "Europe/Amsterdam") / 1 h',
      'say (1 calendar day).toDuration(from: toDateTime("2026-10-24T12:00"), zone: "Europe/Amsterdam") / 1 h',
      // 02:30 on 29 March does not exist in Amsterdam: it resolves to 03:30 first, then moves a calendar day, so the
      // datetime and the moment it resolves to measure alike.
      'let skipped = toDateTime("2026-03-29T02:30")',
      'let resolved = skipped.toAbsoluteDateTime(zone: "Europe/Amsterdam")',
      'say (1 calendar day).toDuration(from: skipped, zone: "Europe/Amsterdam") / 1 h',
      'say resolved.add(1 calendar day, zone: "Europe/Amsterdam").toDateTime(zone: "Europe/Amsterdam").toISO()',
      // '+' on the local value keeps 02:30, which exists the next day.
      'say ((skipped + 1 calendar day).toAbsoluteDateTime(zone: "Europe/Amsterdam") - resolved) / 1 h',
      // Without months and days only the exact offset moves the start, so the later 02:30 of 25 October stays itself.
      'let second = toDateTime("2026-10-25T02:30").toAbsoluteDateTime(zone: "Europe/Amsterdam", disambiguation: "later")',
      'say (0 calendar days).toDuration(from: second, zone: "Europe/Amsterdam") / 1 ms',
      'say second.add(1 calendar day - 1 calendar day + 30 min, zone: "Europe/Amsterdam").toISO()',
      // An exact offset is applied on the timeline after the calendar move, rounded to whole milliseconds.
      'say (1 calendar day + 0.5 ms).toDuration(from: spring, zone: "Europe/Amsterdam") / 1 ms',
    ]),
    [
      "672 672",
      "23",
      "24",
      "25",
      "24",
      "2026-03-30T03:30",
      "23",
      "0",
      "2026-10-25T02:00:00Z",
      "82800001",
    ],
  );
});

test("disambiguation picks the moment of a skipped or repeated time, and reject refuses it", () => {
  const convert = (local: string, disambiguation: string) =>
    `say toDateTime("${local}").toAbsoluteDateTime(zone: "Europe/Amsterdam", disambiguation: "${disambiguation}").toISO()`;
  assert.deepEqual(
    says([
      // 02:30 on 29 March is skipped: the default and "later" move it forward by the hour, "earlier" back.
      'say toDateTime("2026-03-29T02:30").toAbsoluteDateTime(zone: "Europe/Amsterdam").toISO()',
      convert("2026-03-29T02:30", "compatible"),
      convert("2026-03-29T02:30", "later"),
      convert("2026-03-29T02:30", "earlier"),
      // 02:30 on 25 October happens twice: the default and "earlier" take the first.
      'say toDateTime("2026-10-25T02:30").toAbsoluteDateTime(zone: "Europe/Amsterdam").toISO()',
      convert("2026-10-25T02:30", "earlier"),
      convert("2026-10-25T02:30", "later"),
      convert("2026-10-25T03:30", "reject"),
      // One policy resolves both the start and the end of a calendar move.
      'let eve = toDateTime("2026-10-24T02:30")',
      'say (1 calendar day).toDuration(from: eve, zone: "Europe/Amsterdam", disambiguation: "later") / 1 h',
      'say eve.toAbsoluteDateTime(zone: "Europe/Amsterdam").add(1 calendar day, zone: "Europe/Amsterdam", disambiguation: "later").toISO()',
      // The player's zone resolves with the same options.
      'say toDateTime("2026-11-01T01:30").toAbsoluteDateTime(disambiguation: "later").toISO()',
    ]),
    [
      "2026-03-29T01:30:00Z",
      "2026-03-29T01:30:00Z",
      "2026-03-29T01:30:00Z",
      "2026-03-29T00:30:00Z",
      "2026-10-25T00:30:00Z",
      "2026-10-25T00:30:00Z",
      "2026-10-25T01:30:00Z",
      "2026-10-25T02:30:00Z",
      "25",
      "2026-10-25T01:30:00Z",
      "2026-11-01T06:30:00Z",
    ],
  );
  assert.deepEqual(failure([convert("2026-03-29T02:30", "reject")]), [
    "TSR063",
    "2026-03-29T02:30 does not exist in Europe/Amsterdam, because the clocks skip it there, and 'disambiguation: \"reject\"' refuses such a time. Use another time, or 'disambiguation: \"earlier\"' or 'disambiguation: \"later\"' to take the moment before or after.",
  ]);
  assert.deepEqual(failure([convert("2026-10-25T02:30", "reject")]), [
    "TSR063",
    "2026-10-25T02:30 happens twice in Europe/Amsterdam, because the clocks repeat it there, and 'disambiguation: \"reject\"' refuses such a time. Use another time, or 'disambiguation: \"earlier\"' or 'disambiguation: \"later\"' to take the moment before or after.",
  ]);
  // The end of a calendar move is checked as well as its start.
  assert.equal(
    failure([
      'say toDateTime("2026-03-28T02:30").toAbsoluteDateTime(zone: "Europe/Amsterdam").add(1 calendar day, zone: "Europe/Amsterdam", disambiguation: "reject")',
    ])[0],
    "TSR063",
  );
});

test("overflow takes the month's last day or refuses a day the target month lacks, also in leap years", () => {
  assert.deepEqual(
    says([
      'say toDate("2027-01-31").add(1 calendar month).toISO()',
      'say toDate("2028-01-31").add(1 calendar month, overflow: "constrain").toISO()',
      'say toDate("2027-01-31").add(2 calendar months).toISO()',
      'say toDate("2027-01-31").add(1 calendar month).add(1 calendar month).toISO()',
      'say toDate("2027-03-31").add(-1 calendar month).toISO()',
      'say toDate("2027-01-28").add(1 calendar month + 1 calendar day, overflow: "reject").toISO()',
      'say toDateTime("2024-02-29T09:00").add(1 calendar year).toISO()',
      'say toDateTime("2024-02-29T09:00").add(4 calendar years, overflow: "reject").toISO()',
      'say toDate("2027-01-31").add(5 calendar days, overflow: "reject").toISO()',
      'say toDateTime("2027-01-31T09:00").toAbsoluteDateTime(zone: "UTC").add(1 calendar month, zone: "UTC").toISO()',
    ]),
    [
      "2027-02-28",
      "2028-02-29",
      "2027-03-31",
      "2027-03-28",
      "2027-02-28",
      "2027-03-01",
      "2025-02-28T09:00",
      "2028-02-29T09:00",
      "2027-02-05",
      "2027-02-28T09:00:00Z",
    ],
  );
  const refused =
    "2027-01-31 moved by 1 calendar month lands on day 31, but February 2027 has 28 days, and 'overflow: \"reject\"' refuses that. Leave out the option to take the last day of the month.";
  assert.deepEqual(
    failure(['say toDate("2027-01-31").add(1 calendar month, overflow: "reject")']),
    ["TSR063", refused],
  );
  assert.deepEqual(
    failure(['say toDateTime("2027-01-31T09:00").add(1 calendar month, overflow: "reject")']),
    ["TSR063", refused],
  );
  for (const call of [
    'toDateTime("2027-01-31T09:00").toAbsoluteDateTime(zone: "Europe/Amsterdam").add(1 calendar month, zone: "Europe/Amsterdam", overflow: "reject")',
    '(1 calendar month).toDuration(from: toDateTime("2027-01-31T09:00"), zone: "Europe/Amsterdam", overflow: "reject")',
  ])
    assert.deepEqual(failure([`say ${call}`]), ["TSR063", refused]);
  assert.deepEqual(
    failure(['say toDateTime("2024-02-29T09:00").add(1 calendar year, overflow: "reject")']),
    [
      "TSR063",
      "2024-02-29 moved by 1 calendar year lands on day 29, but February 2025 has 28 days, and 'overflow: \"reject\"' refuses that. Leave out the option to take the last day of the month.",
    ],
  );
});

test("the compiler checks zones, options, and amounts that it knows", () => {
  assert.deepEqual(
    diagnostics([
      'let a = getDateTime().toAbsoluteDateTime(zone: "Europe/Amsterdan")',
      'let zone = "Europe/Amsterdam"',
      "let b = getAbsoluteDateTime().toDateTime(zone: zone)",
      'let c = getDateTime().toAbsoluteDateTime(zone: "+02:00")',
    ]),
    [
      [
        "TSV043",
        '"Europe/Amsterdan" is not a time zone that this compiler knows. Write an IANA zone name such as "Europe/Amsterdam" or "America/New_York", or "UTC".',
      ],
      [
        "TSV043",
        "'zone:' takes the name of a time zone written as text, such as 'zone: \"Europe/Amsterdam\"' or 'zone: \"UTC\"'. The Player records the rules of each zone a script names when the session starts, so the name cannot be computed while the script runs.",
      ],
      [
        "TSV043",
        '"+02:00" is not a time zone that this compiler knows. Write an IANA zone name such as "Europe/Amsterdam" or "America/New_York", or "UTC".',
      ],
    ],
  );
  assert.deepEqual(
    diagnostics([
      'let d = getDateTime().toAbsoluteDateTime(disambiguation: "first")',
      'let e = getDate().add(1 calendar month, overflow: "clamp")',
      'let f = getDate().add(1 calendar day, zone: "UTC")',
      "let g = getDate().add(1 day)",
      "let h = getDateTime().add(1 calendar day + 1 h)",
      'let i = getAbsoluteDateTime().add(1 h, zone: "UTC")',
      "let j = getAbsoluteDateTime() + 1 calendar month",
      "let k = (1 calendar month).toDuration()",
      "let l = (1 calendar month).toDuration(from: getDate())",
      'let m = getDateTime().toAbsoluteDateTime("UTC")',
      "let n = getDate().add()",
      "let o = (1 h).toDuration(from: getDateTime())",
    ]),
    [
      [
        "TSV043",
        '\'disambiguation:\' takes "compatible", "earlier", "later", or "reject", not "first".',
      ],
      ["TSV043", '\'overflow:\' takes "constrain" or "reject", not "clamp".'],
      ["TSV022", "add() has no option 'zone:'. Its options are 'overflow:'."],
      [
        "TSV043",
        "add() on a date takes a calendar duration, such as '1 calendar day', but this is a duration.",
      ],
      [
        "TSV043",
        "A date and time moves only by calendar units, not by 1 calendar day 1 hour. Convert it with toAbsoluteDateTime() for elapsed time.",
      ],
      [
        "TSV043",
        "add() with a duration takes no options. 'zone:', 'disambiguation:', and 'overflow:' apply to a calendar duration.",
      ],
      [
        "TSV043",
        "An absolute date and time has no calendar, so '+' cannot move it by calendar units. Use add(...), which counts them in the player's time zone, as in 'value.add(1 calendar month)'.",
      ],
      [
        "TSV020",
        "toDuration() needs its start as 'from:', as in 'span.toDuration(from: getAbsoluteDateTime())'. A calendar day or month has a length only from a start.",
      ],
      [
        "TSV043",
        "toDuration(from:) starts at a date and time or an absolute date and time, but this is a date. Give the date a clock time, as in 'toDateTime(day, toTime(\"00:00\"))'.",
      ],
      [
        "TSV020",
        "toAbsoluteDateTime() takes only the options 'zone:' and 'disambiguation:', each with its name.",
      ],
      ["TSV020", "add() takes one duration or calendar duration, as in 'add(1 calendar day)'."],
      ["TSV043", "A duration has no method 'toDuration'."],
    ],
  );
  // A receiver the compiler cannot know still takes its zone as text, as the Player records it before the script runs.
  assert.deepEqual(
    diagnostics([
      "function convert(moment, zone) {",
      "    return moment.toDateTime(zone: zone)",
      "}",
    ]).map(([code]) => code),
    ["TSV043"],
  );
  // A date that may be null takes 'add' once it is checked.
  assert.deepEqual(
    diagnostics(["function move(value: date?) {", "    say value.add(1 calendar day)", "}"]),
    [["TSV043", "'value' may be null. Check it first: if value != null { ... }"]],
  );
  // `add` on a date or time value is not a collection's `add`, so a union of both has neither.
  for (const amount of ["1 day", "dynamic(1 day)"])
    assert.deepEqual(
      diagnostics([
        DYNAMIC + "function move(value: absoluteDateTime | integer[]) {",
        `    value.add(${amount})`,
        "}",
      ]),
      [
        [
          "TSV043",
          "'value' may be an absolute date and time. Check it first: if value is integer[] { ... }",
        ],
      ],
    );
  assert.deepEqual(
    diagnostics(["let t = getAbsoluteDateTime() - 1 calendar month"])[0]?.[1],
    "An absolute date and time has no calendar, so '-' cannot move it by calendar units. Use add(...), which counts them in the player's time zone, as in 'value.add(-1 calendar month)'.",
  );
});

test("values the compiler cannot know are checked when the script runs", () => {
  const at = 'toDateTime("2026-10-04T12:00")';
  for (const [line, code, message] of [
    [
      `say ${at}.toAbsoluteDateTime(disambiguation: dynamic("sideways"))`,
      "TSR059",
      '\'disambiguation:\' takes "compatible", "earlier", "later", or "reject", not "sideways".',
    ],
    [
      `say toDate("2026-10-04").add(1 calendar day, overflow: dynamic(1))`,
      "TSR059",
      '\'overflow:\' takes "constrain" or "reject", not 1.',
    ],
    [
      `say toDate("2026-10-04").add(dynamic(1 day))`,
      "TSR009",
      "A date moves only by calendar units, such as '1 calendar day', not by 1 day.",
    ],
    [
      `say ${at}.add(dynamic("1 day"))`,
      "TSR059",
      "add() takes a duration or a calendar duration, such as '1 calendar day', not text (string).",
    ],
    [
      'say getAbsoluteDateTime().add(dynamic(1 h), zone: "UTC")',
      "TSR028",
      "add() with a duration takes no options. 'zone:', 'disambiguation:', and 'overflow:' apply to a calendar duration, not to 1 hour.",
    ],
    [
      `say (1 calendar day).toDuration(from: dynamic(toDate("2026-10-04")))`,
      "TSR059",
      "toDuration(from:) starts at a date and time or an absolute date and time, not a date. Give the date a clock time, as in 'toDateTime(day, toTime(\"00:00\"))'.",
    ],
  ] as const)
    assert.deepEqual(failure([DYNAMIC + line]), [code, message], line);
  assert.deepEqual(
    says([
      DYNAMIC +
        `say dynamic(1 calendar day).toDuration(from: dynamic(toDateTime("2026-11-01T00:00"))) / 1 h`,
      `say dynamic(${at}).add(dynamic(1 calendar day), overflow: dynamic("reject")).toISO()`,
    ]),
    ["25", "2026-10-05T12:00"],
  );
});

test("a zone whose rules the host did not record fails when it is used", () => {
  const lines = [
    'say "before"',
    'say getAbsoluteDateTime().toDateTime(zone: "Europe/Amsterdam").toISO()',
  ];
  const { result } = start([...lines, "exit"].join("\n"), { ...AMSTERDAM });
  assert.deepEqual(
    result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["before"],
  );
  assert.deepEqual(
    [result.snapshot.failure?.code, result.snapshot.failure?.message],
    [
      "TSR063",
      "This Player recorded no rules for the time zone 'Europe/Amsterdam', so the date and time cannot be converted. Run the script in a Player that knows this zone.",
    ],
  );
  // A context holds only the zones the script names.
  const plan = compileValidPlan('say "x"\nexit');
  assert.throws(
    () => createImmediatePacingRuntimeSnapshot(plan, { temporalContext: NEW_YORK_PLAYER }),
    /temporalContext is malformed: The script names no time zone Europe\/Amsterdam\./u,
  );
  assert.throws(
    () =>
      createImmediatePacingRuntimeSnapshot(plan, {
        temporalContext: { ...AMSTERDAM, namedZones: [NEW_YORK_ZONE, NEW_YORK_ZONE] },
      }),
    /The named zone America\/New_York appears twice\./u,
  );
});

test("a restored session keeps the rules of named zones while the player's zone changes at Continue", () => {
  const plan = compileValidPlan(
    [
      'let midnight = toDateTime("2026-12-31T00:00")',
      'say midnight.toAbsoluteDateTime(zone: "Europe/Amsterdam").toISO()',
      "say midnight.toAbsoluteDateTime().toISO()",
      "wait 5 s",
      'say midnight.toAbsoluteDateTime(zone: "Europe/Amsterdam").toISO()',
      "say midnight.toAbsoluteDateTime().toISO()",
      "exit",
    ].join("\n"),
  );
  const restore = (snapshot: RuntimeSnapshot): RuntimeSnapshot =>
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot))).snapshot;
  const events: string[] = [];
  const said = (operation: { readonly events: readonly { kind: string; text?: string }[] }) => {
    for (const event of operation.events) if (event.kind === "say") events.push(event.text!);
  };
  const first = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, {
      temporalContext: NEW_YORK_PLAYER,
      wallClockMs: NOW,
    }),
  );
  said(first);
  let snapshot = restore(first.snapshot);
  assert.deepEqual(snapshot.temporalCaptures[0]?.context.namedZones, [AMSTERDAM.zone]);

  // The player continues in Amsterdam; the Player records the player's zone and the named zone again.
  const moved: TemporalContext = { ...AMSTERDAM, namedZones: [AMSTERDAM.zone] };
  const continued = recordContinueCapture(plan, snapshot, {
    wallClockMs: NOW + 3_600_000,
    temporalContext: moved,
  });
  assert.equal(continued.outcome.kind, "recorded");
  snapshot = restore(continued.snapshot);
  const observed = observeTime(plan, snapshot, 5_000);
  assert.equal(observed.outcome.kind, "observed");
  const finished = run(plan, restore(observed.snapshot));
  said(finished);
  assert.equal(finished.snapshot.failure, null);
  // The named zone keeps its moment; the player's zone follows the player.
  assert.deepEqual(events, [
    "2026-12-30T23:00:00Z",
    "2026-12-31T05:00:00Z",
    "2026-12-30T23:00:00Z",
    "2026-12-30T23:00:00Z",
  ]);
  // A Continue may not bring the rules of a zone the script does not name, and a checkpoint may not hold them.
  assert.equal(
    recordContinueCapture(plan, snapshot, { wallClockMs: NOW, temporalContext: AMSTERDAM_PLAYER })
      .outcome.kind,
    "invalidCapture",
  );
  // EVIDENCE: fixture: the parsed checkpoint was serialized from a valid snapshot of this plan.
  const checkpoint = JSON.parse(serializeCheckpoint(createCheckpoint(plan, snapshot))) as {
    snapshot: { temporalCaptures: { context: { namedZones: ZoneRules[] } }[] };
  };
  checkpoint.snapshot.temporalCaptures[0]!.context.namedZones.push(NEW_YORK_ZONE);
  assertCheckpointRejected(checkpoint, "TSK002");
});

test("plan validation takes the named zones unique, sorted, and without UTC", () => {
  const plan: InstructionPlan = compileValidPlan(
    'say getAbsoluteDateTime().toDateTime(zone: "Europe/Amsterdam")\nsay getAbsoluteDateTime().toDateTime(zone: "America/New_York")\nexit',
  );
  assert.deepEqual(plan.timeZones, ["America/New_York", "Europe/Amsterdam"]);
  const errorsOf = (timeZones: unknown) =>
    validateInstructionPlan({ ...plan, timeZones }).errors.map((error) => [error.code, error.path]);
  assert.deepEqual(errorsOf(["Europe/Amsterdam", "America/New_York"]), [
    ["TSC002", "$.timeZones[1]"],
  ]);
  assert.deepEqual(errorsOf(["Europe/Amsterdam", "Europe/Amsterdam"]), [
    ["TSC002", "$.timeZones[1]"],
  ]);
  assert.deepEqual(errorsOf(["UTC"]), [["TSC002", "$.timeZones[0]"]]);
  assert.deepEqual(errorsOf(["+02:00"]), [["TSC002", "$.timeZones[0]"]]);
  assert.deepEqual(errorsOf(undefined), [["TSC002", "$.timeZones"]]);
});

test("the host records the rules of the named zones under the names the script writes", () => {
  // Real rules from this host's time-zone data: Lord Howe Island moves its clocks by half an hour, and Samoa skipped
  // 30 December 2011.
  const context = captureTemporalContext("Europe/Amsterdam", "en-GB", [
    "Australia/Lord_Howe",
    "Pacific/Apia",
    "US/Eastern",
  ]);
  assert.deepEqual(
    context.namedZones?.map((zone) => zone.name),
    ["Australia/Lord_Howe", "Pacific/Apia", "US/Eastern"],
  );
  assert.deepEqual(
    says(
      [
        'say (1 calendar day).toDuration(from: toDateTime("2026-04-04T12:00"), zone: "Australia/Lord_Howe") / 1 h',
        'say toDateTime("2011-12-30T12:00").toAbsoluteDateTime(zone: "Pacific/Apia").toDateTime(zone: "Pacific/Apia").toISO()',
        'say toDateTime("2026-12-31T00:00").toAbsoluteDateTime(zone: "US/Eastern").toISO()',
      ],
      context,
    ),
    ["24.5", "2011-12-31T12:00", "2026-12-31T05:00:00Z"],
  );
  assert.equal(
    failure(
      [
        'say toDateTime("2011-12-30T12:00").toAbsoluteDateTime(zone: "Pacific/Apia", disambiguation: "reject")',
      ],
      captureTemporalContext("Europe/Amsterdam", "en-GB", ["Pacific/Apia"]),
    )[0],
    "TSR063",
  );
  // The Player leaves out a zone its browser does not know; the script then fails only where it uses that zone.
  const player = playerTemporalContext({ timeZone: "Europe/Amsterdam", locale: "en-GB" }, [
    "America/New_York",
    "Mars/Olympus_Mons",
  ]);
  assert.equal(player.zone.name, "Europe/Amsterdam");
  assert.deepEqual(
    player.namedZones?.map((zone) => zone.name),
    ["America/New_York"],
  );
});
