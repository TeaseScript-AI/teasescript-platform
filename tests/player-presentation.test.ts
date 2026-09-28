import assert from "node:assert/strict";
import test from "node:test";

import {
  formatTimer,
  orderRightControls,
  readableControlText,
  timerProgressPercent,
  timerProgressRatio,
} from "../player/presentation.js";

test("Player timer and control presentation helpers remain deterministic", () => {
  assert.equal(timerProgressPercent(161, 300), 46);
  assert.ok(Math.abs(timerProgressRatio(161, 300) - 139 / 300) < 1e-12);
  assert.equal(timerProgressPercent(0, 300), 100);
  assert.equal(timerProgressPercent(999, 300), 0);
  assert.equal(timerProgressPercent(1, 0), 0);
  assert.equal(formatTimer(161), "2:41");
  assert.equal(formatTimer(3599), "59:59");
  assert.equal(formatTimer(3600), "1:00:00");
  assert.equal(formatTimer(3661), "1:01:01");
  assert.equal(formatTimer(-1), "0:00");
  assert.equal(readableControlText("#ffffff"), "#000000");
  assert.equal(readableControlText("#000000"), "#ffffff");
  assert.deepEqual(
    orderRightControls([
      { kind: "status", id: "status", label: "Status", detail: "ok" },
      { kind: "action", id: "action", label: "Action", priority: 1 },
    ]).map((control) => control.id),
    ["action", "status"],
  );
});
