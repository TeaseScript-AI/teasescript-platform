import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MAX_PROPERTY_GRAPH_DEPTH,
  MAX_PROPERTY_STRING_UTF8_BYTES,
  assertPropertyFixtureBounds,
  createPropertyFixtureCatalog,
  type PropertyFixtureCatalog,
} from "./property/fixtures.js";
import {
  PropertyBoundaryFailure,
  assertResumeEquivalent,
  atPropertyBoundary,
} from "./property/invariants.js";
import {
  propertyCases,
  type PropertyCaseDefinition,
  type PropertyCaseVariant,
} from "./property/mutations.js";
import {
  createPropertyPrng,
  nextPropertyUint32,
} from "./property/prng.js";
import {
  MAX_PROPERTY_TOTAL_MUTATIONS,
  MAX_PROPERTY_TOTAL_WORK_UNITS,
  MAX_PROPERTY_WORK_UNITS_PER_CASE,
  PROPERTY_SMOKE_RUNS,
  PROPERTY_SMOKE_SEED,
  PropertyCampaignFailure,
  calculateConfiguredMutationCount,
  calculateConfiguredWorkUnits,
  createReplayCommand,
  defaultPropertyCampaignConfig,
  describePropertyCase,
  parsePropertyCliArguments,
  propertyCliUsage,
  runPropertyCampaign,
  runPropertyCli,
  validatePropertyDefinitions,
  type PropertyCampaignConfig,
  type PropertyCampaignResult,
  type PropertyCliIo,
} from "./property/replay.js";

const EXPECTED_PROPERTY_CASE_IDS = Object.freeze([
  "runtime-run-closes-over-validator",
  "runtime-execute-instruction-closes-over-validator",
  "delay-observation-closes-over-validator",
  "delay-completion-request-closes-over-validator",
  "interaction-completion-closes-over-validator",
  "invalid-completion-preserves-state",
  "duplicate-completion-preserves-state",
  "checkpoint-json-roundtrip-equivalent",
  "delay-restore-resume-equivalent",
  "interaction-restore-resume-equivalent",
  "plan-missing-format",
  "plan-extra-root-field",
  "plan-wrong-version",
  "plan-wrong-instructions-type",
  "plan-non-finite-temporary-count",
  "plan-unsafe-root-end",
  "plan-negative-zero-boundary",
  "plan-invalid-jump-target",
  "plan-invalid-result-destination",
  "plan-exact-string-limit-accepted",
  "plan-over-string-limit-structured",
  "plan-exact-option-limit-accepted",
  "plan-over-option-limit-structured",
  "plan-over-aggregate-string-limit-structured",
  "plan-sparse-instructions",
  "plan-cycle",
  "plan-accessor",
  "plan-non-plain-object",
  "plan-prototype-sensitive-own-key",
  "plan-exact-depth-boundary-accepted",
  "plan-over-depth-boundary-structured",
  "plan-exact-work-boundary-accepted",
  "plan-over-work-boundary-structured",
  "snapshot-missing-status",
  "snapshot-extra-root-field",
  "snapshot-wrong-version",
  "snapshot-wrong-frames-type",
  "snapshot-unsafe-event-sequence",
  "snapshot-exact-numeric-boundaries-accepted",
  "snapshot-zero-session-time",
  "snapshot-negative-zero-action-id",
  "snapshot-negative-zero-request-sequence",
  "snapshot-duplicate-speaker-id",
  "snapshot-duplicate-scope-id",
  "snapshot-invalid-loop-id",
  "snapshot-invalid-call-frame-id",
  "snapshot-invalid-temporary-id",
  "snapshot-invalid-instruction-target",
  "snapshot-invalid-continuation-owner",
  "snapshot-missing-pending-destination",
  "snapshot-settlement-result-mismatch",
  "snapshot-status-action-chronology",
  "snapshot-settlement-chronology",
  "snapshot-sparse-frames",
  "snapshot-cycle",
  "snapshot-accessor",
  "snapshot-non-plain-object",
  "snapshot-prototype-sensitive-own-key",
  "snapshot-exact-depth-boundary-structured",
  "snapshot-over-depth-boundary-structured",
  "snapshot-exact-work-boundary-structured",
  "snapshot-over-work-boundary-structured",
  "checkpoint-wrong-version",
  "checkpoint-nested-plan-version",
  "checkpoint-nested-snapshot-version",
  "checkpoint-plan-snapshot-mismatch",
  "checkpoint-extra-root-field",
  "checkpoint-prototype-sensitive-own-key",
  "checkpoint-non-finite-number",
  "checkpoint-cycle",
  "checkpoint-accessor",
  "checkpoint-non-plain-object",
  "checkpoint-exact-depth-boundary-structured",
  "checkpoint-over-depth-boundary-structured",
  "checkpoint-exact-work-boundary-structured",
  "checkpoint-over-work-boundary-structured",
  "completion-missing-action-id",
  "completion-extra-field",
  "completion-wrong-primitive-type",
  "completion-unsafe-action-id",
  "completion-non-finite-action-id",
  "completion-negative-zero-action-id",
  "completion-wrong-action-kind",
  "completion-unknown-action-id",
  "completion-stale-action-id",
  "completion-exact-multibyte-text-limit",
  "completion-over-limit-text",
  "completion-cycle",
  "completion-accessor",
  "completion-non-plain-object",
  "runtime-malformed-plan-structured",
  "runtime-malformed-snapshot-structured",
  "runtime-hostile-plan-accessor-structured",
  "runtime-hostile-plan-non-plain-structured",
  "runtime-hostile-plan-cycle-structured",
  "runtime-hostile-snapshot-accessor-structured",
  "runtime-hostile-snapshot-non-plain-structured",
  "runtime-hostile-snapshot-cycle-structured",
  "interaction-event-capacity-exact-operation",
  "interaction-event-capacity-exhausted-operation",
  "delay-event-capacity-exact-operation",
  "action-id-capacity-operation",
] as const);

