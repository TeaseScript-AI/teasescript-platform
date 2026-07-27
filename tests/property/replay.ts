import { pathToFileURL } from "node:url";

import {
  createPropertyFixtureCatalog,
  summarizePropertyFixtureCatalog,
} from "./fixtures.js";
import {
  propertyCases,
  repeatablePropertyCases,
  type PropertyCaseDefinition,
  type PropertyCaseObservation,
  type PropertyCaseVariant,
} from "./mutations.js";
import {
  MAX_PROPERTY_SEED,
  createPropertyPrng,
  nextPropertyUint32,
  propertyIndex,
} from "./prng.js";

const MANDATORY_PROPERTY_CASES = propertyCases();
const REPEATABLE_PROPERTY_CASES = Object.freeze([...repeatablePropertyCases()]);

export const PROPERTY_SMOKE_SEED = 1_364_229_357;
export const PROPERTY_SMOKE_RUNS = 128;
export const PROPERTY_EXTENDED_SEED = 1_591_436_852;
export const PROPERTY_EXTENDED_RUNS = 10_000;
export const PROPERTY_MODERATE_RUNS = 2_000;
export const MAX_PROPERTY_RUNS = 1_000_000;
export const MAX_PROPERTY_MUTATIONS_PER_CASE = 3;
export const MAX_PROPERTY_OPERATION_COUNT = 4;
export const PROPERTY_WORK_UNITS_PER_CASE = 4;
export const MAX_PROPERTY_TOTAL_WORK_UNITS =
  MAX_PROPERTY_RUNS * PROPERTY_WORK_UNITS_PER_CASE;

export type PropertyProfile = "smoke" | "extended";

export interface PropertyCampaignConfig {
  readonly profile: PropertyProfile;
  readonly seed: number;
  readonly runs: number;
  readonly caseIndex?: number;
  readonly progressEvery: number;
}

export interface PropertyCaseDescriptor {
  readonly index: number;
  readonly id: string;
  readonly property: string;
  readonly boundary: string;
  readonly variant: PropertyCaseVariant;
}

export interface PropertyCampaignResult {
  readonly seed: number;
  readonly runs: number;
  readonly executed: number;
  readonly signature: string;
  readonly firstCase: PropertyCaseDescriptor;
  readonly lastCase: PropertyCaseDescriptor;
}

export interface PropertyProgress {
  readonly seed: number;
  readonly runs: number;
  readonly completed: number;
  readonly currentCase: PropertyCaseDescriptor;
}

export interface PropertyCampaignOptions {
  readonly onProgress?: (progress: PropertyProgress) => void;
}

export interface PropertyCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export type PropertyCampaignRunner = (
  config: PropertyCampaignConfig,
  options?: PropertyCampaignOptions,
) => PropertyCampaignResult;

export class PropertyCampaignFailure extends Error {
  public readonly seed: number;
  public readonly runs: number;
  public readonly caseIndex: number;
  public readonly caseId: string;
  public readonly property: string;
  public readonly boundary: string;
  public readonly fixtureSummary: string;
  public readonly replayCommand: string;

  public constructor(
    config: PropertyCampaignConfig,
    descriptor: PropertyCaseDescriptor,
    fixtureSummary: string,
    cause: unknown,
  ) {
    const causeText = cause instanceof Error
      ? `${cause.name}: ${cause.message}`
      : String(cause);
    const replayCommand = createReplayCommand(config, descriptor.index);
    super(
      [
        `Property campaign failed at ${descriptor.property}.`,
        `seed=${config.seed}`,
        `runs=${config.runs}`,
        `case=${descriptor.index}`,
        `mutation=${descriptor.id}`,
        `boundary=${descriptor.boundary}`,
        `fixture=${fixtureSummary}`,
        `cause=${causeText}`,
        `replay=${replayCommand}`,
      ].join("\n"),
      { cause },
    );
    this.name = "PropertyCampaignFailure";
    this.seed = config.seed;
    this.runs = config.runs;
    this.caseIndex = descriptor.index;
    this.caseId = descriptor.id;
    this.property = descriptor.property;
    this.boundary = descriptor.boundary;
    this.fixtureSummary = fixtureSummary;
    this.replayCommand = replayCommand;
  }
}

