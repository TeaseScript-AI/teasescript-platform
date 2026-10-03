import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/index.js";
import {
  createFixedPropertyChecks,
  createPropertyDefinitions,
  defaultPropertyCampaignConfig,
  parsePropertyCliArguments,
  PropertyCampaignFailure,
  runFixedPropertyChecks,
  runPropertyCampaign,
  type PropertyCampaignDependencies,
  type PropertyCaseResult,
} from "./property/replay.js";
import {
  createNearValidSourceCase,
  createValidSourceCase,
  NEAR_VALID_SOURCE_FAMILIES,
  VALID_SOURCE_FAMILIES,
} from "./property/source-fuzz.js";

test("required deterministic property campaign preserves durable runtime invariants", () => {
  assert.equal(runPropertyCampaign(defaultPropertyCampaignConfig()).executed, 128);
});

test("fixed property fixtures cover each boundary variant and pass", () => {
  const checks = createFixedPropertyChecks();
  const covered = checks.map((check) => `${check.id}/${check.variant}`);

  for (const operation of ["run", "executeInstruction", "observeTime", "completeAction"]) {
    assert.ok(covered.includes(`operation-closure/${operation}`), operation);
  }
  for (const variant of ["time-completion", "duplicate-settlement"]) {
    assert.ok(covered.includes(`rejected-completion-is-atomic/${variant}`), variant);
  }
  assert.ok(covered.some((check) => check.startsWith("checkpoint-roundtrip-and-resume/")));
  for (const malformed of ["plan", "snapshot", "checkpoint"]) {
    assert.ok(covered.includes(`malformed-boundary-rejection/${malformed}`), malformed);
  }
  runFixedPropertyChecks(checks);
});

test("property replay selects the same generated case by seed and case number", () => {
  const config = parsePropertyCliArguments(["--seed", "12345", "--runs", "40"]);
  const fullRun = recordExecutions();
  const full = runPropertyCampaign(config, fullRun.definitions);
  const replayRun = recordExecutions();
  const replay = runPropertyCampaign({ ...config, caseIndex: 17 }, replayRun.definitions);

  const selected = fullRun.executions.find((execution) => execution.index === 17);
  assert.ok(selected);
  assert.equal(selected.seed, config.seed);
  assert.deepEqual(replayRun.executions, [selected]);
  assert.equal(replay.executed, 1);
  assert.equal(replay.firstCase.index, 17);
  assert.deepEqual(replay.firstCase, selected.result);
  assert.deepEqual(full, runPropertyCampaign(config));
});

