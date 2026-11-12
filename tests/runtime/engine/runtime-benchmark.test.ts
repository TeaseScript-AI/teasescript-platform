import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The compiled test runs from dist/tests; the tool lives in tools/ at the checkout root and reads this build's dist/.
const tool = fileURLToPath(new URL("../../../../tools/benchmark-runtime.mjs", import.meta.url));
const dist = fileURLToPath(new URL("../../..", import.meta.url));

test("the runtime benchmark's instruction counts and results equal its baseline (#1693)", () => {
  const child = spawnSync(process.execPath, [tool, "--count-only", "--dist", dist], {
    encoding: "utf8",
    timeout: 300_000,
  });
  assert.equal(child.status, 0, `${child.stdout}${child.stderr}`);
});
