import assert from "node:assert/strict";
import test from "node:test";

import { compileProject } from "../src/compiler.js";
import { interactionDeadlineMs } from "../src/runtime/actions/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { reportMediaLoad } from "../src/runtime/operations/media-reports.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { pressPermanentButton } from "../src/runtime/operations/press-permanent-button.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";
import { heldGate } from "./helpers/pacing-states.js";
import { runUntilExit } from "./helpers/run-until-exit.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

/*
 * Say pacing holds back everything the player sees or hears (owner decisions of 2026-10-11, issue #829): later output
 * waits until the reading time of the message before it has passed, and a wait that starts during a reading time
 * replaces it. Explicit pacing durations keep the expected scene times readable.
 */

/** What the player perceives, each with the scene time at which it happened. */
function perceived(atMs: number, events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event): string[] => {
    switch (event.kind) {
      case "say":
        return [`${atMs} say ${event.text}`];
      case "messageUpdated":
        return [`${atMs} text ${event.text}`];
      case "exit":
        return [`${atMs} exit`];
      case "actionRequested": {
        const action = event.action;
        if (action.kind === "interaction") return [`${atMs} ${action.interactionKind}`];
        if (action.kind === "media") return [`${atMs} play ${action.media.source}`];
        if (action.kind === "permanentButton") return [`${atMs} show ${action.button.text}`];
        return [];
      }
      case "actionCompleted": {
        const settlement = event.settlement;
        if (settlement.actionKind === "media")
          return [`${atMs} media ${settlement.settlementKind}`];
        if (settlement.actionKind === "permanentButton") return [`${atMs} remove button`];
        return [];
      }
      default:
        return [];
    }
  });
}

/** The earliest time at which waiting work or a reading time or timer round settles. */
function nextDueMs(snapshot: RuntimeSnapshot, foregroundDeadlineMs: number): number {
  let due = foregroundDeadlineMs;
  for (const action of snapshot.backgroundActions) {
    if (action.kind === "chatPacingGate") due = Math.min(due, action.deadlineMs);
    else if (action.kind === "timer" && action.timer.deadlineMs !== null)
      due = Math.min(due, action.timer.deadlineMs);
  }
  return due;
}

/**
 * Plays `source` like a Player whose player answers at once: it observes each deadline when it is due, presses a
 * button or the first choice, types "Ada", lets a timed question time out, and loads media. A Stage image change is
 * listed after the other output of the same step.
 */
function timeline(source: string): string[] {
  const compiled = plan(source);
  let snapshot = createFreshRuntimeSnapshot(compiled);
  const seen: string[] = [];
  for (let step = 0; step < 100; step += 1) {
    const atMs = snapshot.currentSessionTimeMs;
    const ran = run(compiled, snapshot);
    seen.push(...perceived(atMs, ran.events));
    if (ran.snapshot.stageImage !== snapshot.stageImage)
      seen.push(`${atMs} image ${ran.snapshot.stageImage ?? "hidden"}`);
    snapshot = ran.snapshot;
    assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true, source);
    if (snapshot.status === "halted") return seen;
    assert.equal(snapshot.status, "waiting", source);
    const action = snapshot.foregroundAction!;
    if (action.kind === "chatPacingGate" || action.kind === "delay") {
      snapshot = observeTime(compiled, snapshot, nextDueMs(snapshot, action.deadlineMs)).snapshot;
    } else if (action.kind === "mediaPlayback") {
      snapshot = reportMediaLoad(compiled, snapshot, action.mediaId, {
        kind: "loaded",
        durationMs: 60_000,
      }).snapshot;
    } else if (action.kind === "interaction") {
      const deadlineMs = interactionDeadlineMs(action);
      if (deadlineMs !== null) {
        snapshot = observeTime(compiled, snapshot, nextDueMs(snapshot, deadlineMs)).snapshot;
        continue;
      }
      const base = { actionId: action.actionId, actionKind: "interaction" } as const;
      const completed =
        action.interactionKind === "button"
          ? completeAction(compiled, snapshot, {
              ...base,
              interactionKind: "button",
              payload: { kind: "activate" },
            })
          : action.interactionKind === "choice"
            ? completeAction(compiled, snapshot, {
                ...base,
                interactionKind: "choice",
                payload: { kind: "selectedOption", optionIndex: 0 },
              })
            : completeAction(compiled, snapshot, {
                ...base,
                interactionKind: "text",
                payload: { kind: "submittedText", submittedText: "Ada" },
              });
      assert.equal(completed.outcome.kind, "completed", source);
      snapshot = completed.snapshot;
    } else {
      throw new Error(`Unexpected foreground ${action.kind} in ${source}`);
    }
  }
  throw new Error(`The session did not end: ${source}`);
}

