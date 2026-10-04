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

test("calendar units have every spelling, normalize weeks and years, and show their parts", () => {
  assert.deepEqual(
    says(
      [
        "say 1 day",
        "say 2 day",
        "say 2 weeks",
        "say 1 w",
        "say 1 year",
        "say 18 months",
        "say 0.5 years",
        "say 1 mo",
        "say 1 y + 2 mo + 3 d + 4 h",
        "say 1 day - 2 h",
      ].join("\n"),
    ),
    [
      "1 d",
      "2 d",
      "14 d",
      "7 d",
      "1 y",
      "1 y 6 mo",
      "6 mo",
      "1 mo",
      "1 y 2 mo 3 d 4 h",
      "1 d -2 h",
    ],
  );
  // Months and days are whole after normalizing.
  for (const source of [
    "let a = 1.5 days",
    "let a = 1.5 weeks",
    "let a = 1 month * 1.5",
    "let a = 1 day / 2",
  ])
    assert.ok(compileErrors(source).includes("TSV043"), source);
  assert.equal(runtimeFailure(`${DYNAMIC}let a = 1 month * dynamic(1.5)`), "TSR009");
  assert.deepEqual(says("say 2 months / 2\nsay 2 * 1 week"), ["1 mo", "14 d"]);
});

test("durations compare and divide within one family, and equality compares their parts", () => {
  assert.deepEqual(
    says(
      [
        "say 1 week == 7 days",
        "say 1 year == 12 months",
        "say 1 day == 24 h",
        "say 1 week >= 7 days",
        "say 18 months / 1 year",
        "say 3 days > 0 s",
        "say 90 seconds > 1 minute",
      ].join("\n"),
    ),
    ["true", "true", "false", "true", "1.5", "true", "true"],
  );
  for (const source of [
    "let x = 1 day >= 24 h",
    "let x = 1 month >= 30 days",
    "let x = 1 week / 2 h",
    "let x = 1 month * 1.5",
    "let x = 1.5 * 1 month",
    "let x = (1 month).days",
    "let x = (1 day).months",
  ])
    assert.ok(compileErrors(source).includes("TSV043"), source);
  // A zero of any family divides by zero, as `1 s / 0 s` does.
  assert.deepEqual(compileErrors("let x = 1 day / 0 days"), ["TSV050"]);
  assert.equal(runtimeFailure(`${DYNAMIC}let x = dynamic(1 day) >= dynamic(24 h)`), "TSR009");
  assert.equal(
    runtimeFailure(`${DYNAMIC}let x = dynamic(1 day + 1 h) < dynamic(2 days)`),
    "TSR009",
  );
  // A switch matches as == does: `1 week` and `7 days` are one case value, `1 day` and `24 h` two.
  assert.deepEqual(
    says(
      [
        "function describe(span: duration) {",
        "    switch span {",
        '        case 7 days { say "a week" }',
        '        case 24 h { say "24 hours" }',
        '        case 1 d { say "a day" }',
        "    }",
        "}",
        "describe(1 week)",
        "describe(1 day)",
        "describe(24 h)",
      ].join("\n"),
    ),
    ["a week", "a day", "24 hours"],
  );
  assert.deepEqual(
    compileErrors("switch 1 week {\n    case 1 week, 7 days {}\n    case 1 d, 24 h {}\n}"),
    ["TSV048"],
  );
});

test("sort, min, max, and set operations treat calendar durations by their parts", () => {
  assert.deepEqual(
    says(
      [
        "let days = [3 days, 1 week, 1 d]",
        "days.sort()",
        "say days",
        "let months = [1 year, 1 month, 18 months]",
        "months.sort()",
        "say months",
        "say min(1 month, 1 year)",
        "say max(2 weeks, 10 days)",
        "say [1 day, 1 month].union([24 h, 1 mo])",
        "say [1 day, 1 month].intersection([1 mo, 0 s])",
      ].join("\n"),
    ),
    ["[1 d, 3 d, 7 d]", "[1 mo, 1 y, 1 y 6 mo]", "1 mo", "14 d", "[1 d, 1 mo, 24 h]", "[1 mo]"],
  );
  // Durations of different families have no order, also when exact time is mixed with calendar days.
  for (const source of [
    `${DYNAMIC}let spans = [dynamic(1 day), dynamic(24 h)]\nspans.sort()`,
    `${DYNAMIC}let spans = [dynamic(1 month), dynamic(30 days)]\nspans.sort()`,
  ])
    assert.equal(runtimeFailure(source), "TSR060", source);
  assert.equal(runtimeFailure(`${DYNAMIC}say min(dynamic(1 day), dynamic(24 h))`), "TSR059");
  // A zero winner does not hide the other arguments' families.
  assert.ok(compileErrors("say min(0 s, 1 day, 1 month)").includes("TSV043"));
  assert.equal(
    runtimeFailure(`${DYNAMIC}say max(0 s, dynamic(-1 day), dynamic(-1 month))`),
    "TSR059",
  );
});