const PINNED_SMOKE_SIGNATURE =
  "f834c47be70428e9dbdd249d35fb6dd7ad7d2b061327f2af7e9fdb6e6e471a92";

const malformedArguments: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(["--seed", "0"]),
  Object.freeze(["--seed", "-1"]),
  Object.freeze(["--seed", "1.5"]),
  Object.freeze(["--seed", "1e3"]),
  Object.freeze(["--seed", "NaN"]),
  Object.freeze(["--seed", "Infinity"]),
  Object.freeze(["--seed", "4294967296"]),
  Object.freeze(["--runs", "0"]),
  Object.freeze(["--runs", "-1"]),
  Object.freeze(["--runs", "1.5"]),
  Object.freeze(["--runs", "1e3"]),
  Object.freeze(["--runs", "1000001"]),
  Object.freeze(["--case", "128"]),
  Object.freeze(["--unknown", "1"]),
  Object.freeze(["--seed"]),
  Object.freeze(["--seed", "1", "--seed", "2"]),
  Object.freeze(["position"]),
]);

test("property registry pins the complete mandatory Phase 1 catalog", () => {
  const definitions = propertyCases();
  const identifiers = definitions.map((definition) => definition.id);

  assert.deepEqual(identifiers, EXPECTED_PROPERTY_CASE_IDS);
  assert.equal(new Set(identifiers).size, identifiers.length);
  assert.equal(definitions.length, 102);
  assert.ok(definitions.length <= PROPERTY_SMOKE_RUNS);
  assert.doesNotThrow(() => validatePropertyDefinitions(definitions));

  const duplicate = Object.freeze([
    definitions[0]!,
    Object.freeze({ ...definitions[0]! }),
  ]);
  assert.throws(
    () => validatePropertyDefinitions(duplicate),
    /Duplicate property case ID/,
  );
  assert.throws(
    () => validatePropertyDefinitions(Object.freeze([
      Object.freeze({ ...definitions[0]!, workUnits: MAX_PROPERTY_WORK_UNITS_PER_CASE + 1 }),
    ])),
    /invalid workUnits/,
  );
  assert.throws(
    () => validatePropertyDefinitions(Object.freeze([
      Object.freeze({ ...definitions[0]!, mutationCount: 4 }),
    ])),
    /invalid mutationCount/,
  );
});

