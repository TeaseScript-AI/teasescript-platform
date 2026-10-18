import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimeDeadlines,
  playerRuntimeTimers,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import { interruptFrame } from "../src/runtime/activations.js";
import type { RuntimeForegroundActionSnapshot } from "../src/runtime/actions/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { Story } from "./helpers/story-session.js";

/*
 * Preempt and resume (owner decision on #829, 2026-10-11): while a timer, media, or button block runs, everything the
 * main path waits on stands still, and after a normal return it continues with its remaining time. Asynchronous timers
 * and media keep running, and a wait for media to end ends with the media. Each block below starts at 1 s and runs
 * for 2 s, so a 3-s wait that it interrupts ends at 5 s instead of 3 s.
 */

const BLOCK = "timer async 1 s {\n  wait 2 s\n}";

/** The foreground actions a main path waits on with three seconds of time, each followed by "Done.". */
const WAITS = [
  "wait 3 s",
  "timer 3 s",
  'say "Read this.", 3 s',
  'let elapsed = showButton "Go", timeout: 3 s',
  'let answers = askForm fields: { n: { type: "integer", value: 1 } }, timeout: 3 s, onTimeout: "submit"',
];

test("an interrupted wait, blocking timer, reading time, and showButton or askForm timeout stand still during the block", () => {
  for (const wait of WAITS) {
    const story = new Story(`${BLOCK}\n${wait}\nsay "Done.", instant\nexit`);
    const waiting = story.snapshot.foregroundAction;
    story.at(1_000);
    // The block waits; the interrupted action is inert and keeps its two remaining seconds.
    const blockWait = story.snapshot.foregroundAction;
    assert.equal(blockWait?.kind, "delay", wait);
    assert.notEqual(blockWait?.actionId, waiting?.actionId, wait);
    story.at(3_000);
    const resumed = story.snapshot.foregroundAction;
    assert.equal(resumed?.actionId, waiting?.actionId, wait);
    if (resumed?.kind === "interaction") assert.equal(resumed.pausedMs, 2_000, wait);
    else
      assert.equal(
        resumed?.kind === "delay" || resumed?.kind === "chatPacingGate" ? resumed.deadlineMs : null,
        5_000,
        wait,
      );
    story.at(4_999);
    assert.notEqual(story.said().at(-1), "Done.", wait);
    story.at(5_000);
    assert.equal(story.said().at(-1), "Done.", wait);
    assert.equal(story.snapshot.status, "halted", wait);
  }
});

test("a button's elapsed time leaves out the time a block interrupted it", () => {
  const story = new Story(
    `${BLOCK}\nlet elapsed = showButton "Go"\nsay "\${elapsed}", instant\nexit`,
  );
  story.at(1_000).at(3_000).at(4_000);
  const button = story.snapshot.foregroundAction;
  assert.equal(button?.kind, "interaction");
  const activated = completeAction(story.plan, story.snapshot, {
    actionId: button!.actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  });
  assert.equal(activated.outcome.kind, "completed");
  story.snapshot = activated.snapshot;
  story.at(4_000);
  // Shown at 0 s and pressed at 4 s, of which 2 s were the block's.
  assert.deepEqual(story.said(), ["2 seconds"]);
});

test("a message in a block holds the return to an interrupted question for its reading time", () => {
  for (const [pacing, returnsAtMs] of [
    ["2 s", 3_000],
    ["instant", 1_000],
  ] as const) {
    const story = new Story(
      [
        'showPermanentButton "Hint" {',
        `  say "Try the red one.", ${pacing}`,
        "}",
        'let name = askText "Name?"',
        "exit",
      ].join("\n"),
    );
    story.at(1_000);
    assert.equal(story.press(1), "pressed", pacing);
    assert.deepEqual(story.said(), ["Name?", "Try the red one."], pacing);
    if (returnsAtMs > 1_000) {
      story.at(returnsAtMs - 1);
      assert.equal(story.snapshot.foregroundAction?.kind, "chatPacingGate", pacing);
      story.at(returnsAtMs);
    }
    const field = story.snapshot.foregroundAction;
    assert.equal(field?.kind, "interaction", pacing);
    assert.equal(
      field?.kind === "interaction" ? field.pausedMs : null,
      returnsAtMs > 1_000 ? 2_000 : undefined,
      pacing,
    );
  }
});

test("a goto or exit in a block cancels the interrupted action of each kind", () => {
  for (const wait of WAITS) {
    for (const leave of ["goto away", "exit"]) {
      const story = new Story(
        [
          `timer async 1 s {\n  ${leave}\n}`,
          wait,
          'say "Done.", instant',
          "exit",
          "label away",
          'say "Away.", instant',
          "exit",
        ].join("\n"),
      );
      const before = story.said();
      story.at(1_000).at(10_000);
      assert.deepEqual(
        story.said(),
        [...before, ...(leave === "exit" ? [] : ["Away."])],
        `${leave}: ${wait}`,
      );
      assert.equal(story.snapshot.status, "halted", `${leave}: ${wait}`);
    }
  }
});

