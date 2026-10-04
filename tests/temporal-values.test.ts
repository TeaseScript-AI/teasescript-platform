import assert from "node:assert/strict";
import test from "node:test";

import type { InstructionPlan } from "../src/plan/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { createFreshRuntimeSnapshot, type RuntimeSnapshot } from "../src/runtime/state.js";
import { DEFAULT_PRESENTATION_SETTINGS, type TemporalContext } from "../src/temporal.js";
import { assertCheckpointRejected } from "./helpers/checkpoint-rejection.js";
import { compileSource } from "../src/compiler.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

type Mutable<T> = T extends readonly [infer First, infer Second]
  ? [Mutable<First>, Mutable<Second>]
  : T extends readonly (infer Item)[]
    ? Array<Mutable<Item>>
    : T extends object
      ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
      : T;

function utc(text: string): number {
  return Date.parse(`${text}Z`);
}

/**
 * Europe/Amsterdam in 2026 under the EU rule (summer time from 29 March to 25 October, both at 01:00 UTC), shown
 * day first with a 24-hour clock. Hand-written, so the expectations do not depend on host locale data.
 */
const AMSTERDAM: TemporalContext = {
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

/** Hides a value's type from the compiler, so a check reaches the runtime. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

function start(source: string, temporalContext?: TemporalContext) {
  const plan = compileValidPlan(source);
  const snapshot = createImmediatePacingRuntimeSnapshot(
    plan,
    temporalContext === undefined ? {} : { temporalContext },
  );
  return { plan, result: run(plan, snapshot) };
}

function sayTexts(events: readonly { readonly kind: string; readonly text?: string }[]): string[] {
  return events.flatMap((event) => (event.kind === "say" ? [event.text!] : []));
}

function runSays(source: string, temporalContext?: TemporalContext): string[] {
  const { result } = start(source, temporalContext);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return sayTexts(result.events);
}

function failureOf(source: string, temporalContext?: TemporalContext) {
  return start(source, temporalContext).result.snapshot.failure;
}

test("ISO text converts to date and time values whose fields, ISO text, and Unix values follow the calendar", () => {
  const moment = Date.UTC(2026, 9, 4, 12, 30);
  assert.deepEqual(
    runSays(
      [
        'let d = toDate("2026-10-04")',
        'let t = toTime("14:30:05.250")',
        "let dt = toDateTime(d, t)",
        'let ts = toTimestamp("2026-10-04T14:30:00+02:00")',
        "say d.year",
        "say d.month",
        "say d.day",
        "say d.weekday",
        "say d.weekdayNumber",
        "say t.millisecond",
        "say dt.toISO()",
        "say toDate(dt).toISO()",
        "say toTime(dt).toISO()",
        "say ts.toISO()",
        "say ts.toSeconds()",
        "say ts.toMilliseconds()",
        'say toTimestamp("1969-12-31T23:59:59.500Z").toSeconds()',
      ].join("\n"),
    ),
    [
      "2026",
      "10",
      "4",
      "Sunday",
      "7",
      "250",
      "2026-10-04T14:30:05.250",
      "2026-10-04",
      "14:30:05.250",
      "2026-10-04T12:30:00Z",
      String(moment / 1_000),
      String(moment),
      "-1",
    ],
  );
});

test("text known only at runtime converts, falls back to default:, or fails with a reason", () => {
  assert.deepEqual(
    runSays(
      DYNAMIC +
        [
          'say toDate(dynamic("2026-10-04")).toISO()',
          'say toDate(dynamic("2026-02-30"), default: toDate("2000-01-01")).toISO()',
          'let fallback = toTimestamp("2000-01-01T00:00:00Z")',
          'say toTimestamp(dynamic("2026-10-04T12:30"), default: fallback).toISO()',
        ].join("\n"),
    ),
    ["2026-10-04", "2000-01-01", "2000-01-01T00:00:00Z"],
  );
  const failure = failureOf(`${DYNAMIC}let day = toDate(dynamic("2026-02-30"))`);
  assert.equal(failure?.code, "TSR063");
  assert.match(failure?.message ?? "", /February 2026 has 28 days/u);
  assert.equal(failureOf(`${DYNAMIC}let day = toTime(dynamic("2:30 PM"))`)?.code, "TSR063");
});

test("say, interpolation, and format methods use the captured presentation; collections use fixed notation", () => {
  const source = [
    'let d = toDate("2026-10-04")',
    'let dt = toDateTime("2026-10-04T18:30:05")',
    'let ts = toTimestamp("2026-10-04T16:30:00Z")',
    "say d",
    'say "Dinner at ${dt}"',
    "say ts",
    "say dt.formatDate()",
    "say dt.formatTime()",
    'let mixed: (date | time | datetime | timestamp)[] = [d, toTime("14:30"), dt, ts]',
    "say mixed",
  ].join("\n");
  assert.deepEqual(runSays(source, AMSTERDAM), [
    "4-10-2026",
    "Dinner at 4-10-2026, 18:30:05",
    "4-10-2026, 18:30",
    "4-10-2026",
    "18:30:05",
    "[<date 2026-10-04>, <time 14:30>, <datetime 2026-10-04 18:30:05>, <timestamp 2026-10-04T16:30:00Z>]",
  ]);
  // Without a captured context a session shows UTC in locale-neutral text.
  assert.deepEqual(runSays(source).slice(0, 3), [
    "2026-10-04",
    "Dinner at 2026-10-04 18:30:05",
    "2026-10-04 16:30",
  ]);
});

test("choose shows date options in the captured presentation and returns the chosen date", () => {
  const { plan, result } = start(
    'let picked = choose [toDate("2026-10-04"), toDate("2026-10-05")]\nsay picked.toISO()',
    AMSTERDAM,
  );
  const action = result.snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.ui.kind === "choice");
  assert.deepEqual(
    action.ui.options.map((option) => option.text),
    ["4-10-2026", "5-10-2026"],
  );
  const completed = completeAction(plan, result.snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "selectedOption", optionIndex: 1 },
  });
  assert.equal(completed.outcome.kind, "completed");
  assert.deepEqual(sayTexts(run(plan, completed.snapshot).events), ["2026-10-05"]);
});

test("ordering, equality, and set membership compare kind and value", () => {
  assert.deepEqual(
    runSays(
      [
        'let d = toDate("2026-10-04")',
        'say d < toDate("2026-10-05")',
        'say toTime("23:59") > toTime("00:00")',
        'say toDateTime("2026-10-04T23:00") < toDateTime("2026-10-05T01:00")',
        'say toTimestamp("2026-10-04T12:00:00Z") == toTimestamp("2026-10-04T14:00:00+02:00")',
        'say d == toDate("2026-10-04")',
        'let days = set[d, toDate("2026-10-04"), toDate("2026-10-05")]',
        "say days.length",
        'say days.contains(toDate("2026-10-04"))',
        'say [d] == [toDate("2026-10-04")]',
      ].join("\n"),
    ),
    ["true", "true", "true", "true", "true", "2", "true", "true"],
  );
  const failure = failureOf(
    `${DYNAMIC}let wrong = dynamic(toDate("2026-10-04")) < dynamic(toTime("14:30"))`,
  );
  assert.equal(failure?.code, "TSR009");
});

test("exact durations move datetimes through the captured zone and timestamps by elapsed time", () => {
  assert.deepEqual(
    runSays(
      [
        // 24 elapsed hours after 18:00 on the eve of summer time is 19:00; the difference stays 24 h.
        'let dinner = toDateTime("2026-03-28T18:00")',
        "say (dinner + 24 h).toISO()",
        "say (dinner + 24 h) - dinner",
        // A result in the repeated autumn hour is read back as its earlier occurrence.
        'let late = toDateTime("2026-10-24T03:30")',
        "say (late + 24 h).toISO()",
        "say (late + 24 h) - late",
        'let start = toTimestamp("2026-10-04T12:00:00Z")',
        "say (start + 90 min).toISO()",
        "say (start + 90 min) - start",
        "say (start + 0.4 ms).toISO()",
        "say dinner.toTimestamp().toISO()",
        'say toTimestamp("2026-03-29T01:30:00Z").toDateTime().toISO()',
        // 02:30 does not exist on 29 March; it moves forward by the skipped hour.
        'say toDateTime("2026-03-29T02:30").toTimestamp().toISO()',
      ].join("\n"),
      AMSTERDAM,
    ),
    [
      "2026-03-29T19:00",
      "24 h",
      "2026-10-25T02:30",
      "23 h",
      "2026-10-04T13:30:00Z",
      "1 h 30 min",
      "2026-10-04T12:00:00Z",
      "2026-03-28T17:00:00Z",
      "2026-03-29T03:30",
      "2026-03-29T01:30:00Z",
    ],
  );
  const failure = failureOf('let x = toDateTime("2101-07-01T12:00").toTimestamp()', AMSTERDAM);
  assert.equal(failure?.code, "TSR063");
  assert.match(failure?.message ?? "", /1970 through 2099/u);
});

test("a checkpoint keeps temporal values and the captured context, and rejects malformed ones", () => {
  const plan = compileValidPlan(
    'let d = toDate("2026-10-04")\nlet s = set[d, toDate("2026-10-05")]\nwait 1 s\nsay d\nsay s',
  );
  const waiting = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { temporalContext: AMSTERDAM }),
  );
  assert.equal(waiting.snapshot.status, "waiting");
  const serialized = serializeCheckpoint(createCheckpoint(plan, waiting.snapshot));
  const restored = deserializeCheckpoint(serialized);
  assert.deepEqual(restored.snapshot, waiting.snapshot);
  const resumed = finish(plan, restored.snapshot);
  assert.deepEqual(resumed, ["4-10-2026", "[<date 2026-10-04>, <date 2026-10-05>]"]);
  assert.deepEqual(finish(plan, waiting.snapshot), resumed);

  const corrupt = (mutate: (snapshot: Mutable<RuntimeSnapshot>) => void) => {
    // EVIDENCE: fixture: the parsed checkpoint was serialized from a valid runtime snapshot just above.
    const json = JSON.parse(serialized) as { snapshot: Mutable<RuntimeSnapshot> };
    mutate(json.snapshot);
    assertCheckpointRejected(json, "TSK002");
  };
  const binding = (snapshot: Mutable<RuntimeSnapshot>, name: string) => {
    const found = snapshot.frames[0]!.bindings.find((entry) => entry.name === name);
    assert.ok(found !== undefined && typeof found.value === "object" && found.value !== null);
    return found.value;
  };
  corrupt((snapshot) => {
    const day = binding(snapshot, "d");
    assert.ok(day.kind === "date");
    day.month = 13;
  });
  corrupt((snapshot) => {
    const set = binding(snapshot, "s");
    assert.ok(set.kind === "set");
    set.items.push({ kind: "date", year: 2026, month: 10, day: 4 });
  });
  corrupt((snapshot) => {
    const set = binding(snapshot, "s");
    assert.ok(set.kind === "set");
    // A kind that is not text must be reported, not converted into text.
    Object.assign(set.items[0]!, { kind: { toString: null, valueOf: null } });
  });
  corrupt((snapshot) => {
    snapshot.temporalContext.zone.transitions.reverse();
  });
  corrupt((snapshot) => {
    snapshot.temporalContext.presentation.date = "{day}-{month}";
  });
});

function finish(plan: InstructionPlan, snapshot: RuntimeSnapshot): string[] {
  const observed = observeTime(plan, snapshot, 1_000);
  return sayTexts(run(plan, observed.snapshot).events);
}

test("typed storage keeps date and time kinds apart from each other and from text", () => {
  assert.deepEqual(
    runSays(
      [
        'save toDate("2026-10-04") as "day"',
        'save toTimestamp("2026-10-04T12:00:00Z") as "moment"',
        'let day: date = load "day"',
        'let moment: timestamp = load "moment"',
        "say day.toISO()",
        "say moment.toISO()",
      ].join("\n"),
    ),
    ["2026-10-04", "2026-10-04T12:00:00Z"],
  );
  const failure = failureOf('save "2026-10-04" as "day"\nlet day: date = load "day"');
  assert.notEqual(failure, null);
  assert.match(failure?.message ?? "", /a date/u);
});

test("a fresh session rejects a malformed temporal context", () => {
  const plan = compileValidPlan('say "ready"');
  for (const temporalContext of [
    { zone: AMSTERDAM.zone },
    {
      ...AMSTERDAM,
      zone: {
        ...AMSTERDAM.zone,
        transitions: [
          [1, 3_600],
          [1, 7_200],
        ],
      },
    },
    { ...AMSTERDAM, presentation: { ...AMSTERDAM.presentation, hourCycle: "h13" } },
  ])
    assert.throws(
      // Host input arrives as JSON data, which the fresh-session boundary validates.
      () => createFreshRuntimeSnapshot(plan, JSON.parse(JSON.stringify({ temporalContext }))),
      RangeError,
    );
});

test("copies of a set hold their own date members", () => {
  const compiled = compileSource(
    'let original = set[toDate("2026-10-04")]\nlet copy = original\ninspect(copy)\nsay original\nsay copy',
    { builtins: ["inspect"] },
  );
  assert.ok(compiled.plan !== null);
  const result = run(compiled.plan, createImmediatePacingRuntimeSnapshot(compiled.plan), {
    builtins: {
      inspect: (call) => {
        const set = call.positional[0];
        assert.ok(typeof set === "object" && set !== null && set.kind === "set");
        // The builtin receives its own copy, so changing it changes neither variable.
        Object.assign(set.items[0]!, { day: 5 });
        return null;
      },
    },
  });
  assert.deepEqual(sayTexts(result.events), ["[<date 2026-10-04>]", "[<date 2026-10-04>]"]);
});

test("a session keeps the context it started with, whatever the host does with its own copy", () => {
  const context = structuredClone(AMSTERDAM);
  const plan = compileValidPlan('let d = toDate("2026-10-04")\nwait 1 s\nsay d');
  const waiting = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { temporalContext: context }),
  );
  Object.assign(context.presentation, { date: "{year}/{month}/{day}" });
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, waiting.snapshot)),
  );
  assert.deepEqual(finish(plan, waiting.snapshot), ["4-10-2026"]);
  assert.deepEqual(finish(plan, restored.snapshot), ["4-10-2026"]);
  // Every restore path gives a deeply frozen context, which no later operation can change.
  const json = serializeCheckpoint(createCheckpoint(plan, waiting.snapshot));
  for (const { temporalContext: restoredContext } of [
    restoreCheckpoint(JSON.parse(json)).snapshot,
    deserializeCheckpoint(json).snapshot,
  ])
    for (const part of [
      restoredContext,
      restoredContext.zone,
      restoredContext.zone.transitions,
      restoredContext.zone.transitions[0],
      restoredContext.presentation,
      restoredContext.presentation.dayPeriods,
    ])
      assert.ok(Object.isFrozen(part));
});

test("a speaker's name may be any shown value, in the captured presentation", () => {
  const { result } = start(
    'speaker vera { firstName: toDate("2026-10-04") }\nsay as vera "hello"',
    AMSTERDAM,
  );
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  const said = result.events.find((event) => event.kind === "say");
  assert.ok(said?.kind === "say");
  assert.equal(said.speaker?.displayName, "4-10-2026");
});
