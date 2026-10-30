import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setKey, sourceKey, sourcesOf } from "../../sources.mjs";
import { makePlan, configurations } from "../lib/plan.mjs";
import { corpusModule } from "../lib/export.mjs";
import { mergeShards } from "../lib/merge.mjs";
const plan = makePlan("quick");
const pilot = fileURLToPath(new URL("../bin/pilot.mjs", import.meta.url));
function parts() {
  return [0, 1].map((index) => ({
    plan,
    metadata: {
      planHash: plan.planHash,
      provenance: { commit: "same", executionNode: "26.5.0" },
      shard: { index, total: 2 },
    },
    summary: { elapsedMs: 1 },
    rows: configurations(plan, { index, total: 2 }).map((c) => ({
      id: c.id,
      status: "PASS",
      executions: 1,
      assertions: 1,
    })),
  }));
}
test("corpus export contains every selected source, no imports, and the record the corpus check reads", () => {
  const code = corpusModule(plan, "where recorded");
  assert.equal(/\bimport\b/.test(code), false);
  const value = vm.runInNewContext(
    code.replaceAll("export const ", "const ") +
      "\nJSON.stringify({cases,globals,checks,recorded})",
  );
  const exported = JSON.parse(value);
  assert.deepEqual(
    exported.cases,
    plan.cases.map((c) => [c.id, c.source]),
  );
  assert.deepEqual(exported.globals, ["hostValue"]);
  const keys = new Set(sourcesOf(exported).map(sourceKey));
  assert.equal(exported.recorded.sources, keys.size);
  assert.equal(exported.recorded.sha256, setKey(keys));
});
test("the committed corpus module holds the focused plan's sources, as its record says", async () => {
  const focused = makePlan("focused", 1442);
  const committed = await import("../s8-stores.mjs");
  assert.deepEqual(
    committed.cases,
    focused.cases.map((c) => [c.id, c.source]),
  );
  const keys = focused.cases.map((c) =>
    sourceKey({ files: [{ path: "main.tease", source: c.source }], globals: c.globals }),
  );
  assert.equal(committed.recorded.sha256, setKey(new Set(keys)));
});
test("shards merge completely in deterministic configuration order", () => {
  const result = mergeShards(parts().reverse());
  assert.equal(result.rows.length, 96);
  assert.deepEqual(
    result.rows.map((r) => r.id),
    configurations(plan).map((r) => r.id),
  );
  assert.equal(result.summary.elapsedMs, 2);
});
test("shard merge rejects missing, duplicate, wrong plan and different provenance", () => {
  assert.throws(() => mergeShards(parts().slice(0, 1)), /all shards/);
  const duplicate = parts();
  duplicate[1] = duplicate[0];
  assert.throws(() => mergeShards(duplicate), /Duplicate/);
  const foreign = parts();
  foreign[1].metadata = { ...foreign[1].metadata, provenance: { commit: "other" } };
  assert.throws(() => mergeShards(foreign), /provenance/);
  const wrong = parts();
  wrong[1].metadata = { ...wrong[1].metadata, planHash: "wrong" };
  assert.throws(() => mergeShards(wrong), /plans/);
  const missing = parts();
  missing[0].rows.pop();
  assert.throws(() => mergeShards(missing), /missing/);
});
test("timeouts remain non-PASS after shard merge", () => {
  const p = parts();
  p[1].rows[0].status = "TIMEOUT";
  const r = mergeShards(p);
  assert.equal(r.summary.verdict, "ERROR");
});
test("CLI rejects flags from the wrong command and unknown families", () => {
  for (const args of [
    ["plan", "--build", "x", "--out", "x"],
    ["run", "--profile", "focused"],
    ["plan", "--family", "unknown", "--out", "x"],
  ]) {
    const r = spawnSync(process.execPath, [pilot, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown/);
  }
});