test("asynchronous timers keep running during a block, and their blocks run after it", () => {
  const story = new Story(
    ['let t = timer async 2 s { say "Async.", instant }', BLOCK, "wait 10 s", "exit"].join("\n"),
  );
  story.at(1_000).at(2_000);
  // The block's own timer finished at 1 s; the async timer finished on time at 2 s, and its block waits.
  assert.deepEqual(
    story.events.flatMap((event) =>
      event.kind === "actionCompleted" && event.settlement.actionKind === "timer"
        ? [event.settlement.completedAtMs]
        : [],
    ),
    [1_000, 2_000],
  );
  assert.deepEqual(story.said(), []);
  story.at(3_000);
  assert.deepEqual(story.said(), ["Async."]);
});

test("a wait for media to end ends with its media, also while a block runs", () => {
  const story = new Story(
    [
      "timer async 1 s {",
      "  wait 5 s",
      "}",
      'playAudio "sounds/bell.mp3"',
      'say "After the bell.", instant',
      "exit",
    ].join("\n"),
  );
  story.load(1, 3_000).at(1_000, [1, 1_000]);
  assert.equal(story.snapshot.foregroundAction?.kind, "delay");
  // The bell ends at 3 s during the block; the main path goes on as soon as the block returns.
  story.at(3_000, [1, 3_000]);
  assert.deepEqual(story.said(), []);
  story.at(6_000);
  assert.deepEqual(story.said(), ["After the bell."]);
  assert.equal(story.snapshot.status, "halted");
});

test("a session restored at any boundary of a block that interrupted a waiting action plays on identically", () => {
  for (const wait of [...WAITS, 'playAudio "sounds/bell.mp3"']) {
    assertRuntimeResumeEquivalent(
      [
        "timer async 1 s {",
        '  say "Ping.", 1 s',
        "  wait 1 s",
        "}",
        wait,
        'say "Done.", instant',
        "exit",
      ].join("\n"),
      { scenarioName: `block interrupting ${wait}`, mediaDurationMs: 4_000 },
    );
  }
});

function observe(session: PlayerRuntimeSession, atMs: number): PlayerRuntimeSession {
  const observed = observePlayerRuntimeTime(session, atMs);
  assert.equal(observed.outcome.kind, "observed");
  return observed.session;
}

test("the Player shows an interrupted blocking timer standing still and schedules no observation for it", () => {
  let session = observe(createPlayerRuntimeSession(`${BLOCK}\ntimer 3 s\nexit`), 1_000);
  const remaining = (atMs: number) =>
    playerRuntimeTimers(session.state, atMs).map((timer) => timer.remainingSeconds);
  assert.deepEqual(remaining(1_000), [2]);
  assert.deepEqual(remaining(2_500), [2]);
  // Only the block's own wait is due; the timer stands still.
  assert.deepEqual(playerRuntimeDeadlines(session.state), [3_000]);
  session = observe(session, 3_000);
  assert.deepEqual(remaining(3_000), [2]);
  assert.deepEqual(remaining(4_000), [1]);
  assert.deepEqual(playerRuntimeDeadlines(session.state), [5_000]);
});

/** How a Player makes a block due at 1 s and lets it run on, for each source of a block that then waits 2 s. */
const BLOCK_SOURCES = [
  {
    name: "timer",
    block: BLOCK,
    start: (story: Story) => story,
    at: (story: Story, atMs: number) => story.at(atMs),
    due: (story: Story) => story.at(1_000),
  },
  {
    name: "media cue",
    block: 'let music = playAudio async "music.mp3" {\n  at 1 s {\n    wait 2 s\n  }\n}',
    start: (story: Story) => story.load(1, 60_000),
    at: (story: Story, atMs: number) => story.at(atMs, [1, atMs]),
    due: (story: Story) => story.at(1_000, [1, 1_000]),
  },
  {
    name: "permanent button",
    block: 'showPermanentButton "Hint" {\n  wait 2 s\n}',
    start: (story: Story) => story,
    at: (story: Story, atMs: number) => story.at(atMs),
    due: (story: Story) => {
      assert.equal(story.at(1_000).press(1), "pressed");
      return story;
    },
  },
] as const;

/**
 * Statements that make the main path wait on a foreground action of each kind, keyed by kind so that a new kind needs
 * its rows. A block interrupts the action, which then resumes as it was with `resumesWith` changed, or the action is a
 * host step that the block waits for until the Player settles it with `settledBy` (owner decision on #829, 2026-10-11;
 * V30 §13 for storage, captures, file stores, and locks).
 */
