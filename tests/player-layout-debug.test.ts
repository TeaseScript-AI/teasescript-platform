import assert from "node:assert/strict";
import test from "node:test";

import { captureRect, parseGridTracks } from "../player/vue/src/phase2c/layoutDebugMeasurement.js";

test("Layout Debug measurement helpers preserve rectangle fields and grid tracks", () => {
  const geometry = {
    x: 10.25,
    y: 20.5,
    width: 320.75,
    height: 180.25,
    top: 20.5,
    right: 331,
    bottom: 200.75,
    left: 10.25,
  };
  assert.deepEqual(captureRect(geometry), geometry);

  assert.deepEqual(parseGridTracks("300px 640.5px 190px", 8), [
    { offset: 0, size: 300 },
    { offset: 308, size: 640.5 },
    { offset: 956.5, size: 190 },
  ]);
  assert.deepEqual(parseGridTracks("300px minmax(0, 1fr)"), []);
});
