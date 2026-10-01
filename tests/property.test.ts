import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/index.js";
import {
  createPropertyDefinitions,
  defaultPropertyCampaignConfig,
  parsePropertyCliArguments,
  PropertyCampaignFailure,
  runPropertyCampaign,
  type PropertyCampaignConfig,
  type PropertyCaseResult,
} from "./property/replay.js";
import {
  createNearValidSourceCase,
  createValidSourceCase,
  NEAR_VALID_SOURCE_FAMILIES,
  VALID_SOURCE_FAMILIES,
} from "./property/source-fuzz.js";

test("required deterministic property campaign preserves durable runtime invariants", () => {
  const first = runPropertyCampaign(defaultPropertyCampaignConfig());
  const second = runPropertyCampaign(defaultPropertyCampaignConfig());

  assert.equal(first.executed, 128);
  assert.deepEqual(second, first);
});

test("property replay executes the same generated case and source as the full campaign", () => {
  const config = defaultPropertyCampaignConfig();
  const full = recordExecutions(config);
  assert.deepEqual(
    full.map((execution) => [execution.seed, execution.index]),
    Array.from({ length: config.runs }, (_, index) => [config.seed, index]),
  );
  for (const execution of full) {
    // Both compilations of a source scenario receive exactly the reported source.
    const { source } = execution.result;
    assert.deepEqual(execution.compiled, source === undefined ? [] : [source, source]);
    assert.deepEqual(recordExecutions({ ...config, caseIndex: execution.index }), [execution]);
  }
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
      assert.deepEqual(error.config, config);
      assert.equal(error.result.index, config.caseIndex);
      assert.equal(error.result.id, "valid-source-pipeline");
      assert.equal(error.result.boundary, "package-root compile/run");
      assert.equal(error.result.source, undefined);
      const [, replayArguments] = error.replayCommand.split(" -- ");
      assert.deepEqual(parsePropertyCliArguments(replayArguments!.split(" ")), config);
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

  assert.throws(() => runPropertyCampaign(config, definitions), PropertyCampaignFailure);
  assert.equal(compilationCount, 2);
});

test("near-valid source determinism rejects a plan from either compilation", () => {
  const config = sourceCaseConfig("near-valid");
  const executable = compileSource("exit");
  assert.notEqual(executable.plan, null);
  let compilationCount = 0;
  const definitions = createPropertyDefinitions({
    compileSource: (source) => {
      compilationCount += 1;
      const rejected = compileSource(source);
      return compilationCount === 1 ? rejected : { ...rejected, plan: executable.plan };
    },
  });

  assert.throws(() => runPropertyCampaign(config, definitions), PropertyCampaignFailure);
  assert.equal(compilationCount, 2);
});

test("required campaign reaches retained variants and varied source-fuzz families", () => {
  const config = defaultPropertyCampaignConfig();
  const cases = recordExecutions(config).map((execution) => execution.result);
  const contexts = cases.map((result) => result.context);

  for (const operation of ["run", "executeInstruction", "observeTime", "completeAction"]) {
    assert.ok(contexts.some((context) => context.includes(`operation=${operation}`)));
  }
  for (const variant of ["time-completion", "duplicate-settlement"]) {
    assert.ok(contexts.some((context) => context.includes(`rejected-completion=${variant}`)));
  }
  for (const malformed of ["plan", "snapshot", "checkpoint"]) {
    assert.ok(contexts.some((context) => context.includes(`malformed=${malformed}`)));
  }

  assertSourceFamilyCoverage(cases, "valid", VALID_SOURCE_FAMILIES);
  assertSourceFamilyCoverage(cases, "near-valid", NEAR_VALID_SOURCE_FAMILIES);

  // Seeds select different source; a small sample suffices, since particular seeds may coincide.
  const seeds = [0, 1, 2, 3].map((offset) => config.seed + offset);
  assert.ok(new Set(seeds.map((seed) => createValidSourceCase(seed, 5).source)).size > 1);
  assert.ok(new Set(seeds.map((seed) => createNearValidSourceCase(seed, 6).source)).size > 1);
});

interface RecordedExecution {
  readonly seed: number;
  readonly index: number;
  readonly result: PropertyCaseResult;
  readonly compiled: readonly string[];
}

/** Runs a campaign with the real properties, recording each executed case and every source it compiled. */
function recordExecutions(config: PropertyCampaignConfig): RecordedExecution[] {
  const executions: RecordedExecution[] = [];
  let compiled: string[] = [];
  const definitions = createPropertyDefinitions({
    compileSource: (...args: Parameters<typeof compileSource>) => {
      compiled.push(args[0]);
      return compileSource(...args);
    },
  }).map((definition) => ({
    ...definition,
    prepare: (seed: number, index: number) => {
      const prepared = definition.prepare(seed, index);
      return {
        result: prepared.result,
        execute: () => {
          compiled = [];
          prepared.execute();
          executions.push({ seed, index, result: prepared.result, compiled });
        },
      };
    },
  }));
  runPropertyCampaign(config, definitions);
  return executions;
}

function assertSourceFamilyCoverage(
  cases: readonly PropertyCaseResult[],
  classification: "valid" | "near-valid",
  families: readonly string[],
): void {
  for (const family of families) {
    const sources = cases
      .filter(
        (result) =>
          result.context.includes(`classification=${classification}`) &&
          result.context.includes(`family=${family}`),
      )
      .map((result) => result.source);

    assert.ok(sources.length >= 2, `${classification}/${family} must be reached twice`);
    assert.equal(new Set(sources).size >= 2, true, `${classification}/${family} must vary source`);
  }
}

function sourceCaseConfig(classification: "valid" | "near-valid") {
  const config = defaultPropertyCampaignConfig();
  const result = Array.from(
    { length: config.runs },
    (_, index) => runPropertyCampaign({ ...config, caseIndex: index }).firstCase,
  ).find((caseResult) => caseResult.context.includes(`classification=${classification}`));
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
