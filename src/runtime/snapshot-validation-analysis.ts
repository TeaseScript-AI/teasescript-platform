import { expressionPlanChildren } from "../plan/expression-children.js";
import type {
  CompiledFunctionDefinition,
  ExpressionPlan,
  InstructionPlan,
  PlanTransferDestination,
} from "../plan/model.js";
import { isValidatedImmutableInstructionPlan } from "../plan/validated-immutable.js";
import { recordValidationTestWork } from "../validation-testing.js";

/** A loop of the plan, at its `loopStart`: where it starts and continues, and the instruction after it. */
export interface PlannedLoop {
  readonly kind: "repeat" | "for" | "while";
  readonly variable?: string;
  /** A pair loop's value variable. */
  readonly valueVariable?: string;
  readonly start: number;
  readonly continueStart: number;
  readonly target: number;
}

export interface PreparedSayTemporaryOwnership {
  readonly outputSpeakerIds: ReadonlySet<number>;
  readonly nullableOutputSpeakerIds: ReadonlySet<number>;
  readonly explicitOutputSpeakerIdentifiers: ReadonlyMap<number, string>;
  readonly textIds: ReadonlySet<number>;
  readonly contextualSpeakerIds: ReadonlySet<number>;
  readonly nullableContextualSpeakerIds: ReadonlySet<number>;
  readonly contextualSpeakerSources: ReadonlyMap<number, number>;
}

/** What snapshot validation derives from an instruction plan alone; every snapshot is still validated against it. */
export interface SnapshotValidationAnalysis {
  readonly plan: InstructionPlan;
  readonly functionsById: ReadonlyMap<number, CompiledFunctionDefinition>;
  readonly regionEnds: readonly number[];
  readonly functionIdsByInstruction: readonly (number | null)[];
  /** The temporaries that continuations of accepted snapshots need, by where they resume and the loops they run in. */
  readonly continuationRequirements: Map<string, ReadonlySet<number>>;
  readonly defaultBindingPositions: ReadonlyMap<string, number>;
  readonly parameterNames: ReadonlyMap<number, ReadonlySet<string>>;
  /**
   * The temporaries that `prepareReference` instructions produce, each with whether an attached reference stored there
   * keeps a copy of its root ({@link collectPreparedReferenceTemporaries}).
   */
  readonly preparedReferenceTemporaries: ReadonlyMap<number, boolean>;
  readonly preparedSayTemporaryOwnership: PreparedSayTemporaryOwnership;
  readonly loops: ReadonlyMap<number, PlannedLoop>;
  /** The destinations that `fallback` statements of the plan name directly. */
  readonly fallbackDestinations: readonly PlanTransferDestination[];
  /** Whether a `fallback` statement of the plan computes its destination. */
  readonly computedFallback: boolean;
  /** Where an activation of each file may start: its entry and its labels. */
  readonly fileEntries: readonly ReadonlySet<number>[];
  /** The variables each timer, media, or button block shares, as the instruction that creates its resource names them. */
  readonly handlerCaptures: ReadonlyMap<number, readonly string[]>;
}

/**
 * The analyses of validated immutable plans. Such a plan cannot change, so its analysis is built on its first
 * validation and kept while the plan lives. Membership in the validated-plan registry decides; any other plan,
 * including one whose root alone is frozen, is analysed afresh each time.
 */
const keptAnalyses = new WeakMap<InstructionPlan, SnapshotValidationAnalysis>();

export function snapshotValidationAnalysis(plan: InstructionPlan): SnapshotValidationAnalysis {
  if (!isValidatedImmutableInstructionPlan(plan)) return createSnapshotValidationAnalysis(plan);
  let analysis = keptAnalyses.get(plan);
  if (analysis === undefined) {
    analysis = createSnapshotValidationAnalysis(plan);
    keptAnalyses.set(plan, analysis);
  }
  return analysis;
}

/** The function whose region holds an instruction index, if any. */
export function functionHoldingInstruction(
  plan: InstructionPlan,
  instruction: number,
): CompiledFunctionDefinition | undefined {
  if (!isValidatedImmutableInstructionPlan(plan)) {
    return plan.functions.find(
      (definition) =>
        definition !== undefined &&
        instruction >= definition.entryInstruction &&
        instruction < definition.endInstruction,
    );
  }
  // Validation keeps function regions disjoint, so the region table names the one function that holds it.
  const analysis = snapshotValidationAnalysis(plan);
  const functionId = analysis.functionIdsByInstruction[instruction];
  return functionId == null ? undefined : analysis.functionsById.get(functionId);
}

