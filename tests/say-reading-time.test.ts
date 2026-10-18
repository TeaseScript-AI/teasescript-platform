import assert from "node:assert/strict";
import test from "node:test";

import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/snapshot/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { Story } from "./helpers/story-session.js";

/*
 * A paced `say` lasts its reading time, and the next statement runs after it unless the player skips it (owner
 * decision on #829, 2026-10-11; RUNTIME.md "Message reading time"). Reading times below are exact durations, so each
 * expected moment follows from the source.
 */

const READ = 'say "Read this.", 2 s';

test("an instant say after a paced say waits for its reading time", () => {
  for (const pacing of ["instant", "0 s"]) {
    const story = new Story(`${READ}\nsay "Now.", ${pacing}\nexit`);
    assert.deepEqual(story.said(), ["Read this."], pacing);
    assert.equal(story.at(1_999).reading(), true, pacing);
    assert.deepEqual(story.said(), ["Read this."], pacing);
    story.at(2_000);
    assert.deepEqual(story.said(), ["Read this.", "Now."], pacing);
    assert.equal(story.snapshot.status, "halted", pacing);
  }
});

test("buttons, a choice, an ask, and a form after a paced say wait for its reading time", () => {
  for (const [source, question] of [
    ['showButton "Go"', null],
    ['let pick = askChoice ["Red", "Blue"]', null],
    ['let name = askText "Name?"', "Name?"],
    ['let ready = askBoolean "Ready?"', "Ready?"],
    ['let answers = askForm "Settings", fields: { n: { type: "integer", value: 1 } }', "Settings"],
  ] as const) {
    const story = new Story(`${READ}\n${source}\nexit`);
    assert.equal(story.at(1_999).reading(), true, source);
    assert.deepEqual(story.requested(), ["chatPacingGate"], source);
    const before = story.events.length;
    story.at(2_000);
    const interaction = story.snapshot.foregroundAction;
    assert.equal(interaction?.kind, "interaction", source);
    assert.equal(interaction?.createdAtMs, 2_000, source);
    // A question appears together with its controls, with no reading time between them.
    assert.deepEqual(
      story.events
        .slice(before)
        .flatMap((event) =>
          event.kind === "say"
            ? [`say ${event.text}`]
            : event.kind === "actionRequested"
              ? [event.action.kind]
              : [],
        ),
      question === null ? ["interaction"] : [`say ${question}`, "interaction"],
      source,
    );
  }
});

test("a smart-paced question shows with its field even after a smart message", () => {
  const story = new Story('say "Hello there."\nlet name = askText "What is your name?"\nexit');
  // Two words: 1500 + max(2 * 300, 12 * 30) ms; the question then has no reading time of its own.
  assert.equal(story.at(2_099).reading(), true);
  story.at(2_100);
  assert.deepEqual(story.said(), ["Hello there.", "What is your name?"]);
  assert.equal(story.snapshot.foregroundAction?.kind, "interaction");
  assert.deepEqual(story.requested(), ["chatPacingGate", "interaction"]);
});

test("the Stage image, sound, video, and camera change only after the reading time before them", () => {
  const stageImage = (story: Story) => story.snapshot.stageImage;
  const media = (story: Story) =>
    story.snapshot.backgroundActions.filter((action) => action.kind === "media").length;
  const camera = (story: Story) => story.snapshot.cameraView?.shown ?? false;
  for (const [source, changed] of [
    ['showImage "images/room.jpg"', (story: Story) => stageImage(story) === "images/room.jpg"],
    ['playAudio async "sounds/bell.mp3"', (story: Story) => media(story) === 1],
    ['playVideo async "videos/intro.mp4"', (story: Story) => media(story) === 1],
    ["showCamera", camera],
  ] as const) {
    const story = new Story(`${READ}\n${source}\nwait 10 s\nexit`);
    assert.equal(changed(story.at(1_999)), false, source);
    assert.equal(changed(story.at(2_000)), true, source);
  }
  // Hiding and stopping wait the same way.
  const hidden = new Story(`showImage "images/room.jpg"\n${READ}\nhideImage\nwait 10 s\nexit`);
  assert.equal(stageImage(hidden.at(1_999)), "images/room.jpg");
  assert.equal(stageImage(hidden.at(2_000)), null);
});

test("a message change and permanent-button changes after a paced say wait for its reading time", () => {
  const changed = new Story(
    `let line = say "Waiting", instant\n${READ}\nline.text = "Ready"\nwait 10 s\nexit`,
  );
  const updates = () => changed.events.filter((event) => event.kind === "messageUpdated").length;
  assert.equal(updates(), 0);
  changed.at(1_999);
  assert.equal(updates(), 0);
  changed.at(2_000);
  assert.equal(updates(), 1);

  const buttons = (story: Story) =>
    story.snapshot.backgroundActions.filter((action) => action.kind === "permanentButton").length;
  const shown = new Story(`${READ}\nshowPermanentButton "Hint" {\n}\nwait 10 s\nexit`);
  assert.equal(buttons(shown.at(1_999)), 0);
  assert.equal(buttons(shown.at(2_000)), 1);
  const removed = new Story(
    `let hint = showPermanentButton "Hint" {\n}\n${READ}\nhint.remove()\nwait 10 s\nexit`,
  );
  assert.equal(buttons(removed.at(1_999)), 1);
  assert.equal(buttons(removed.at(2_000)), 0);
});