test("property campaign wraps preparation failures with replay evidence", () => {
  const cause = new Error("synthetic generator failure");
  const config = sourceCaseConfig("valid");
  // The same case without the failure identifies the property and boundary the report must name.
  const selected = runPropertyCampaign(config).firstCase;
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
      assert.deepEqual([error.result.id, error.result.boundary], [selected.id, selected.boundary]);
      assert.ok(error.message.includes(`property=${selected.id}`), error.message);
      assert.ok(error.message.includes(`boundary=${selected.boundary}`), error.message);
      assert.equal(error.result.source, undefined);
      assert.ok(error.message.includes(error.replayCommand), error.message);
      assert.ok(error.message.includes(cause.message), error.message);
      const [command, replayArguments] = error.replayCommand.split(" -- ");
      assert.equal(command, "npm run test:property");
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

test("execution compiles the reported prepared source", () => {
  assertReportedSourceExecutes("valid");
  assertReportedSourceExecutes("near-valid");
});

test("required campaign reaches same-seed determinism and varied source-fuzz families", () => {
  const config = defaultPropertyCampaignConfig();
  const cases = Array.from(
    { length: config.runs },
    (_, index) => runPropertyCampaign({ ...config, caseIndex: index }).firstCase,
  );
  assert.ok(cases.some((result) => result.id === "same-seed-is-deterministic"));
  assertSourceFamilyCoverage(cases, "valid", VALID_SOURCE_FAMILIES);
  assertSourceFamilyCoverage(cases, "near-valid", NEAR_VALID_SOURCE_FAMILIES);

  const replayed = runPropertyCampaign({ ...config, caseIndex: 5 }).firstCase;
  assert.deepEqual(replayed, cases[5]);

  // The seed must influence generated source; a bounded seed sample need not differ pairwise.
  const seeds = Array.from({ length: 8 }, (_, offset) => config.seed + offset);
  for (const index of [5, 6]) {
    for (const create of [createValidSourceCase, createNearValidSourceCase]) {
      const sources = new Set(seeds.map((seed) => create(seed, index).source));
      assert.ok(sources.size >= 2, `${create.name} case ${index} must vary with the seed`);
    }
  }
});

function assertSourceFamilyCoverage(
  cases: readonly { readonly index: number; readonly context: string; readonly source?: string }[],
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

    const result = cases.find(
      (caseResult) =>
        caseResult.context.includes(`classification=${classification}`) &&
        caseResult.context.includes(`family=${family}`),
    );
    assert.ok(result);
    assertExactSourceReplay(result, classification);
  }
}

function assertReportedSourceExecutes(classification: "valid" | "near-valid"): void {
  const config = sourceCaseConfig(classification);
  // A test-owned suffix shows that execution compiles the injected preparation that the report shows.
  const prepare = <T extends { readonly source: string }>(scenario: T): T => ({
    ...scenario,
    source: `${scenario.source}\n// prepared by the property test`,
  });
  const expected = prepare(createSourceCase(config.seed, config.caseIndex!, classification));
  const recorded = recordExecutions(
    classification === "valid"
      ? { createValidSourceCase: (seed, index) => prepare(createValidSourceCase(seed, index)) }
      : {
          createNearValidSourceCase: (seed, index) =>
            prepare(createNearValidSourceCase(seed, index)),
        },
  );

  const replay = runPropertyCampaign(config, recorded.definitions);
  assert.equal(replay.firstCase.source, expected.source);
  assert.deepEqual(
    recorded.executions.map((execution) => execution.compiled),
    [[expected.source, expected.source]],
  );
}

function assertExactSourceReplay(
  result: { readonly index: number; readonly source?: string },
  classification: "valid" | "near-valid",
): void {
  const config = defaultPropertyCampaignConfig();
  const replayConfig = { ...config, caseIndex: result.index };
  const expected = assertExactGeneratedScenario(config.seed, result.index, (seed, index) =>
    createSourceCase(seed, index, classification),
  );
  const recorded = recordExecutions();
  const replay = runPropertyCampaign(replayConfig, recorded.definitions);

  assert.equal(result.source, expected.source);
  assert.deepEqual(replay.firstCase, result);
  assert.deepEqual(
    recorded.executions.map((execution) => execution.compiled),
    [[expected.source, expected.source]],
  );
}

/** Wraps the campaign properties to record each executed case and every source its execution compiles. */
function recordExecutions(dependencies: PropertyCampaignDependencies = {}) {
  const executions: {
    readonly seed: number;
    readonly index: number;
    readonly result: PropertyCaseResult;
    readonly compiled: string[];
  }[] = [];
  let compiled: string[] | undefined;
  const definitions = createPropertyDefinitions({
    ...dependencies,
    compileSource: (source) => {
      assert.ok(compiled, "sources compile only while a case executes");
      compiled.push(source);
      return compileSource(source);
    },
  }).map((definition) => ({
    ...definition,
    prepare: (seed: number, index: number) => {
      const prepared = definition.prepare(seed, index);
      return {
        result: prepared.result,
        execute: () => {
          compiled = [];
          executions.push({ seed, index, result: prepared.result, compiled });
          try {
            prepared.execute();
          } finally {
            compiled = undefined;
          }
        },
      };
    },
  }));
  return { definitions, executions };
}

function assertExactGeneratedScenario<T>(
  seed: number,
  index: number,
  createScenario: (seed: number, index: number) => T,
): T {
  const first = createScenario(seed, index);
  const second = createScenario(seed, index);
  assert.deepEqual(second, first);
  return first;
}

function createSourceCase(seed: number, index: number, classification: "valid" | "near-valid") {
  return classification === "valid"
    ? createValidSourceCase(seed, index)
    : createNearValidSourceCase(seed, index);
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
  assert.throws(() => parsePropertyCliArguments(["--unknown-option", "1"]));
  assert.throws(() => parsePropertyCliArguments(["--runs", "0"]));
});
