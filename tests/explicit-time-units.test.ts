import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { RuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";

/** Hides a value's type from the compiler, so a number reaches the runtime check. */
const DYNAMIC = "function dynamic(value) {\n  return value\n}\n";
const FORM = 'askForm "Ready?", fields: { ready: false }';

function said(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

/** The scene time at which the foreground delay of `source`, which has the warnings named, ends. */
function delayDeadline(
  source: string,
  seed?: number,
  warnings: readonly string[] = [],
): number | null {
  const plan = compileValidPlan(source, {}, warnings);
  const snapshot =
    seed === undefined
      ? createImmediatePacingRuntimeSnapshot(plan)
      : createImmediatePacingRuntimeSnapshot(plan, { seed });
  const action = run(plan, snapshot).snapshot.foregroundAction;
  assert.equal(action?.kind, "delay", source);
  return action.deadlineMs;
}

test("a time without a unit is a compile error at every consumer, and the error names the fix", () => {
  for (const [source, subject, fix] of [
    ["wait 5", "5", "such as 'wait 5 s'"],
    ["wait 0", "0", "such as 'wait 0 s'"],
    ["let n = 3\nwait n", "n", "such as 'wait n s'"],
    [
      "wait 15 + randomInteger(0..35)",
      "15 + randomInteger(0..35)",
      "such as 'wait (15 + randomInteger(0..35)) s'",
    ],
    ["let n = 3\nwait n + 5", "n + 5", "such as 'wait (n + 5) s'"],
    ['timer async mystery 10 "Hold"', "10", "such as 'timer 10 s'"],
    ["timer 5..10", "5..10", "Give the range a unit, such as 'timer (5..10) s'."],
    ["let t = timer(duration: 10, async: true)", "10", "such as 'duration: 10 s'"],
    [
      "let secs = 3\nlet t = timer(duration: secs, async: true)",
      "secs",
      "such as 'duration: secs s'",
    ],
    [
      "let t = timer(duration: 5..=10, async: true, repeat: true)",
      "5..=10",
      "such as 'duration: (5..=10) s'",
    ],
    [
      "let a = 1\nlet t = timer(duration: a..=3, async: true, repeat: true)",
      "a..=3",
      "such as 'duration: (a..=3) s'",
    ],
    ['showButton "Go", timeout: 30', "30", "such as '30 s'"],
    [`let a = ${FORM}, timeout: 20, onTimeout: "submit"`, "20", "such as '20 s'"],
    ['say "Hold.", 3', "3", "such as '3 s'"],
    ['let n = 3\nsay "Hold.", n', "n", "such as 'n s'"],
    ['playAudio(file: "a.mp3", startAt: 30)', "30", "such as '30 s'"],
    ['playAudio(file: "a.mp3", endAt: 90)', "90", "such as '90 s'"],
    ['playAudio "a.mp3" {\n  at 20 {\n  }\n}', "20", "such as '20 s'"],
    ['playAudio "a.mp3" {\n  beforeEnd 5 {\n  }\n}', "5", "such as '5 s'"],
  ] as const) {
    const result = compileSource(`${source}\nexit`);
    const [diagnostic, ...rest] = result.diagnostics;
    assert.equal(diagnostic?.code, "TSV043", source);
    assert.ok(diagnostic.message.includes(fix), `${source}: ${diagnostic.message}`);
    assert.ok(!diagnostic.message.includes(";"), diagnostic.message);
    const start = source.lastIndexOf(subject);
    assert.deepEqual(
      [diagnostic.span.start.offset, diagnostic.span.end.offset],
      [start, start + subject.length],
      source,
    );
    assert.deepEqual(rest, [], source);
  }
});

test("a number that reaches a time at runtime fails instead of counting seconds", () => {
  for (const source of [
    'let d = dynamic(5)\nwait d\nsay "never"',
    'let d = dynamic(5)\ntimer d\nsay "never"',
    'let d = dynamic(5..7)\ntimer d\nsay "never"',
    'let d = dynamic(5)\nlet t = timer(duration: d, async: true)\nsay "never"',
    'let d = dynamic(3)\nsay "Hold.", d',
    'let d = dynamic(30)\nshowButton "Go", timeout: d',
    `let d = dynamic(20)\nlet a = ${FORM}, timeout: d, onTimeout: "submit"`,
    'let d = dynamic(30)\nplayAudio(file: "a.mp3", startAt: d)',
  ]) {
    const result = runValidSource(`${DYNAMIC}${source}\nexit`);
    assert.equal(result.snapshot.status, "failed", source);
    assert.match(result.snapshot.failure?.message ?? "", /duration|unit/u, source);
    assert.equal(result.snapshot.foregroundAction, null, source);
    assert.deepEqual(result.snapshot.backgroundActions, [], source);
    assert.ok(!said(result.events).includes("never"), source);
  }
});

test("a unit follows a number, a name, a member, a call, or parentheses, and binds before + and *", () => {
  assert.equal(delayDeadline("let n = 2\nwait n s\nexit"), 2_000);
  assert.equal(delayDeadline("let n = 2\nwait n ms\nexit"), 2);
  assert.equal(delayDeadline("let p = { pause: 4 }\nwait p.pause s\nexit"), 4_000);
  assert.equal(delayDeadline("let pauses = [3, 4]\nwait pauses[1] s\nexit"), 4_000);
  // Long unit names work wherever a short one does.
  assert.equal(delayDeadline("let count = 2\nwait count minutes\nexit"), 120_000);
  assert.equal(delayDeadline("let n = 4\nwait (n / 2) hours\nexit"), 7_200_000);
  assert.equal(delayDeadline("let n = 3\ntimer n seconds\nexit"), 3_000);
  assert.equal(delayDeadline("let n = 5\nwait n milliseconds\nexit"), 5);
  assert.equal(delayDeadline("wait 1 minute + 2 seconds\nexit"), 62_000);
  assert.equal(delayDeadline("let n = 2\nwait (n + 5) s\nexit"), 7_000);
  assert.equal(delayDeadline("let count = 6\nwait (count / 2) min\nexit"), 180_000);
  assert.equal(delayDeadline("let n = 2\nwait n * 1 h\nexit"), 7_200_000);
  assert.equal(delayDeadline("let n = 2\nwait 1 s + n s\nexit"), 3_000);
  for (const seed of [1, 7, 42, 0x1234_5678]) {
    const deadline = delayDeadline("wait (15 + randomInteger(0..35)) s\nexit", seed);
    const drawn = delayDeadline("let r = randomInteger(0..35)\nwait 15 s + r s\nexit", seed);
    assert.equal(deadline, drawn);
    assert.ok(deadline !== null && deadline >= 15_000 && deadline <= 49_000, `${deadline}`);
    const called = delayDeadline("wait randomInteger(5..=10) s\nexit", seed);
    assert.ok(called !== null && called >= 5_000 && called <= 10_000, `${called}`);
  }
  // The unit belongs to the call alone, so a number would be added to a duration.
  const grouped = compileSource("wait 15 + randomInteger(0..35) s\nexit").diagnostics;
  assert.deepEqual(
    grouped.map(({ code, message }) => [code, message]),
    [
      [
        "TSV043",
        "A duration and a number cannot be combined with '+'. Put the expression in parentheses with the unit after them, such as 'wait (15 + randomInteger(0..35)) s'.",
      ],
    ],
  );
  // One duration has one unit, and the operand of a unit is a number.
  for (const [source, code, message] of [
    ["let x = 1 h 30 min", "TSP033", "Add the parts of a duration with '+', as in '1 h + 30 min'."],
    ["let x = 5 s ms", "TSP033", "This duration already has a unit. Remove the 'ms' after it."],
    [
      "let d = 5 s\nlet x = d s",
      "TSV043",
      "A unit follows a number, but this is a duration. Remove the 's' after it.",
    ],
    [
      "let x = (1..3) s",
      "TSV043",
      "A unit follows a number, but this is a range. Only a wait or timer takes a range with a unit, as in 'wait (1..3) s'.",
    ],
  ] as const) {
    const [diagnostic, ...rest] = compileSource(`${source}\nexit`).diagnostics;
    assert.deepEqual([diagnostic?.code, diagnostic?.message], [code, message], source);
    assert.deepEqual(rest, [], source);
  }
  for (const operand of ['"5"', "5 s"]) {
    const result = runValidSource(`${DYNAMIC}let d = dynamic(${operand})\nlet x = d s\nexit`);
    assert.equal(result.snapshot.failure?.code, "TSR027", operand);
    // A wait or timer checks the value before its unit itself.
    const waited = runValidSource(`${DYNAMIC}let d = dynamic(${operand})\nwait d s\nexit`);
    assert.equal(waited.snapshot.failure?.code, "TSR050", operand);
  }
  assertRuntimeResumeEquivalent(
    'let n = 1\nwait (n + randomInteger(1..=2)) s\ntimer (n * 2) s\nsay "done"\nexit',
  );
});

test("a random timer length takes its unit after the range in the short and the named form", () => {
  const short = new Set<number | null>();
  for (let seed = 1; seed <= 40; seed += 1)
    short.add(delayDeadline("timer (5..=7) s\nexit", Math.imul(seed, 0x9e37_79b9) >>> 0 || 1));
  assert.deepEqual([...short].sort(), [5_000, 6_000, 7_000]);

  // A repeating named timer draws each round anew within its range.
  const plan = compileValidPlan(
    'let rounds = []\nlet beat = timer(duration: (1..=3) s, async: true, repeat: true) {\n  rounds.add(beat.elapsed)\n}\nwait 60 s\nbeat.stop()\nsay "${rounds.length}"\nexit',
  );
  let snapshot: RuntimeSnapshot = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { seed: 99 }),
  ).snapshot;
  const timer = snapshot.backgroundActions.find((action) => action.kind === "timer");
  assert.ok(timer?.kind === "timer");
  assert.deepEqual(timer.timer.range, { start: 1, end: 3, inclusive: true, unit: "s" });
  snapshot = run(plan, observeTime(plan, snapshot, 60_000).snapshot).snapshot;
  const rounds = snapshot.frames[0]?.bindings.find(({ name }) => name === "rounds")?.value;
  assert.ok(typeof rounds === "object" && rounds !== null && rounds.kind === "list");
  const ends = rounds.items.map((item) =>
    typeof item === "object" && item !== null && item.kind === "duration" ? item.milliseconds : -1,
  );
  const lengths = ends.map((end, index) => end - (index === 0 ? 0 : ends[index - 1]!));
  assert.ok(lengths.length >= 20, `${lengths.length} rounds`);
  assert.ok(
    lengths.every((length) => [1_000, 2_000, 3_000].includes(length)),
    `${lengths}`,
  );
  assert.equal(new Set(lengths).size, 3);

  // Computed bounds and a range in a variable take the unit after the range, and the rounds restore from every
  // checkpoint. A unit after an unparenthesized range would belong to its end alone.
  for (const [range, expected] of [
    ["(a..=b) s", { start: 1, end: 3, inclusive: true, unit: "s" }],
    ["(a..b + 1) s", { start: 1, end: 4, inclusive: false, unit: "s" }],
    // A range held in a variable takes the unit after its name (owner decision on #512, 2026-10-09).
    ["r s", { start: 1, end: 3, inclusive: true, unit: "s" }],
    ["r minutes", { start: 1, end: 3, inclusive: true, unit: "min" }],
  ] as const) {
    const computed = compileValidPlan(
      `let a = 1\nlet b = 3\nlet r = 1..=3\nlet t = timer(duration: ${range}, async: true, repeat: true)\nwait 1 s\nexit`,
    );
    const started = run(computed, createImmediatePacingRuntimeSnapshot(computed)).snapshot;
    const action = started.backgroundActions.find((candidate) => candidate.kind === "timer");
    assert.ok(action?.kind === "timer", range);
    assert.deepEqual(action.timer.range, expected, range);
  }
  assertRuntimeResumeEquivalent(
    'let a = 1\nlet b = 3\nlet n = 0\nlet beat = timer(duration: (a..=b) s, async: true, repeat: true) {\n  n += 1\n}\nwait 7 s\nbeat.stop()\nsay "${n}"\nexit',
  );
  for (const [source, fix] of [
    ["timer 5..10 s", "timer (5..10) s"],
    ["let a = 1\nlet b = 3\nlet t = timer(duration: a..=b s, async: true)", "duration: (a..=b) s"],
  ] as const) {
    const [diagnostic, ...rest] = compileSource(`${source}\nexit`).diagnostics;
    assert.deepEqual(
      [diagnostic?.code, diagnostic?.message],
      [
        "TSP033",
        `A unit after a range belongs to its end alone. Put the range in parentheses, as in '${fix}'.`,
      ],
      source,
    );
    assert.deepEqual(rest, [], source);
  }
});