test("fixture bounds revisit shared aliases and inspect own descriptors safely", () => {
  const shared: Record<string, unknown> = { value: "ok" };
  let deep: Record<string, unknown> = shared;
  for (let index = 0; index < MAX_PROPERTY_GRAPH_DEPTH; index += 1) {
    deep = { next: deep };
  }
  assert.throws(
    () => assertPropertyFixtureBounds({ shallow: shared, deep }),
    /exceeds property fixture depth/,
  );

  const nonEnumerable: Record<string, unknown> = {};
  Object.defineProperty(nonEnumerable, "hidden", {
    value: "é".repeat(Math.ceil((MAX_PROPERTY_STRING_UTF8_BYTES + 1) / 2)),
    enumerable: false,
    configurable: true,
  });
  assert.throws(
    () => assertPropertyFixtureBounds(nonEnumerable),
    /exceeds property fixture string bytes/,
  );

  let getterCalls = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "hostile", {
    get(): never {
      getterCalls += 1;
      throw new Error("fixture bound getter must not run");
    },
    enumerable: true,
    configurable: true,
  });
  assert.throws(
    () => assertPropertyFixtureBounds(accessor),
    /must not contain an accessor fixture property/,
  );
  assert.equal(getterCalls, 0);
});

test("deep-frozen fixtures prevent campaign poisoning", () => {
  const poisoningCase: PropertyCaseDefinition = Object.freeze({
    id: "synthetic-fixture-poisoning",
    property: "fixture catalog isolation",
    boundary: "fixture-immutability",
    workUnits: 1,
    mutationCount: 0,
    repeatable: true,
    describe: (_fixtures: PropertyFixtureCatalog, variant: PropertyCaseVariant) =>
      JSON.stringify({ caseId: "synthetic-fixture-poisoning", fixture: "fresh", variant }),
    execute(fixtures: PropertyFixtureCatalog) {
      const mutableSnapshot = fixtures.fresh.snapshot as unknown as { status: string };
      mutableSnapshot.status = "failed";
      return { detail: "unreachable", fixtureSummary: "fresh" };
    },
  });
  const config: PropertyCampaignConfig = Object.freeze({
    profile: "extended",
    seed: 12345,
    runs: 1,
    progressEvery: 0,
  });

  assert.throws(
    () => runPropertyCampaign(config, { caseDefinitions: [poisoningCase] }),
    (error: unknown) => {
      assert.ok(error instanceof PropertyCampaignFailure);
      assert.equal(error.caseId, "synthetic-fixture-poisoning");
      assert.equal(error.boundary, "fixture-immutability");
      return true;
    },
  );

  const replay = runPropertyCampaign(config);
  assert.equal(replay.executed, 1);
});

test("required property smoke campaign is exact, deterministic, and bounded", () => {
  const config = defaultPropertyCampaignConfig("smoke");
  const first = runPropertyCampaign(config, { captureTrace: true });
  const second = runPropertyCampaign(config, { captureTrace: true });
  const configuredWork = calculateConfiguredWorkUnits(config);
  const configuredMutations = calculateConfiguredMutationCount(config);

  assert.equal(config.seed, PROPERTY_SMOKE_SEED);
  assert.equal(config.runs, PROPERTY_SMOKE_RUNS);
  assert.equal(first.executed, PROPERTY_SMOKE_RUNS);
  assert.ok(first.totalWorkUnits <= configuredWork);
  assert.ok(first.totalWorkUnits <= MAX_PROPERTY_TOTAL_WORK_UNITS);
  assert.ok(first.totalMutations <= configuredMutations);
  assert.ok(first.totalMutations <= MAX_PROPERTY_TOTAL_MUTATIONS);
  assert.ok(
    Math.max(...propertyCases().map((definition) => definition.workUnits)) <=
      MAX_PROPERTY_WORK_UNITS_PER_CASE,
  );
  assert.equal(first.signature, PINNED_SMOKE_SIGNATURE);
  assert.equal(first.trace?.length, PROPERTY_SMOKE_RUNS);
  assert.deepEqual(second, first);
});

