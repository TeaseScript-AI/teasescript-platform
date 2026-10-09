import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { withValidationTestStatistics } from "../src/validation-testing.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import type { RuntimeSnapshot } from "../src/runtime/state.js";
import type { TemporalContext } from "../src/temporal.js";
import { assertCheckpointRejected } from "./helpers/checkpoint-rejection.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { AMSTERDAM } from "./helpers/temporal-fixtures.js";

/** Hides a value's type and value from the compiler, so a check reaches the runtime. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

function start(source: string, temporalContext?: TemporalContext) {
  const plan = compileValidPlan(source);
  const snapshot = createImmediatePacingRuntimeSnapshot(
    plan,
    temporalContext === undefined ? {} : { temporalContext },
  );
  return { plan, result: run(plan, snapshot) };
}

function says(source: string, temporalContext?: TemporalContext): string[] {
  const { result } = start(source, temporalContext);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return result.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

function compileErrors(source: string): string[] {
  const compiled = compileSource(source);
  assert.equal(compiled.plan, null, `${JSON.stringify(source)} must not compile`);
  return compiled.diagnostics.map((diagnostic) => diagnostic.code);
}

function runtimeFailure(source: string): string | undefined {
  return start(source).result.snapshot.failure?.code;
}

function diagnostics(source: string): [string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
  ]);
}

test("days and weeks are exact, calendar units follow 'calendar', and both show their parts", () => {
  assert.deepEqual(
    says(
      [
        "say 1 day",
        "say 2 weeks",
        "say 1 w",
        "say 2 days + 6 h",
        "say 1 day / 2",
        "say 1 calendar day",
        "say 2 calendar day",
        "say 2 calendar weeks",
        "say 1 calendar w",
        "say 1 calendar year",
        "say 18 calendar months",
        "say 0.5 calendar years",
        "say 1 calendar mo",
        "say 1 calendar y + 2 calendar mo + 3 calendar d + 4 h",
        "say 1 calendar day - 2 h",
        "exit",
      ].join("\n"),
    ),
    [
      "1 day",
      "14 days",
      "7 days",
      "2 days 6 hours",
      "12 hours",
      "1 calendar day",
      "2 calendar days",
      "14 calendar days",
      "7 calendar days",
      "1 calendar year",
      "1 calendar year 6 calendar months",
      "6 calendar months",
      "1 calendar month",
      "1 calendar year 2 calendar months 3 calendar days 4 hours",
      "1 calendar day -2 hours",
    ],
  );
  // Calendar months and days are whole after normalizing.
  for (const source of [
    "let a = 1.5 calendar days\nexit",
    "let a = 1.5 calendar weeks\nexit",
    "let a = 1 calendar month * 1.5\nexit",
    "let a = 1 calendar day / 2\nexit",
  ])
    assert.ok(compileErrors(source).includes("TSV043"), source);
  assert.equal(runtimeFailure(`${DYNAMIC}let a = 1 calendar month * dynamic(1.5)\nexit`), "TSR009");
  assert.deepEqual(
    says(
      "say 2 calendar months / 2\nsay 2 * 1 calendar week\nsay 1 calendar month - 1 calendar month\nexit",
    ),
    ["1 calendar month", "14 calendar days", "0 calendar days"],
  );
  assert.deepEqual(diagnostics("let a = 1.5 calendar days\nexit"), [
    [
      "TSV043",
      "1.5 calendar days is not a whole number of days. Use whole calendar days, or exact hours such as '36 h'.",
    ],
  ]);
  // A month or a year has no fixed length, so it needs 'calendar'; 'calendar' needs a unit after it.
  assert.deepEqual(diagnostics("let a = 3 months\nexit"), [
    ["TSP033", "A month has no fixed length. Write '3 calendar months'."],
  ]);
  assert.deepEqual(diagnostics("let a = 1 y\nexit"), [
    ["TSP033", "A year has no fixed length. Write '1 calendar y'."],
  ]);
  // After a name, a member, a call, or parentheses too, also in an interpolation and over lines in parentheses.
  const named = "let n = 3\nlet p = { delay: 3 }\nfunction f {\n  return 3\n}\n";
  for (const [source, message] of [
    ["wait n months", "A month has no fixed length. Write 'n calendar months'."],
    ["let a = p.delay years", "A year has no fixed length. Write 'p.delay calendar years'."],
    ["let a = f() month", "A month has no fixed length. Write 'f() calendar month'."],
    ['let a = "${n months}"', "A month has no fixed length. Write 'n calendar months'."],
    [
      "let a = (\n  n + 1\n) months",
      "A month has no fixed length. Write '(n + 1) calendar months'.",
    ],
  ] as const)
    assert.deepEqual(diagnostics(`${named}${source}\nexit`), [["TSP033", message]], source);
  assert.deepEqual(diagnostics("let a = 2 calendar\nexit"), [
    ["TSP033", "Expected a calendar unit after 'calendar': day, week, month, or year."],
  ]);
  // Elsewhere 'calendar' is an ordinary name.
  assert.deepEqual(says("let calendar = { month: 3 }\nsay calendar.month * 2\nexit"), ["6"]);
});

test("a calendar duration stays one; durations compare by length, calendar durations within one family", () => {
  assert.deepEqual(
    says(
      [
        "say 1 week == 7 days",
        "say 1 day == 24 h",
        "say 1 calendar week == 7 calendar days",
        "say 1 calendar year == 12 calendar months",
        "say 1 calendar month + 1 day == 1 day + 1 calendar month",
        "say (2 days + 6 h) / 1 h",
        "say (2 days + 6 h) / 1 day",
        "say 18 calendar months / 1 calendar year",
        "say 1 day >= 24 h",
        "say 3 calendar days > 1 calendar day",
        "exit",
      ].join("\n"),
    ),
    ["true", "true", "true", "true", "true", "54", "2.25", "1.5", "true", "true"],
  );
  // A calendar duration never equals a duration, also when both are zero, which the compiler warns about where it
  // sees both types; a cancelled calendar duration stays one.
  assert.deepEqual(
    says(
      `${DYNAMIC}let zero = dynamic(1 calendar month - 1 calendar month)\nsay dynamic(1 calendar day) == dynamic(1 day)\nsay zero == dynamic(0 s)\nsay zero is calendarDuration\nexit`,
    ),
    ["false", "false", "true"],
  );
  assert.deepEqual(diagnostics("let x = 1 calendar day == 1 day\nexit"), [
    [
      "TSV046",
      "This value holds a calendar duration, never a duration, so this comparison is always false.",
    ],
  ]);
  assert.deepEqual(
    says(
      [
        "let span = 1 calendar year + 2 calendar months + 3 calendar days + 90 min",
        'say "${span.months} ${span.days} ${span.exactOffset}"',
        "exit",
      ].join("\n"),
    ),
    ["14 3 1 hour 30 minutes"],
  );
  assert.deepEqual(diagnostics("let x = 1 calendar day >= 24 h\nexit"), [
    [
      "TSV043",
      "'>=' cannot compare a calendar duration with a duration. A calendar day or month has no fixed length. Compare two calendar durations, or two durations.",
    ],
  ]);
  assert.deepEqual(diagnostics("let span = 2 days\nlet n = span.days\nexit"), [
    ["TSV043", "A duration has no property 'days'. Divide it by a unit, as in 'span / 1 day'."],
  ]);
  for (const source of [
    "let x = 1 calendar month >= 30 calendar days\nexit",
    "let x = 1 calendar week / 2 h\nexit",
    "let x = 1 calendar month * 1.5\nexit",
    "let x = (1 calendar month).hours\nexit",
  ])
    assert.ok(compileErrors(source).includes("TSV043"), source);
  // A zero of any family divides by zero, as `1 s / 0 s` does.
  assert.deepEqual(compileErrors("let x = 1 calendar day / 0 calendar days"), ["TSV050"]);
  assert.equal(
    runtimeFailure(`${DYNAMIC}let x = dynamic(1 calendar day) >= dynamic(24 h)\nexit`),
    "TSR009",
  );
  assert.equal(
    runtimeFailure(
      `${DYNAMIC}let x = dynamic(1 calendar day + 1 h) < dynamic(2 calendar days)\nexit`,
    ),
    "TSR009",
  );
  assert.equal(runtimeFailure(`${DYNAMIC}let n = dynamic(1 day).days\nexit`), "TSR017");
  // A switch matches as == does: `1 week` and `7 days` are one case value, and so are `1 d` and `24 h`.
  assert.deepEqual(
    says(
      [
        "function describe(span: duration) {",
        "    switch span {",
        '        case 7 days { say "a week" }',
        '        case 24 h { say "a day" }',
        "    }",
        "}",
        "describe(1 week)",
        "describe(1 day)",
        "exit",
      ].join("\n"),
    ),
    ["a week", "a day"],
  );
  assert.deepEqual(compileErrors("switch 1 week {\n    case 1 week {}\n    case 1 d, 24 h {}\n}"), [
    "TSV048",
  ]);
});

test("sort, min, max, and set operations order durations by length and calendar durations by their parts", () => {
  assert.deepEqual(
    says(
      [
        "let days = [3 days, 1 week, 1 d]",
        "days.sort()",
        "say days",
        "let months = [1 calendar year, 1 calendar month, 18 calendar months]",
        "months.sort()",
        "say months",
        "say min(1 calendar month, 1 calendar year)",
        "say max(2 weeks, 10 days)",
        "say [1 day, 2 days].union([24 h, 3 days])",
        "say [1 calendar day, 1 calendar month].intersection([1 calendar mo, 2 calendar days])",
        // A set holds equal durations once: an exact one by its length, a calendar one by its parts.
        "say set[1 day, 24 h, 1 week, 7 days].length",
        "say set[1 calendar day, 1 calendar week, 7 calendar days, 12 calendar months, 1 calendar year].length",
        "exit",
      ].join("\n"),
    ),
    [
      "[1 day, 3 days, 7 days]",
      "[1 calendar month, 1 calendar year, 1 calendar year 6 calendar months]",
      "1 calendar month",
      "14 days",
      "[1 day, 2 days, 3 days]",
      "[1 calendar month]",
      "2",
      "3",
    ],
  );
  // Calendar durations of different families, or beside exact ones, have no order.
  for (const source of [
    `${DYNAMIC}let spans = [dynamic(1 calendar day), dynamic(24 h)]\nspans.sort()\nexit`,
    `${DYNAMIC}let spans = [dynamic(1 calendar month), dynamic(30 calendar days)]\nspans.sort()\nexit`,
  ])
    assert.equal(runtimeFailure(source), "TSR060", source);
  assert.equal(
    runtimeFailure(`${DYNAMIC}say min(dynamic(1 calendar day), dynamic(24 h))\nexit`),
    "TSR059",
  );
  // A zero winner does not hide the other arguments' families.
  assert.ok(
    compileErrors("say min(0 calendar days, 1 calendar day, 1 calendar month)\nexit").includes(
      "TSV043",
    ),
  );
  assert.equal(
    runtimeFailure(
      `${DYNAMIC}say max(0 calendar days, dynamic(-1 calendar day), dynamic(-1 calendar month))\nexit`,
    ),
    "TSR059",
  );
});

test("dates move by calendar units with clamping, and subtract to calendar days", () => {
  assert.deepEqual(
    says(
      [
        'say (toDate("2026-01-31") + 1 calendar month).toISO()',
        'say (toDate("2028-01-31") + 1 calendar month).toISO()',
        'say (toDate("2028-02-29") + 1 calendar year).toISO()',
        'say (toDate("2026-10-04") + 2 calendar weeks + 1 calendar day).toISO()',
        'say (toDate("2026-03-31") - 1 calendar month).toISO()',
        // Clamping is not undone: January 31 plus one month minus one month is January 28.
        'say (toDate("2026-01-31") + 1 calendar month - 1 calendar month).toISO()',
        'say toDate("2026-10-09") - toDate("2026-10-04")',
        'say (toDate("2026-10-04") - toDate("2026-10-09")).days',
        'say toDate("2026-10-11") - toDate("2026-10-04") >= 7 calendar days',
        "say (2 calendar years).months",
        "exit",
      ].join("\n"),
    ),
    [
      "2026-02-28",
      "2028-02-29",
      "2029-02-28",
      "2026-10-19",
      "2026-02-28",
      "2026-01-28",
      "5 calendar days",
      "-5",
      "true",
      "24",
    ],
  );
  // A date moves only by calendar units, even when an exact duration is a whole number of days.
  assert.deepEqual(diagnostics('let d = toDate("2026-10-04") + 1 day\nexit'), [
    ["TSV043", "A date moves only by calendar units. Write '1 calendar day'."],
  ]);
  assert.deepEqual(diagnostics('let d = toDate("2026-10-04") + 2 h\nexit'), [
    ["TSV043", "A date moves only by calendar units, such as '1 calendar day'."],
  ]);
  assert.deepEqual(diagnostics('let d = toDate("2026-10-04") + (1 calendar month + 2 h)\nexit'), [
    [
      "TSV043",
      "A date moves only by calendar units, not by 1 calendar month 2 hours. A date has no clock time, so leave out the 2 hours.",
    ],
  ]);
  // A compound assignment checks a known calendar duration as the operator does.
  for (const [declaration, kind] of [
    ['let d = toDate("2026-10-09")', "A date"],
    ['let d = toDateTime("2026-10-09T18:00")', "A date and time"],
  ])
    for (const operator of ["+=", "-="]) {
      const diagnostics = compileSource(
        `${declaration}\nd ${operator} 1 calendar day + 1 h\nexit`,
      ).diagnostics;
      assert.deepEqual(
        diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message.split(",")[0]]),
        [["TSV043", `${kind} moves only by calendar units`]],
        `${declaration} ${operator}`,
      );
    }
  assert.deepEqual(
    says(
      'let d = toDate("2026-10-09")\nd += 1 calendar day\nd -= 2 calendar days\nsay d.toISO()\nexit',
    ),
    ["2026-10-08"],
  );
  for (const duration of ["dynamic(1 day)", "dynamic(1 calendar day + 2 h)"])
    assert.equal(
      runtimeFailure(`${DYNAMIC}let d = toDate("2026-10-04") + ${duration}\nexit`),
      "TSR009",
      duration,
    );
});

test("a local date and time moves only by calendar units, keeping its clock time; elapsed time goes through an absolute date and time", () => {
  assert.deepEqual(
    says(
      [
        'let dinner = toDateTime("2026-03-28T18:00")',
        "say (dinner + 1 calendar day).toISO()",
        "say (dinner + (1 calendar month + 1 calendar day)).toISO()",
        'say (toDateTime("2026-01-31T09:00") + 1 calendar month).toISO()',
        // 24 elapsed hours across the spring change in Amsterdam end at 19:00, and a calendar day there is 23 h.
        "say (dinner.toAbsoluteDateTime() + 24 h).toDateTime().toISO()",
        "say (dinner + 1 calendar day).toAbsoluteDateTime() - dinner.toAbsoluteDateTime()",
        "exit",
      ].join("\n"),
      AMSTERDAM,
    ),
    ["2026-03-29T18:00", "2026-04-29T18:00", "2026-02-28T09:00", "2026-03-29T19:00", "23 hours"],
  );
  const dinner =
    'let dinner = toDateTime("2026-03-28T18:00")\nlet lunch = toDateTime("2026-03-28T12:00")\n';
  assert.deepEqual(diagnostics(`${dinner}let later = dinner + 2 h\nexit`), [
    [
      "TSV043",
      "A date and time has no time zone, so it cannot move by elapsed time. Convert it first, as in '(dinner.toAbsoluteDateTime() + 2 h).toDateTime()', or use calendar units to keep the clock time.",
    ],
  ]);
  assert.deepEqual(diagnostics(`${dinner}let gap = dinner - lunch\nexit`), [
    [
      "TSV043",
      "A date and time has no time zone, so one cannot be subtracted from another. Subtract their dates with 'toDate(dinner) - toDate(lunch)', or convert both with toAbsoluteDateTime() for the elapsed time.",
    ],
  ]);
  assert.ok(
    compileErrors(`${dinner}let x = dinner + (1 calendar month + 30 min)\nexit`).includes("TSV043"),
  );
  assert.deepEqual(diagnostics(`${dinner}dinner += 30 min\nexit`), [
    [
      "TSV041",
      "'dinner' holds a date and time, which has no time zone, so it cannot move by elapsed time. Use calendar units, such as '1 calendar day', or write 'dinner = (dinner.toAbsoluteDateTime() + 30 min).toDateTime()'.",
    ],
  ]);
  for (const source of [
    `${DYNAMIC}${dinner}let later = dynamic(dinner) + dynamic(2 h)\nexit`,
    `${DYNAMIC}${dinner}let gap = dynamic(dinner) - dynamic(lunch)\nexit`,
    `${DYNAMIC}${dinner}let x = dynamic(dinner) + dynamic(1 calendar month + 30 min)\nexit`,
  ])
    assert.equal(runtimeFailure(source), "TSR009", source);
});

test("an absolute date and time moves only by exact time, and elapsed-time consumers reject calendar durations", () => {
  assert.deepEqual(
    says('say (toAbsoluteDateTime("2026-10-04T12:00:00Z") + 1 week).toISO()\nexit'),
    ["2026-10-11T12:00:00Z"],
  );
  assert.deepEqual(
    diagnostics(
      'let t = toAbsoluteDateTime("2026-10-04T12:00:00Z")\nlet later = t + 1 calendar day\nexit',
    ),
    [
      [
        "TSV043",
        "An absolute date and time has no calendar. Convert it first, as in '(t.toDateTime() + 1 calendar day).toAbsoluteDateTime()'.",
      ],
    ],
  );
  assert.equal(
    runtimeFailure(
      `${DYNAMIC}let t = toAbsoluteDateTime("2026-10-04T12:00:00Z") + dynamic(1 calendar day)\nexit`,
    ),
    "TSR009",
  );
  assert.ok(compileErrors("timer 1 calendar day\nexit").length > 0);
  assert.ok(
    compileErrors("let t = timer async 10 s\nt.remaining = 1 calendar day\nexit").includes(
      "TSV041",
    ),
  );
  assert.equal(
    runtimeFailure(
      `${DYNAMIC}let t = timer async 10 s\nt.remaining = dynamic(1 calendar week)\nexit`,
    ),
    "TSR058",
  );
  assert.equal(
    runtimeFailure(`${DYNAMIC}showButton "Go", timeout: dynamic(1 calendar day)\nexit`),
    "TSR065",
  );
  assert.ok(compileErrors('playAudio(file: "a", repeat: 1 calendar day)\nexit').includes("TSV043"));
  assert.equal(
    runtimeFailure(`${DYNAMIC}playAudio(file: "a", repeat: dynamic(1 calendar day))\nexit`),
    "TSR065",
  );
});

test("calendar parts that grow past whole numbers a value can keep fail where they are computed", () => {
  for (const source of [
    `${DYNAMIC}let result = dynamic(9007199254740991 calendar days) + 1 calendar day\nexit`,
    `${DYNAMIC}let result = dynamic(9007199254740991 calendar months) * 2\nexit`,
  ])
    assert.equal(runtimeFailure(source), "TSR036", source);
});

test("folding known durations takes work in proportion to the source", () => {
  const shapes: Record<string, (steps: number) => string> = {
    "number sums": (steps) => Array<string>(steps).fill("1").join(" + "),
    "duration sums": (steps) => Array<string>(steps).fill("1 day").join(" + "),
    "duration products": (steps) => `1 day${" * 1".repeat(steps)}`,
    "right-nested sums": (steps) => `${"1 day + (".repeat(steps)}1 day${")".repeat(steps)}`,
  };
  const folds = (source: string) =>
    withValidationTestStatistics((finish) => {
      // A fixture that fails to compile would measure a different path.
      assert.notEqual(compileSource(`let x = ${source}\nexit`).plan, null, source.slice(0, 40));
      return finish().counts.staticFolds ?? 0;
    });
  for (const [name, shape] of Object.entries(shapes)) {
    const [small, large] = [folds(shape(400)), folds(shape(800))];
    // Twice the steps take at most about twice the folds; refolding each operand's subtree would take four times.
    assert.ok(large <= 2.5 * small, `${name}: ${small} folds for 400 steps, ${large} for 800`);
  }
});

test("calendar durations survive checkpoints and choices with their parts", () => {
  const plan = compileValidPlan(
    "let d = 1 calendar mo + 2 calendar d + 3 h\nlet e = 2 days\nlet pick = choose [1 calendar day, 1 calendar week]\nsay d\nsay e\nsay pick\nexit",
  );
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  const action = waiting.snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.ui.kind === "choice");
  assert.deepEqual(
    action.ui.options.map((option) => option.text),
    ["1 calendar day", "7 calendar days"],
  );
  const serialized = serializeCheckpoint(createCheckpoint(plan, waiting.snapshot));
  const restored = deserializeCheckpoint(serialized).snapshot;
  assert.deepEqual(restored, waiting.snapshot);
  const completed = completeAction(plan, restored, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "selectedOption", optionIndex: 1 },
  });
  assert.equal(completed.outcome.kind, "completed");
  assert.deepEqual(
    run(plan, completed.snapshot).events.flatMap((event) =>
      event.kind === "say" ? [event.text] : [],
    ),
    ["1 calendar month 2 calendar days 3 hours", "2 days", "7 calendar days"],
  );

  // A calendar duration keeps whole days, and an exact duration has no calendar parts.
  for (const [name, change] of [
    ["d", { days: 1.5 }],
    ["e", { days: 1 }],
  ] as const) {
    // EVIDENCE: fixture: the parsed checkpoint was serialized from a valid snapshot just above.
    const json = JSON.parse(serialized) as { snapshot: RuntimeSnapshot };
    const binding = json.snapshot.frames[0]!.bindings.find((entry) => entry.name === name);
    assert.ok(binding !== undefined && typeof binding.value === "object" && binding.value !== null);
    Object.assign(binding.value, change);
    assertCheckpointRejected(json, "TSK002");
  }
});