export class PropertyCliArgumentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PropertyCliArgumentError";
  }
}

export function defaultPropertyCampaignConfig(
  profile: PropertyProfile,
): PropertyCampaignConfig {
  return profile === "smoke"
    ? Object.freeze({
        profile,
        seed: PROPERTY_SMOKE_SEED,
        runs: PROPERTY_SMOKE_RUNS,
        progressEvery: 0,
      })
    : Object.freeze({
        profile,
        seed: PROPERTY_EXTENDED_SEED,
        runs: PROPERTY_EXTENDED_RUNS,
        progressEvery: 1_000,
      });
}

export function validatePropertyCampaignConfig(
  config: PropertyCampaignConfig,
): void {
  if (!Number.isSafeInteger(config.seed) || config.seed < 1 || config.seed > MAX_PROPERTY_SEED) {
    throw new PropertyCliArgumentError(
      `--seed must be an integer from 1 through ${MAX_PROPERTY_SEED}.`,
    );
  }
  if (!Number.isSafeInteger(config.runs) || config.runs < 1 || config.runs > MAX_PROPERTY_RUNS) {
    throw new PropertyCliArgumentError(
      `--runs must be an integer from 1 through ${MAX_PROPERTY_RUNS}.`,
    );
  }
  if (
    config.caseIndex !== undefined &&
    (!Number.isSafeInteger(config.caseIndex) ||
      config.caseIndex < 0 ||
      config.caseIndex >= config.runs)
  ) {
    throw new PropertyCliArgumentError(
      `--case must be an integer from 0 through ${config.runs - 1}.`,
    );
  }
  if (
    !Number.isSafeInteger(config.progressEvery) ||
    config.progressEvery < 0 ||
    config.progressEvery > MAX_PROPERTY_RUNS
  ) {
    throw new PropertyCliArgumentError(
      `--progress-every must be an integer from 0 through ${MAX_PROPERTY_RUNS}.`,
    );
  }
  const totalWork = config.runs * PROPERTY_WORK_UNITS_PER_CASE;
  if (totalWork > MAX_PROPERTY_TOTAL_WORK_UNITS) {
    throw new PropertyCliArgumentError(
      `Configured work ${totalWork} exceeds ${MAX_PROPERTY_TOTAL_WORK_UNITS} units.`,
    );
  }
}

export function describePropertyCase(
  seed: number,
  caseIndex: number,
): PropertyCaseDescriptor {
  if (!Number.isSafeInteger(caseIndex) || caseIndex < 0) {
    throw new RangeError("Property case index must be a non-negative safe integer.");
  }
  let state = createPropertyPrng(mixSeedWithCaseIndex(seed, caseIndex));
  const selection = nextPropertyUint32(state);
  state = selection.state;
  const first = nextPropertyUint32(state);
  state = first.state;
  const second = nextPropertyUint32(state);
  state = second.state;
  const third = nextPropertyUint32(state);

  const definition = caseIndex < MANDATORY_PROPERTY_CASES.length
    ? MANDATORY_PROPERTY_CASES[caseIndex]!
    : REPEATABLE_PROPERTY_CASES[
        propertyIndex(selection.value, REPEATABLE_PROPERTY_CASES.length)
      ]!;
  return Object.freeze({
    index: caseIndex,
    id: definition.id,
    property: definition.property,
    boundary: definition.boundary,
    variant: Object.freeze({
      first: first.value,
      second: second.value,
      third: third.value,
    }),
  });
}

