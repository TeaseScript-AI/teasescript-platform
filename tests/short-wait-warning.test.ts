import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

// TSV060 (V30 §27): a `wait` of known duration directly after a `say` with default pacing, in the same block, that is
// shorter than the message's reading time at the default reading speed adds no time, because it runs alongside the
// message's pacing; the compiler says so on the wait. The reading time is the runtime's smart pacing of the message's
// visible text, with interpolated values empty.

/** The TSV060 warnings of `source` as `line: wait / reading` seconds, read from their messages. */
function shortWaits(source: string): string[] {
  const result = compileSource(`${source}\nexit`);
  assert.notEqual(result.plan, null, "a warning does not stop the plan");
  return result.diagnostics.flatMap((diagnostic) => {
    if (diagnostic.code !== "TSV060") return [];
    assert.equal(diagnostic.severity, "warning");
    const numbers = /takes at least ([\d.]+) s to read, so this ([\d.]+) s wait/.exec(
      diagnostic.message,
    );
    assert.ok(numbers, diagnostic.message);
    return [`${diagnostic.span.start.line + 1}: ${numbers[2]} / ${numbers[1]}`];
  });
}

test("a wait shorter than the message before it gets TSV060, which names both times and what to do", () => {
  const source = 'for i in 1..=10 {\n    say ".${i}."\n    wait 0.5 s\n}\nexit';
  const [warning, ...rest] = compileSource(source).diagnostics;
  assert.deepEqual(rest, []);
  assert.equal(warning?.code, "TSV060");
  assert.equal(warning.span.start.line + 1, 3);
  assert.equal(
    warning.message,
    "At the default reading speed, the previous message takes at least 1.8 s to read, so this 0.5 s wait adds no time unless the player skips the message. Add `instant` to that `say` to make the wait the only pause, or remove the wait.",
  );
});

test("the reading time is the default smart pacing of the visible text, and a wait as long adds time", () => {
  // "Ready, set": 2 words take longer than 10 characters, so 1.5 s + 2 × 0.3 s; markup does not count.
  assert.deepEqual(shortWaits('say "**Ready**, *set*"\nwait 2'), ["2: 2 / 2.1"]);
  assert.deepEqual(shortWaits('say "**Ready**, *set*"\nwait 2.1'), []);
  // 40 characters of one word take longer than one word: 1.5 s + 40 × 0.03 s.
  assert.deepEqual(shortWaits(`say "${"a".repeat(40)}"\nwait 2.5`), ["2: 2.5 / 2.7"]);
  // A block string counts its lines' text.
  assert.deepEqual(shortWaits('say """\n    One\n    two\n    """\nwait 2'), ["5: 2 / 2.1"]);
  // An interpolated value counts as empty, so the time is the shortest the message can take.
  assert.deepEqual(shortWaits('let name = "Ada"\nsay "${name}"\nwait 1.4'), ["3: 1.4 / 1.5"]);
  assert.deepEqual(shortWaits('let name = "Ada"\nsay "${name}"\nwait 1.5'), []);
  // Text the compiler cannot know counts as empty too.
  assert.deepEqual(shortWaits('let line = "Hello there"\nsay line\nwait 1'), ["3: 1 / 1.5"]);
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
        "    wait 1",
        "}",
        "timer async 5 s {",
        '    say "Five"',
        "    wait 1",
        "}",
        "if true {",
        '    say "Six"',
        "    wait 1",
        "}",
      ].join("\n"),
    ),
    ["5: 0.5 / 1.8", "7: 0.5 / 1.8", "9: 0.5 / 1.8", "12: 1 / 1.8", "16: 1 / 1.8", "20: 1 / 1.8"],
  );
});

test("a wait that sets the timing, or one the compiler cannot measure, gets no TSV060", () => {
  for (const source of [
    // The message has its own pacing.
    'say "One", instant\nwait 0.5',
    'say "One", 0\nwait 0.5',
    'say "One", 3\nwait 0.5',
    // The wait's duration is not known, or never adds time.
    'let beat = 0.5\nsay "One"\nwait beat',
    'say "One"\nwait 0',
    // Something runs in between, or the wait is in another block.
    'say "One"\nlet beat = 1\nwait 0.5',
    'say "One"\nlabel later\nwait 0.5',
    'if true {\n    say "One"\n}\nwait 0.5',
    'for i in 1..=2 {\n    wait 0.5\n    say "One"\n}',
    // A message used as a value is not checked.
    'let message = say "One"\nwait 0.5',
  ])
    assert.deepEqual(shortWaits(source), [], source);
});
