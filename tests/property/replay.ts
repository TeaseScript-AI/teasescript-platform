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
  type InstructionPlan,
  type RuntimeSnapshot,
} from "../../src/index.js";

export const PROPERTY_DEFAULT_SEED = 1_364_229_357;
export const PROPERTY_DEFAULT_RUNS = 128;
export const MAX_PROPERTY_RUNS = 100_000;
export const SOURCE_FUZZ_INSTRUCTION_BUDGET = 200;

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

interface PropertyDefinition {
  readonly id: string;
  readonly boundary: string;
  readonly describe: (seed: number, index: number) => PropertyCaseContext;
  readonly execute: (seed: number, index: number) => void;
}

interface PropertyCaseContext {
  readonly description: string;
  readonly source?: string;
}

interface NearValidSourceCase extends PropertyCaseContext {
  readonly source: string;
  readonly diagnosticCodes: readonly string[];
}

const PROPERTIES: readonly PropertyDefinition[] = Object.freeze([
  { id: "operation-closure", boundary: "public runtime operation", describe: describeOperationClosure, execute: assertOperationClosure },
  { id: "rejected-completion-is-atomic", boundary: "completeAction", describe: describeRejectedCompletion, execute: assertRejectedCompletionIsAtomic },
  { id: "checkpoint-roundtrip-and-resume", boundary: "checkpoint/restore", describe: describeCheckpointRoundTrip, execute: assertCheckpointRoundTripAndResume },
  { id: "same-seed-is-deterministic", boundary: "compile/run", describe: describeSameSeed, execute: assertSameSeedIsDeterministic },
  { id: "malformed-boundary-rejection", boundary: "external/persistence validation", describe: describeMalformedBoundary, execute: assertMalformedBoundaryRejection },
  { id: "valid-source-pipeline", boundary: "package-root compile/run", describe: validSourceCase, execute: assertValidSourcePipeline },
  { id: "near-valid-source-diagnostics", boundary: "package-root compile", describe: nearValidSourceCase, execute: assertNearValidSourceDiagnostics },
]);

export class PropertyCampaignFailure extends Error {
  public constructor(
    readonly config: PropertyCampaignConfig,
    readonly result: PropertyCaseResult,
    readonly replayCommand: string,
    cause: unknown,
  ) {
    const causeText = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    super([
      "Property campaign failed.",
      `seed=${config.seed}`,
      `runs=${config.runs}`,
      `case=${result.index}`,
      `property=${result.id}`,
      `boundary=${result.boundary}`,
      `context=${result.context}`,
      ...(result.source === undefined ? [] : ["source-begin", result.source, "source-end"]),
      `replay=${replayCommand}`,
      `cause=${causeText}`,
    ].join("\n"), { cause });
    this.name = "PropertyCampaignFailure";
  }
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
    if (seen.has(option)) throw new Error(`Duplicate option: ${option}`);
    seen.add(option);
    const raw = argv[index + 1];
    if (raw === undefined || raw.startsWith("--")) throw new Error(`Missing value for ${option}.`);
    index += 1;
    const value = parseDecimal(option, raw, option === "--case");
    if (option === "--seed") seed = value;
    else if (option === "--runs") runs = value;
    else if (option === "--case") caseIndex = value;
    else throw new Error(`Unknown option: ${option}`);
  }
  validateConfig({ seed, runs, ...(caseIndex === undefined ? {} : { caseIndex }) });
  return Object.freeze({ seed, runs, ...(caseIndex === undefined ? {} : { caseIndex }) });
}

export function runPropertyCampaign(config: PropertyCampaignConfig): PropertyCampaignResult {
  validateConfig(config);
  const count = config.caseIndex === undefined ? config.runs : 1;
  let firstCase: PropertyCaseResult | undefined;
  let lastCase: PropertyCaseResult | undefined;
  for (let offset = 0; offset < count; offset += 1) {
    const index = config.caseIndex ?? offset;
    const definition = PROPERTIES[index % PROPERTIES.length]!;
    const context = definition.describe(config.seed, index);
    const result = Object.freeze({
      index,
      id: definition.id,
      boundary: definition.boundary,
      context: formatCaseContext(config.seed, index, context),
      ...(context.source === undefined ? {} : { source: context.source }),
    });
    try {
      definition.execute(config.seed, index);
    } catch (error) {
      throw new PropertyCampaignFailure(config, result, createReplayCommand(config, index), error);
    }
    firstCase ??= result;
    lastCase = result;
  }
  return Object.freeze({ seed: config.seed, runs: config.runs, executed: count, firstCase: firstCase!, lastCase: lastCase! });
}