test("property PRNG and recorded replay vectors are pinned", () => {
  let state = createPropertyPrng(1);
  const values: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const step = nextPropertyUint32(state);
    values.push(step.value);
    state = step.state;
  }
  assert.deepEqual(values, [270369, 67634689, 2647435461, 307599695, 2398689233]);

  assert.deepEqual(describePropertyCase(12345, 211), {
    index: 211,
    id: "delay-restore-resume-equivalent",
    property: "restored execution equals uninterrupted execution",
    boundary: "checkpoint/observeTime/run",
    workUnits: 12,
    mutationCount: 0,
    variant: {
      first: 1555439958,
      second: 2332626456,
      third: 4085331165,
    },
  });
});

test("a case from a full campaign is identical to isolated replay", () => {
  const fullConfig: PropertyCampaignConfig = Object.freeze({
    profile: "extended",
    seed: 12345,
    runs: 40,
    progressEvery: 0,
  });
  const isolatedConfig: PropertyCampaignConfig = Object.freeze({
    ...fullConfig,
    caseIndex: 17,
  });
  const full = runPropertyCampaign(fullConfig, { captureTrace: true });
  const isolated = runPropertyCampaign(isolatedConfig, { captureTrace: true });

  assert.equal(full.trace?.[17], isolated.trace?.[0]);
  assert.deepEqual(full.trace?.slice(17, 18), isolated.trace);
  assert.equal(isolated.executed, 1);
  assert.equal(
    createReplayCommand(isolatedConfig, isolatedConfig.caseIndex!),
    "npm run test:property:extended -- --seed 12345 --runs 40 --case 17",
  );
});

test("property CLI accepts explicit safe seed and run controls", () => {
  assert.deepEqual(
    parsePropertyCliArguments([
      "--profile",
      "extended",
      "--seed",
      "12345",
      "--runs",
      "250",
      "--case",
      "211",
      "--progress-every",
      "10",
    ]),
    {
      profile: "extended",
      seed: 12345,
      runs: 250,
      caseIndex: 211,
      progressEvery: 10,
    },
  );
});

test("documented npm wrappers match the profile argument contract", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { readonly scripts: Readonly<Record<string, string>> };

  assert.equal(
    packageJson.scripts["test:property"],
    "npm run build && node dist/tests/property/replay.js",
  );
  assert.equal(
    packageJson.scripts["test:property:extended"],
    "npm run build && node dist/tests/property/replay.js --profile extended",
  );
  assert.match(propertyCliUsage(), /generic wrapper to override/);
});

test("property CLI rejects malformed, negative, unsafe, and unsupported controls", () => {
  for (const argumentsValue of malformedArguments) {
    assert.throws(
      () => parsePropertyCliArguments(argumentsValue),
      { name: "PropertyCliArgumentError" },
      argumentsValue.join(" "),
    );
  }
  assert.match(propertyCliUsage(), /--seed/);
});

