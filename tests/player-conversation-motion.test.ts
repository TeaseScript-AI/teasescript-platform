import assert from "node:assert/strict";
import test from "node:test";

import {
  CONVERSATION_ENTRANCE_MS,
  ConversationEntrances,
  ConversationGlide,
  type MotionAnimation,
  type MotionTarget,
} from "../player/conversation-motion.js";

/** An element that records the animations played on it, each `finished` once the clock passes its end. */
function element(clock: { now: number }) {
  const played: { keyframes: Keyframe[]; animation: MotionAnimation & { cancelled: boolean } }[] =
    [];
  const target: MotionTarget = {
    animate(keyframes, options) {
      const startedAt = clock.now;
      const animation: MotionAnimation & { cancelled: boolean } = {
        currentTime: 0,
        cancelled: false,
        get playState(): AnimationPlayState {
          if (animation.cancelled) return "idle";
          return clock.now - startedAt >= Number(options.duration) ? "finished" : "running";
        },
        cancel() {
          animation.cancelled = true;
        },
      };
      played.push({ keyframes, animation });
      return animation;
    },
  };
  return { target, played };
}

/** The vertical offset an animation starts the conversation at. */
function startOffset(keyframes: readonly Keyframe[]): number {
  return Number(/^0 (-?[\d.]+)px$/u.exec(String(keyframes[0]!.translate))![1]);
}

test("the conversation glides from where it was drawn, and shows at once beyond a viewport", () => {
  const clock = { now: 0 };
  const glide = new ConversationGlide(
    () => clock.now,
    () => 400,
  );
  const history = element(clock);
  const controls = element(clock);
  // A new message moved the conversation up by 45 px: both parts start where they were drawn.
  assert.equal(glide.shift([history.target, controls.target], 45), true);
  assert.deepEqual(
    [history.played, controls.played].map((played) => startOffset(played[0]!.keyframes)),
    [45, 45],
  );
  // The next shift during the glide continues from what is drawn, not from the start, and stops the previous glide.
  clock.now = CONVERSATION_ENTRANCE_MS / 2;
  assert.equal(glide.shift([history.target], 45), true);
  const continued = startOffset(history.played[1]!.keyframes);
  assert.ok(continued > 45 && continued < 90, String(continued));
  assert.equal(history.played[0]!.animation.cancelled, true);
  // After a glide ends nothing is left to continue from.
  clock.now += CONVERSATION_ENTRANCE_MS;
  assert.equal(glide.shift([history.target], 30), true);
  assert.equal(startOffset(history.played[2]!.keyframes), 30);
  // More than a viewport of new content shows where it is at once, also stopping what still glides.
  assert.equal(glide.shift([history.target], 500), false);
  assert.equal(history.played[2]!.animation.cancelled, true);
  assert.equal(history.played.length, 3);
});

test("each entry enters once, from as far into its entrance as time has gone on", () => {
  const clock = { now: 0 };
  const entrances = new ConversationEntrances(() => clock.now);
  const row = element(clock);
  entrances.admit(["a", "b"]);
  entrances.play("a", row.target);
  // Drawn again, such as after scrolling away and back, it does not enter again.
  entrances.play("a", row.target);
  assert.equal(row.played.length, 1);
  assert.deepEqual(
    row.played[0]!.keyframes.map((frame) => frame.opacity),
    [0, 1],
  );
  // An entry first drawn later starts part of the way in, and not at all once its entrance would be over.
  clock.now = 50;
  const later = element(clock);
  entrances.play("b", later.target);
  assert.equal(later.played[0]!.animation.currentTime, 50);
  entrances.admit(["c"]);
  clock.now += CONVERSATION_ENTRANCE_MS;
  const late = element(clock);
  entrances.play("c", late.target);
  // An entry that never entered, such as history, has no entrance.
  entrances.play("history", late.target);
  assert.equal(late.played.length, 0);
});

test("history and more than can enter stop every entrance still playing", () => {
  const clock = { now: 0 };
  const entrances = new ConversationEntrances(() => clock.now);
  const first = element(clock);
  const controls = element(clock);
  entrances.admit(["a"]);
  entrances.play("a", first.target);
  entrances.enter(controls.target);
  clock.now = 20;
  entrances.admit(["b"]);
  entrances.clear();
  assert.equal(first.played[0]!.animation.cancelled, true);
  assert.equal(controls.played[0]!.animation.cancelled, true);
  // What was admitted but not yet drawn shows directly too.
  const second = element(clock);
  entrances.play("b", second.target);
  assert.equal(second.played.length, 0);
});
