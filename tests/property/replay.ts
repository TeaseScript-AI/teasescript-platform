import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import {
  CheckpointError,
  completeAction,
  compileSource,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  executeInstruction,
  observeTime,
  restoreCheckpoint,
  run,
  serializeCheckpoint,
  validateInstructionPlan,
  validateRuntimeSnapshot,
  type ActionCompletionOutcome,
  type InstructionPlan,
  type PendingActionOperationResult,
  type RuntimeOperationResult,
  type RuntimeSnapshot,
} from "../../src/index.js";
import { createImmediatePacingRuntimeSnapshot } from "../helpers/immediate-pacing-runtime.js";
import {
  createNearValidSourceCase,
  createValidSourceCase,
  MAX_SOURCE_FUZZ_LENGTH,
  SOURCE_FUZZ_INSTRUCTION_BUDGET,
  type NearValidSourceCase,
  type ValidSourceCase,
} from "./source-fuzz.js";

export const PROPERTY_DEFAULT_SEED = 1_364_229_357;
export const PROPERTY_DEFAULT_RUNS = 128;
export const MAX_PROPERTY_RUNS = 100_000;

const OPERATION_VARIANTS = ["run", "executeInstruction", "observeTime", "completeAction"] as const;
const REJECTION_VARIANTS = ["time-completion", "duplicate-settlement"] as const;
const MALFORMED_VARIANTS = ["plan", "snapshot", "checkpoint"] as const;

export interface PropertyCampaignConfig {
  readonly seed: number;
  readonly runs: number;
  readonly caseIndex?: number;
}

export interface PropertyCaseResult {
  readonly index: number;
  readonly id: string;
  readonly boundary: string;
  readonly context: string;
  readonly source?: string;
}

export interface PropertyCampaignResult {
  readonly seed: number;
  readonly runs: number;
  readonly executed: number;
  readonly firstCase: PropertyCaseResult;
  readonly lastCase: PropertyCaseResult;
}

export interface PropertyDefinition {
  readonly id: string;
  readonly boundary: string;
  readonly prepare: (seed: number, index: number) => PreparedPropertyCase;
}

/** A seed-independent fixture that runs once rather than in generated campaign slots. */
export interface FixedPropertyCheck {
  readonly id: string;
  readonly boundary: string;
  readonly variant: string;
  readonly execute: () => void;
}

export interface PropertyCampaignDependencies {
  readonly compileSource?: typeof compileSource;
  readonly createValidSourceCase?: typeof createValidSourceCase;
  readonly createNearValidSourceCase?: typeof createNearValidSourceCase;
}

interface PreparedPropertyCase {
  readonly result: PropertyCaseResult;
  readonly execute: () => void;
}

interface PropertyCaseContext {
  readonly description: string;
  readonly source?: string;
}

const PROPERTIES = createPropertyDefinitions();

export class PropertyCampaignFailure extends Error {
  public constructor(
    readonly config: PropertyCampaignConfig,
    readonly result: PropertyCaseResult,
    readonly replayCommand: string,
    cause: unknown,
  ) {
    const causeText = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    const sourceLines =
      result.source === undefined ? [] : ["source-begin", result.source, "source-end"];

    super(
      [
        "Property campaign failed.",
        `seed=${config.seed}`,
        `runs=${config.runs}`,
        `case=${result.index}`,
        `property=${result.id}`,
        `boundary=${result.boundary}`,
        `context=${result.context}`,
        ...sourceLines,
        `replay=${replayCommand}`,
        `cause=${causeText}`,
      ].join("\n"),
      { cause },
    );
    this.name = "PropertyCampaignFailure";
  }
}

