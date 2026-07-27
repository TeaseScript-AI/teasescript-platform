import assert from "node:assert/strict";
import test from "node:test";

import {
  PropertyBoundaryFailure,
  assertResumeEquivalent,
} from "./property/invariants.js";
import { createPropertyFixtureCatalog } from "./property/fixtures.js";
import { propertyCases } from "./property/mutations.js";
import {
  PROPERTY_SMOKE_RUNS,
  PROPERTY_SMOKE_SEED,
  MAX_PROPERTY_TOTAL_WORK_UNITS,
  MAX_PROPERTY_WORK_UNITS_PER_CASE,
  PropertyCampaignFailure,
  calculateConfiguredWorkUnits,
  createReplayCommand,
  defaultPropertyCampaignConfig,
  describePropertyCase,
  parsePropertyCliArguments,
  propertyCliUsage,
  runPropertyCampaign,
  runPropertyCli,
  type PropertyCampaignResult,
  type PropertyCliIo,
} from "./property/replay.js";

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

test("required property smoke campaign is deterministic and closes public boundaries", () => {
  const config = defaultPropertyCampaignConfig("smoke");
  const first = runPropertyCampaign(config);
  const second = runPropertyCampaign(config);

  assert.ok(
    propertyCases().length <= PROPERTY_SMOKE_RUNS,
    "The smoke budget must execute every mandatory Phase 1 case.",
  );
  assert.equal(config.seed, PROPERTY_SMOKE_SEED);
  assert.equal(config.runs, PROPERTY_SMOKE_RUNS);
  assert.equal(first.executed, PROPERTY_SMOKE_RUNS);
  assert.equal(first.totalWorkUnits, calculateConfiguredWorkUnits(config));
  assert.ok(first.totalWorkUnits <= MAX_PROPERTY_TOTAL_WORK_UNITS);
  assert.ok(
    Math.max(...propertyCases().map((definition) => definition.workUnits)) <=
      MAX_PROPERTY_WORK_UNITS_PER_CASE,
  );
  assert.deepEqual(second, first);
});

test("case derivation and exact replay are stable", () => {
  const config = Object.freeze({
    ...defaultPropertyCampaignConfig("extended"),
    seed: 12345,
    runs: 250,
    caseIndex: 211,
    progressEvery: 0,
  });
  const descriptor = describePropertyCase(config.seed, config.caseIndex);
  const first = runPropertyCampaign(config);
  const second = runPropertyCampaign(config);

  assert.deepEqual(second, first);
  assert.deepEqual(first.firstCase, descriptor);
  assert.equal(first.executed, 1);
  assert.equal(first.totalWorkUnits, descriptor.workUnits);
  assert.equal(
    createReplayCommand(config, config.caseIndex),
    "npm run test:property:extended -- --seed 12345 --runs 250 --case 211",
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

test("property CLI reports failures with non-zero status and exact replay", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: PropertyCliIo = {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  const config = parsePropertyCliArguments([
    "--profile",
    "extended",
    "--seed",
    "12345",
    "--runs",
    "250",
  ]);
  const descriptor = describePropertyCase(config.seed, 17);
  const status = runPropertyCli(
    ["--profile", "extended", "--seed", "12345", "--runs", "250"],
    io,
    () => {
      throw new PropertyCampaignFailure(
        config,
        descriptor,
        "fixture:sample",
        new PropertyBoundaryFailure("serializeCheckpoint", new Error("synthetic failure")),
      );
    },
  );

  assert.equal(status, 1);
  assert.deepEqual(stdout, []);
  assert.match(stderr.join(""), /seed=12345/);
  assert.match(stderr.join(""), /runs=250/);
  assert.match(stderr.join(""), /case=17/);
  assert.match(stderr.join(""), /mutation=/);
  assert.match(stderr.join(""), /boundary=serializeCheckpoint/);
  assert.match(stderr.join(""), /fixture=fixture:sample/);
  assert.match(
    stderr.join(""),
    /npm run test:property:extended -- --seed 12345 --runs 250 --case 17/,
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
    "property campaign passed seed=12345 runs=2 executed=2 work=4 signature=1234abcd\n",
  ]);
});
