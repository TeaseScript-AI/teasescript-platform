import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { run } from "../src/runtime/engine.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";

// TSV060 (V30 §27): a `wait` of known duration directly after a `say` with default pacing, in the same block, that is
// shorter than the message's reading time at the default reading speed adds no time, because it runs alongside the
// message's pacing; the compiler says so on the wait. The reading time is the runtime's smart pacing of the message's
// visible text when the compiler knows all of it, and otherwise the base delay alone.

/** The TSV060 warnings of `source` as `line: wait / reading` seconds, read from their messages. */
function shortWaits(source: string): string[] {
  const result = compileSource(`${source}\nexit`);
  assert.notEqual(result.plan, null, "a warning does not stop the plan");
  return result.diagnostics.flatMap((diagnostic) => {
    if (diagnostic.code !== "TSV060") return [];
    assert.equal(diagnostic.severity, "warning");
    const times = /takes at least (.+) to read, so this wait of (.+) adds no time/.exec(
      diagnostic.message,
    );
    assert.ok(times, diagnostic.message);
    return [`${diagnostic.span.start.line + 1}: ${seconds(times[2]!)} / ${seconds(times[1]!)}`];
  });
}

const UNIT_SECONDS: Readonly<Record<string, number>> = {
  minute: 60,
  second: 1,
  millisecond: 0.001,
};

/** A displayed duration, such as `1 minute 2.5 seconds` or `500 milliseconds`, as seconds. */
function seconds(shown: string): string {
  let total = 0;
  for (const [, amount, unit] of shown.matchAll(/([\d.]+) (minute|second|millisecond)s?/gu))
    total += Number(amount) * (UNIT_SECONDS[unit!] ?? Number.NaN);
  return String(Number(total.toFixed(3)));
}

test("a wait shorter than the message before it gets TSV060, which names both times and what to do", () => {
  const source = 'for i in 1..=10 {\n    say ".${i}."\n    wait 0.5 s\n}\nexit';
  const [warning, ...rest] = compileSource(source).diagnostics;
  assert.deepEqual(rest, []);
  assert.equal(warning?.code, "TSV060");
  assert.equal(warning.span.start.line + 1, 3);
  assert.equal(
    warning.message,
    "At the default reading speed, the previous message takes at least 1.5 seconds to read, so this wait of 500 milliseconds adds no time unless the player skips the message. Add `instant` to that `say` to make the wait the only pause, or remove the wait.",
  );
});

test("the reading time is the default smart pacing of the visible text, and a wait as long adds time", () => {
  // "Ready, set": 2 words take longer than 10 characters, so 1.5 s + 2 × 0.3 s; markup does not count.
  assert.deepEqual(shortWaits('say "**Ready**, *set*"\nwait 2 s'), ["2: 2 / 2.1"]);
  assert.deepEqual(shortWaits('say "**Ready**, *set*"\nwait 2.1 s'), []);
  // 40 characters of one word take longer than one word: 1.5 s + 40 × 0.03 s.
  assert.deepEqual(shortWaits(`say "${"a".repeat(40)}"\nwait 2.5 s`), ["2: 2.5 / 2.7"]);
  // A block string counts its lines' text.
  assert.deepEqual(shortWaits('say """\n    One\n    two\n    """\nwait 2 s'), ["5: 2 / 2.1"]);
  // Interpolated values the compiler knows count with their text.
  assert.deepEqual(shortWaits('say "${2 + 2} apples"\nwait 2 s'), ["2: 2 / 2.1"]);
  // A value it cannot know may change which markup the text holds, so only the base delay counts.
  assert.deepEqual(shortWaits('let name = "Ada"\nsay "${name}"\nwait 1.4 s'), ["3: 1.4 / 1.5"]);
  assert.deepEqual(shortWaits('let name = "Ada"\nsay "${name}"\nwait 1.5 s'), []);
  assert.deepEqual(
    shortWaits('let name = "Ada"\nsay "Hello ${name}, welcome to the house"\nwait 2 s'),
    [],
  );
  assert.deepEqual(shortWaits('let line = "Hello there"\nsay line\nwait 1 s'), ["3: 1 / 1.5"]);
});

test("a value the compiler cannot know may hide the text around it, so a wait that adds time gets no warning", () => {
  for (const source of [
    // The value makes a link of the address, so only "x" shows.
    'let name = "x"\nsay "[${name}](https://example.com/a/long/path)"\nwait 2 s\nsay "next"\nexit',
    // The value completes a weight tag, so the tag does not show.
    'let weight = "light"\nsay "[weight=${weight}]x[/weight]"\nwait 2 s\nsay "next"\nexit',
  ]) {
    const compiled = compileSource(source);
    assert.deepEqual(compiled.diagnostics, [], source);
    const waiting = run(compiled.plan!, createFreshRuntimeSnapshot(compiled.plan!)).snapshot;
    const gate = waiting.backgroundActions.find((action) => action.kind === "chatPacingGate");
    assert.equal(waiting.foregroundAction?.kind, "delay", source);
    assert.ok(gate !== undefined && gate.deadlineMs < waiting.foregroundAction.deadlineMs, source);
  }
});

test("a known wait in any unit or as a duration value is checked, after any kind of say and in any block", () => {
  assert.deepEqual(
    shortWaits(
      [
        'speaker mistress { name: "Mistress" }',
        'say as mistress unskippable "One"',
        "// A comment and a blank line are no statements.",
        "",
        "wait 500 ms",
        'say "Two"',
        "wait 2 * 250 ms",
        'say "Three"',
        "wait 1 min / 120",
        "function beat {",
        '    say "Four"',
        "    wait 1 s",
        "}",
        "timer async 5 s {",
        '    say "Five"',
        "    wait 1 s",
        "}",
        "if true {",
        '    say "Six"',
        "    wait 1 s",
        "}",
      ].join("\n"),
    ),
    ["5: 0.5 / 1.8", "7: 0.5 / 1.8", "9: 0.5 / 1.8", "12: 1 / 1.8", "16: 1 / 1.8", "20: 1 / 1.8"],
  );
});

test("a wait that sets the timing, or one the compiler cannot measure, gets no TSV060", () => {
  for (const source of [
    // The message has its own pacing.
    'say "One", instant\nwait 0.5 s',
    'say "One", 0 s\nwait 0.5 s',
    'say "One", 3 s\nwait 0.5 s',
    // The wait's duration is not known, or never adds time.
    'let beat = 0.5 s\nsay "One"\nwait beat',
    'say "One"\nwait 0 s',
    // Something runs in between, or the wait is in another block.
    'say "One"\nlet beat = 1\nwait 0.5 s',
    'say "One"\nlabel later\nwait 0.5 s',
    'if true {\n    say "One"\n}\nwait 0.5 s',
    'for i in 1..=2 {\n    wait 0.5 s\n    say "One"\n}',
    // A message used as a value is not checked.
    'let message = say "One"\nwait 0.5 s',
  ])
    assert.deepEqual(shortWaits(source), [], source);
});
