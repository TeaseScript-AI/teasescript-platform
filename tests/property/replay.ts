import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  assertPropertyFixtureCatalogFrozen,
  createPropertyFixtureCatalog,
  type PropertyFixtureCatalog,
} from "./fixtures.js";
import {
  propertyCases,
  type PropertyCaseDefinition,
  type PropertyCaseObservation,
  type PropertyCaseVariant,
} from "./mutations.js";
import {
  PropertyBoundaryFailure,
  measurePropertyBoundaryWork,
} from "./invariants.js";
import {
  MAX_PROPERTY_SEED,
  createPropertyPrng,
  nextPropertyUint32,
  propertyIndex,
} from "./prng.js";

const MANDATORY_PROPERTY_CASES = Object.freeze([...propertyCases()]);

export const PROPERTY_SMOKE_SEED = 1_364_229_357;
export const PROPERTY_SMOKE_RUNS = 128;
export const PROPERTY_EXTENDED_SEED = 1_591_436_852;
export const PROPERTY_EXTENDED_RUNS = 10_000;
export const PROPERTY_MODERATE_RUNS = 2_000;
export const MAX_PROPERTY_RUNS = 1_000_000;
export const MAX_PROPERTY_MUTATIONS_PER_CASE = 3;
export const MAX_PROPERTY_WORK_UNITS_PER_CASE = 16;
export const MAX_PROPERTY_TOTAL_WORK_UNITS =
  MAX_PROPERTY_RUNS * MAX_PROPERTY_WORK_UNITS_PER_CASE;
export const MAX_PROPERTY_TOTAL_MUTATIONS =
  MAX_PROPERTY_RUNS * MAX_PROPERTY_MUTATIONS_PER_CASE;

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
  readonly workUnits: number;
  readonly mutationCount: number;
  readonly variant: PropertyCaseVariant;
}

export interface PropertyCampaignResult {
  readonly seed: number;
  readonly runs: number;
  readonly executed: number;
  readonly totalWorkUnits: number;
  readonly totalMutations: number;
  readonly signature: string;
  readonly firstCase: PropertyCaseDescriptor;
  readonly lastCase: PropertyCaseDescriptor;
  readonly trace?: readonly string[];
}

export interface PropertyProgress {
  readonly seed: number;
  readonly runs: number;
  readonly completed: number;
  readonly completedWorkUnits: number;
  readonly completedMutations: number;
  readonly currentCase: PropertyCaseDescriptor;
}

