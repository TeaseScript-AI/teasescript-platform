import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultPropertyCampaignConfig,
  parsePropertyCliArguments,
  runPropertyCampaign,
} from "./property/replay.js";
import {
  createNearValidSourceCase,
  createValidSourceCase,
  NEAR_VALID_SOURCE_FAMILIES,
  selectSourceFamily,
  VALID_SOURCE_FAMILIES,
} from "./property/source-fuzz.js";

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

test("source family selection uses the selected family collection", () => {
  assert.equal(selectSourceFamily(["valid-a", "valid-b"], 1, 4), "valid-b");
  assert.equal(selectSourceFamily(["near-a", "near-b", "near-c"], 1, 4), "near-c");
});

test("required campaign reaches retained variants and varied source-fuzz families", () => {
  const config = defaultPropertyCampaignConfig();
  const cases = Array.from({ length: config.runs }, (_, index) =>
    runPropertyCampaign({ ...config, caseIndex: index }).firstCase,
  );
  const contexts = cases.map((result) => result.context);

  for (const operation of [
    "run",
    "executeInstruction",
    "observeTime",
    "completeAction",
  ]) {
    assert.ok(contexts.some((context) => context.includes(`operation=${operation}`)));
  }
  for (const variant of ["not-due", "duplicate-settlement"]) {
    assert.ok(
      contexts.some((context) => context.includes(`rejected-completion=${variant}`)),
    );
  }
  for (const malformed of ["plan", "snapshot", "checkpoint"]) {
    assert.ok(contexts.some((context) => context.includes(`malformed=${malformed}`)));
  }

  assertSourceFamilyCoverage(cases, "valid", VALID_SOURCE_FAMILIES);
  assertSourceFamilyCoverage(cases, "near-valid", NEAR_VALID_SOURCE_FAMILIES);

  const replayed = runPropertyCampaign({ ...config, caseIndex: 5 }).firstCase;
  assert.deepEqual(replayed, cases[5]);

  const changedValidSeed = createValidSourceCase(config.seed + 1, 5);
  const changedNearValidSeed = createNearValidSourceCase(config.seed + 1, 6);
  assert.notEqual(changedValidSeed.source, createValidSourceCase(config.seed, 5).source);
  assert.notEqual(
    changedNearValidSeed.source,
    createNearValidSourceCase(config.seed, 6).source,
  );

  const functionsCase = Array.from(
    { length: VALID_SOURCE_FAMILIES.length },
    (_, index) => createValidSourceCase(1, index),
  ).find(({ family }) => family === "functions-defaults-calls-and-recursion");
  assert.ok(functionsCase);
  assert.match(functionsCase.source, /return `\$\{prefix\}:\$\{value\}`/);
});

function assertSourceFamilyCoverage(
  cases: readonly { readonly context: string; readonly source?: string }[],
  classification: "valid" | "near-valid",
  families: readonly string[],
): void {
  for (const family of families) {
    const sources = cases
      .filter((result) => (
        result.context.includes(`classification=${classification}`)
        && result.context.includes(`family=${family}`)
      ))
      .map((result) => result.source);

    assert.ok(sources.length >= 2, `${classification}/${family} must be reached twice`);
    assert.equal(
      new Set(sources).size >= 2,
      true,
      `${classification}/${family} must vary source`,
    );
  }
}

test("property command accepts only seed, run count, and exact replay case", () => {
  assert.deepEqual(
    parsePropertyCliArguments(["--seed", "12345", "--runs", "2000", "--case", "17"]),
    { seed: 12345, runs: 2000, caseIndex: 17 },
  );
  assert.throws(() => parsePropertyCliArguments(["--profile", "smoke"]));
  assert.throws(() => parsePropertyCliArguments(["--runs", "0"]));
});