test("a wait, timers, and code the player cannot see start only when the reading time ends", () => {
  for (const source of [
    'wait 3 s\nsay "Done.", instant',
    'timer 3 s\nsay "Done.", instant',
    'let t = timer async 3 s { say "Done.", instant }\nwait 10 s',
    'timer async hidden 3 s { say "Done.", instant }\nwait 10 s',
  ]) {
    const story = new Story(`${READ}\n${source}\nexit`);
    story.at(4_999);
    assert.deepEqual(story.said(), ["Read this."], source);
    story.at(5_000);
    assert.deepEqual(story.said(), ["Read this.", "Done."], source);
  }
  const counted = new Story(`let count = 0\n${READ}\ncount += 1\nwait 10 s\nexit`);
  assert.equal(counted.at(1_999).binding("count"), 0);
  assert.equal(counted.at(2_000).binding("count"), 1);
  const saved = new Story(`${READ}\nsave 1 as "seen"\nexit`, { persistentScriptStorage: true });
  assert.equal(saved.at(1_999).requested().includes("storageWrite"), false);
  assert.equal(saved.at(2_000).snapshot.foregroundAction?.kind, "storageWrite");
});

test("say instant followed by wait 30 s takes exactly 30 s; without instant the reading time comes first", () => {
  const exact = new Story(
    'say "Hold the position.", instant\nwait 30 s\nsay "Done.", instant\nexit',
  );
  assert.deepEqual(exact.at(29_999).said(), ["Hold the position."]);
  assert.deepEqual(exact.at(30_000).said(), ["Hold the position.", "Done."]);

  // Three words: 1500 + max(3 * 300, 18 * 30) ms of reading time, then the 30 seconds.
  const paced = new Story('say "Hold the position."\nwait 30 s\nsay "Done.", instant\nexit');
  assert.deepEqual(paced.at(32_399).said(), ["Hold the position."]);
  assert.deepEqual(paced.at(32_400).said(), ["Hold the position.", "Done."]);
});

test("a counting loop takes the reading time plus the wait per step, or the wait alone with instant", () => {
  const steps = (pacing: string) => {
    const story = new Story(
      `for i in 1..=3 {\n  say "Swat \${i}"${pacing}\n  wait 1 s\n}\nsay "Done.", instant\nexit`,
    );
    const moments: number[] = [];
    for (let nowMs = 0; nowMs <= 12_000 && story.snapshot.status !== "halted"; nowMs += 100) {
      const before = story.said().length;
      story.at(nowMs);
      if (story.said().length > before) moments.push(nowMs);
    }
    return moments;
  };
  // Two words: 1500 + max(2 * 300, 6 * 30) = 2100 ms of reading time, then one second.
  assert.deepEqual(steps(""), [3_100, 6_200, 9_300]);
  assert.deepEqual(steps(", instant"), [1_000, 2_000, 3_000]);
});

test("a form's time limit and a button's timeout count from when they appear", () => {
  const form = new Story(
    `${READ}\nlet answers = askForm fields: { n: { type: "integer", value: 1 } }, timeout: 3 s, onTimeout: "submit"\nsay "Sent.", instant\nexit`,
  );
  form.at(2_000);
  assert.equal(form.snapshot.foregroundAction?.kind, "interaction");
  assert.equal(form.at(4_999).snapshot.foregroundAction?.kind, "interaction");
  assert.deepEqual(form.at(5_000).said(), ["Read this.", "Sent."]);

  const button = new Story(
    `${READ}\nlet elapsed = showButton "Go", timeout: 3 s\nsay "\${elapsed}", instant\nexit`,
  );
  button.at(2_000);
  assert.equal(button.at(4_999).snapshot.foregroundAction?.kind, "interaction");
  assert.deepEqual(button.at(5_000).said(), ["Read this.", "3 seconds"]);
});

test("a permanent button stays usable during a reading time, and its block interrupts it at once", () => {
  const story = new Story(
    [
      'showPermanentButton "Hint" {',
      '  say "Try the red one.", 2 s',
      "}",
      'say "A long message.", 5 s',
      'say "Next.", instant',
      "exit",
    ].join("\n"),
  );
  story.at(1_000);
  assert.equal(story.press(1), "pressed");
  assert.deepEqual(story.said(), ["A long message.", "Try the red one."]);
  // The long message had four of its five seconds left; it gets them back after the hint's two.
  story.at(6_999);
  assert.deepEqual(story.said(), ["A long message.", "Try the red one."]);
  story.at(7_000);
  assert.deepEqual(story.said(), ["A long message.", "Try the red one.", "Next."]);
});