export function createPropertyDefinitions(
  overrides: PropertyCampaignDependencies = {},
): readonly PropertyDefinition[] {
  const dependencies = {
    compileSource: overrides.compileSource ?? compileSource,
    createValidSourceCase: overrides.createValidSourceCase ?? createValidSourceCase,
    createNearValidSourceCase: overrides.createNearValidSourceCase ?? createNearValidSourceCase,
  };

  return [
    ordinaryProperty(
      "same-seed-is-deterministic",
      "compile/run",
      describeSameSeed,
      assertSameSeedIsDeterministic,
    ),
    sourceProperty(
      "valid-source-pipeline",
      "package-root compile/run",
      dependencies.createValidSourceCase,
      (scenario, seed, index) =>
        assertValidSourcePipeline(scenario, seed, index, dependencies.compileSource),
    ),
    sourceProperty(
      "near-valid-source-diagnostics",
      "package-root compile",
      dependencies.createNearValidSourceCase,
      (scenario) => assertNearValidSourceDiagnostics(scenario, dependencies.compileSource),
    ),
  ];
}

/** Fixed operation, rejection, checkpoint and malformed-input fixtures consume no RNG. */
export function createFixedPropertyChecks(): readonly FixedPropertyCheck[] {
  return [
    ...OPERATION_VARIANTS.map((variant) => ({
      id: "operation-closure",
      boundary: "public runtime operation",
      variant,
      execute: () => assertOperationClosure(variant),
    })),
    ...REJECTION_VARIANTS.map((variant) => ({
      id: "rejected-completion-is-atomic",
      boundary: "completeAction",
      variant,
      execute: () => assertRejectedCompletionIsAtomic(variant),
    })),
    {
      id: "checkpoint-roundtrip-and-resume",
      boundary: "checkpoint/restore",
      variant: "wait-checkpoint-json-restore-resume",
      execute: assertCheckpointRoundTripAndResume,
    },
    ...MALFORMED_VARIANTS.map((variant) => ({
      id: "malformed-boundary-rejection",
      boundary: "external/persistence validation",
      variant,
      execute: () => assertMalformedBoundaryRejection(variant),
    })),
  ];
}

/** Runs every fixed check once and returns how many ran; a failure names its check. */
export function runFixedPropertyChecks(
  checks: readonly FixedPropertyCheck[] = createFixedPropertyChecks(),
): number {
  for (const check of checks) {
    try {
      check.execute();
    } catch (error) {
      const causeText = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(
        [
          "Fixed property check failed.",
          `property=${check.id}`,
          `boundary=${check.boundary}`,
          `variant=${check.variant}`,
          `cause=${causeText}`,
        ].join("\n"),
        { cause: error },
      );
    }
  }
  return checks.length;
}

export function defaultPropertyCampaignConfig(): PropertyCampaignConfig {
  return Object.freeze({ seed: PROPERTY_DEFAULT_SEED, runs: PROPERTY_DEFAULT_RUNS });
}