export function runPropertyCampaign(
  config: PropertyCampaignConfig,
  options: PropertyCampaignOptions = {},
): PropertyCampaignResult {
  validatePropertyCampaignConfig(config);
  const fixtures = createPropertyFixtureCatalog();
  const catalogSummary = summarizePropertyFixtureCatalog(fixtures);
  const selectedCount = config.caseIndex === undefined ? config.runs : 1;
  let signature = 0x811c_9dc5;
  let firstCase: PropertyCaseDescriptor | undefined;
  let lastCase: PropertyCaseDescriptor | undefined;
  let completed = 0;

  for (let offset = 0; offset < selectedCount; offset += 1) {
    const caseIndex = config.caseIndex ?? offset;
    const descriptor = describePropertyCase(config.seed, caseIndex);
    const definition = definitionForDescriptor(descriptor);
    let observation: PropertyCaseObservation;
    try {
      observation = definition.execute(fixtures, descriptor.variant);
    } catch (error) {
      throw new PropertyCampaignFailure(
        config,
        descriptor,
        catalogSummary,
        error,
      );
    }
    firstCase ??= descriptor;
    lastCase = descriptor;
    signature = updateSignature(
      signature,
      `${descriptor.index}|${descriptor.id}|${descriptor.property}|${descriptor.boundary}|` +
        `${descriptor.variant.first},${descriptor.variant.second},${descriptor.variant.third}|` +
        `${observation.detail}|${observation.fixtureSummary}`,
    );
    completed += 1;
    if (
      options.onProgress !== undefined &&
      config.progressEvery > 0 &&
      (completed % config.progressEvery === 0 || completed === selectedCount)
    ) {
      options.onProgress(Object.freeze({
        seed: config.seed,
        runs: config.runs,
        completed,
        currentCase: descriptor,
      }));
    }
  }

  if (firstCase === undefined || lastCase === undefined) {
    throw new Error("Property campaign executed no cases.");
  }
  return Object.freeze({
    seed: config.seed,
    runs: config.runs,
    executed: completed,
    signature: signature.toString(16).padStart(8, "0"),
    firstCase,
    lastCase,
  });
}

export function parsePropertyCliArguments(
  argv: readonly string[],
): PropertyCampaignConfig {
  let profile: PropertyProfile = "smoke";
  let seed: number | undefined;
  let runs: number | undefined;
  let caseIndex: number | undefined;
  let progressEvery: number | undefined;
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help") {
      throw new PropertyCliArgumentError(propertyCliUsage());
    }
    if (!argument.startsWith("--")) {
      throw new PropertyCliArgumentError(`Unexpected positional argument: ${argument}`);
    }
    if (seen.has(argument)) {
      throw new PropertyCliArgumentError(`Duplicate option: ${argument}`);
    }
    seen.add(argument);
    const rawValue = argv[index + 1];
    if (rawValue === undefined || rawValue.startsWith("--")) {
      throw new PropertyCliArgumentError(`Missing value for ${argument}.`);
    }
    index += 1;
    switch (argument) {
      case "--profile":
        if (rawValue !== "smoke" && rawValue !== "extended") {
          throw new PropertyCliArgumentError(
            "--profile must be either smoke or extended.",
          );
        }
        profile = rawValue;
        break;
      case "--seed":
        seed = parseUnsignedDecimal(argument, rawValue);
        break;
      case "--runs":
        runs = parseUnsignedDecimal(argument, rawValue);
        break;
      case "--case":
        caseIndex = parseUnsignedDecimal(argument, rawValue, true);
        break;
      case "--progress-every":
        progressEvery = parseUnsignedDecimal(argument, rawValue, true);
        break;
      default:
        throw new PropertyCliArgumentError(`Unknown option: ${argument}`);
    }
  }

  const defaults = defaultPropertyCampaignConfig(profile);
  const config: PropertyCampaignConfig = Object.freeze({
    profile,
    seed: seed ?? defaults.seed,
    runs: runs ?? defaults.runs,
    ...(caseIndex === undefined ? {} : { caseIndex }),
    progressEvery: progressEvery ?? defaults.progressEvery,
  });
  validatePropertyCampaignConfig(config);
  return config;
}

