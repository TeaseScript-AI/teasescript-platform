import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimeAwaitsHost,
  playerRuntimeDeadlines,
  playerRuntimeTimers,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import { interruptFrame } from "../src/runtime/scopes/activations.js";
import type { RuntimeForegroundActionSnapshot } from "../src/runtime/actions/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/snapshot/checkpoint.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { runtimeTimedWork } from "../src/runtime/operations/observe-time.js";
import { createRuntimeSession } from "../src/runtime/session.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { Story } from "./helpers/story-session.js";
import { validateRuntimeSnapshot } from "../src/runtime/snapshot/snapshot-validation.js";

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

/**
 * How a Player lets a block run on, for each source of a block that waits 2 s: a timer's and a media cue's block is due
 * at 1 s, and a button's when the Player clicks it on observing `atMs`.
 */
const BLOCK_SOURCES = [
  {
    name: "timer",
    block: BLOCK,
    start: (story: Story) => story,
    at: (story: Story, atMs: number) => story.at(atMs),
    due: (story: Story, atMs: number) => story.at(atMs),
    dueAtMs: () => 1_000,
  },
  {
    name: "media cue",
    block: 'let music = playAudio async "music.mp3" {\n  at 1 s {\n    wait 2 s\n  }\n}',
    start: (story: Story) => story.load(1, 60_000),
    at: (story: Story, atMs: number) => story.at(atMs, [1, atMs]),
    due: (story: Story, atMs: number) => story.at(atMs, [1, atMs]),
    dueAtMs: () => 1_000,
  },
  {
    name: "permanent button",
    block: 'showPermanentButton "Hint" {\n  wait 2 s\n}',
    start: (story: Story) => story,
    at: (story: Story, atMs: number) => story.at(atMs),
    due: (story: Story, atMs: number) => {
      assert.equal(story.at(atMs).press(1), "pressed");
      return story;
    },
    dueAtMs: (atMs: number) => atMs,
  },
] as const;

/**
 * Statements that make the main path wait on a foreground action of each kind, keyed by kind so that a new kind needs
 * its rows. Each row gives the deadline at which time settles or times out the action, or `null`, and whether the
 * action waits for the host alone, so that a Player's time jump stops at it. A block interrupts the action, which then
 * resumes as it was with `resumesWith` changed, or the action is a host step that the block waits for until the Player
 * settles it with `settledBy`; meanwhile scene time stands at the block's due time if the step `holdsCatchUp` (owner
 * decision on #829, 2026-10-11, and the host steps in docs/RUNTIME.md).
 */
const FOREGROUND_ROWS: {
  readonly [K in RuntimeForegroundActionSnapshot["kind"]]: readonly (
    | {
        readonly source: string;
        readonly deadlineMs: number | null;
        readonly awaitsHost: boolean;
        readonly resumesWith: Readonly<Record<string, number>>;
      }
    | {
        readonly source: string;
        readonly deadlineMs: number | null;
        readonly awaitsHost: boolean;
        readonly holdsCatchUp: boolean;
        readonly settledBy: Readonly<Record<string, string>>;
      }
  )[];
} = {
  // A wait and a reading time keep the time they had left.
  delay: [
    {
      source: "wait 3 s",
      deadlineMs: 3_000,
      awaitsHost: false,
      resumesWith: { createdAtMs: 2_000, deadlineMs: 5_000 },
    },
  ],
  chatPacingGate: [
    {
      source: 'say "Read this.", 3 s',
      deadlineMs: 3_000,
      awaitsHost: false,
      resumesWith: { createdAtMs: 2_000, deadlineMs: 5_000 },
    },
  ],
  // An interaction leaves out the time it stood still; a password field is shown anew too.
  interaction: [
    {
      source: 'let name = askText "Name?"',
      deadlineMs: null,
      awaitsHost: false,
      resumesWith: { pausedMs: 2_000 },
    },
    {
      source: 'let elapsed = showButton "Go", timeout: 3 s',
      deadlineMs: 3_000,
      awaitsHost: false,
      resumesWith: { pausedMs: 2_000 },
    },
    {
      source: 'let code = askPassword "Code?"',
      deadlineMs: null,
      awaitsHost: false,
      resumesWith: { pausedMs: 2_000, resumes: 1 },
    },
  ],
  // A media wait is not timed.
  mediaPlayback: [
    { source: 'playAudio "sounds/bell.mp3"', deadlineMs: null, awaitsHost: false, resumesWith: {} },
  ],
  // A lock's dialog asks again; its work step is a host step.
  lock: [
    {
      source: 'let locked = encryptText("x")',
      deadlineMs: null,
      awaitsHost: false,
      resumesWith: { resumes: 1 },
    },
    {
      source: 'let locked = encryptText("x", password: "p", publicKey: false, timeLock: false)',
      deadlineMs: null,
      awaitsHost: true,
      holdsCatchUp: false,
      settledBy: { kind: "locked", text: "AAAA" },
    },
  ],
  // A block may read the value a write stored, so it runs at its due time once the host acknowledged the write.
  storageWrite: [
    {
      source: 'save 2 as "k"',
      deadlineMs: null,
      awaitsHost: true,
      holdsCatchUp: true,
      settledBy: { kind: "stored" },
    },
  ],
  capture: [
    {
      source: "let photo = takePhoto()",
      deadlineMs: null,
      awaitsHost: true,
      holdsCatchUp: false,
      settledBy: { kind: "unavailable", reason: "denied" },
    },
  ],
  fileStore: [
    {
      source: 'let file = fileFromBase64("YWJj", default: null)',
      deadlineMs: null,
      awaitsHost: true,
      holdsCatchUp: false,
      settledBy: { kind: "failed" },
    },
  ],
};

