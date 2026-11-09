import assert from "node:assert/strict";
import test from "node:test";

import type { CapturedMediaRecord } from "../../player/media/captured-media.js";
import { LiveHostEffects } from "../helpers/live-host-effects.js";

// The live host's effect witness (`tests/helpers/live-host-effects.ts`, #1919): a wrapped service counts its mutating
// call before it reads the call's input, so a call whose input throws when read still counts.

test("a repository add whose record throws on its reference counts once, and the throw still reaches the caller", async () => {
  const effects = new LiveHostEffects();
  const record = {
    get reference(): string {
      throw new Error("an unreadable reference");
    },
    namespace: "replay",
    kind: "image",
    mimeType: "image/png",
    size: 1,
    data: new Blob(["x"]),
  } satisfies CapturedMediaRecord;
  await assert.rejects(
    async () => effects.keptSessions.media.add(record),
    (error: unknown) => error instanceof Error && error.message === "an unreadable reference",
  );
  const { calls } = await effects.sample();
  assert.equal(calls["keptSessions.media"]?.["add"], 1);
});