function binding(snapshot: RuntimeSnapshot, name: string) {
  return snapshot.frames[0]!.bindings.find((entry) => entry.name === name)?.value;
}

test("every say waits for the reading time before it, also an instant one, which starts none of its own", () => {
  assert.deepEqual(timeline('say "A", 2 s\nsay "B", instant\nsay "C", 0 s\nsay "D", 1 s\nexit'), [
    "0 say A",
    "2000 say B",
    "2000 say C",
    "2000 say D",
    "3000 exit",
  ]);
});

test("buttons, choices, asks, and forms wait for the reading time before them", () => {
  assert.deepEqual(
    timeline(
      [
        'say "A", 2 s',
        'showButton "Go"',
        'say "B", 1 s',
        'let pick = choose "x", "y"',
        'say "C", 1 s',
        'let name = askText "Name?"',
        'say "D", 1 s',
        'let answers = askForm fields: { on: false }, timeout: 1 s, onTimeout: "submit"',
        'say "E", instant',
        "exit",
      ].join("\n"),
    ),
    [
      "0 say A",
      "2000 button",
      "2000 say B",
      "3000 choice",
      "3000 say C",
      // The question has no reading time of its own: its field opens with it.
      "4000 say Name?",
      "4000 text",
      "4000 say D",
      // The form's time limit counts from when it appeared.
      "5000 form",
      "6000 say E",
      "6000 exit",
    ],
  );
});

test("Stage images, sound, and video wait for the reading time before them", () => {
  assert.deepEqual(
    timeline(
      [
        'say "A", 2 s',
        'showImage "images/room.jpg"',
        'say "B", 1 s',
        'let music = playAudio async "music.mp3"',
        'say "C", 1 s',
        "stopAudio",
        'say "D", 1 s',
        'playVideo async "clip.mp4"',
        'say "E", 1 s',
        "hideImage",
        "exit",
      ].join("\n"),
    ),
    [
      "0 say A",
      "2000 say B",
      "2000 image images/room.jpg",
      "3000 play music.mp3",
      "3000 say C",
      "4000 media stopped",
      "4000 say D",
      "5000 play clip.mp4",
      "5000 say E",
      // Hiding the image also stops the video.
      "6000 media stopped",
      "6000 exit",
      "6000 image hidden",
    ],
  );
});

test("a message's text and permanent buttons change once the reading time before them has passed", () => {
  assert.deepEqual(
    timeline(
      [
        'let line = say "A", 2 s',
        'line.text = "A!"',
        'say "B", 1 s',
        'let stop = showPermanentButton "Stop" {',
        "    exit",
        "}",
        'say "C", 1 s',
        "removePermanentButton(stop)",
        "exit",
      ].join("\n"),
    ),
    [
      "0 say A",
      "2000 text A!",
      "2000 say B",
      "3000 show Stop",
      "3000 say C",
      "4000 remove button",
      "4000 exit",
    ],
  );
});