export interface PropertyCampaignOptions {
  readonly onProgress?: (progress: PropertyProgress) => void;
  readonly captureTrace?: boolean;
  readonly caseDefinitions?: readonly PropertyCaseDefinition[];
  readonly fixtureFactory?: () => PropertyFixtureCatalog;
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
    const boundary = cause instanceof PropertyBoundaryFailure
      ? cause.boundary
      : descriptor.boundary;
    super(
      [
        `Property campaign failed at ${descriptor.property}.`,
        `seed=${config.seed}`,
        `runs=${config.runs}`,
        `case=${descriptor.index}`,
        `mutation=${descriptor.id}`,
        `boundary=${boundary}`,
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
    this.boundary = boundary;
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

validatePropertyDefinitions(MANDATORY_PROPERTY_CASES);

export function validatePropertyDefinitions(
  definitions: readonly PropertyCaseDefinition[],
): void {
  const identifiers = new Set<string>();
  for (const definition of definitions) {
    if (identifiers.has(definition.id)) {
      throw new Error(`Duplicate property case ID: ${definition.id}.`);
    }
    identifiers.add(definition.id);
    if (
      !Number.isSafeInteger(definition.workUnits) ||
      definition.workUnits < 1 ||
      definition.workUnits > MAX_PROPERTY_WORK_UNITS_PER_CASE
    ) {
      throw new Error(
        `Property case ${definition.id} has invalid workUnits=${definition.workUnits}; ` +
          `expected 1..${MAX_PROPERTY_WORK_UNITS_PER_CASE}.`,
      );
    }
    if (
      !Number.isSafeInteger(definition.mutationCount) ||
      definition.mutationCount < 0 ||
      definition.mutationCount > MAX_PROPERTY_MUTATIONS_PER_CASE
    ) {
      throw new Error(
        `Property case ${definition.id} has invalid mutationCount=${definition.mutationCount}; ` +
          `expected 0..${MAX_PROPERTY_MUTATIONS_PER_CASE}.`,
      );
    }
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
}

export function describePropertyCase(
  seed: number,
  caseIndex: number,
): PropertyCaseDescriptor {
  return describePropertyCaseFromDefinitions(seed, caseIndex, MANDATORY_PROPERTY_CASES);
}

export function runPropertyCampaign(
  config: PropertyCampaignConfig,
  options: PropertyCampaignOptions = {},
): PropertyCampaignResult {
  validatePropertyCampaignConfig(config);
  const definitions = Object.freeze([
    ...(options.caseDefinitions ?? MANDATORY_PROPERTY_CASES),
  ]);
  validatePropertyDefinitions(definitions);
  const selectedCount = config.caseIndex === undefined ? config.runs : 1;
  const configured = calculateConfiguredBounds(config, definitions);
  if (configured.workUnits > MAX_PROPERTY_TOTAL_WORK_UNITS) {
    throw new PropertyCliArgumentError(
      `Configured work ${configured.workUnits} exceeds ${MAX_PROPERTY_TOTAL_WORK_UNITS} units.`,
    );
  }
  if (configured.mutations > MAX_PROPERTY_TOTAL_MUTATIONS) {
    throw new PropertyCliArgumentError(
      `Configured mutations ${configured.mutations} exceed ${MAX_PROPERTY_TOTAL_MUTATIONS}.`,
    );
  }

  const fixtures = (options.fixtureFactory ?? createPropertyFixtureCatalog)();
  assertPropertyFixtureCatalogFrozen(fixtures);
  const digest = createHash("sha256");
  const trace = options.captureTrace === true ? [] as string[] : undefined;
  let firstCase: PropertyCaseDescriptor | undefined;
  let lastCase: PropertyCaseDescriptor | undefined;
  let completed = 0;
  let completedWorkUnits = 0;
  let completedMutations = 0;

  for (let offset = 0; offset < selectedCount; offset += 1) {
    const caseIndex = config.caseIndex ?? offset;
    const descriptor = describePropertyCaseFromDefinitions(config.seed, caseIndex, definitions);
    let caseContext = JSON.stringify({
      caseId: descriptor.id,
      fixture: "unresolved",
      variant: descriptor.variant,
    });
    let caseObservation: PropertyCaseObservation;
    let actualBoundaries: readonly string[] = Object.freeze([]);
    try {
      const definition = definitionForDescriptor(descriptor, definitions);
      caseContext = definition.describe(fixtures, descriptor.variant);
      const measured = measurePropertyBoundaryWork(
        () => definition.execute(fixtures, descriptor.variant),
      );
      caseObservation = measured.value;
      actualBoundaries = measured.boundaries;
      if (actualBoundaries.length < 1) {
        throw new PropertyBoundaryFailure(
          "work-accounting",
          new Error(`Case ${descriptor.id} executed no documented public boundary.`),
        );
      }
      if (actualBoundaries.length > descriptor.workUnits) {
        throw new PropertyBoundaryFailure(
          "work-accounting",
          new Error(
            `Case ${descriptor.id} executed ${actualBoundaries.length} public boundaries ` +
              `but declares a conservative limit of ${descriptor.workUnits}: ` +
              actualBoundaries.join(", "),
          ),
        );
      }
    } catch (error) {
      throw new PropertyCampaignFailure(config, descriptor, caseContext, error);
    }

    firstCase ??= descriptor;
    lastCase = descriptor;
    const traceEntry = JSON.stringify({
      index: descriptor.index,
      id: descriptor.id,
      property: descriptor.property,
      boundary: descriptor.boundary,
      workUnits: descriptor.workUnits,
      actualWorkUnits: actualBoundaries.length,
      boundaries: actualBoundaries,
      mutationCount: descriptor.mutationCount,
      variant: descriptor.variant,
      observation: caseObservation,
    });
    digest.update(traceEntry);
    digest.update("\n");
    trace?.push(traceEntry);
    completed += 1;
    completedWorkUnits += actualBoundaries.length;
    completedMutations += descriptor.mutationCount;

    if (
      options.onProgress !== undefined &&
      config.progressEvery > 0 &&
      (completed % config.progressEvery === 0 || completed === selectedCount)
    ) {
      options.onProgress(Object.freeze({
        seed: config.seed,
        runs: config.runs,
        completed,
        completedWorkUnits,
        completedMutations,
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
    totalWorkUnits: completedWorkUnits,
    totalMutations: completedMutations,
    signature: digest.digest("hex"),
    firstCase,
    lastCase,
    ...(trace === undefined ? {} : { trace: Object.freeze(trace) }),
  });
}

export function calculateConfiguredWorkUnits(
  config: Pick<PropertyCampaignConfig, "seed" | "runs" | "caseIndex">,
): number {
  return calculateConfiguredBounds(config, MANDATORY_PROPERTY_CASES).workUnits;
}

export function calculateConfiguredMutationCount(
  config: Pick<PropertyCampaignConfig, "seed" | "runs" | "caseIndex">,
): number {
  return calculateConfiguredBounds(config, MANDATORY_PROPERTY_CASES).mutations;
}

function calculateConfiguredBounds(
  config: Pick<PropertyCampaignConfig, "seed" | "runs" | "caseIndex">,
  definitions: readonly PropertyCaseDefinition[],
): { readonly workUnits: number; readonly mutations: number } {
  const selectedCount = config.caseIndex === undefined ? config.runs : 1;
  let workUnits = 0;
  let mutations = 0;
  for (let offset = 0; offset < selectedCount; offset += 1) {
    const caseIndex = config.caseIndex ?? offset;
    const descriptor = describePropertyCaseFromDefinitions(config.seed, caseIndex, definitions);
    workUnits += descriptor.workUnits;
    mutations += descriptor.mutationCount;
    if (!Number.isSafeInteger(workUnits) || !Number.isSafeInteger(mutations)) {
      throw new PropertyCliArgumentError("Configured property bounds are not safe integers.");
    }
  }
  return Object.freeze({ workUnits, mutations });
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
    const configuredWorkUnits = calculateConfiguredWorkUnits(config);
    const configuredMutations = calculateConfiguredMutationCount(config);
    const result = campaignRunner(config, {
      onProgress(progress) {
        io.stdout(
          `property progress seed=${progress.seed} completed=${progress.completed}/` +
            `${config.caseIndex === undefined ? config.runs : 1} ` +
            `work=${progress.completedWorkUnits}/${configuredWorkUnits} ` +
            `mutations=${progress.completedMutations}/${configuredMutations} ` +
            `case=${progress.currentCase.index}:${progress.currentCase.id}\n`,
        );
      },
    });
    io.stdout(
      `property campaign passed seed=${result.seed} runs=${result.runs} ` +
        `executed=${result.executed} work=${result.totalWorkUnits} ` +
        `mutations=${result.totalMutations} signature=${result.signature}\n`,
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
    "Usage:",
    "  npm run test:property -- [--profile smoke|extended] [options]",
    "  npm run test:property:extended -- [options]",
    "The extended wrapper already selects the extended profile; use the generic wrapper to override it.",
    `  --seed 1..${MAX_PROPERTY_SEED}`,
    `  --runs 1..${MAX_PROPERTY_RUNS}`,
    "  --case 0..runs-1",
    `  --progress-every 0..${MAX_PROPERTY_RUNS}`,
  ].join("\n");
}

function describePropertyCaseFromDefinitions(
  seed: number,
  caseIndex: number,
  definitions: readonly PropertyCaseDefinition[],
): PropertyCaseDescriptor {
  if (!Number.isSafeInteger(caseIndex) || caseIndex < 0) {
    throw new RangeError("Property case index must be a non-negative safe integer.");
  }
  if (definitions.length === 0) throw new Error("Property case catalog is empty.");
  const repeatable = definitions.filter((definition) => definition.repeatable);
  if (caseIndex >= definitions.length && repeatable.length === 0) {
    throw new Error("Property case catalog has no repeatable cases.");
  }

  let state = createPropertyPrng(mixSeedWithCaseIndex(seed, caseIndex));
  const selection = nextPropertyUint32(state);
  state = selection.state;
  const first = nextPropertyUint32(state);
  state = first.state;
  const second = nextPropertyUint32(state);
  state = second.state;
  const third = nextPropertyUint32(state);

  const definition = caseIndex < definitions.length
    ? definitions[caseIndex]!
    : repeatable[propertyIndex(selection.value, repeatable.length)]!;
  return Object.freeze({
    index: caseIndex,
    id: definition.id,
    property: definition.property,
    boundary: definition.boundary,
    workUnits: definition.workUnits,
    mutationCount: definition.mutationCount,
    variant: Object.freeze({
      first: first.value,
      second: second.value,
      third: third.value,
    }),
  });
}

function definitionForDescriptor(
  descriptor: PropertyCaseDescriptor,
  definitions: readonly PropertyCaseDefinition[],
): PropertyCaseDefinition {
  const mandatory = definitions[descriptor.index];
  if (mandatory !== undefined) {
    if (mandatory.id !== descriptor.id) {
      throw new Error(`Property case changed: ${descriptor.id}.`);
    }
    return mandatory;
  }
  const repeatableById = new Map(
    definitions.filter((definition) => definition.repeatable).map((definition) => [
      definition.id,
      definition,
    ] as const),
  );
  const definition = repeatableById.get(descriptor.id);
  if (definition === undefined) throw new Error(`Unknown property case: ${descriptor.id}.`);
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