test("zero and negative times follow the rule of each consumer", () => {
  // `wait`, a one-shot timer, and pacing take zero, which is immediate.
  for (const source of [
    'wait 0 s\nsay "now"',
    'timer 0 s\nsay "now"',
    'say "first", 0 s\nsay "now"',
  ]) {
    const result = runValidSource(`${source}\nexit`);
    assert.equal(result.snapshot.status, "halted", source);
    assert.deepEqual(result.snapshot.backgroundActions, [], source);
  }
  // A one-shot timer of zero expires at once.
  const once = runValidSource('timer async 0 s { say "expired" }\nwait 1 s\nexit');
  assert.deepEqual(said(once.events), ["expired"]);

  // A known negative time, a zero repeat round, and a zero timeout are compile errors.
  for (const [source, code] of [
    ["wait -1 s", "TSV011"],
    ["timer -1 s", "TSV011"],
    ['say "x", -1 s', "TSV011"],
    ["let t = timer(duration: 0 s, async: true, repeat: true)", "TSV011"],
    ['showButton "Go", timeout: 0 s', "TSV011"],
    ['playAudio(file: "a.mp3", startAt: -1 s)', "TSV036"],
  ] as const)
    assert.equal(compileSource(`${source}\nexit`).diagnostics[0]?.code, code, source);

  // The same values fail at runtime when the compiler cannot see them.
  for (const source of [
    "let d = dynamic(-1 s)\nwait d",
    "let d = dynamic(-1 s)\ntimer d",
    'let d = dynamic(-1 s)\nsay "x", d',
    "let d = dynamic(0 s)\nlet t = timer(duration: d, async: true, repeat: true)",
    'let d = dynamic(0 s)\nshowButton "Go", timeout: d',
    `let d = dynamic(0 s)\nlet a = ${FORM}, timeout: d, onTimeout: "submit"`,
    'let d = dynamic(-1 s)\nplayAudio(file: "a.mp3", startAt: d)',
  ]) {
    const result = runValidSource(`${DYNAMIC}${source}\nexit`);
    assert.equal(result.snapshot.status, "failed", source);
  }

  // Setting a timer's remaining time to zero or less settles its round at once.
  const settled = runValidSource(
    'let t = timer async 5 s\nt.remaining = -5 s\nsay "${t.state} ${t.remaining}"\nexit',
  );
  assert.deepEqual(said(settled.events), ["finished 0 seconds"]);
});

