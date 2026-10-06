import assert from "node:assert/strict";
import test from "node:test";

import { MessageUpdateAnnouncer } from "../player/message-update-announcer.js";

/** An announcer on a manual clock: `advance` runs the scheduled flushes that come due. */
function announcer() {
  let now = 0;
  let scheduled: { at: number; callback: () => void } | null = null;
  const spoken: [number, string][] = [];
  const subject = new MessageUpdateAnnouncer({
    now: () => now,
    schedule: (callback, delayMs) => {
      const entry = { at: now + delayMs, callback };
      scheduled = entry;
      return () => {
        if (scheduled === entry) scheduled = null;
      };
    },
    announce: (text) => spoken.push([now, text]),
  });
  const advance = (to: number) => {
    while (scheduled !== null && scheduled.at <= to) {
      const due: { at: number; callback: () => void } = scheduled;
      scheduled = null;
      now = due.at;
      due.callback();
    }
    now = to;
  };
  return { subject, spoken, advance, pending: () => scheduled !== null };
}

test("changes of one message coalesce to the latest text, at most once per five seconds", () => {
  const { subject, spoken, advance } = announcer();
  subject.update(1, "Vera", "Strokes: 0", "Strokes: 1");
  subject.update(1, "Vera", "Strokes: 1", "Strokes: 2");
  advance(0);
  for (let count = 3; count <= 20; count += 1) {
    advance((count - 2) * 500);
    subject.update(1, "Vera", `Strokes: ${count - 1}`, `Strokes: ${count}`);
  }
  // The trailing value is spoken once the message may be spoken again, also after the burst ends.
  advance(60_000);
  assert.deepEqual(spoken, [
    [0, "Vera: Strokes: 2"],
    [5_000, "Vera: Strokes: 11"],
    [10_000, "Vera: Strokes: 20"],
  ]);
});

test("a busy message does not hold back another one, and each keeps its place in line", () => {
  const { subject, spoken, advance } = announcer();
  subject.update(1, "Vera", "a0", "a1");
  subject.update(2, "Coach", "b0", "b1");
  subject.update(1, "Vera", "a1", "a2");
  advance(0);
  advance(1_000);
  subject.update(1, "Vera", "a2", "a3");
  subject.update(2, "Coach", "b1", "b2");
  advance(10_000);
  assert.deepEqual(spoken, [
    [0, "Vera: a2"],
    [1_000, "Coach: b1"],
    [5_000, "Vera: a3"],
    [6_000, "Coach: b2"],
  ]);
});

test("a change back to the text last seen, or one that keeps the visible text, is not spoken", () => {
  const { subject, spoken, advance, pending } = announcer();
  subject.update(1, "Vera", "Waiting", "Waiting.");
  subject.update(1, "Vera", "Waiting.", "Waiting");
  subject.update(2, "Vera", "Ready", "Ready");
  advance(10_000);
  assert.deepEqual(spoken, []);
  assert.equal(pending(), false);
  subject.update(2, "Vera", "Ready", "");
  advance(20_000);
  assert.deepEqual(spoken, [[10_000, "Vera: message cleared"]]);
});

test("reset forgets every change and cancels the next announcement", () => {
  const { subject, spoken, advance, pending } = announcer();
  subject.update(1, "Vera", "a", "b");
  subject.reset();
  assert.equal(pending(), false);
  advance(10_000);
  assert.deepEqual(spoken, []);
});