test("dates move by calendar days and months with clamping, and subtract to whole days", () => {
  assert.deepEqual(
    says(
      [
        'say (toDate("2026-01-31") + 1 month).toISO()',
        'say (toDate("2028-01-31") + 1 month).toISO()',
        'say (toDate("2028-02-29") + 1 year).toISO()',
        'say (toDate("2026-10-04") + 2 weeks + 1 day).toISO()',
        'say (toDate("2026-03-31") - 1 month).toISO()',
        // Clamping is not undone: January 31 plus one month minus one month is January 28.
        'say (toDate("2026-01-31") + 1 month - 1 month).toISO()',
        'say toDate("2026-10-09") - toDate("2026-10-04")',
        'say (toDate("2026-10-04") - toDate("2026-10-09")).days',
        "say (2 years).months",
      ].join("\n"),
    ),
    [
      "2026-02-28",
      "2028-02-29",
      "2029-02-28",
      "2026-10-19",
      "2026-02-28",
      "2026-01-28",
      "5 d",
      "-5",
      "24",
    ],
  );
  assert.ok(compileErrors('let d = toDate("2026-10-04") + 2 h').includes("TSV043"));
  assert.equal(runtimeFailure(`${DYNAMIC}let d = toDate("2026-10-04") + dynamic(2 h)`), "TSR009");
  assert.equal(runtimeFailure(`${DYNAMIC}let n = dynamic(1 day + 1 h).days`), "TSR017");
});

test("a calendar day keeps the local clock time while 24 h is elapsed time through the zone", () => {
  assert.deepEqual(
    says(
      [
        'let dinner = toDateTime("2026-03-28T18:00")',
        "say (dinner + 1 day).toISO()",
        "say (dinner + 24 h).toISO()",
        // Months, then days, then exact time.
        "say (dinner + (1 month + 1 day + 30 min)).toISO()",
        "say (dinner + 1 day) - dinner",
        'say (toDateTime("2026-01-31T09:00") + 1 month).toISO()',
      ].join("\n"),
      AMSTERDAM,
    ),
    ["2026-03-29T18:00", "2026-03-29T19:00", "2026-04-29T18:30", "23 h", "2026-02-28T09:00"],
  );
});

test("a timestamp moves only by exact time, and elapsed-time consumers reject calendar parts", () => {
  assert.ok(
    compileErrors('let t = toTimestamp("2026-10-04T12:00:00Z") + 1 day').includes("TSV043"),
  );
  assert.equal(
    runtimeFailure(`${DYNAMIC}let t = toTimestamp("2026-10-04T12:00:00Z") + dynamic(1 day)`),
    "TSR009",
  );
  assert.ok(compileErrors("timer 1 day").length > 0);
  assert.ok(compileErrors("let t = timer async 10 s\nt.remaining = 1 day").includes("TSV043"));
  assert.equal(
    runtimeFailure(`${DYNAMIC}let t = timer async 10 s\nt.remaining = dynamic(1 week)`),
    "TSR065",
  );
  assert.equal(runtimeFailure(`${DYNAMIC}showButton "Go", timeout: dynamic(1 day)`), "TSR065");
  // A calendar repeat budget is reported as having no fixed length, not as too short.
  assert.deepEqual(compileErrors('playAudio(file: "a", repeat: 1 day)'), ["TSV043"]);
  assert.equal(runtimeFailure(`${DYNAMIC}playAudio(file: "a", repeat: dynamic(1 day))`), "TSR065");
});

test("calendar parts that grow past whole numbers a value can keep fail where they are computed", () => {
  for (const source of [
    `${DYNAMIC}let result = dynamic(9007199254740991 days) + 1 day`,
    `${DYNAMIC}let result = dynamic(9007199254740991 months) * 2`,
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
      assert.notEqual(compileSource(`let x = ${source}`).plan, null, source.slice(0, 40));
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
    "let d = 1 mo + 2 d + 3 h\nlet pick = choose [1 day, 1 week]\nsay d\nsay pick",
  );
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  const action = waiting.snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.ui.kind === "choice");
  assert.deepEqual(
    action.ui.options.map((option) => option.text),
    ["1 d", "7 d"],
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
    ["1 mo 2 d 3 h", "7 d"],
  );

  for (const days of [1.5, 0]) {
    // EVIDENCE: fixture: the parsed checkpoint was serialized from a valid snapshot just above.
    const json = JSON.parse(serialized) as { snapshot: RuntimeSnapshot };
    const binding = json.snapshot.frames[0]!.bindings.find((entry) => entry.name === "d");
    assert.ok(binding !== undefined && typeof binding.value === "object" && binding.value !== null);
    Object.assign(binding.value, { days });
    assertCheckpointRejected(json, "TSK002");
  }
});
