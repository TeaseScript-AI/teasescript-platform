import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileSource, type ProjectSourceFile } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";
import { Story } from "./helpers/story-session.js";

const VERA = 'speaker vera {\n    title: "Mistress"\n    font: "Georgia"\n}';
const NO_SPEAKER_AT_RUNTIME =
  "This message has no speaker, so 'speaker' has no value: it names none with 'as', and no default speaker is set. Give it one with 'as name', or set a default speaker with 'speaker name' before it.";

const NO_SPEAKER_AT_COMPILE =
  "This message has no speaker, so 'speaker' has no value: it names none with 'as', and the script never sets a default speaker. Give it one with 'as name', or set a default speaker with 'speaker name'.";

/** Each diagnostic as its code, message, and the source it marks. */
function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

/** A default speaker that only one path sets, so the compiler cannot tell whether the message has a speaker. */
function onePath(on: boolean): string {
  return `${VERA}\nlet on = ${on}\nif on {\n    speaker vera\n}`;
}

/**
 * The places a message reads `speaker` (V30 §37), by route: a `say` that evaluates its own text, one that prepares it
 * because of a call, a mode, or an option, and an interaction, which prepares its speaker apart, also `askImage`,
 * written as a call. Each read is the only `speaker` of its source, with what a `say` shows when the message has one.
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
  [
    'let image = askImage("Show your ${speaker.title} your setup")',
    ["Show your Mistress your setup"],
  ],
  ['let image = askImage(hint: "Attach a photo", message: "${speaker.title}?")', ["Mistress?"]],
  ['let image = askImage prose(font: speaker.font) ("Hi")', ["Hi"]],
  ['let image = askImage(hint: "For your ${speaker.title}")', []],
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

test("'speaker' in a message without 'as' is a compile error when the script never sets a default speaker", () => {
  const reads = [
    ...READS.map(([read]) => read),
    'timer async 1 s {\n    say "${speaker.title}"\n}',
    'showPermanentButton "Kneel" {\n    say "${speaker.title}"\n}',
    // An ask without 'as' inside a 'say as' text is a message of its own, with the default speaker.
    'say as vera "${askText "Q ${speaker.title}"}"',
    'say as vera "${askImage("Q ${speaker.title}")}"',
    'say as vera "${askImage("Q", hint: speaker.title)}"',
  ];
  for (const read of reads) {
    const source = `${VERA}\n${read}\nexit`;
    assert.deepEqual(diagnostics(source), [["TSV063", NO_SPEAKER_AT_COMPILE, "speaker"]], source);
  }
  // Without any speaker declared, too.
  assert.deepEqual(diagnostics('say "${speaker.title}"\nexit'), [
    ["TSV063", NO_SPEAKER_AT_COMPILE, "speaker"],
  ]);
});

test("a message with 'as', and a speaker's own property, read 'speaker' without a default speaker", () => {
  const result = runValidSource(
    [
      'speaker vera {\n    title: "Mistress"\n    alias: speaker.title + "!"\n}',
      'say as vera "${speaker.title} ${speaker.alias}"',
      'let answer = askText as vera "${speaker.title.uppercase()}?"',
      "exit",
    ].join("\n"),
  );
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(sayTexts(result), ["Mistress Mistress!", "MISTRESS?"]);
});

test("an askImage reads the speaker who asks, not that of a 'say as' around it", () => {
  const result = runValidSource(
    [
      VERA,
      'speaker guide {\n    title: "Guide"\n}',
      "speaker guide",
      'say as vera "${askImage("Show your ${speaker.title}", hint: "For your ${speaker.title}")}"',
      "exit",
    ].join("\n"),
  );
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(
    result.events.flatMap((event) =>
      event.kind === "say" ? [[event.speaker?.identifier, event.text]] : [],
    ),
    [["guide", "Show your Guide"]],
  );
  const action = result.snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.ui.kind === "image");
  assert.equal(action.ui.hint, "For your Guide");
});

test("'speaker' next to an askImage call, outside its arguments, is no message's speaker", () => {
  const source = `${VERA}\nspeaker vera\nlet image = askImage("Q") + speaker.title\nexit`;
  assert.deepEqual(diagnostics(source), [["TSV002", "Unknown variable 'speaker'.", "speaker"]]);
});

test("a default speaker set anywhere in the package leaves 'speaker' to the runtime", () => {
  const main = (setter: string): ProjectSourceFile => ({
    path: "main.tease",
    source: [VERA, setter, 'say "${speaker.title}"', "exit"].join("\n"),
  });
  const elsewhere: readonly (readonly ProjectSourceFile[])[] = [
    // In another file, in a function, or in a block that may not run.
    [main(""), { path: "cast.tease", source: "speaker vera\nend" }],
    [main("function cast {\n    speaker vera\n}")],
    [main("timer async 1 s {\n    speaker vera\n}")],
  ];
  for (const files of elsewhere)
    assert.deepEqual(compileProject(files).diagnostics, [], JSON.stringify(files));
});