test("a name after a say mode or skip word stays the text, also when it is a unit word", () => {
  for (const [source, text, presentation] of [
    ['let s = "Hi"\nsay bubble() s, instant', "Hi", "bubble"],
    ['let s = "Hi"\nsay bubble(color: "red") s, instant', "Hi", "bubble"],
    ['let h = "Hi"\nsay prose h, instant', "Hi", "prose"],
    ['let ms = "Hi"\nsay skippable ms, instant', "Hi", "bubble"],
    // A month or a year written out after a value asks for 'calendar', but after a mode, a skip word, or a speaker it
    // is the text too.
    ['let months = "Hi"\nsay skippable months, instant', "Hi", "bubble"],
    ['let year = "Hi"\nsay bubble() year, instant', "Hi", "bubble"],
    ['let y = "Hi"\nsay prose y, instant', "Hi", "prose"],
    [
      'speaker narrator { displayName: "Narrator" }\nlet months = "Hi"\nsay as narrator months, instant',
      "Hi",
      "bubble",
    ],
    ['let mo = "Hi"\nlet shown = say unskippable mo, instant', "Hi", "bubble"],
    // Without a mode or skip word before it, the unit belongs to the value, also to a member, an element, or a call
    // named like one.
    ["let n = 3\nsay n s, instant", "3 seconds", "bubble"],
    ["let bubble = { n: 3 }\nsay bubble.n s, instant", "3 seconds", "bubble"],
    ["let skippable = [3]\nsay skippable[0] s, instant", "3 seconds", "bubble"],
    ["function prose(n) {\n  return n\n}\nsay prose(3) s, instant", "3 seconds", "bubble"],
    ["function f {\n  return 2\n}\nsay f() min, instant", "2 minutes", "bubble"],
  ] as const) {
    const result = runValidSource(`${source}\nexit`);
    const shown = result.events.flatMap((event) => (event.kind === "say" ? [event] : []));
    assert.deepEqual(
      shown.map((event) => [event.text, event.presentation?.kind]),
      [[text, presentation]],
      source,
    );
  }
});

