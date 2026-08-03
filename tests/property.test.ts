import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultPropertyCampaignConfig,
  parsePropertyCliArguments,
  runPropertyCampaign,
} from "./property/replay.js";

test("required deterministic property campaign preserves durable runtime invariants", () => {
  const first = runPropertyCampaign(defaultPropertyCampaignConfig());
  const second = runPropertyCampaign(defaultPropertyCampaignConfig());

  assert.equal(first.executed, 128);
  assert.deepEqual(second, first);
});

test("property replay selects the same generated case by seed and case number", () => {
  const config = parsePropertyCliArguments(["--seed", "12345", "--runs", "40"]);
  const full = runPropertyCampaign(config);
  const replay = runPropertyCampaign({ ...config, caseIndex: 17 });

  assert.equal(replay.executed, 1);
  assert.equal(replay.firstCase.index, 17);
  assert.deepEqual(full, runPropertyCampaign(config));
});

test("required campaign reaches every retained operation, malformed, and source-fuzz variant", () => {
  const config = defaultPropertyCampaignConfig();
  const contexts = Array.from({ length: 42 }, (_, index) =>
    runPropertyCampaign({ ...config, caseIndex: index }).firstCase.context,
  );

  for (const operation of ["run", "executeInstruction", "observeTime", "completeAction"]) {
    assert.ok(contexts.some((context) => context.includes(`operation=${operation}`)));
  }
  for (const malformed of ["plan", "snapshot", "checkpoint"]) {
    assert.ok(contexts.some((context) => context.includes(`malformed=${malformed}`)));
  }
  for (const classification of ["classification=valid", "classification=near-valid"]) {
    const families = contexts
      .filter((context) => context.includes(classification))
      .map((context) => context.match(/family=([^ ]+)/)?.[1]);
    assert.equal(new Set(families).size, 6);
  }
});

test("property command accepts only seed, run count, and exact replay case", () => {
  assert.deepEqual(
    parsePropertyCliArguments(["--seed", "12345", "--runs", "2000", "--case", "17"]),
    { seed: 12345, runs: 2000, caseIndex: 17 },
  );
  assert.throws(() => parsePropertyCliArguments(["--profile", "smoke"]));
  assert.throws(() => parsePropertyCliArguments(["--runs", "0"]));
});
