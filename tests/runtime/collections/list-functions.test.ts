import assert from "node:assert/strict";
import test from "node:test";
import { runValidSource } from "../../helpers/run-valid-source.js";
import { sayTexts } from "../../helpers/runtime-events.js";
import { assertRuntimeResumeEquivalent } from "../../helpers/runtime-equivalence.js";

function said(source: string, seed?: number): string[] {
  const result = runValidSource(source, seed);
  assert.equal(result.snapshot.failure, null, source);
  return sayTexts(result);
}

test("statistics of a list of numbers", () => {
  assert.deepEqual(
    said(
      [
        "let scores = [3, 1, 4, 1, 5, 9, 2, 6]",
        'say "${sum(scores)} ${average(scores)} ${median(scores)} ${stddev(scores)} ${min(scores)} ${max(scores)}"',
        // Between the two nearest values in ascending order, [1, 1, 2, 3, 4, 5, 6, 9]: the 90th lies at rank 6.3.
        'say "${percentile(scores, 0)} ${percentile(scores, 10)} ${percentile(scores, 25)} ${percentile(scores, 90)} ${percentile(scores, 100)}"',
        'say "${median([7])} ${median([1, 2, 3])} ${stddev([2, 4, 4, 4, 5, 5, 7, 9])}"',
        "exit",
      ].join("\n"),
    ),
    ["31 3.875 3.5 2.748376143938713 1 9", "1 1 1.75 6.9 9", "7 2 2.138089935299395"],
  );
});

test("median and percentile sort a copy and leave the list in its order", () => {
  assert.deepEqual(
    said(
      'let scores = [3, 9, 1]\nsay "${median(scores)} ${percentile(scores, 100)} ${scores.join(" ")}"\nexit',
    ),
    ["3 9 3 9 1"],
  );
});

test("statistics read a property with by:, and durations give durations", () => {
  assert.deepEqual(
    said(
      [
        "let sessions = [",
        '    { count: 10, pause: 30 s, day: toDate("2026-10-02") },',
        '    { count: 14, pause: 45 s, day: toDate("2026-10-01") },',
        '    { count: 12, pause: 40 s, day: toDate("2026-10-03") }',
        "]",
        'say "${median(sessions, by: "count")} ${sum(sessions, by: "count")} ${percentile(sessions, 50, by: "count")}"',
        'say "${average(sessions, by: "pause")} ${sum(sessions, by: "pause")} ${max(sessions, by: "pause")} ${stddev([1 min, 2 min])}"',
        'say "${min(sessions, by: "day")} ${max([toDate("2026-01-05"), toDate("2025-12-31")])} ${sum([1 day, 1 week])}"',
        "exit",
      ].join("\n"),
    ),
    [
      "12 36 12",
      "38.333 seconds 1 minute 55 seconds 45 seconds 42.426 seconds",
      "2026-10-01 2026-01-05 8 days",
    ],
  );
});

test("statistics and trends keep their precision for equal, close, tiny, and huge values", () => {
  assert.deepEqual(
    said(
      [
        // Equal values have no spread, also when their rounded average differs from them.
        'say "${linearRegression([0.1, 0.1, 0.1]).r2} ${stddev([0.1, 0.1, 0.1])} ${stddev([10000000000000000, 10000000000000002])}"',
        'say "${stddev([0, 1e-200])} ${average([1e308, 1e308])} ${percentile([-1e308, 1e308], 25)} ${median([5e-324, 5e-324])}"',
        'say linearRegression([{ x: 0, y: 0 }, { x: 1e200, y: 1 }], x: "x", y: "y")',
        'say "${linearRegression([0, 1e200]).r2}"',
        // A horizontal line predicts its value even where the distance to its start overflows.
        'let level = linearRegression([{ x: -1e308, y: 1 }, { x: -1e308 + 1e292, y: 1 }], x: "x", y: "y")',
        'say "${predict(level, 1e308)}"',
        // Large values that cancel leave the small one, and a line's intercept may cancel a change that overflows.
        'say "${sum([1e308, -1e308, 1e-100])} ${average([1e308, -1e308, 1e-100])}"',
        'let rising = linearRegression([{ x: -1e308, y: -1e308 }, { x: 0, y: 0 }], x: "x", y: "y")',
        'say "${predict(rising, 1e308)}"',
        'say linearRegression([{ x: -5e-324, y: 1e308 }, { x: 0, y: 0 }, { x: 5e-324, y: 1e308 }], x: "x", y: "y").slope',
        // Duration sums are exact too, in milliseconds and in whole days.
        'say "${sum([1e16 ms, 1 ms, -1e16 ms])} ${sum([9007199254740991 d, 2 d, -9007199254740991 d])} ${sum([-5 s, 5 s])}"',
        "exit",
      ].join("\n"),
    ),
    [
      "1 0 1.4142135623730951",
      "7.071067811865475e-201 1e+308 -5e+307 5e-324",
      "{ slope: 1e-200, intercept: 0, r2: 1, start: 0 }",
      "1",
      "1",
      "1e-100 3.3333333333333336e-101",
      "1e+308",
      "0",
      "1 millisecond 2 days 0 seconds",
    ],
  );
});

