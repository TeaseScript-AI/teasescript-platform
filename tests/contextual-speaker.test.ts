import assert from "node:assert/strict";
import test from "node:test";

import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";
import { Story } from "./helpers/story-session.js";

const VERA = 'speaker vera {\n    title: "Mistress"\n    font: "Georgia"\n}';
const NO_SPEAKER_AT_RUNTIME =
  "This message has no speaker, so 'speaker' has no value: it names none with 'as', and no default speaker is set. Give it one with 'as name', or set a default speaker with 'speaker name' before it.";

/** A default speaker that only one path sets, so the compiler cannot tell whether the message has a speaker. */
function onePath(on: boolean): string {
  return `${VERA}\nlet on = ${on}\nif on {\n    speaker vera\n}`;
}

/**
 * The places a message reads `speaker` (V30 §37), by route: a `say` that evaluates its own text, one that prepares it
 * because of a call, a mode, or an option, and an interaction, which prepares its speaker apart. Each read is the only
 * `speaker` of its source, with what a `say` shows when the message has one.
 */
const READS: readonly (readonly [string, readonly string[]])[] = [
  ['say "${speaker.title}"', ["Mistress"]],
  ["say speaker.title.uppercase()", ["MISTRESS"]],
  ['let line = say "${speaker.title}"', ["Mistress"]],
  ['say "Hi", speaker.title.length * 1 ms', ["Hi"]],
  ['function f {\n    return "!"\n}\nsay "${speaker.title}${f()}"', ["Mistress!"]],
  ['say prose(align: "center") "${speaker.title}"', ["Mistress"]],
  ['say bubble(font: speaker.font) "Hi"', ["Hi"]],
  ['function g {\n    say "${speaker.title}"\n}\ng()', ["Mistress"]],
  ['for i in 1..=1 {\n    say "${speaker.title}"\n}', ["Mistress"]],
  ['showButton "${speaker.title}"', []],
  ['showButton "Go", timeout: speaker.title.length * 1 s', []],
  ['let answer = askText "${speaker.title}"', ["Mistress"]],
  ['let answer = askChoice "${speaker.title}", "Other"', []],
];

test("'speaker' in a message without a speaker is a runtime error, wherever the message reads it", () => {
  for (const [read] of READS) {
    const source = `${onePath(false)}\n${read}\nexit`;
    const failure = runValidSource(source).snapshot.failure;
    assert.deepEqual(
      failure === null
        ? null
        : [
            failure.code,
            failure.message,
            source.slice(failure.span.start.offset, failure.span.end.offset),
          ],
      ["TSR071", NO_SPEAKER_AT_RUNTIME, "speaker"],
      source,
    );
  }
});

test("a message reads the default speaker that its path set", () => {
  for (const [read, shown] of READS) {
    const source = `${onePath(true)}\n${read}\nexit`;
    const result = runValidSource(source);
    assert.equal(result.snapshot.failure, null, source);
    assert.deepEqual(sayTexts(result), shown, source);
  }
});

test("a default speaker set after the message does not give it one", () => {
  const result = runValidSource(
    [VERA, 'say "${speaker.title}"', "speaker vera", "exit"].join("\n"),
  );
  assert.equal(result.snapshot.failure?.code, "TSR071");
  assert.deepEqual(sayTexts(result), []);
});

test("a timer or button block reads the default speaker when it runs", () => {
  const blocks = [
    'timer async 1 s {\n    say "${speaker.title}", instant\n}',
    'showPermanentButton "Kneel" {\n    say "${speaker.title.lowercase()}", instant\n}',
  ].join("\n");
  const without = new Story(`${onePath(false)}\n${blocks}\nwait 5 s\nexit`);
  without.at(1_000);
  assert.equal(without.snapshot.failure?.code, "TSR071");
  const pressed = new Story(`${onePath(false)}\n${blocks}\nwait 5 s\nexit`);
  assert.equal(pressed.press(1), "pressed");
  assert.equal(pressed.snapshot.failure?.code, "TSR071");
  const story = new Story(`${onePath(true)}\n${blocks}\nwait 5 s\nexit`);
  story.at(1_000);
  assert.equal(story.press(1), "pressed");
  assert.equal(story.snapshot.failure, null);
  assert.deepEqual(story.said(), ["Mistress", "mistress"]);
});
