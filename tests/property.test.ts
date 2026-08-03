import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/index.js";
import {
  createPropertyDefinitions,
  defaultPropertyCampaignConfig,
  parsePropertyCliArguments,
  PropertyCampaignFailure,
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

test("property campaign wraps preparation failures with replay evidence", () => {
  const cause = new Error("synthetic generator failure");
  const config = sourceCaseConfig("valid");
  const definitions = createPropertyDefinitions({
    createValidSourceCase: () => {
      throw cause;
    },
  });

  assert.throws(
    () => runPropertyCampaign(config, definitions),
    (error: unknown) => {
      assert.ok(error instanceof PropertyCampaignFailure);
      assert.equal(error.cause, cause);
      assert.equal(error.result.id, "valid-source-pipeline");
      assert.equal(error.result.boundary, "package-root compile/run");
      assert.equal(error.result.context, "preparation-failure context=unavailable");
      assert.equal(error.result.source, undefined);
      assert.match(error.message, /seed=/);
      assert.match(error.message, /runs=/);
      assert.match(error.message, /case=/);
      assert.match(error.message, /replay=npm run test:property --/);
      assert.match(error.message, /cause=Error: synthetic generator failure/);
      return true;
    },
  );
});

test("valid source determinism independently compiles the prepared source", () => {
  const config = sourceCaseConfig("valid");
  let compilationCount = 0;
  const definitions = createPropertyDefinitions({
    compileSource: (source) => {
      compilationCount += 1;
      return compilationCount === 1
        ? compileSource(source)
        : compileSource('say "different"\nexit');
    },
  });

  assert.throws(
    () => runPropertyCampaign(config, definitions),
    PropertyCampaignFailure,
  );
  assert.equal(compilationCount, 2);
});

test("source scenarios are prepared once for reporting and execution", () => {
  assertSinglePreparedScenario("valid");
  assertSinglePreparedScenario("near-valid");
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
  cases: readonly {
    readonly index: number;
    readonly context: string;
    readonly source?: string;
  }[],
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

    const result = cases.find((caseResult) => (
      caseResult.context.includes(`classification=${classification}`)
      && caseResult.context.includes(`family=${family}`)
    ));
    assert.ok(result);
    assertExactSourceReplay(result, classification);
  }
}

function assertSinglePreparedScenario(
  classification: "valid" | "near-valid",
): void {
  const config = sourceCaseConfig(classification);
  const expected = createSourceCase(config.seed, config.caseIndex!, classification);
  let preparedCount = 0;
  const definitions = createPropertyDefinitions({
    ...(classification === "valid"
      ? {
        createValidSourceCase: (seed, index) => {
          preparedCount += 1;
          assert.equal(preparedCount, 1, "valid source must not be generated twice");
          return createValidSourceCase(seed, index);
        },
      }
      : {
        createNearValidSourceCase: (seed, index) => {
          preparedCount += 1;
          assert.equal(preparedCount, 1, "near-valid source must not be generated twice");
          return createNearValidSourceCase(seed, index);
        },
      }),
  });

  const replay = runPropertyCampaign(config, definitions);
  assert.equal(preparedCount, 1);
  assert.equal(replay.firstCase.source, expected.source);
}

function assertExactSourceReplay(
  result: { readonly index: number; readonly source?: string },
  classification: "valid" | "near-valid",
): void {
  const config = defaultPropertyCampaignConfig();
  const replayConfig = { ...config, caseIndex: result.index };
  const expected = createSourceCase(config.seed, result.index, classification);
  let preparedCount = 0;
  const replay = runPropertyCampaign(
    replayConfig,
    createPropertyDefinitions(
      classification === "valid"
        ? {
          createValidSourceCase: (seed, index) => {
            preparedCount += 1;
            assert.equal(preparedCount, 1, "valid replay must reuse its prepared source");
            return createValidSourceCase(seed, index);
          },
        }
        : {
          createNearValidSourceCase: (seed, index) => {
            preparedCount += 1;
            assert.equal(preparedCount, 1, "near-valid replay must reuse its prepared source");
            return createNearValidSourceCase(seed, index);
          },
        },
    ),
  );

  assert.equal(preparedCount, 1);
  assert.equal(result.source, expected.source);
  assert.equal(replay.firstCase.source, expected.source);
}

function createSourceCase(
  seed: number,
  index: number,
  classification: "valid" | "near-valid",
) {
  return classification === "valid"
    ? createValidSourceCase(seed, index)
    : createNearValidSourceCase(seed, index);
}

function sourceCaseConfig(
  classification: "valid" | "near-valid",
) {
  const config = defaultPropertyCampaignConfig();
  const result = Array.from({ length: config.runs }, (_, index) =>
    runPropertyCampaign({ ...config, caseIndex: index }).firstCase,
  ).find((caseResult) =>
    caseResult.context.includes(`classification=${classification}`),
  );
  assert.ok(result, `expected a ${classification} source case`);
  return { ...config, caseIndex: result.index };
}

test("property command accepts only seed, run count, and exact replay case", () => {
  assert.deepEqual(
    parsePropertyCliArguments(["--seed", "12345", "--runs", "2000", "--case", "17"]),
    { seed: 12345, runs: 2000, caseIndex: 17 },
  );
  assert.throws(() => parsePropertyCliArguments(["--profile", "smoke"]));
  assert.throws(() => parsePropertyCliArguments(["--runs", "0"]));
});