export function parsePropertyCliArguments(argv: readonly string[]): PropertyCampaignConfig {
  let seed = PROPERTY_DEFAULT_SEED;
  let runs = PROPERTY_DEFAULT_RUNS;
  let caseIndex: number | undefined;
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (seen.has(option)) {
      throw new Error(`Duplicate option: ${option}`);
    }
    seen.add(option);

    const raw = argv[index + 1];
    if (raw === undefined || raw.startsWith("--")) {
      throw new Error(`Missing value for ${option}.`);
    }
    index += 1;

    const value = parseDecimal(option, raw, option === "--case");
    switch (option) {
      case "--seed":
        seed = value;
        break;
      case "--runs":
        runs = value;
        break;
      case "--case":
        caseIndex = value;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  const config = caseIndex === undefined ? { seed, runs } : { seed, runs, caseIndex };
  validateConfig(config);
  return Object.freeze(config);
}

export function runPropertyCampaign(
  config: PropertyCampaignConfig,
  definitions: readonly PropertyDefinition[] = PROPERTIES,
): PropertyCampaignResult {
  validateConfig(config);
  const count = config.caseIndex === undefined ? config.runs : 1;
  let firstCase: PropertyCaseResult | undefined;
  let lastCase: PropertyCaseResult | undefined;

  for (let offset = 0; offset < count; offset += 1) {
    const index = config.caseIndex ?? offset;
    const definition = definitions[index % definitions.length]!;
    let result = fallbackPropertyCaseResult(index, definition);

    try {
      const prepared = definition.prepare(config.seed, index);
      result = prepared.result;
      prepared.execute();
    } catch (error) {
      throw new PropertyCampaignFailure(config, result, createReplayCommand(config, index), error);
    }

    firstCase ??= result;
    lastCase = result;
  }

  if (firstCase === undefined || lastCase === undefined) {
    throw new Error("The property campaign did not select a case.");
  }
  return Object.freeze({
    seed: config.seed,
    runs: config.runs,
    executed: count,
    firstCase,
    lastCase,
  });
}

export function createReplayCommand(
  config: Pick<PropertyCampaignConfig, "seed" | "runs">,
  caseIndex: number,
): string {
  return [
    "npm run test:property --",
    `--seed ${config.seed}`,
    `--runs ${config.runs}`,
    `--case ${caseIndex}`,
  ].join(" ");
}

export function runPropertyCli(argv: readonly string[]): number {
  try {
    const config = parsePropertyCliArguments(argv);
    if (config.caseIndex === undefined) {
      const checks = runFixedPropertyChecks();
      process.stdout.write(`fixed property checks passed executed=${checks}\n`);
    }
    const result = runPropertyCampaign(config);
    process.stdout.write(
      `property campaign passed seed=${result.seed} runs=${result.runs} executed=${result.executed}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function ordinaryProperty(
  id: string,
  boundary: string,
  describe: (seed: number, index: number) => PropertyCaseContext,
  execute: (seed: number, index: number) => void,
): PropertyDefinition {
  return {
    id,
    boundary,
    prepare: (seed, index) => ({
      result: createPropertyCaseResult(seed, index, id, boundary, describe(seed, index)),
      execute: () => execute(seed, index),
    }),
  };
}

function sourceProperty<T extends ValidSourceCase | NearValidSourceCase>(
  id: string,
  boundary: string,
  createScenario: (seed: number, index: number) => T,
  executeScenario: (scenario: T, seed: number, index: number) => void,
): PropertyDefinition {
  return {
    id,
    boundary,
    prepare: (seed, index) => {
      const scenario = createScenario(seed, index);
      return {
        result: createPropertyCaseResult(seed, index, id, boundary, describeSourceCase(scenario)),
        execute: () => executeScenario(scenario, seed, index),
      };
    },
  };
}

function createPropertyCaseResult(
  seed: number,
  index: number,
  id: string,
  boundary: string,
  context: PropertyCaseContext,
): PropertyCaseResult {
  return Object.freeze({
    index,
    id,
    boundary,
    context: formatCaseContext(seed, index, context),
    ...(context.source === undefined ? {} : { source: context.source }),
  });
}

function fallbackPropertyCaseResult(
  index: number,
  definition: PropertyDefinition,
): PropertyCaseResult {
  return Object.freeze({
    index,
    id: definition.id,
    boundary: definition.boundary,
    context: "preparation-failure context=unavailable",
  });
}

function assertOperationClosure(variant: (typeof OPERATION_VARIANTS)[number]): void {
  const plan = compilePlan('showButton "Go"\nwait 1 ms\nexit');
  const snapshot = createFreshRuntimeSnapshot(plan);
  const result = runOperationVariant(plan, snapshot, variant);
  assertValidSnapshot(plan, result.snapshot);
}

function runOperationVariant(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  variant: (typeof OPERATION_VARIANTS)[number],
): RuntimeOperationResult {
  switch (variant) {
    case "run":
      return assertButtonRequested(withUnchangedInput(snapshot, () => run(plan, snapshot)));
    case "executeInstruction": {
      const result = withUnchangedInput(snapshot, () => executeInstruction(plan, snapshot));
      assert.equal(result.instructionsExecuted, 1);
      return assertButtonRequested(result);
    }
    case "observeTime": {
      const waiting = assertButtonRequested(run(plan, snapshot)).snapshot;
      const result = withUnchangedInput(waiting, () => observeTime(plan, waiting, 1));
      // Nothing is due while the button waits, so scene time reaches the observed time.
      assert.deepEqual(result.outcome, { kind: "observed", currentSessionTimeMs: 1 });
      assert.equal(result.snapshot.observedSessionTimeMs, 1);
      assert.equal(result.snapshot.currentSessionTimeMs, 1);
      assert.deepEqual(result.snapshot.foregroundAction, waiting.foregroundAction);
      assert.deepEqual(result.events, []);
      return result;
    }
    case "completeAction": {
      const waiting = assertButtonRequested(run(plan, snapshot)).snapshot;
      const request = buttonCompletion(waiting);
      const result = withUnchangedInput(waiting, () => completeAction(plan, waiting, request));
      assertButtonCompleted(result, waiting);
      return result;
    }
  }
}

function withUnchangedInput<T>(snapshot: RuntimeSnapshot, operation: () => T): T {
  const before = structuredClone(snapshot);
  const result = operation();
  assert.deepEqual(snapshot, before);
  return result;
}

/** The fixture's first instruction requests its button and then waits for it. */
function assertButtonRequested<T extends RuntimeOperationResult>(result: T): T {
  const action = result.snapshot.foregroundAction;
  assert.equal(result.snapshot.status, "waiting");
  assert.ok(action?.kind === "interaction" && action.interactionKind === "button");
  assert.deepEqual(
    result.events.map((event) => (event.kind === "actionRequested" ? event.action : event.kind)),
    [action],
  );
  return result;
}

/** A valid activation settles exactly the waiting button and releases execution to its continuation. */
function assertButtonCompleted(
  result: PendingActionOperationResult<ActionCompletionOutcome>,
  waiting: RuntimeSnapshot,
): void {
  const action = waiting.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.interactionKind === "button");
  assert.equal(result.outcome.kind, "completed");
  const { settlement } = result.outcome;
  assert.equal(settlement.actionId, action.actionId);
  assert.equal(settlement.actionKind, "interaction");
  assert.equal(settlement.interactionKind, "button");
  assert.equal(settlement.settlementKind, "completed");
  assert.equal(settlement.owningInstruction, action.owningInstruction);
  assert.equal(settlement.continuationInstruction, action.continuationInstruction);
  assert.equal(settlement.requestEventSequence, action.requestEventSequence);
  assert.deepEqual(result.snapshot.lastSettlement, settlement);
  assert.equal(result.snapshot.foregroundAction, null);
  assert.equal(result.snapshot.status, "running");
  assert.equal(result.snapshot.nextInstruction, action.continuationInstruction);
  const completed = result.events.at(-1);
  assert.ok(completed?.kind === "actionCompleted");
  assert.equal(completed.sequence, settlement.completionEventSequence);
  assert.deepEqual(completed.settlement, settlement);
}

function assertRejectedCompletionIsAtomic(variant: (typeof REJECTION_VARIANTS)[number]): void {
  // Time reaches a wait only through observation; a button can be completed only once.
  const plan = compilePlan(
    variant === "time-completion" ? "wait 10 ms\nexit" : 'showButton "Go"\nexit',
  );
  const waiting = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  const waitingBefore = structuredClone(waiting);
  const request =
    variant === "time-completion"
      ? {
          actionId: waiting.foregroundAction!.actionId,
          actionKind: "delay",
          payload: { kind: "time", currentSessionTimeMs: 10 },
        }
      : buttonCompletion(waiting);
  const settled =
    variant === "duplicate-settlement" ? completeAction(plan, waiting, request) : undefined;
  if (settled !== undefined) {
    assertButtonCompleted(settled, waiting);
    assertValidSnapshot(plan, settled.snapshot);
  }
  const input = settled?.snapshot ?? waiting;
  const inputBefore = structuredClone(input);
  const result = completeAction(plan, input, request);

  if (settled === undefined) {
    assert.equal(result.outcome.kind, "invalidPayload");
  } else {
    // The duplicate reports the settlement its first completion recorded.
    assert.deepEqual(result.outcome, { ...settled.outcome, kind: "alreadySettled" });
  }
  assert.deepEqual(result.snapshot, inputBefore);
  assert.deepEqual(result.events, []);
  assert.deepEqual(waiting, waitingBefore);
}

function assertCheckpointRoundTripAndResume(): void {
  const plan = compilePlan('wait 1 ms\nsay "done"\nexit');
  const waiting = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  const checkpoint = createCheckpoint(plan, waiting);
  const restored = deserializeCheckpoint(serializeCheckpoint(checkpoint));

  assert.doesNotThrow(() => restoreCheckpoint(restored));
  assert.deepEqual(restored.plan, plan);
  assert.deepEqual(restored.snapshot, waiting);

  const uninterruptedFirst = observeTime(plan, waiting, 1);
  const resumedFirst = observeTime(restored.plan, restored.snapshot, 1);
  assert.deepEqual(resumedFirst, uninterruptedFirst);
  assert.deepEqual(
    run(restored.plan, resumedFirst.snapshot),
    run(plan, uninterruptedFirst.snapshot),
  );
}

function assertSameSeedIsDeterministic(seed: number, index: number): void {
  const plan = compilePlan('let value = randomInteger(1..=100)\nsay "\${value}"\nexit');
  const runtimeSeed = caseSeed(seed, index);
  const first = run(plan, createImmediatePacingRuntimeSnapshot(plan, { seed: runtimeSeed }));
  const second = run(plan, createImmediatePacingRuntimeSnapshot(plan, { seed: runtimeSeed }));

  assert.deepEqual(second, first);
  assertValidSnapshot(plan, first.snapshot);
}

function describeSameSeed(): PropertyCaseContext {
  return { description: "randomInteger same-source same-seed source=repository-authored" };
}

function assertMalformedBoundaryRejection(variant: (typeof MALFORMED_VARIANTS)[number]): void {
  const plan = compilePlan("exit");
  const snapshot = createFreshRuntimeSnapshot(plan);

  switch (variant) {
    case "plan":
      assert.equal(validateInstructionPlan({ ...plan, version: plan.version + 1 }).valid, false);
      break;
    case "snapshot":
      assert.equal(validateRuntimeSnapshot({ ...snapshot, status: "invalid" }, plan).valid, false);
      break;
    case "checkpoint":
      assert.throws(() => restoreCheckpoint({}), CheckpointError);
      break;
  }
}

function assertValidSourcePipeline(
  scenario: ValidSourceCase,
  seed: number,
  index: number,
  compile: typeof compileSource,
): void {
  assert.ok(scenario.source.length <= MAX_SOURCE_FUZZ_LENGTH, scenario.variant);

  const runtimeSeed = caseSeed(seed, index);
  const firstPlan = compilePlan(scenario.source, compile);
  const first = runSourceToHalt(firstPlan, runtimeSeed);
  const secondPlan = compilePlan(scenario.source, compile);
  const second = runSourceToHalt(secondPlan, runtimeSeed);

  assert.equal(first.snapshot.status, "halted", scenario.variant);
  assertValidSnapshot(firstPlan, first.snapshot);
  assertValidSnapshot(secondPlan, second.snapshot);
  assert.deepEqual(second, first, scenario.variant);
}

function runSourceToHalt(plan: InstructionPlan, seed: number) {
  return run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { seed }),
    {},
    { instructionBudget: SOURCE_FUZZ_INSTRUCTION_BUDGET },
  );
}

function assertNearValidSourceDiagnostics(
  scenario: NearValidSourceCase,
  compile: typeof compileSource,
): void {
  assert.ok(scenario.source.length <= MAX_SOURCE_FUZZ_LENGTH, scenario.variant);

  const first = compile(scenario.source);
  const second = compile(scenario.source);
  assert.equal(first.plan, null, scenario.variant);
  assert.equal(second.plan, null, scenario.variant);
  assert.ok(first.diagnostics.length > 0, scenario.variant);
  assert.deepEqual(diagnosticShape(second), diagnosticShape(first), scenario.variant);
  assert.deepEqual(
    first.diagnostics.map((diagnostic) => diagnostic.code),
    scenario.diagnosticCodes,
  );

  for (const diagnostic of first.diagnostics) {
    assert.ok(diagnostic.span.start.offset <= diagnostic.span.end.offset);
    assert.ok(diagnostic.span.start.offset >= 0);
    assert.ok(diagnostic.span.end.offset <= scenario.source.length);
  }
}

function describeSourceCase(scenario: ValidSourceCase | NearValidSourceCase): PropertyCaseContext {
  const diagnostic =
    "diagnosticCodes" in scenario ? ` diagnostic=${scenario.diagnosticCodes.join(",")}` : "";
  return {
    description: [
      `classification=${scenario.classification}`,
      `family=${scenario.family}`,
      `variant=${scenario.variant}${diagnostic}`,
    ].join(" "),
    source: scenario.source,
  };
}

function diagnosticShape(result: ReturnType<typeof compileSource>) {
  return result.diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.span.start.offset,
    diagnostic.span.end.offset,
  ]);
}

function compilePlan(
  source: string,
  compile: typeof compileSource = compileSource,
): InstructionPlan {
  const compiled = compile(source);
  assert.deepEqual(compiled.diagnostics, [], source);
  if (compiled.plan === null) {
    throw new Error(`Expected a compiled plan for source:\n${source}`);
  }
  assert.equal(validateInstructionPlan(compiled.plan).valid, true);
  return compiled.plan;
}

function buttonCompletion(snapshot: RuntimeSnapshot): {
  readonly actionId: number;
  readonly actionKind: "interaction";
  readonly interactionKind: "button";
  readonly payload: { readonly kind: "activate" };
} {
  const actionId = snapshot.foregroundAction?.actionId;
  assert.ok(actionId !== undefined);
  return {
    actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  };
}

function assertValidSnapshot(plan: InstructionPlan, snapshot: RuntimeSnapshot): void {
  const validation = validateRuntimeSnapshot(snapshot, plan);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
}

function validateConfig(config: PropertyCampaignConfig): void {
  if (!Number.isSafeInteger(config.seed) || config.seed < 1 || config.seed > 0xffff_ffff) {
    throw new Error("--seed must be an integer from 1 through 4294967295.");
  }
  if (!Number.isSafeInteger(config.runs) || config.runs < 1 || config.runs > MAX_PROPERTY_RUNS) {
    throw new Error(`--runs must be an integer from 1 through ${MAX_PROPERTY_RUNS}.`);
  }
  if (
    config.caseIndex !== undefined &&
    (!Number.isSafeInteger(config.caseIndex) ||
      config.caseIndex < 0 ||
      config.caseIndex >= config.runs)
  ) {
    throw new Error(`--case must be an integer from 0 through ${config.runs - 1}.`);
  }
}

function parseDecimal(option: string, raw: string, allowZero: boolean): number {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${option} must be a base-10 integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (!allowZero && value === 0)) {
    throw new Error(`${option} is outside the supported range.`);
  }
  return value;
}

function caseSeed(seed: number, index: number): number {
  const mixed = (seed ^ Math.imul(index + 1, 0x9e37_79b1)) >>> 0;
  return mixed === 0 ? 1 : mixed;
}

function formatCaseContext(seed: number, index: number, context: PropertyCaseContext): string {
  return `variantSeed=${caseSeed(seed, index)} ${context.description}`;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = runPropertyCli(process.argv.slice(2));
}