const FOREGROUND_ROWS: {
  readonly [K in RuntimeForegroundActionSnapshot["kind"]]: readonly (
    | { readonly source: string; readonly resumesWith: Readonly<Record<string, number>> }
    | { readonly source: string; readonly settledBy: Readonly<Record<string, string>> }
  )[];
} = {
  // A wait and a reading time keep the time they had left.
  delay: [{ source: "wait 3 s", resumesWith: { createdAtMs: 2_000, deadlineMs: 5_000 } }],
  chatPacingGate: [
    { source: 'say "Read this.", 3 s', resumesWith: { createdAtMs: 2_000, deadlineMs: 5_000 } },
  ],
  // An interaction leaves out the time it stood still; a password field is shown anew too.
  interaction: [
    { source: 'let name = askText "Name?"', resumesWith: { pausedMs: 2_000 } },
    { source: 'let code = askPassword "Code?"', resumesWith: { pausedMs: 2_000, resumes: 1 } },
  ],
  // A media wait is not timed.
  mediaPlayback: [{ source: 'playAudio "sounds/bell.mp3"', resumesWith: {} }],
  // A lock's dialog asks again; its work step is a host step.
  lock: [
    { source: 'let locked = encryptText("x")', resumesWith: { resumes: 1 } },
    {
      source: 'let locked = encryptText("x", password: "p", publicKey: false, timeLock: false)',
      settledBy: { kind: "locked", text: "AAAA" },
    },
  ],
  storageWrite: [{ source: 'save 2 as "k"', settledBy: { kind: "stored" } }],
  capture: [
    { source: "let photo = takePhoto()", settledBy: { kind: "unavailable", reason: "denied" } },
  ],
  fileStore: [
    { source: 'let file = fileFromBase64("YWJj", default: null)', settledBy: { kind: "failed" } },
  ],
};

test("a block from each source interrupts each foreground action that is no host step, and waits for a host step", () => {
  for (const source of BLOCK_SOURCES) {
    for (const [kind, rows] of Object.entries(FOREGROUND_ROWS)) {
      for (const row of rows) {
        const name = `${source.name} block during ${row.source}`;
        const story = source.start(
          new Story(`${source.block}\n${row.source}\nsay "Done.", instant\nexit`, {
            persistentScriptStorage: true,
            wallClockMs: Date.UTC(2026, 9, 14, 12, 0, 0),
          }),
        );
        const waiting = story.snapshot.foregroundAction!;
        assert.equal(waiting.kind, kind, name);
        if (waiting.kind === "lock")
          assert.equal(waiting.phase, "resumesWith" in row ? "ask" : "work", name);
        source.due(story);
        // The state at the block's due time checkpoints as it is, an interrupted action and a waiting block alike.
        assert.deepEqual(
          deserializeCheckpoint(serializeCheckpoint(createCheckpoint(story.plan, story.snapshot)))
            .snapshot,
          story.snapshot,
          name,
        );
        const completion = (payload: Readonly<Record<string, string>>) =>
          completeAction(story.plan, story.snapshot, {
            actionId: waiting.actionId,
            actionKind: waiting.kind,
            ...(waiting.kind === "interaction" ? { interactionKind: waiting.interactionKind } : {}),
            payload,
          });
        if ("resumesWith" in row) {
          // The block runs; the interrupted action is inert until it returns.
          assert.equal(story.snapshot.foregroundAction?.kind, "delay", name);
          assert.equal(
            interruptFrame(story.snapshot)?.timerInterruption?.suspendedAction?.actionId,
            waiting.actionId,
            name,
          );
          assert.equal(completion({ kind: "skip" }).outcome.kind, "suspendedAction", name);
          source.at(story, 3_000);
          assert.deepEqual(
            story.snapshot.foregroundAction,
            { ...waiting, ...row.resumesWith },
            name,
          );
        } else {
          // The block waits until the host step settles, and then runs at once.
          assert.equal(interruptFrame(story.snapshot), undefined, name);
          assert.equal(story.snapshot.pendingTimerHandlers.length, 1, name);
          assert.deepEqual(story.snapshot.foregroundAction, waiting, name);
          const settled = completion(row.settledBy);
          assert.equal(settled.outcome.kind, "completed", name);
          story.snapshot = settled.snapshot;
          source.at(story, 1_000);
          assert.equal(story.snapshot.foregroundAction?.kind, "delay", name);
          assert.equal(
            interruptFrame(story.snapshot)?.timerInterruption?.suspendedAction,
            null,
            name,
          );
          source.at(story, 3_000);
          assert.equal(story.said().at(-1), "Done.", name);
        }
      }
    }
  }
});
