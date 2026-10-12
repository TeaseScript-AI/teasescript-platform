import assert from "node:assert/strict";
import test from "node:test";

import type { InterpreterEvent } from "../src/runtime/events.js";
import { validateRuntimeSnapshot } from "../src/runtime/state.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { Story } from "./helpers/story-session.js";

/*
 * Developer warning TSW018 (owner decision, 2026-10-12): blocks never interrupt each other, so a repeating timer whose
 * block takes at least as long as its period starts its next round before the block returns, and the script after the
 * timer cannot continue while that repeats. Debug reports it once per timer, when such a block returns normally.
 */

function overrun(line: number, period: string): string {
  return `The timer at main.tease:${line} started its next round before its block had finished, because the block took at least as long as its period of ${period}. While this repeats, the script after the timer cannot continue. Make the block shorter than the period, or the period longer.`;
}

function warnings(
  events: readonly InterpreterEvent[],
): { code: string; line: number; message: string }[] {
  return events.flatMap((event) =>
    event.kind === "developerWarning"
      ? [{ code: event.code, line: event.span.start.line + 1, message: event.message }]
      : [],
  );
}

/** Plays `source` with an observation every half second up to `untilMs`. */
function play(source: string, untilMs = 30_000): Story {
  const story = new Story(source);
  for (let nowMs = 500; nowMs <= untilMs; nowMs += 500) story.at(nowMs);
  return story;
}

/** A repeating 2-second timer whose block runs `body`, then a wait the blocks interrupt. */
function ticking(body: string): string {
  return [
    "timer(duration: 2 s, async: true, repeat: true) {",
    `  ${body}`,
    "}",
    "wait 5 s",
    'say "Done", instant',
    "exit",
  ].join("\n");
}

test("a block that takes longer than its period, or exactly as long, reports TSW018 once", () => {
  for (const body of ['say "Tick.", 3 s', 'say "Tick.", 2 s']) {
    const story = play(ticking(body));
    assert.deepEqual(
      warnings(story.events),
      [{ code: "TSW018", line: 1, message: overrun(1, "2 seconds") }],
      body,
    );
    assert.equal(story.said().includes("Done"), false, body);
  }
});

test("a shorter block, a timer that does not repeat, and a block that leaves by goto or exit report nothing", () => {
  const sources = [
    ticking('say "Tick.", 1 s'),
    ticking('say "Tick.", 3 s').replace(", repeat: true", ""),
    ticking("wait 3 s\n  goto away").replace("exit", 'exit\nlabel away\nsay "Away", instant\nexit'),
    ticking("wait 3 s\n  exit"),
  ];
  for (const source of sources) {
    const story = play(source);
    assert.deepEqual(warnings(story.events), [], source);
    assert.equal(story.snapshot.status, "halted", source);
  }
});

test("rounds that another block held back do not count, but a held-back block as long as its period does", () => {
  // The 2-second timer's blocks take no time until the 5-second timer's block holds its rounds due at 6 to 14 s back
  // until 15 s.
  const heldBack = (body: string) =>
    [
      "let slow = false",
      "timer(duration: 5 s, async: true) {",
      "  slow = true",
      "  wait 10 s",
      "}",
      "let t = timer(duration: 2 s, async: true, repeat: true) {",
      `  ${body}`,
      "}",
      "wait 30 s",
      "t.stop()",
      'say "Done", instant',
      "exit",
    ].join("\n");
  // Its waiting blocks then run back to back in no time, and the script goes on.
  const instant = play(heldBack('say "X", instant'), 60_000);
  assert.deepEqual(warnings(instant.events), []);
  assert.equal(instant.said().at(-1), "Done");
  // Its first waiting block starts mid-round at 15 s and takes 2 s, as long as the round that ends during it at 16 s.
  // Five rounds then stay queued, as one round ends during each block.
  const asLong = play(heldBack("if slow {\n    wait 2 s\n  }"), 20_000);
  assert.deepEqual(warnings(asLong.events), [
    { code: "TSW018", line: 6, message: overrun(6, "2 seconds") },
  ]);
  // A block shorter than the period does not, although a round ends during it, and the queue empties.
  const shorter = play(heldBack("if slow {\n    wait 1500 ms\n  }"), 30_000);
  assert.deepEqual(warnings(shorter.events), []);
});