test("work the player cannot see runs on during a reading time, and code after held output runs once it appears", () => {
  const compiled = plan(
    [
      "let count = 0",
      'say "A", 2 s',
      "count += 1",
      "let paused = timer async hidden 10 s",
      'showImage "images/room.jpg"',
      "count += 1",
      "exit",
    ].join("\n"),
  );
  const held = run(compiled, createFreshRuntimeSnapshot(compiled));
  // The count and the timer start during the reading time; the image waits for it, and so does the code after it.
  assert.equal(binding(held.snapshot, "count"), 1);
  assert.ok(held.snapshot.backgroundActions.some((action) => action.kind === "timer"));
  assert.equal(held.snapshot.stageImage, null);
  assert.equal(heldGate(held.snapshot).deadlineMs, 2_000);

  const shown = runUntilExit(compiled, observeTime(compiled, held.snapshot, 2_000).snapshot);
  assert.equal(shown.snapshot.stageImage, "images/room.jpg");
  assert.equal(binding(shown.snapshot, "count"), 2);
});

test("a wait that starts during a reading time replaces it, whatever code runs in between", () => {
  assert.deepEqual(
    timeline(
      [
        'say "A", 5 s',
        "let n = 1",
        "if n > 0 {",
        "    n += 1",
        "}",
        "wait 1 s",
        'say "B", 2 s',
        // A wait of zero ends the reading time at once.
        "wait 0 s",
        'say "C", instant',
        "exit",
      ].join("\n"),
    ),
    ["0 say A", "1000 say B", "1000 say C", "1000 exit"],
  );
});

test("a question appears together with its field in one step, once the message before it has been read", () => {
  const compiled = plan('say "A", 2 s\nlet name = askText "Name?"\nexit');
  const held = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.deepEqual(
    held.events.map((event) => (event.kind === "say" ? event.text : event.kind)),
    ["A", "actionRequested"],
  );
  // The question waits before it is said, so it holds no prepared output.
  assert.equal(heldGate(held.snapshot).preparedOutput, null);

  const asked = run(compiled, observeTime(compiled, held.snapshot, 2_000).snapshot);
  // No reading time of its own comes between the question and its field.
  assert.deepEqual(
    asked.events.map((event) =>
      event.kind === "say"
        ? event.text
        : event.kind === "actionRequested"
          ? event.action.kind
          : event.kind,
    ),
    ["Name?", "interaction"],
  );
  const field = asked.snapshot.foregroundAction;
  assert.equal(field?.kind === "interaction" && field.createdAtMs, 2_000);
  assert.deepEqual(asked.snapshot.backgroundActions, []);
});

test("a block queued during a reading time runs before a question, never between it and its controls", () => {
  const interrupt = ["timer async 1 s {", '    say "Interrupt", 3 s', "}", 'say "A", 2 s'];
  for (const ask of [
    'let answer = askText "Name?"',
    'let mark = "?"\nlet answer = askText "Name${mark}", hint: "Type"',
    'let answer = askBoolean "Name?"',
    'let answer = askForm "Name?", fields: { on: false }, timeout: 1 s, onTimeout: "submit"',
  ]) {
    const seen = timeline([...interrupt, ask, "exit"].join("\n"));
    // The block's message comes first and gets its reading time; then the question appears with its controls.
    assert.deepEqual(seen.slice(0, 3), ["0 say A", "2000 say Interrupt", "5000 say Name?"], ask);
    assert.match(seen[3]!, /^5000 (text|choice|form)$/u, ask);
  }
});

test("in a block, a message's text, permanent buttons, and exit wait for a reading time, and media keep its timing", () => {
  assert.deepEqual(
    timeline(
      [
        'let line = say "Counter", instant',
        'let close = showPermanentButton "Close" {',
        "    exit",
        "}",
        "timer async 1 s {",
        '    say "Reading", 5 s',
        '    showImage "images/room.jpg"',
        '    line.text = "Changed"',
        "    removePermanentButton(close)",
        '    say "Bye", 1 s',
        "    exit",
        "}",
        "wait 10 s",
        "exit",
      ].join("\n"),
    ),
    [
      "0 say Counter",
      "0 show Close",
      "1000 say Reading",
      "1000 image images/room.jpg",
      "6000 text Changed",
      "6000 remove button",
      "6000 say Bye",
      "7000 exit",
    ],
  );
});