test("a number, text, or boolean equals only the same value of its kind, also among lists, and 0 equals -0", () => {
  assert.deepEqual(
    said(
      [
        'let mixed: (number | boolean | string | number[])[] = [[1], true, "1", 1, 0, 1]',
        'say "${mixed.indexOf(1)} ${mixed.lastIndexOf(1)} ${mixed.indexOf(-0)} ${mixed.lastIndexOf(true)} ${mixed.indexOf("1")} ${mixed.indexOf(false)} ${mixed.lastIndexOf([1])} ${mixed.contains(0)}"',
        "mixed.remove(1)",
        'say "${mixed.length} ${mixed.indexOf(1)}"',
        "exit",
      ].join("\n"),
    ),
    ["3 5 4 1 2 null 0 true", "5 4"],
  );
});

test("get joins an empty list default into the element type as a literal does", () => {
  // As in [[1, 2], []], the empty list takes the element type of the inner lists, also inside an object.
  assert.deepEqual(
    said(
      [
        "let rows: integer[][] = [[1, 2], [3]]",
        "for count in rows.get(5, default: []) {",
        "    say count + 1",
        "}",
        "for count in rows.get(0, default: []) {",
        "    say count + 1",
        "}",
        'let groups = [{ name: "warmup", counts: [10] }]',
        'let group = groups.get(0, default: { name: "none", counts: [] })',
        "for count in group.counts {",
        "    say count + 1",
        "}",
        'say groups.get(1, default: { name: "none", counts: [] }).name',
        "exit",
      ].join("\n"),
    ),
    ["2", "3", "11", "none"],
  );
});

test("list results survive checkpoint resume", () => {
  const source = [
    "let scores = [12, 15, 11, 18, 16]",
    "let target = round(percentile(scores, 10))",
    "wait 1 s",
    "let recent = scores.takeLast(3)",
    "let trend = linearRegression(recent)",
    "wait 1 s",
    'let task = randomWeighted(dict{ "squats": 3, "plank": 1 })',
    "wait 1 s",
    'say "${target} ${recent.join()} ${trend.slope} ${predict(trend, 3)} ${task == "squats" or task == "plank"}"',
    // A search waits for its value after reading its list.
    'let rounds = [["squats"], ["plank"], ["squats"]]',
    "function exercise(name: string) {",
    "    wait 1 s",
    "    return [name]",
    "}",
    'say "${rounds.lastIndexOf(exercise("squats"))} ${rounds.indexOf(exercise("lunges"))} ${rounds.count(exercise("squats"))}"',
    // So does get, for its default.
    'say "${rounds.get(1, default: exercise("rest")).join()} ${rounds.get(5, default: exercise("rest")).join()}"',
    "exit",
  ].join("\n");
  const equivalent = assertRuntimeResumeEquivalent(source);
  assert.deepEqual(
    equivalent.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["11 11, 18, 16 2.5 20 true", "2 null 2", "plank rest"],
  );
});
