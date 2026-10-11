import assert from "node:assert/strict";
import test from "node:test";

import { debugCountdownText } from "../player/presentation.js";
import {
  activatePlayerRuntimeButton,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimeDebugCountdown,
  restorePlayerRuntimeSession,
  type PlayerRuntimeDebugCountdown,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";

// Player Debug countdowns (DEBUGGER.md "Player Debug") name the current foreground wait from canonical state: an
// authored `wait`, a presented timed `showButton`, or a message's reading time. Expected deadlines follow from the
// source's durations.

const W = (deadlineMs: number) => ({ kind: "wait" as const, deadlineMs });
const B = (deadlineMs: number) => ({ kind: "button" as const, deadlineMs });
const P = (deadlineMs: number) => ({ kind: "pacing" as const, deadlineMs });

function observe(session: PlayerRuntimeSession, atMs: number): PlayerRuntimeSession {
  const observed = observePlayerRuntimeTime(session, atMs);
  assert.equal(observed.outcome.kind, "observed");
  return observed.session;
}

/** The countdown of a new session, then after observing each scene time in turn. */
function countdowns(
  source: string,
  times: readonly number[],
  options?: PlayerRuntimeSessionOptions,
): (PlayerRuntimeDebugCountdown | null)[] {
  let session = createPlayerRuntimeSession(source, options);
  const seen = [playerRuntimeDebugCountdown(session)];
  for (const atMs of times) {
    session = observe(session, atMs);
    seen.push(playerRuntimeDebugCountdown(session));
  }
  return seen;
}

test("a wait counts down, but a blocking timer, which runs as the same delay, never does", () => {
  assert.deepEqual(countdowns("wait 5 s\nexit", [1_000, 5_000]), [W(5_000), W(5_000), null]);
  for (const timer of ["timer 5 s", "timer hidden 5 s", "timer mystery 5 s"])
    assert.deepEqual(countdowns(`${timer}\nexit`, [1_000]), [null, null], timer);
  // An earlier async timer deadline is not the wait.
  assert.deepEqual(countdowns("timer async hidden 2 s\nwait 5 s\nexit", [1_000]), [
    W(5_000),
    W(5_000),
  ]);
  assert.deepEqual(countdowns("wait 0 s\nexit", []), [null]);
});

test("only a presented showButton with a timeout counts down, until it is pressed or times out", () => {
  assert.deepEqual(countdowns('showButton "Go", timeout: 5 s\nexit', [1_000, 5_000]), [
    B(5_000),
    B(5_000),
    null,
  ]);
  const pressed = activatePlayerRuntimeButton(
    observe(createPlayerRuntimeSession('showButton "Go", timeout: 500 ms\nexit'), 100),
  );
  assert.equal(pressed?.outcome.kind, "completed");
  assert.equal(playerRuntimeDebugCountdown(pressed.session), null);
  assert.deepEqual(countdowns('showButton "Go"\nexit', [10_000]), [null, null]);
  assert.deepEqual(countdowns('let x = askText hint: "Answer"\nexit', [1_000]), [null, null]);
});

test("every reading time counts down, and what follows a message counts down only after it", () => {
  assert.deepEqual(
    countdowns('say "A", 5 s\nsay "B", 2 s\nshowButton "Go"\nexit', [1_000, 5_000, 7_000]),
    [P(5_000), P(5_000), P(7_000), null],
  );
  assert.deepEqual(countdowns('say unskippable "A", 5 s\nsay "B", 2 s\nexit', []), [P(5_000)]);
  assert.deepEqual(countdowns('say "A", instant\nshowButton "Go"\nexit', []), [null]);
  // A wait starts when the reading time ends; a blocking timer shows nothing meanwhile.
  assert.deepEqual(
    countdowns('say "A", 5 s\nwait 2 s\nsay "B", 2 s\nexit', [1_000, 5_000, 7_000]),
    [P(5_000), P(5_000), W(7_000), P(9_000)],
  );
  assert.deepEqual(
    countdowns('say "A", 5 s\ntimer 2 s\nsay "B", 2 s\nexit', [1_000, 5_000, 7_000]),
    [P(5_000), P(5_000), null, P(9_000)],
  );
  // A timed button appears after the reading time, and its timeout counts from then.
  assert.deepEqual(countdowns('say "A", 5 s\nshowButton "Go", timeout: 4 s\nexit', [5_000]), [
    P(5_000),
    B(9_000),
  ]);
  // A pending save owns progress once the reading time before it has ended.
  assert.deepEqual(
    countdowns('say "A", 5 s\nsave 1 as "x"\nshowButton "Go"\nexit', [5_000], {
      persistentScriptStorage: true,
    }),
    [P(5_000), null],
  );
});

test("a block's own foreground work counts down while the action it interrupted stands still hidden", () => {
  // The button had two of its three seconds left when the block started; it gets them back when the block returns.
  assert.deepEqual(
    countdowns(
      'timer async 1 s { wait 5 s }\nshowButton "Go", timeout: 3 s\nexit',
      [1_000, 3_000, 6_000],
    ),
    [B(3_000), W(6_000), W(6_000), B(8_000)],
  );
  assert.deepEqual(
    countdowns(
      'timer async 1 s {\n  say "H", 5 s\n  say "I", 2 s\n}\nshowButton "Go", timeout: 3 s\nexit',
      [1_000, 6_000, 8_000],
    ),
    [B(3_000), P(6_000), P(8_000), B(10_000)],
  );
  assert.deepEqual(
    countdowns(
      'timer async 1 s { let x = askText hint: "Inside" }\nshowButton "Go", timeout: 3 s\nexit',
      [1_000, 5_000],
    ),
    [B(3_000), null, null],
  );
});

test("a restored session counts down to the same deadline, and an ended or failed one shows nothing", () => {
  const waiting = observe(createPlayerRuntimeSession("wait 5 s\nexit"), 1_000);
  assert.deepEqual(
    playerRuntimeDebugCountdown(
      restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(waiting)),
    ),
    W(5_000),
  );
  assert.deepEqual(countdowns("exit", []), [null]);
  assert.deepEqual(countdowns('say "A", 5 s\nlet x = 0\nlet y = 1 / x\nexit', [5_000]), [
    P(5_000),
    null,
  ]);
});

test("the countdown text rounds whole seconds up and says when a deadline elapsed before its action settled", () => {
  assert.deepEqual(
    [0, 1_000, 4_999, 5_000, 5_500].map((nowMs) => debugCountdownText(W(5_000), nowMs)),
    [
      "Debug · Continues in 5 s",
      "Debug · Continues in 4 s",
      "Debug · Continues in 1 s",
      "Wait elapsed · waiting for script",
      "Wait elapsed · waiting for script",
    ],
  );
  assert.equal(debugCountdownText(B(2_500), 0), "Debug · Press within 3 s");
  assert.equal(debugCountdownText(P(900), 0), "Debug · Pacing: 1 s remaining");
});