test("a skip ends the reading time and starts what follows at once", () => {
  const story = new Story(`say "A long message.", 5 s\nwait 1 s\nsay "Done.", instant\nexit`);
  story.at(500).skip();
  const delay = story.snapshot.foregroundAction;
  assert.equal(delay?.kind, "delay");
  assert.deepEqual(
    delay?.kind === "delay" ? [delay.createdAtMs, delay.deadlineMs] : null,
    [500, 1_500],
  );
  assert.deepEqual(story.at(1_500).said(), ["A long message.", "Done."]);

  const unskippable = new Story('say unskippable "Read every word.", 5 s\nexit');
  const gate = unskippable.snapshot.foregroundAction;
  const refused = completeAction(unskippable.plan, unskippable.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(refused.outcome.kind, "invalidPayload");
});

test("a timer block and a media cue block interrupt a reading time at once", () => {
  const timer = new Story(
    [
      'timer async 1 s { say "Ping.", instant }',
      'say "A long message.", 5 s',
      'say "Next.", instant',
      "exit",
    ].join("\n"),
  );
  timer.at(1_000);
  assert.deepEqual(timer.said(), ["A long message.", "Ping."]);
  // The block took no time, so the reading time still ends at 5 s.
  timer.at(4_999);
  assert.deepEqual(timer.said(), ["A long message.", "Ping."]);
  timer.at(5_000);
  assert.deepEqual(timer.said(), ["A long message.", "Ping.", "Next."]);

  const cue = new Story(
    [
      'let music = playAudio async "music.mp3" {',
      "  at 1 s {",
      '    say "Listen.", 1 s',
      "  }",
      "}",
      'say "A long message.", 5 s',
      'say "Next.", instant',
      "exit",
    ].join("\n"),
  );
  cue.load(1, 60_000).at(1_000, [1, 1_000]);
  assert.deepEqual(cue.said(), ["A long message.", "Listen."]);
  // The cue's own message lasts one second, which the long message gets back.
  cue.at(5_999, [1, 5_999]);
  assert.deepEqual(cue.said(), ["A long message.", "Listen."]);
  cue.at(6_000, [1, 6_000]);
  assert.deepEqual(cue.said(), ["A long message.", "Listen.", "Next."]);
});

test("a checkpoint taken during a block that interrupted a reading time restores to the same continuation", () => {
  const story = new Story(
    [
      "timer async 1 s {",
      '  say "Ping.", instant',
      "  wait 2 s",
      "}",
      'let line = say "Counting", instant',
      'say "A long message.", 5 s',
      'line.text = "Counted"',
      'showImage "images/room.jpg"',
      'let ready = askBoolean "Ready?"',
      "exit",
    ].join("\n"),
  );
  story.at(1_500);
  assert.deepEqual(story.said(), ["Counting", "A long message.", "Ping."]);
  assert.equal(story.snapshot.foregroundAction?.kind, "delay");
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(story.plan, story.snapshot)),
  );
  assert.deepEqual(restored.snapshot, story.snapshot);
  // The block waits until 3 s; the reading time then has four seconds left, until 7 s.
  for (const atMs of [6_999, 7_000]) {
    const direct = run(story.plan, observeTime(story.plan, story.snapshot, atMs).snapshot);
    const resumed = run(
      restored.plan,
      observeTime(restored.plan, restored.snapshot, atMs).snapshot,
    );
    assert.deepEqual(resumed.events, direct.events, `${atMs}`);
    assert.deepEqual(resumed.snapshot, direct.snapshot, `${atMs}`);
    assert.deepEqual(
      direct.events.flatMap((event) =>
        event.kind === "say"
          ? [event.text]
          : event.kind === "messageUpdated"
            ? [`updated ${event.text}`]
            : [],
      ),
      atMs === 7_000 ? ["updated Counted", "Ready?"] : [],
      `${atMs}`,
    );
  }
});

test("reading times resume identically from every checkpoint boundary", () => {
  assertRuntimeResumeEquivalent(
    [
      "let count = 0",
      "let tick = timer async hidden 1 s { count += 1 }",
      'let line = say "Waiting.", 2 s',
      'line.text += "."',
      'timer async 500 ms {\n  say "Block.", 1 s\n  showImage "images/block.jpg"\n}',
      'say "Read this.", 1.5 s',
      'showImage "images/room.jpg"',
      "wait 1 s",
      'say "Hold.", instant',
      'let elapsed = showButton "Go", timeout: 1 s',
      'say "${count} ${elapsed}", 1 s',
      "exit",
    ].join("\n"),
    { scenarioName: "reading times" },
  );
});