test("a call named like a skip word runs as a call before its unit", () => {
  const result = runValidSource(
    'function unskippable(n) {\n  say "called", instant\n  return n + 1\n}\nsay unskippable(3) s, instant\nexit',
  );
  assert.deepEqual(said(result.events), ["called", "4 seconds"]);
});

test("a wait takes a range with a unit like a hidden timer, drawn once in whole seconds", () => {
  const seed = (index: number): number => Math.imul(index, 0x9e37_79b9) >>> 0 || 1;
  const written = new Set<number | null>();
  for (let index = 1; index <= 40; index += 1) {
    const deadline = delayDeadline("wait (5..=7) s\nexit", seed(index));
    written.add(deadline);
    // One draw, as `randomInteger` makes it, also for a range in a variable.
    assert.equal(delayDeadline("let r = 5..=7\nwait r s\nexit", seed(index)), deadline);
    assert.equal(
      delayDeadline("let drawn = randomInteger(5..=7)\nwait drawn s\nexit", seed(index)),
      deadline,
    );
  }
  assert.deepEqual([...written].sort(), [5_000, 6_000, 7_000]);
  const hidden = runValidSource("wait (5..7) s\nexit").snapshot.foregroundAction;
  assert.ok(hidden?.kind === "delay" && hidden.display === "hidden");
  assertRuntimeResumeEquivalent(
    'let n = 0\nwait (1..=3) s\nn += 1\nwait (n..n + 2) s\nsay "done"\nexit',
  );

  for (const [source, code, fix] of [
    ["wait 1..3 s", "TSP033", "Put the range in parentheses, as in 'wait (1..3) s'."],
    ["wait 1..3", "TSV043", "Give the range a unit, such as 'wait (1..3) s'."],
    [
      "wait (1.5..3) s",
      "TSV010",
      "A wait range counts whole units, so its bounds must be whole numbers.",
    ],
  ] as const) {
    const [diagnostic, ...rest] = compileSource(`${source}\nexit`).diagnostics;
    assert.equal(diagnostic?.code, code, source);
    assert.ok(diagnostic.message.includes(fix), `${source}: ${diagnostic.message}`);
    assert.deepEqual(rest, [], source);
  }
  const negative = runValidSource(`${DYNAMIC}let r = dynamic(-2..3)\nwait r s\nexit`);
  assert.equal(
    negative.snapshot.failure?.message,
    "A wait range must not start below 0, but this range is -2..3.",
  );
});