test("a countdown appears, and starts, once the reading time before it ends, and a hidden timer starts at once", () => {
  const compiled = plan(
    [
      'say "A", 2 s',
      "let quiet = timer async hidden 10 s",
      'let shown = timer(duration: 10 s, async: true, display: "mystery")',
      'showButton "Go"',
      "exit",
    ].join("\n"),
  );
  const timers = (snapshot: RuntimeSnapshot) =>
    snapshot.backgroundActions.flatMap((action) =>
      action.kind === "timer"
        ? [`${action.timer.display} ${action.createdAtMs} ${action.timer.deadlineMs}`]
        : [],
    );
  const held = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.deepEqual(timers(held.snapshot), ["hidden 0 10000"]);
  assert.equal(heldGate(held.snapshot).deadlineMs, 2_000);
  const shown = run(compiled, observeTime(compiled, held.snapshot, 2_000).snapshot);
  assert.deepEqual(timers(shown.snapshot), ["hidden 0 10000", "mystery 2000 12000"]);
  assert.equal(shown.snapshot.foregroundAction?.kind, "interaction");
});

test("a goto that removes a shown permanent button waits for the reading time, and one that removes nothing goes on", () => {
  assert.deepEqual(
    timeline(
      [
        'showPermanentButton "Hint" {',
        '    say "Hint", instant',
        "}",
        'showPermanentButton "Always", persist: true {',
        '    say "Always", instant',
        "}",
        'say "A", 5 s',
        "goto next",
        "label next",
        'showButton "Go"',
        "exit",
      ].join("\n"),
    ),
    ["0 show Hint", "0 show Always", "0 say A", "5000 remove button", "5000 button", "5000 exit"],
  );

  const kept = plan(
    [
      "let count = 0",
      'showPermanentButton "Always", persist: true {',
      '    say "Always", instant',
      "}",
      'say "A", 5 s',
      "goto next",
      "label next",
      "count += 1",
      'showButton "Go"',
      "exit",
    ].join("\n"),
  );
  const held = run(kept, createFreshRuntimeSnapshot(kept));
  // Leaving the entry removes no shown button here, so the goto and the code after it run during the reading time.
  assert.equal(binding(held.snapshot, "count"), 1);
  assert.equal(kept.instructions[held.snapshot.nextInstruction]?.kind, "interaction");
});

test("a goto to another file that removes a shown permanent button waits for the reading time", () => {
  const compiled = compileProject([
    {
      path: "main.tease",
      source: [
        'showPermanentButton "Hint" {',
        '    say "Hint", instant',
        "}",
        'say "A", 5 s',
        'goto "next.tease"',
      ].join("\n"),
    },
    { path: "next.tease", source: 'showButton "Go"\nexit' },
  ]);
  assert.deepEqual(compiled.diagnostics, []);
  const project = compiled.plan!;
  const held = run(project, createFreshRuntimeSnapshot(project));
  assert.equal(heldGate(held.snapshot).deadlineMs, 5_000);
  assert.equal(project.instructions[held.snapshot.nextInstruction]?.kind, "transfer");
  assert.ok(held.snapshot.backgroundActions.some((action) => action.kind === "permanentButton"));
  const moved = run(project, observeTime(project, held.snapshot, 5_000).snapshot);
  assert.equal(
    moved.snapshot.backgroundActions.some((action) => action.kind === "permanentButton"),
    false,
  );
  assert.equal(moved.snapshot.foregroundAction?.kind, "interaction");
});