export function createReplayCommand(config: Pick<PropertyCampaignConfig, "seed" | "runs">, caseIndex: number): string {
  return `npm run test:property -- --seed ${config.seed} --runs ${config.runs} --case ${caseIndex}`;
}

export function runPropertyCli(argv: readonly string[]): number {
  try {
    const result = runPropertyCampaign(parsePropertyCliArguments(argv));
    process.stdout.write(`property campaign passed seed=${result.seed} runs=${result.runs} executed=${result.executed}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function assertOperationClosure(seed: number, index: number): void {
  const source = "wait 1 ms\nexit";
  const plan = compilePlan(source);
  const snapshot = createFreshRuntimeSnapshot(plan, { seed: caseSeed(seed, index) });
  const operation = index % 4;
  const result = operation === 0 ? run(plan, snapshot)
    : operation === 1 ? executeInstruction(plan, snapshot)
    : (() => {
      const waiting = run(plan, snapshot).snapshot;
      return operation === 2
        ? observeTime(plan, waiting, 1)
        : completeAction(plan, waiting, delayCompletion(waiting, 1));
    })();
  assertValidSnapshot(plan, result.snapshot);
}

function describeOperationClosure(_seed: number, index: number): PropertyCaseContext {
  return { description: `operation=${["run", "executeInstruction", "observeTime", "completeAction"][index % 4]} source=repository-authored` };
}

function assertRejectedCompletionIsAtomic(seed: number, index: number): void {
  const plan = compilePlan("wait 10 ms\nexit");
  const waiting = run(plan, createFreshRuntimeSnapshot(plan, { seed: caseSeed(seed, index) })).snapshot;
  const before = structuredClone(waiting);
  const request = delayCompletion(waiting, index % 2 === 0 ? 9 : 10);
  const input = index % 2 === 0 ? waiting : completeAction(plan, waiting, request).snapshot;
  const inputBefore = structuredClone(input);
  const result = completeAction(plan, input, request);
  assert.ok(["notDue", "alreadySettled"].includes(result.outcome.kind));
  assert.deepEqual(result.snapshot, inputBefore);
  assert.deepEqual(result.events, []);
  assert.deepEqual(waiting, before);
}

function describeRejectedCompletion(_seed: number, index: number): PropertyCaseContext {
  return { description: `rejected-completion=${index % 2 === 0 ? "not-due" : "duplicate-settlement"} source=repository-authored` };
}

function assertCheckpointRoundTripAndResume(seed: number, index: number): void {
  const plan = compilePlan('wait 1 ms\nsay "done"\nexit');
  const waiting = run(plan, createFreshRuntimeSnapshot(plan, { seed: caseSeed(seed, index) })).snapshot;
  const checkpoint = createCheckpoint(plan, waiting);
  const restored = deserializeCheckpoint(serializeCheckpoint(checkpoint));
  assert.doesNotThrow(() => restoreCheckpoint(restored));
  assert.deepEqual(restored.plan, plan);
  assert.deepEqual(restored.snapshot, waiting);
  const uninterruptedFirst = observeTime(plan, waiting, 1);
  const resumedFirst = observeTime(restored.plan, restored.snapshot, 1);
  assert.deepEqual(resumedFirst, uninterruptedFirst);
  assert.deepEqual(run(restored.plan, resumedFirst.snapshot), run(plan, uninterruptedFirst.snapshot));
}

function describeCheckpointRoundTrip(): PropertyCaseContext {
  return { description: "wait-checkpoint-json-restore-resume source=repository-authored" };
}

function assertSameSeedIsDeterministic(seed: number, index: number): void {
  const plan = compilePlan("let value = randomInteger(1, 100)\nsay `\${value}`\nexit");
  const runSeed = caseSeed(seed, index);
  const first = run(plan, createFreshRuntimeSnapshot(plan, { seed: runSeed }));
  const second = run(plan, createFreshRuntimeSnapshot(plan, { seed: runSeed }));
  assert.deepEqual(second, first);
  assertValidSnapshot(plan, first.snapshot);
}

function describeSameSeed(): PropertyCaseContext {
  return { description: "randomInteger same-source same-seed source=repository-authored" };
}

function assertMalformedBoundaryRejection(seed: number, index: number): void {
  const plan = compilePlan("exit");
  const snapshot = createFreshRuntimeSnapshot(plan, { seed: caseSeed(seed, index) });
  const variant = (seed + index) % 3;
  if (variant === 0) {
    assert.equal(validateInstructionPlan({ ...plan, version: plan.version + 1 }).valid, false);
  } else if (variant === 1) {
    assert.equal(validateRuntimeSnapshot({ ...snapshot, status: "invalid" }, plan).valid, false);
  } else {
    assert.throws(() => restoreCheckpoint({}), CheckpointError);
  }
}

function describeMalformedBoundary(seed: number, index: number): PropertyCaseContext {
  return { description: `malformed=${["plan", "snapshot", "checkpoint"][(seed + index) % 3]} fixture=deliberately-mutated-external-data` };
}

function assertValidSourcePipeline(seed: number, index: number): void {
  const scenario = validSourceCase(seed, index);
  assert.ok(scenario.source!.length <= 512, scenario.description);
  const plan = compilePlan(scenario.source!);
  const runtimeSeed = caseSeed(seed, index);
  const first = run(plan, createFreshRuntimeSnapshot(plan, { seed: runtimeSeed }), {}, {
    instructionBudget: SOURCE_FUZZ_INSTRUCTION_BUDGET,
  });
  const second = run(plan, createFreshRuntimeSnapshot(plan, { seed: runtimeSeed }), {}, {
    instructionBudget: SOURCE_FUZZ_INSTRUCTION_BUDGET,
  });
  assert.equal(first.snapshot.status, "halted", scenario.description);
  assertValidSnapshot(plan, first.snapshot);
  assert.deepEqual(second, first, scenario.description);
}

function assertNearValidSourceDiagnostics(seed: number, index: number): void {
  const scenario = nearValidSourceCase(seed, index);
  assert.ok(scenario.source.length <= 512, scenario.description);
  const first = compileSource(scenario.source);
  const second = compileSource(scenario.source);
  assert.equal(first.plan, null, scenario.description);
  assert.ok(first.diagnostics.length > 0, scenario.description);
  assert.deepEqual(
    diagnosticShape(second),
    diagnosticShape(first),
    scenario.description,
  );
  assert.deepEqual(first.diagnostics.map((diagnostic) => diagnostic.code), scenario.diagnosticCodes);
  assert.ok(first.diagnostics.every((diagnostic) => diagnostic.span.start.offset <= diagnostic.span.end.offset));
}

function validSourceCase(seed: number, index: number): PropertyCaseContext {
  const value = (caseSeed(seed, index) % 3) + 1;
  const family = (seed + index) % 6;
  const cases = [
    {
      description: "classification=valid family=literals-expressions-ranges-templates",
      source: [
        `let start = ${value}`,
        "let total = -start + 2 * 3",
        "for item in start..=start + 2 { total = total + item }",
        "say `total:${total}`",
      ].join("\n"),
    },
    {
      description: "classification=valid family=variables-scope-and-collections",
      source: [
        "let source = [1, 2]",
        "let copy = source",
        "copy[0] = 9",
        "let record = { label: \"kept\", values: set[\"a\", \"b\", \"a\"] }",
        "for item in record.values { say `${record.label}:${item}` }",
        "say source[0]",
      ].join("\n"),
    },
    {
      description: "classification=valid family=conditions-and-loop-control",
      source: [
        "let total = 0",
        "repeat 3 { total = total + 1 }",
        "for value in 1..=4 { if value == 2 { continue }\nif value == 4 { break }\ntotal = total + value }",
        "while total < 8 { total = total + 1 }",
        "if total == 8 { say \"done\" } else { say \"wrong\" }",
      ].join("\n"),
    },
    {
      description: "classification=valid family=functions-defaults-calls-and-recursion",
      source: [
        "function count(value, step = 1) { if value <= 0 { return 0 }\nreturn step + count(value - 1, step) }",
        "function describeValue(value, prefix = \"n\") { return `${prefix}:${value}` }",
        "say describeValue(value: count(3), prefix: \"count\")",
      ].join("\n"),
    },
    {
      description: "classification=valid family=speakers-default-output-and-say-as",
      source: [
        "speaker vera { displayName: \"Vera\" }",
        "speaker vera",
        "say \"default\"",
        "say as vera \"override\"",
      ].join("\n"),
    },
    {
      description: "classification=valid family=deterministic-random-builtins",
      source: [
        "let roll = randomInteger(1..=6)",
        "let lucky = chance(50)",
        "say `${roll}:${lucky}:${random()}`",
      ].join("\n"),
    },
  ] as const;
  return cases[family]!;
}

function nearValidSourceCase(seed: number, index: number): NearValidSourceCase {
  const cases: readonly NearValidSourceCase[] = [
    { description: "classification=near-valid family=missing-declaration-identifier mutation=missing-identifier diagnostic=TSP013", source: "let = 1", diagnosticCodes: ["TSP013"] },
    { description: "classification=near-valid family=template-interpolation mutation=missing-expression diagnostic=TSP008", source: "say `Hello ${}`", diagnosticCodes: ["TSP008"] },
    { description: "classification=near-valid family=loop-control mutation=break-outside-loop diagnostic=TSV008", source: "break", diagnosticCodes: ["TSV008"] },
    { description: "classification=near-valid family=semantic-name mutation=unknown-name diagnostic=TSV002", source: "say unknownName", diagnosticCodes: ["TSV002"] },
    { description: "classification=near-valid family=function-arguments mutation=duplicate-parameter diagnostic=TSV014", source: "function sample(value, value) { return value }", diagnosticCodes: ["TSV014"] },
    { description: "classification=near-valid family=set-elements mutation=composite-set-element diagnostic=TSV006", source: "let values = set[[1]]", diagnosticCodes: ["TSV006"] },
  ];
  return cases[(seed + index) % cases.length]!;
}

function diagnosticShape(result: ReturnType<typeof compileSource>): readonly [string, number, number][] {
  return result.diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.span.start.offset,
    diagnostic.span.end.offset,
  ]);
}

function compilePlan(source: string): InstructionPlan {
  const compiled = compileSource(source);
  assert.deepEqual(compiled.diagnostics, [], source);
  assert.notEqual(compiled.plan, null, source);
  assert.equal(validateInstructionPlan(compiled.plan!).valid, true);
  return compiled.plan!;
}

function delayCompletion(snapshot: RuntimeSnapshot, currentSessionTimeMs: number): object {
  const actionId = snapshot.foregroundAction?.actionId;
  assert.notEqual(actionId, undefined);
  return { actionId, actionKind: "delay", payload: { kind: "time", currentSessionTimeMs } };
}

function assertValidSnapshot(plan: InstructionPlan, snapshot: RuntimeSnapshot): void {
  assert.equal(validateRuntimeSnapshot(snapshot, plan).valid, true);
}

function validateConfig(config: PropertyCampaignConfig): void {
  if (!Number.isSafeInteger(config.seed) || config.seed < 1 || config.seed > 0xffff_ffff) throw new Error("--seed must be an integer from 1 through 4294967295.");
  if (!Number.isSafeInteger(config.runs) || config.runs < 1 || config.runs > MAX_PROPERTY_RUNS) throw new Error(`--runs must be an integer from 1 through ${MAX_PROPERTY_RUNS}.`);
  if (config.caseIndex !== undefined && (!Number.isSafeInteger(config.caseIndex) || config.caseIndex < 0 || config.caseIndex >= config.runs)) throw new Error(`--case must be an integer from 0 through ${config.runs - 1}.`);
}

function parseDecimal(option: string, raw: string, allowZero: boolean): number {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${option} must be a base-10 integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (!allowZero && value === 0)) throw new Error(`${option} is outside the supported range.`);
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
