import assert from "node:assert/strict";
import test from "node:test";

import { formatTimer, timerProgressRatio } from "../player/presentation.js";

test("Player timer presentation helpers remain deterministic and framework-independent", () => {
  assert.ok(Math.abs(timerProgressRatio(161, 300) - 139 / 300) < 1e-12);
  assert.equal(formatTimer(161), "2:41");
  assert.equal(formatTimer(3599), "59:59");
  assert.equal(formatTimer(3600), "1:00:00");
  assert.equal(formatTimer(3661), "1:01:01");
  assert.equal(formatTimer(-1), "0:00");
});