test("permanent buttons stay usable while a reading time holds output back", () => {
  const compiled = plan(
    [
      'showPermanentButton "Hint" {',
      '    say "Hint.", instant',
      "}",
      'say "A", 5 s',
      'showButton "Go"',
      "exit",
    ].join("\n"),
  );
  const held = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.equal(heldGate(held.snapshot).deadlineMs, 5_000);
  const pressed = pressPermanentButton(compiled, held.snapshot, 1);
  assert.equal(pressed.outcome.kind, "pressed");
  // The click is taken at once; its block runs when the reading time ends, before the button it held back.
  assert.deepEqual(run(compiled, pressed.snapshot).events, []);
  const resumed = run(compiled, observeTime(compiled, pressed.snapshot, 5_000).snapshot);
  assert.deepEqual(
    resumed.events.flatMap((event) =>
      event.kind === "say"
        ? [event.text]
        : event.kind === "actionRequested"
          ? [event.action.kind]
          : [],
    ),
    ["Hint.", "interaction"],
  );
});

test("a skip ends the reading time and shows the output it held back at once", () => {
  const compiled = plan('say "A", 5 s\nlet elapsed = showButton "Go", timeout: 2 s\nexit');
  const held = run(compiled, createFreshRuntimeSnapshot(compiled));
  const skipped = completeAction(compiled, held.snapshot, {
    actionId: heldGate(held.snapshot).actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(skipped.outcome.kind, "completed");
  const shown = run(compiled, skipped.snapshot);
  const button = shown.snapshot.foregroundAction;
  assert.equal(button?.kind, "interaction");
  assert.deepEqual(
    button?.kind === "interaction" && [button.createdAtMs, button.timeoutMs],
    [0, 2_000],
  );
});

test("in a block, messages and questions wait for a reading time, and other output keeps the block's timing", () => {
  assert.deepEqual(
    timeline(
      [
        "timer async 1 s {",
        '    say "B", 2 s',
        '    showImage "images/room.jpg"',
        '    showButton "OK"',
        "}",
        "wait 10 s",
        "exit",
      ].join("\n"),
    ),
    ["1000 say B", "1000 image images/room.jpg", "3000 button", "10000 exit"],
  );
});

test("output held back behind a reading time resumes the same from a checkpoint at every boundary", () => {
  assertRuntimeResumeEquivalent(
    [
      'let line = say("A", 1 s)',
      'showImage "images/room.jpg"',
      'let music = playAudio async "music.mp3"',
      'say "B", 1 s',
      'line.text = "A!"',
      'say "C", 1 s',
      'let elapsed = showButton "Go", timeout: 1 s',
      'say "D", 1 s',
      'let stop = showPermanentButton "Stop" {',
      "    exit",
      "}",
      'say "E", 1 s',
      "removePermanentButton(stop)",
      'say "F", 1 s',
      "music.stop()",
      'say "G", 1 s',
      "exit",
    ].join("\n"),
    { mediaDurationMs: 60_000, scenarioName: "held output" },
  );

  // A question held back behind a reading time, restored from JSON, appears like the uninterrupted one.
  const compiled = plan('say "A", 2 s\nlet pick = choose "x", "y"\nsay pick, instant\nexit');
  const held = run(compiled, createFreshRuntimeSnapshot(compiled));
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, held.snapshot)),
  );
  assert.deepEqual(restored.snapshot, held.snapshot);
  const resume = (start: {
    readonly plan: typeof compiled;
    readonly snapshot: RuntimeSnapshot;
  }) => {
    const asked = run(start.plan, observeTime(start.plan, start.snapshot, 2_000).snapshot);
    const choice = asked.snapshot.foregroundAction!;
    const answered = completeAction(start.plan, asked.snapshot, {
      actionId: choice.actionId,
      actionKind: "interaction",
      interactionKind: "choice",
      payload: { kind: "selectedOption", optionIndex: 1 },
    });
    const ended = run(start.plan, answered.snapshot);
    return {
      events: [...asked.events, ...answered.events, ...ended.events],
      snapshot: ended.snapshot,
    };
  };
  const direct = resume({ plan: compiled, snapshot: held.snapshot });
  assert.deepEqual(resume(restored), direct);
  assert.equal(direct.snapshot.status, "halted");
  assert.deepEqual(
    direct.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["y"],
  );
});
