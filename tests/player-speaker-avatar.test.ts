import assert from "node:assert/strict";
import test from "node:test";
import { authoredColorToOklch, contrastRatio } from "../player/theme/color.js";
import {
  leastUsedAvatarColor,
  recordSpeakerAvatarMessage,
  speakerAvatarColors,
  speakerAvatarPalette,
} from "../player/vue/src/phase2c/speakerAvatar.js";

test("the twelve avatar colours have readable light and dark variants", () => {
  assert.equal(speakerAvatarPalette.length, 12);
  assert.equal(new Set(speakerAvatarPalette.map((pair) => pair.dark.background)).size, 12);
  assert.deepEqual(speakerAvatarColors(12), speakerAvatarColors(0));
  for (const pair of speakerAvatarPalette) {
    for (const mode of ["light", "dark"] as const) {
      const background = authoredColorToOklch(pair[mode].background);
      const ink = authoredColorToOklch(pair[mode].color);
      assert.ok(contrastRatio(background, ink) >= 4.5);
      assert.ok(mode === "light" ? background.l > ink.l : background.l < ink.l);
    }
  }
});

test("new speakers get the colour used by the fewest messages, with stable ties", () => {
  const counts = Array<number>(speakerAvatarPalette.length).fill(0);
  const firstTwelve = [];
  for (let speaker = 0; speaker < 100; speaker += 1) {
    const index = leastUsedAvatarColor(counts);
    if (speaker < 12) firstTwelve.push(index);
    counts[index]! += 1;
  }
  assert.deepEqual(
    firstTwelve,
    Array.from({ length: 12 }, (_, index) => index),
  );
  assert.equal(Math.max(...counts) - Math.min(...counts), 1);

  counts.fill(1);
  counts[0] = 50;
  assert.equal(leastUsedAvatarColor(counts), 1);
  counts[1] = 2;
  assert.equal(leastUsedAvatarColor(counts), 2);
});

test("a frequent speaker keeps their colour while brief NPCs share less-used colours", () => {
  const assignments = new Map<string, number>();
  const counts = Array<number>(speakerAvatarPalette.length).fill(0);
  recordSpeakerAvatarMessage(assignments, counts, "guide", false);
  assert.equal(assignments.has("guide"), false);
  for (let message = 0; message < 50; message += 1) {
    recordSpeakerAvatarMessage(assignments, counts, "guide", true);
  }
  for (let npc = 0; npc < 100; npc += 1) {
    recordSpeakerAvatarMessage(assignments, counts, `npc-${npc}`, true);
  }
  assert.equal(assignments.get("guide"), 0);
  assert.equal(counts[0], 50);
  assert.ok(
    Array.from(assignments.values())
      .slice(1)
      .every((index) => index !== 0),
  );
  recordSpeakerAvatarMessage(assignments, counts, "guide", true);
  assert.equal(assignments.get("guide"), 0);
  assert.equal(counts[0], 51);
});