test("a block from each source interrupts each foreground action that is no host step, and waits for a host step", () => {
  /** The deadline of the main path's action as timed work, or `null`, and whether a Player's time jump waits. */
  const timing = (story: Story, actionId: number) => {
    const view = createRuntimeSession(story.plan, story.snapshot).view();
    const work = runtimeTimedWork(view).find((candidate) => candidate.actionId === actionId);
    return { deadlineMs: work?.deadlineMs ?? null, awaitsHost: playerRuntimeAwaitsHost(view) };
  };
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
        assert.deepEqual(
          timing(story, waiting.actionId),
          { deadlineMs: row.deadlineMs, awaitsHost: row.awaitsHost },
          name,
        );
        // A host step is observed late, at 1.5 s, so that a step that holds catch-up keeps scene time behind.
        const observedMs = "resumesWith" in row ? 1_000 : 1_500;
        source.due(story, observedMs);
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
          assert.equal(
            story.snapshot.currentSessionTimeMs,
            row.holdsCatchUp ? source.dueAtMs(observedMs) : observedMs,
            name,
          );
          const settled = completion(row.settledBy);
          assert.equal(settled.outcome.kind, "completed", name);
          story.snapshot = settled.snapshot;
          source.at(story, observedMs);
          assert.equal(story.snapshot.foregroundAction?.kind, "delay", name);
          assert.equal(
            interruptFrame(story.snapshot)?.timerInterruption?.suspendedAction,
            null,
            name,
          );
          source.at(story, 4_000);
          assert.equal(story.said().at(-1), "Done.", name);
        }
      }
    }
  }
});

test("structural validation refuses a block frame that suspends a host step", () => {
  const story = new Story(`${BLOCK}\nwait 3 s\nexit`, { persistentScriptStorage: true });
  story.at(1_000);
  // Assembled: the engine's frame of a block that interrupted a wait, with the wait replaced by a storage write of the
  // same identity and context. Validation without the plan leaves out ownership, so only the host step is wrong.
  // EVIDENCE: JSON serialization preserves the validated snapshot's plain-data shape; the case replaces one action.
  const tampered = JSON.parse(JSON.stringify(story.snapshot)) as {
    callFrames: { timerInterruption: { suspendedAction: Record<string, unknown> } | null }[];
  };
  assert.deepEqual(validateRuntimeSnapshot(tampered).errors, []);
  const interruption = tampered.callFrames.find(
    (frame) => frame.timerInterruption !== null,
  )!.timerInterruption!;
  const wait = interruption.suspendedAction;
  assert.equal(wait.kind, "delay");
  interruption.suspendedAction = {
    kind: "storageWrite",
    ...Object.fromEntries(
      [
        "actionId",
        "owningInstruction",
        "continuationInstruction",
        "ownerCallFrameId",
        "scopeDepth",
        "loopDepth",
        "createdAtMs",
        "requestEventSequence",
      ].map((field) => [field, wait[field]]),
    ),
    key: "k",
    value: 2,
  };
  assert.deepEqual(validateRuntimeSnapshot(tampered).errors, [
    "Runtime suspended foreground action is malformed.",
  ]);
});