test("a wait or timer range takes any exact unit and draws whole units of it", () => {
  const seed = (index: number): number => Math.imul(index, 0x9e37_79b9) >>> 0 || 1;
  for (const [unit, milliseconds] of [
    ["ms", 1],
    ["min", 60_000],
    ["hours", 3_600_000],
    ["days", 86_400_000],
  ] as const) {
    // A wait or timer in days gets warning TSV061.
    const warnings = unit === "days" ? ["TSV061"] : [];
    for (const command of ["wait", "timer"]) {
      const drawn = new Set<number | null>();
      for (let index = 1; index <= 40; index += 1) {
        const deadline = delayDeadline(`${command} (2..=4) ${unit}\nexit`, seed(index), warnings);
        drawn.add(deadline);
        // One draw, as `randomInteger` makes it.
        assert.equal(
          delayDeadline(`${command} randomInteger(2..=4) ${unit}\nexit`, seed(index), warnings),
          deadline,
          `${command} ${unit}`,
        );
      }
      assert.deepEqual(
        [...drawn].sort((a, b) => a! - b!),
        [2, 3, 4].map((count) => count * milliseconds),
        `${command} ${unit}`,
      );
    }
  }

  // A repeating timer draws each round in its unit.
  const plan = compileValidPlan(
    "let rounds = []\nlet r = 1..=3\nlet beat = timer(duration: r min, async: true, repeat: true) {\n  rounds.add(beat.elapsed)\n}\nwait 1 h\nbeat.stop()\nexit",
  );
  let snapshot: RuntimeSnapshot = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { seed: 7 }),
  ).snapshot;
  snapshot = run(plan, observeTime(plan, snapshot, 3_600_000).snapshot).snapshot;
  const rounds = snapshot.frames[0]?.bindings.find(({ name }) => name === "rounds")?.value;
  assert.ok(typeof rounds === "object" && rounds !== null && rounds.kind === "list");
  const ends = rounds.items.map((item) =>
    typeof item === "object" && item !== null && item.kind === "duration" ? item.milliseconds : -1,
  );
  const lengths = ends.map((end, index) => end - (index === 0 ? 0 : ends[index - 1]!));
  assert.ok(lengths.length >= 20, `${lengths.length} rounds`);
  assert.ok(
    lengths.every((length) => [60_000, 120_000, 180_000].includes(length)),
    `${lengths}`,
  );

  // Every draw restores from every checkpoint.
  assertRuntimeResumeEquivalent(
    'let n = 0\nlet beat = timer(duration: (1..=4) h, async: true, repeat: true) {\n  n += 1\n}\nwait (100..500) ms\nwait (1..3) min\ntimer (1..=4) h\nwait (1..=2) h\ntimer (100..=300) ms\nbeat.stop()\nsay "${n}"\nexit',
  );

  // A calendar unit after a range is refused like any calendar duration.
  const calendar =
    "but this is a calendar duration. A calendar day or month has no fixed length. Use a fixed length such as '1 day' or '24 h'.";
  for (const [source, rule] of [
    ["wait 3 calendar days", "A wait takes a duration"],
    ["wait (1..3) calendar days", "A wait takes a duration"],
    ["let r = 1..3\nwait r calendar days", "A wait takes a duration"],
    ["timer (1..3) calendar weeks", "A timer takes a duration"],
    ["let t = timer(duration: (1..3) calendar months, async: true)", "A timer takes a duration"],
  ] as const) {
    const [diagnostic, ...rest] = compileSource(`${source}\nexit`).diagnostics;
    assert.deepEqual(
      [diagnostic?.code, diagnostic?.message],
      ["TSV043", `${rule}, ${calendar}`],
      source,
    );
    assert.deepEqual(rest, [], source);
  }
});

