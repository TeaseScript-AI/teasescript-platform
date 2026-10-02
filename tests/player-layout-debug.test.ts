import assert from "node:assert/strict";
import test from "node:test";

import { parseGridTracks } from "../player/vue/src/layoutDebugMeasurement.js";

test("Layout Debug grid tracks accumulate resolved sizes and gaps and reject unresolved tracks", () => {
  assert.deepEqual(parseGridTracks("300px 640.5px 190px", 8), [
    { offset: 0, size: 300 },
    { offset: 308, size: 640.5 },
    { offset: 956.5, size: 190 },
  ]);
  assert.deepEqual(parseGridTracks("300px minmax(0, 1fr)"), []);
});