export function runPropertyCli(
  argv: readonly string[],
  io: PropertyCliIo = defaultCliIo(),
  campaignRunner: PropertyCampaignRunner = runPropertyCampaign,
): number {
  let config: PropertyCampaignConfig;
  try {
    config = parsePropertyCliArguments(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`${message}\n`);
    return 2;
  }

  try {
    const result = campaignRunner(config, {
      onProgress(progress) {
        io.stdout(
          `property progress seed=${progress.seed} completed=${progress.completed}/` +
            `${config.caseIndex === undefined ? config.runs : 1} ` +
            `case=${progress.currentCase.index}:${progress.currentCase.id}\n`,
        );
      },
    });
    io.stdout(
      `property campaign passed seed=${result.seed} runs=${result.runs} ` +
        `executed=${result.executed} signature=${result.signature}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof PropertyCampaignFailure) {
      io.stderr(`${error.message}\n`);
    } else {
      const message = error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
      io.stderr(`Property campaign infrastructure failed: ${message}\n`);
    }
    return 1;
  }
}

export function createReplayCommand(
  config: Pick<PropertyCampaignConfig, "seed" | "runs">,
  caseIndex: number,
): string {
  return "npm run test:property:extended -- " +
    `--seed ${config.seed} --runs ${config.runs} --case ${caseIndex}`;
}

export function propertyCliUsage(): string {
  return [
    "Usage: npm run test:property[:extended] -- [options]",
    "  --profile smoke|extended",
    `  --seed 1..${MAX_PROPERTY_SEED}`,
    `  --runs 1..${MAX_PROPERTY_RUNS}`,
    "  --case 0..runs-1",
    `  --progress-every 0..${MAX_PROPERTY_RUNS}`,
  ].join("\n");
}

function definitionForDescriptor(
  descriptor: PropertyCaseDescriptor,
): PropertyCaseDefinition {
  const describedAgain = describePropertyCaseDescriptorAndDefinition(
    descriptor.index,
    descriptor.id,
  );
  return describedAgain;
}

function describePropertyCaseDescriptorAndDefinition(
  caseIndex: number,
  expectedId: string,
): PropertyCaseDefinition {
  const mandatory = MANDATORY_PROPERTY_CASES[caseIndex];
  if (mandatory !== undefined) {
    if (mandatory.id !== expectedId) throw new Error(`Property case changed: ${expectedId}.`);
    return mandatory;
  }
  const definition = REPEATABLE_PROPERTY_CASES.find(
    (candidate) => candidate.id === expectedId,
  );
  if (definition === undefined) throw new Error(`Unknown property case: ${expectedId}.`);
  return definition;
}

function mixSeedWithCaseIndex(seed: number, caseIndex: number): number {
  createPropertyPrng(seed);
  let value = (seed ^ Math.imul((caseIndex + 1) >>> 0, 0x9e37_79b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85eb_ca6b) >>> 0;
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2_ae35) >>> 0;
  value ^= value >>> 16;
  value >>>= 0;
  return value === 0 ? 0x6d2b_79f5 : value;
}

function parseUnsignedDecimal(
  option: string,
  rawValue: string,
  allowZero = false,
): number {
  if (!/^(0|[1-9][0-9]*)$/.test(rawValue)) {
    throw new PropertyCliArgumentError(
      `${option} must be a base-10 integer without signs, fractions, or exponents.`,
    );
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || (!allowZero && value === 0)) {
    throw new PropertyCliArgumentError(`${option} is outside the supported range.`);
  }
  return value;
}

function updateSignature(signature: number, text: string): number {
  let value = signature >>> 0;
  for (const byte of new TextEncoder().encode(text)) {
    value ^= byte;
    value = Math.imul(value, 0x0100_0193) >>> 0;
  }
  return value;
}

function defaultCliIo(): PropertyCliIo {
  return Object.freeze({
    stdout(text: string): void {
      process.stdout.write(text);
    },
    stderr(text: string): void {
      process.stderr.write(text);
    },
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  process.exitCode = runPropertyCli(process.argv.slice(2));
}