test("a repeating range names the round that ran out during the block", () => {
  const story = new Story(
    "timer(duration: (2..=3) s, async: true, repeat: true) {\n  wait 3 s\n}\nwait 5 s\nexit",
  );
  for (let nowMs = 500; story.snapshot.callFrames.length === 0; nowMs += 500) story.at(nowMs);
  // The block started as the first round ran out, and only the round it started can run out while the block runs.
  const timer = story.snapshot.backgroundActions.find((action) => action.kind === "timer");
  const roundMs = timer?.kind === "timer" ? timer.timer.roundDurationMs : null;
  assert.ok(roundMs === 2_000 || roundMs === 3_000);
  const startedAtMs = story.snapshot.currentSessionTimeMs;
  story
    .at(startedAtMs + 1_000)
    .at(startedAtMs + 2_000)
    .at(startedAtMs + 3_000);
  assert.deepEqual(warnings(story.events), [
    { code: "TSW018", line: 1, message: overrun(1, `${roundMs / 1_000} seconds`) },
  ]);
});

test("a session restored before or after the warning reports it once, at the same return", () => {
  const { events } = assertRuntimeResumeEquivalent(
    [
      "let n = 0",
      "let t = timer(duration: 2 s, async: true, repeat: true) {",
      "  n += 1",
      "  wait 3 s",
      // A message after the round ran out keeps the record through the say's staged state.
      '  say "Block ${n} ends.", instant',
      "  if n == 3 {",
      "    t.stop()",
      "  }",
      "}",
      "wait 5 s",
      'say "Done after ${n} blocks", instant',
      "exit",
    ].join("\n"),
    { scenarioName: "block overrun" },
  );
  // The first block's return reports it, the second overruns again without a report, and the third stops the timer.
  assert.deepEqual(warnings(events), [
    { code: "TSW018", line: 2, message: overrun(2, "2 seconds") },
  ]);
  assert.deepEqual(
    events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["Block 1 ends.", "Block 2 ends.", "Block 3 ends.", "Done after 3 blocks"],
  );
});

test("restore refuses a malformed overrun record", () => {
  const story = play(
    `timer async 10 s {\n  wait 1 s\n}\n${ticking("wait 3 s")}`.replace("wait 5 s", "wait 20 s"),
    4_500,
  );
  // The repeating timer's first block runs from 2 s, and the round that started with it ran out at 4 s.
  const frame = story.snapshot.callFrames.at(-1);
  const interruption = frame?.kind === "function" ? frame.timerInterruption : null;
  assert.equal(
    interruption !== null && "timerId" in interruption ? interruption.endedRoundMs : null,
    2_000,
  );
  assert.equal(validateRuntimeSnapshot(story.snapshot, story.plan).valid, true);
  type Mutable = {
    callFrames: { timerInterruption: Record<string, unknown> }[];
    backgroundActions: { timer: Record<string, unknown> }[];
  };
  const mutations: readonly (readonly [string, (snapshot: Mutable) => void])[] = [
    ["negative round", (snapshot) => (snapshot.callFrames[0]!.timerInterruption.endedRoundMs = -1)],
    [
      "round as text",
      (snapshot) => (snapshot.callFrames[0]!.timerInterruption.endedRoundMs = "2 s"),
    ],
    ["missing round", (snapshot) => delete snapshot.callFrames[0]!.timerInterruption.endedRoundMs],
    ["mark as text", (snapshot) => (snapshot.backgroundActions[1]!.timer.overrunReported = "yes")],
    [
      "mark on a timer that does not repeat",
      (snapshot) => (snapshot.backgroundActions[0]!.timer.overrunReported = true),
    ],
  ];
  for (const [name, mutate] of mutations) {
    // EVIDENCE: JSON serialization preserves the validated snapshot's plain-data shape; each case applies one invalid mutation.
    const corrupted = JSON.parse(JSON.stringify(story.snapshot)) as Mutable;
    mutate(corrupted);
    assert.equal(validateRuntimeSnapshot(corrupted, story.plan).valid, false, name);
  }
});