function createSnapshotValidationAnalysis(plan: InstructionPlan): SnapshotValidationAnalysis {
  recordValidationTestWork("snapshotValidationAnalyses");
  const functionsById = new Map<number, InstructionPlan["functions"][number]>();
  const regionEnds = new Array<number>(plan.instructions.length).fill(plan.instructions.length);
  for (const file of plan.files) {
    regionEnds.fill(file.rootEndInstruction, file.startInstruction, file.rootEndInstruction);
  }
  const functionIdsByInstruction = new Array<number | null>(plan.instructions.length).fill(null);
  for (const definition of plan.functions) {
    if (definition === undefined) continue;
    functionsById.set(definition.id, definition);
    for (let index = definition.entryInstruction; index < definition.endInstruction; index += 1) {
      regionEnds[index] = definition.endInstruction;
      functionIdsByInstruction[index] = definition.id;
    }
  }
  const defaultBindingPositions = new Map<string, number>();
  const loops = new Map<number, PlannedLoop>();
  const fallbackDestinations: PlanTransferDestination[] = [];
  let computedFallback = false;
  const handlerCaptures = new Map<number, readonly string[]>();
  for (let index = 0; index < plan.instructions.length; index += 1) {
    const instruction = plan.instructions[index];
    if (instruction?.kind === "startTimer" || instruction?.kind === "showPermanentButton") {
      if (instruction.handlerFunctionId !== null)
        handlerCaptures.set(instruction.handlerFunctionId, instruction.captures);
    } else if (instruction?.kind === "playMedia") {
      for (const cue of instruction.cues) handlerCaptures.set(cue.functionId, instruction.captures);
      if (instruction.finishFunctionId !== null)
        handlerCaptures.set(instruction.finishFunctionId, instruction.captures);
    }
    if (instruction?.kind === "bindDefaultParameter") {
      defaultBindingPositions.set(`${instruction.functionId}:${instruction.parameterIndex}`, index);
    } else if (instruction?.kind === "loopStart") {
      loops.set(instruction.loopId, {
        kind: instruction.loopKind,
        ...(instruction.loopKind === "for"
          ? {
              variable: instruction.variable,
              ...(instruction.valueVariable === undefined
                ? {}
                : { valueVariable: instruction.valueVariable }),
            }
          : {}),
        start: index,
        continueStart: instruction.continueTarget,
        target: instruction.target,
      });
    } else if (instruction?.kind === "setFallback" && instruction.destination !== null) {
      // A computed destination holds an expression, never a stored fallback.
      if ("value" in instruction.destination) computedFallback = true;
      else fallbackDestinations.push(instruction.destination);
    }
  }
  // A media block's self-handle is bound on entry, like a parameter.
  const parameterNames = new Map(
    [...functionsById.values()].map((definition) => [
      definition.id,
      new Set([
        ...definition.parameters.map((parameter) => parameter.name),
        ...(definition.selfHandle === null ? [] : [definition.selfHandle]),
      ]),
    ]),
  );
  return {
    plan,
    functionsById,
    regionEnds,
    functionIdsByInstruction,
    continuationRequirements: new Map(),
    defaultBindingPositions,
    parameterNames,
    preparedReferenceTemporaries: collectPreparedReferenceTemporaries(plan),
    preparedSayTemporaryOwnership: collectPreparedSayTemporaryOwnership(plan),
    loops,
    fallbackDestinations,
    computedFallback,
    fileEntries: plan.files.map(
      (file) => new Set([file.entryInstruction, ...file.labels.map((label) => label.instruction)]),
    ),
    handlerCaptures,
  };
}

/**
 * An attached prepared reference resolves through its variable, and every change that could break its path first fixes
 * it to the value it reaches. Its copy of the root is read only while a preparation runs: by its own, when a call after
 * the root was read can change the value it selects, and by a later preparation that extends it and keeps a copy too.
 * Only such references keep one.
 */
function collectPreparedReferenceTemporaries(plan: InstructionPlan): ReadonlyMap<number, boolean> {
  const temporaries = new Map<number, boolean>();
  // A producer precedes every use, so the preparations that extend a reference come before it here.
  for (let index = plan.instructions.length - 1; index >= 0; index -= 1) {
    const instruction = plan.instructions[index];
    if (instruction?.kind !== "prepareReference") continue;
    const keepsRoot =
      temporaries.get(instruction.destinationTemporary) === true ||
      expressionCalls(instruction.expression);
    temporaries.set(instruction.destinationTemporary, keepsRoot);
    if (!keepsRoot) continue;
    for (const extended of preparedReferenceLeaves(instruction.expression)) {
      temporaries.set(extended, true);
    }
  }
  return temporaries;
}

function expressionCalls(root: ExpressionPlan): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const expression = pending.pop()!;
    if (expression.kind === "call") return true;
    pending.push(...expressionPlanChildren(expression));
  }
  return false;
}

function preparedReferenceLeaves(root: ExpressionPlan): number[] {
  const leaves: number[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const expression = pending.pop()!;
    if (expression.kind === "preparedReference") leaves.push(expression.temporaryId);
    else pending.push(...expressionPlanChildren(expression));
  }
  return leaves;
}

function collectPreparedSayTemporaryOwnership(
  plan: InstructionPlan,
): PreparedSayTemporaryOwnership {
  const outputSpeakerIds = new Set<number>();
  const textIds = new Set<number>();
  const contextualSpeakerIds = new Set<number>();
  const nullableContextualSpeakerIds = new Set<number>();
  const contextualSpeakerSources = new Map<number, number>();
  const explicitOutputSpeakerIdentifiers = new Map<number, string>();
  const nullableSaySpeakerSources = new Set<number>();
  for (const instruction of plan.instructions) {
    if (instruction === undefined) continue;
    if (instruction.kind === "prepareSaySpeaker") {
      outputSpeakerIds.add(instruction.destinationTemporary);
      if (instruction.speaker === null)
        nullableSaySpeakerSources.add(instruction.destinationTemporary);
      else
        explicitOutputSpeakerIdentifiers.set(instruction.destinationTemporary, instruction.speaker);
    } else if (instruction.kind === "prepareSayText") {
      textIds.add(instruction.destinationTemporary);
    } else if (instruction.kind === "prepareSayContextualSpeaker") {
      contextualSpeakerIds.add(instruction.destinationTemporary);
      contextualSpeakerSources.set(instruction.destinationTemporary, instruction.speakerTemporary);
      if (nullableSaySpeakerSources.has(instruction.speakerTemporary)) {
        nullableContextualSpeakerIds.add(instruction.destinationTemporary);
      }
    }
  }
  return {
    outputSpeakerIds,
    nullableOutputSpeakerIds: nullableSaySpeakerSources,
    explicitOutputSpeakerIdentifiers,
    textIds,
    contextualSpeakerIds,
    nullableContextualSpeakerIds,
    contextualSpeakerSources,
  };
}