test("a calendar unit follows a name, a call, or parentheses like an exact unit", () => {
  const result = runValidSource(
    'let n = 2\nfunction f {\n  return 3\n}\nsay "${n calendar months} ${f() calendar days} ${(n + 1) calendar years}", instant\nexit',
  );
  assert.deepEqual(said(result.events), ["2 calendar months 3 calendar days 3 calendar years"]);
  for (const [source, message] of [
    [
      "let d = 2 s\nlet x = d calendar days",
      "A unit follows a number, but this is a duration. Remove the 'calendar d' after it.",
    ],
    [
      "let n = 3\nwait n calendar days",
      "A wait takes a duration, but this is a calendar duration. A calendar day or month has no fixed length. Use a fixed length such as '1 day' or '24 h'.",
    ],
  ] as const) {
    const [diagnostic, ...rest] = compileSource(`${source}\nexit`).diagnostics;
    assert.deepEqual([diagnostic?.code, diagnostic?.message], ["TSV043", message], source);
    assert.deepEqual(rest, [], source);
  }
  // A known amount is checked like a literal: whole calendar days or months, and a representable duration.
  for (const [source, code, message] of [
    [
      "let d = (1.5) calendar days",
      "TSV043",
      "1.5 calendar days is not a whole number of days. Use whole calendar days, or exact hours such as '36 h'.",
    ],
    [
      "let d = (1 / 2) calendar months",
      "TSV043",
      "0.5 calendar months is not a whole number of months. Use whole calendar months.",
    ],
    [
      "let d = (1 day / 2 days) calendar days",
      "TSV043",
      "0.5 calendar days is not a whole number of days. Use whole calendar days, or exact hours such as '12 h'.",
    ],
    [
      "let d = (1e306) h",
      "TSV050",
      "This calculation gives a duration too long to represent. Use a shorter duration.",
    ],
  ] as const) {
    const [diagnostic, ...rest] = compileSource(`${source}\nexit`).diagnostics;
    assert.deepEqual([diagnostic?.code, diagnostic?.message], [code, message], source);
    assert.deepEqual(rest, [], source);
  }
  assert.deepEqual(
    said(
      runValidSource(
        'say "${(0.5) calendar years} ${(1 day / 2 days) calendar years}", instant\nexit',
      ).events,
    ),
    ["6 calendar months 6 calendar months"],
  );
  // An amount the compiler cannot see fails when it is given the unit, and a wait never measures a calendar duration.
  for (const [source, code, message] of [
    [
      "let n = dynamic(1.5)\nlet d = n calendar days",
      "TSR009",
      "1.5 calendar days is not a whole number of days. Use a whole number before the 'calendar d'.",
    ],
    [
      "let d = dynamic(3 calendar days)\nwait d",
      "TSR065",
      "'wait' needs a duration such as '30 s', not a calendar duration. A calendar day or month has no fixed length. Use a fixed length such as '1 day' or '24 h'.",
    ],
  ] as const) {
    const failure = runValidSource(`${DYNAMIC}${source}\nexit`).snapshot.failure;
    assert.deepEqual([failure?.code, failure?.message], [code, message], source);
  }
});