test("the real campaign loop wraps a failing case with replay context", () => {
  const syntheticCase: PropertyCaseDefinition = Object.freeze({
    id: "synthetic-campaign-failure",
    property: "synthetic campaign wrapping",
    boundary: "synthetic-static-boundary",
    workUnits: 1,
    mutationCount: 0,
    repeatable: true,
    describe: (_fixtures: PropertyFixtureCatalog, variant: PropertyCaseVariant) => JSON.stringify({
      caseId: "synthetic-campaign-failure",
      fixture: "synthetic-fixture",
      variant,
    }),
    execute: () => atPropertyBoundary("synthetic:first-boundary", () => {
      throw new Error("synthetic failure");
    }),
  });
  const config: PropertyCampaignConfig = Object.freeze({
    profile: "extended",
    seed: 12345,
    runs: 1,
    progressEvery: 0,
  });

  assert.throws(
    () => runPropertyCampaign(config, { caseDefinitions: [syntheticCase] }),
    (error: unknown) => {
      assert.ok(error instanceof PropertyCampaignFailure);
      assert.equal(error.seed, 12345);
      assert.equal(error.runs, 1);
      assert.equal(error.caseIndex, 0);
      assert.equal(error.caseId, "synthetic-campaign-failure");
      assert.equal(error.boundary, "synthetic:first-boundary");
      assert.match(error.fixtureSummary, /synthetic-fixture/);
      assert.equal(
        error.replayCommand,
        "npm run test:property:extended -- --seed 12345 --runs 1 --case 0",
      );
      return true;
    },
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: PropertyCliIo = {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  const status = runPropertyCli(
    ["--profile", "extended", "--seed", "12345", "--runs", "1"],
    io,
    (cliConfig) => runPropertyCampaign(cliConfig, {
      caseDefinitions: [syntheticCase],
    }),
  );
  assert.equal(status, 1);
  assert.deepEqual(stdout, []);
  assert.match(stderr.join(""), /boundary=synthetic:first-boundary/);
  assert.match(stderr.join(""), /fixture=.*synthetic-fixture/);
  assert.match(stderr.join(""), /--case 0/);
});

test("campaign accounting rejects a case that reaches no public boundary", () => {
  const noBoundaryCase: PropertyCaseDefinition = Object.freeze({
    id: "synthetic-no-boundary",
    property: "synthetic accounting regression",
    boundary: "synthetic-static-boundary",
    workUnits: 1,
    mutationCount: 0,
    repeatable: true,
    describe: (_fixtures: PropertyFixtureCatalog, variant: PropertyCaseVariant) => JSON.stringify({
      caseId: "synthetic-no-boundary",
      fixture: "synthetic-fixture",
      variant,
    }),
    execute: () => Object.freeze({ detail: "no-boundary", fixtureSummary: "synthetic-fixture" }),
  });
  const config: PropertyCampaignConfig = Object.freeze({
    profile: "extended",
    seed: 12345,
    runs: 1,
    progressEvery: 0,
  });

  assert.throws(
    () => runPropertyCampaign(config, { caseDefinitions: [noBoundaryCase] }),
    (error: unknown) => {
      assert.ok(error instanceof PropertyCampaignFailure);
      assert.equal(error.boundary, "work-accounting");
      assert.match(error.message, /executed no documented public boundary/);
      assert.match(error.fixtureSummary, /synthetic-fixture/);
      return true;
    },
  );
});

test("composite invariants preserve the exact first failing stage", () => {
  const fixtures = createPropertyFixtureCatalog();
  assert.throws(
    () => assertResumeEquivalent(
      fixtures.waitingDelay.plan,
      fixtures.waitingDelay.snapshot,
      () => {
        throw new Error("synthetic continue failure");
      },
      "observeTime",
    ),
    (error: unknown) => {
      assert.ok(error instanceof PropertyBoundaryFailure);
      assert.equal(error.boundary, "observeTime:uninterrupted");
      return true;
    },
  );
});

test("property CLI returns zero and concise output for a successful campaign", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: PropertyCliIo = {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  const result: PropertyCampaignResult = Object.freeze({
    seed: 12345,
    runs: 2,
    executed: 2,
    totalWorkUnits: 4,
    totalMutations: 2,
    signature: "1234abcd",
    firstCase: describePropertyCase(12345, 0),
    lastCase: describePropertyCase(12345, 1),
  });
  const status = runPropertyCli(
    ["--seed", "12345", "--runs", "2"],
    io,
    () => result,
  );

  assert.equal(status, 0);
  assert.deepEqual(stderr, []);
  assert.deepEqual(stdout, [
    "property campaign passed seed=12345 runs=2 executed=2 work=4 mutations=2 signature=1234abcd\n",
  ]);
});
