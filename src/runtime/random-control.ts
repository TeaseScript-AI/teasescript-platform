import type {
  ExpressionPlan,
  Instruction,
  InstructionPlan,
  PlanSourceLocation,
} from "../plan/model.js";
import { expressionPlanChildren } from "../plan/expression-children.js";
import { NUMERIC_FUNCTIONS } from "../numeric-functions.js";
import type { SourceSpan } from "../source.js";
import type { RuntimeDebugRandomOperation, TraceStore } from "./debug-trace.js";
import type { InterpreterEvent } from "./events.js";
import { weightedIndex } from "./list-statistics.js";
import { nextXorShift32, XORSHIFT32_ALGORITHM, type XorShift32State } from "./random.js";
import { sampleChance, sampleIndex, sampleOrder, type PrimitiveDraw } from "./random-draws.js";
import {
  cloneCapturedSerializableValue,
  validateCapturedSerializableValue,
  type SerializableRuntimeValue,
} from "./serializable-values.js";
import type { RuntimeSnapshot, RuntimeStatus } from "./state.js";

/*
 * Controlled randomness (#512, owner decision 2026-10-07; docs/RUNTIME.md#controlled-randomness). A host may choose
 * the outcome of a semantic random draw, let it be natural, or pause the engine at it. Natural sampling always runs
 * first, so the generator advances exactly as without control; only a chosen outcome replaces the result.
 *
 * A pause undoes the unit the draw belongs to, one instruction or one timer round, and keeps a small continuation in
 * the snapshot. Resuming executes that unit again from its start: earlier draws of the unit take their recorded
 * outcomes without asking the host again, builtins it called return their recorded results, and the paused draw takes
 * the resolution. The engine is deterministic, so the unit reaches the paused draw in the same state.
 */

/** The kinds of semantic random draw: the operations a debug trace names. */
export type RandomDrawKind = RuntimeDebugRandomOperation;

export const RANDOM_DRAW_KINDS: readonly RandomDrawKind[] = Object.freeze([
  "random",
  "chance",
  "randomInteger",
  "collectionRandom",
  "randomWeighted",
  "randomNormal",
  "randomBeta",
  "randomPert",
  "interpolation",
  "shuffle",
  "tagQuery",
  "glob",
  "timerRepeat",
  "duration",
]);

/** What a draw can produce. A host chooses within it; the engine refuses anything else. */
export type RandomSupport =
  /** `random()`: a finite number from 0 up to, but not including, 1. */
  | { readonly kind: "unit" }
  /** `chance(percent)`: a boolean; at 0 only `false`, at 100 only `true`. */
  | { readonly kind: "chance"; readonly percent: number }
  /** A whole number from `min` through `max`: `randomInteger`, or a timer's seconds. */
  | { readonly kind: "integer"; readonly min: number; readonly max: number }
  /** One of the candidates, by index: an element, a tagged image or script, or a glob's file path. */
  | { readonly kind: "candidates"; readonly candidates: readonly SerializableRuntimeValue[] }
  /** One of the candidates with a positive weight, by index. */
  | {
      readonly kind: "weighted";
      readonly candidates: readonly SerializableRuntimeValue[];
      readonly weights: readonly number[];
    }
  /** Any finite number; with spread 0 only the mean. */
  | { readonly kind: "normal"; readonly mean: number; readonly spread: number }
  /** A finite number from 0 through 1. */
  | { readonly kind: "beta"; readonly alpha: number; readonly beta: number }
  /** A finite number from `min` through `max`. */
  | {
      readonly kind: "pert";
      readonly min: number;
      readonly mostLikely: number;
      readonly max: number;
    }
  /** A new order of the items, as their old indexes. */
  | { readonly kind: "order"; readonly items: readonly SerializableRuntimeValue[] };

export type RandomOutcome =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "order"; readonly order: readonly number[] };

/** The natural result of a draw: an outcome, or the failure a natural result has, such as `TSR036`. */
export type RandomNatural =
  RandomOutcome | { readonly kind: "failure"; readonly code: string; readonly message: string };

/** A draw as a host sees it. */
export interface RandomDrawView {
  /**
   * The generator state before the draw. Each draw takes at least one generator step, so no two draws of one execution
   * path share it; a restored or forked session meets the same draw with the same ID.
   */
  readonly drawId: number;
  /** The site, `path:line:column` of the draw in its file, counted from 1. */
  readonly site: string;
  readonly kind: RandomDrawKind;
  readonly support: RandomSupport;
  readonly natural: RandomNatural;
}

export type RandomDecision =
  | { readonly kind: "natural" }
  | { readonly kind: "choose"; readonly outcome: RandomOutcome }
  | { readonly kind: "suspend" };

export interface RandomControlFilter {
  /** Site IDs from `listRandomSites`; absent matches every site. */
  readonly sites?: readonly string[];
  /** Absent matches every kind. */
  readonly kinds?: readonly RandomDrawKind[];
}

export interface RandomControlOptions {
  /** Which draws the host decides; every other draw is natural. Absent matches every draw. */
  readonly filter?: RandomControlFilter;
  /**
   * Decides a matched draw at once, inside the operation. Absent pauses at every matched draw. It must not call the
   * session; an exception it throws ends the operation as any thrown host error does.
   */
  readonly decide?: (draw: RandomDrawView) => RandomDecision;
}

/** An outcome the engine accepted for a draw: a host input, which replaying the same operations needs. */
export interface RandomChoiceReceipt {
  readonly drawId: number;
  readonly site: string;
  readonly kind: RandomDrawKind;
  readonly outcome: RandomOutcome;
}

/** A draw the host's decision callback answered with an outcome the draw cannot produce; the draw pauses instead. */
export interface RandomDecisionRefusal {
  readonly drawId: number;
  readonly message: string;
}

/** A place in the plan where a random draw can happen. */
export interface RandomSite {
  /** `path:line:column`, counted from 1. */
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  /**
   * Where the draw's source ends, exclusive, counted from 1; a site with several kinds ends where its first one does.
   */
  readonly endLine: number;
  readonly endColumn: number;
  /** The kinds of draw that can happen there, in `RANDOM_DRAW_KINDS` order. */
  readonly kinds: readonly RandomDrawKind[];
}

export type RandomDrawRequest = {
  readonly drawId: number;
  readonly outcome: "natural" | RandomOutcome;
};

export type RandomDrawResolutionOutcome =
  | { readonly kind: "resolved"; readonly forced: boolean }
  | { readonly kind: "noPendingDraw" }
  | { readonly kind: "staleDraw"; readonly drawId: number }
  | { readonly kind: "invalidOutcome"; readonly message: string };

/** Where an operation that found a paused draw stopped: nothing runs until the host resolves it. */
export interface RandomDrawPendingOutcome {
  readonly kind: "randomDrawPending";
  readonly drawId: number;
}

/** What the snapshot keeps about controlled randomness once a host chose an outcome or paused at a draw. */
export interface RuntimeRandomControlSnapshot {
  /** How many chosen outcomes this state's history accepted. */
  readonly forcedChoices: number;
  readonly pending: RuntimePendingRandomDrawSnapshot | null;
}

/** The operation a paused draw interrupted, which resuming finishes. */
export type RandomRootOperation = "run" | "stepToEvent" | "executeInstruction" | "dueWork";

export interface RuntimePendingRandomDrawSnapshot {
  readonly draw: RandomDrawView;
  /** The unit that resuming executes again: the next instruction, or the due work at the current scene time. */
  readonly unit: "instruction" | "dueWork";
  readonly root: RandomRootOperation;
  /** For `run` and `stepToEvent`, the operation's instruction budget and how much of it is used; otherwise `null`. */
  readonly instructionBudget: number | null;
  readonly instructionsUsed: number | null;
  /** For `stepToEvent`, whether it had emitted an event before the unit, so it stops once the unit is done. */
  readonly eventsBefore: boolean;
  /** The outcomes chosen for earlier draws of the unit. */
  readonly forced: readonly { readonly drawId: number; readonly outcome: RandomOutcome }[];
  /** What the builtins the unit called before the draw returned, in call order. */
  readonly builtinResults: readonly SerializableRuntimeValue[];
}

/** What controlled randomness throws through evaluation; no catch on the way may treat it as a script failure. */
export class RandomControlSignal extends Error {}

/** Thrown from a draw that pauses, out to the operation that started the unit. */
export class RandomSuspension extends RandomControlSignal {
  public unit: "instruction" | "dueWork" = "instruction";
  public journal: {
    readonly forced: { readonly drawId: number; readonly outcome: RandomOutcome }[];
    readonly builtinResults: SerializableRuntimeValue[];
  } = { forced: [], builtinResults: [] };

  public constructor(public readonly draw: RandomDrawView) {
    super("A random draw paused.");
    this.name = "RandomSuspension";
  }
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Sites                                                                                                            */
/* ---------------------------------------------------------------------------------------------------------------- */

const RANDOM_BUILTINS: ReadonlySet<string> = new Set([
  "random",
  "chance",
  "randomInteger",
  "randomWeighted",
  "randomNormal",
  "randomBeta",
  "randomPert",
]);

interface PlanRandomSites {
  readonly sites: readonly RandomSite[];
  readonly ids: ReadonlySet<string>;
  /** The file of each instruction. */
  readonly files: Int32Array;
}

const planSites = new WeakMap<InstructionPlan, PlanRandomSites>();

/** The places in `plan` where a random draw can happen, in file and then source order. */
export function listRandomSites(plan: InstructionPlan): readonly RandomSite[] {
  return randomSitesOf(plan).sites;
}

function randomSitesOf(plan: InstructionPlan): PlanRandomSites {
  let known = planSites.get(plan);
  if (known !== undefined) return known;
  const files = new Int32Array(plan.instructions.length);
  plan.files.forEach((file, index) =>
    files.fill(index, file.startInstruction, file.endInstruction),
  );
  const found = new Map<
    string,
    {
      file: number;
      path: string;
      line: number;
      column: number;
      endLine: number;
      endColumn: number;
      kinds: Set<string>;
    }
  >();
  const add = (file: number, span: PlanSourceLocation, kind: RandomDrawKind): void => {
    const path = plan.files[file]!.path;
    const id = siteId(path, span.sl, span.sc);
    let site = found.get(id);
    if (site === undefined) {
      site = {
        file,
        path,
        line: span.sl + 1,
        column: span.sc + 1,
        endLine: span.el + 1,
        endColumn: span.ec + 1,
        kinds: new Set(),
      };
      found.set(id, site);
    }
    site.kinds.add(kind);
  };
  const globFallback = plan.instructions.some(
    (instruction) =>
      instruction.kind === "setFallback" &&
      instruction.destination !== null &&
      "pick" in instruction.destination,
  );
  plan.instructions.forEach((instruction, index) => {
    const file =
      instruction.kind === "declareGlobal" || instruction.kind === "declareSpeaker"
        ? instruction.file
        : files[index]!;
    for (const expression of instructionExpressions(instruction)) {
      walkExpression(expression, (node) => {
        const kind = drawKindOf(node);
        if (kind !== null) add(file, node.span, kind);
        if (node.kind === "template")
          for (const part of node.parts)
            if (part.kind === "expression") add(file, part.expression.span, "interpolation");
      });
    }
    if (drawsTimerDuration(instruction)) {
      add(file, instruction.duration.span, "duration");
      // Each round of a repeating ranged timer draws where its duration stands. Restore refuses a range on a timer whose
      // duration is written as a number or duration, so other repeating timers never draw a round.
      if (instruction.kind === "startTimer" && instruction.repeat)
        add(file, instruction.duration.span, "timerRepeat");
    }
    if (instruction.kind === "transfer" && "pick" in instruction.destination)
      add(file, instruction.span, "glob");
    if (instruction.kind === "end" && globFallback) add(file, instruction.span, "glob");
  });
  const sites = [...found.entries()]
    .sort(
      ([, left], [, right]) =>
        left.file - right.file || left.line - right.line || left.column - right.column,
    )
    .map(([id, site]) =>
      Object.freeze({
        id,
        path: site.path,
        line: site.line,
        column: site.column,
        endLine: site.endLine,
        endColumn: site.endColumn,
        kinds: Object.freeze(RANDOM_DRAW_KINDS.filter((kind) => site.kinds.has(kind))),
      }),
    );
  known = { sites: Object.freeze(sites), ids: new Set(found.keys()), files };
  planSites.set(plan, known);
  return known;
}

function siteId(path: string, line: number, column: number): string {
  return `${path}:${line + 1}:${column + 1}`;
}

/** The site of a draw at `span`, made while instruction `instruction` runs or owns the timer that draws. */
function randomSiteAt(
  plan: InstructionPlan,
  instruction: number,
  span: SourceSpan | PlanSourceLocation,
): string {
  const file = randomSitesOf(plan).files[instruction]!;
  return "sl" in span
    ? siteId(plan.files[file]!.path, span.sl, span.sc)
    : siteId(plan.files[file]!.path, span.start.line, span.start.column);
}

/**
 * Whether an instruction may draw a timer's duration from a range, after evaluating all its operands: a timer, blocking
 * or not, whose duration is not a number or duration written in the source.
 */
function drawsTimerDuration(
  instruction: Instruction,
): instruction is Extract<Instruction, { kind: "startTimer" | "wait" }> {
  return (
    (instruction.kind === "startTimer" ||
      (instruction.kind === "wait" && instruction.command === "timer")) &&
    instruction.duration.kind !== "literal" &&
    instruction.duration.kind !== "duration"
  );
}

function drawKindOf(node: ExpressionPlan): RandomDrawKind | null {
  if (node.kind === "call") {
    if (node.callee.kind === "identifier" && RANDOM_BUILTINS.has(node.callee.name))
      // EVIDENCE: invariant: each random builtin is named like its draw kind.
      return node.callee.name as RandomDrawKind;
    if (node.callee.kind === "property" && node.callee.name === "shuffle") return "shuffle";
    return null;
  }
  if (node.kind === "property" && node.name === "random") return "collectionRandom";
  if (node.kind === "tagQuery" && node.select === "random") return "tagQuery";
  return null;
}

/** Visits every node of an expression; a method call's callee is visited through its receiver only. */
function walkExpression(root: ExpressionPlan, visit: (node: ExpressionPlan) => void): void {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    visit(node);
    for (const child of evaluatedChildren(node)) pending.push(child);
  }
}

/** The children an expression evaluates, in evaluation order. */
function evaluatedChildren(node: ExpressionPlan): readonly ExpressionPlan[] {
  if (node.kind === "call" && node.callee.kind === "property")
    return [node.callee.object, ...node.arguments.map((argument) => argument.value)];
  if (node.kind === "call") return node.arguments.map((argument) => argument.value);
  return expressionPlanChildren(node);
}

/** The expressions an instruction may evaluate. */
function instructionExpressions(instruction: Instruction): readonly ExpressionPlan[] {
  switch (instruction.kind) {
    case "declareSpeaker":
      return instruction.properties.map((property) => property.value);
    case "declareGlobal":
    case "declareBinding":
    case "storeTemporary":
    case "bindDefaultParameter":
    case "prepareSayText":
    case "returnValue":
      return [instruction.value];
    case "prepareReference":
    case "evaluate":
      return [instruction.expression];
    case "validateAssignmentTarget":
      return [instruction.target];
    case "assign":
      return [instruction.value, instruction.target];
    case "validateCallReceiver":
      return [instruction.receiver];
    case "jumpIfFalse":
      return [instruction.condition];
    case "loopStart":
      return [instruction.expression];
    case "callFunction":
      return instruction.arguments.map((argument) => argument.value);
    case "transfer":
    case "setFallback":
      return instruction.destination !== null && "value" in instruction.destination
        ? [instruction.destination.value]
        : [];
    case "say":
      return [
        ...(typeof instruction.textTemporary === "number" ? [] : [instruction.value]),
        ...(typeof instruction.pacing === "object" ? [instruction.pacing] : []),
        ...(instruction.presentation === null ? [] : [instruction.presentation]),
      ];
    case "wait":
    case "startTimer":
      return [
        instruction.duration,
        ...(typeof instruction.display === "object" ? [instruction.display] : []),
        ...(instruction.label === null ? [] : [instruction.label]),
      ];
    case "pacingBarrier":
      return instruction.receiver === null ? [] : [instruction.receiver];
    case "showPermanentButton":
      return [instruction.text];
    case "showImage":
      return instruction.image === null ? [] : [instruction.image];
    case "capture":
      return instruction.tags === null ? [] : [instruction.tags];
    case "storageWrite":
      return instruction.value === null ? [instruction.key] : [instruction.value, instruction.key];
    case "playMedia":
      return [
        instruction.file,
        ...(instruction.repeat.kind === "value" ? [instruction.repeat.value] : []),
        ...(instruction.repeat.kind === "times" ? [instruction.repeat.count] : []),
        ...[instruction.startAt, instruction.endAt, instruction.volume].filter(
          (operand): operand is ExpressionPlan => operand !== null,
        ),
        ...instruction.cues.map((cue) => cue.offset),
      ];
    default:
      return [];
  }
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Which units need a state copy                                                                                    */
/* ---------------------------------------------------------------------------------------------------------------- */

/** Calls that change runtime state: collection and dict methods that change their receiver, and handle methods. */
const MUTATING_CALLS: ReadonlySet<string> = new Set([
  "add",
  "addAll",
  "remove",
  "removeAt",
  "removeFirst",
  "removeLast",
  "clear",
  "sort",
  "shuffle",
  "pause",
  "resume",
  "stop",
]);

const changesBeforeDraw = new WeakMap<Instruction, boolean>();

/**
 * Whether an instruction may change runtime state before a later draw of the same instruction. Such an instruction
 * keeps a copy of the state while control is on, because undoing it takes more than the counters a unit restores. An
 * instruction that evaluates several expressions counts a change in one before a draw in any other, whatever their
 * order; within one expression the evaluation order decides.
 */
function mayChangeBeforeDraw(instruction: Instruction): boolean {
  let known = changesBeforeDraw.get(instruction);
  if (known !== undefined) return known;
  known = analyseChangesBeforeDraw(instruction);
  changesBeforeDraw.set(instruction, known);
  return known;
}

function analyseChangesBeforeDraw(instruction: Instruction): boolean {
  // A staged say or speaker changes only its stage, which a pause drops.
  if (instruction.kind === "say" || instruction.kind === "declareSpeaker") return false;
  // `timer.remaining = …` changes the timer, then may end its round, which draws the next one.
  if (
    instruction.kind === "assign" &&
    instruction.target.kind === "property" &&
    instruction.target.name === "remaining"
  )
    return true;
  const facts = instructionExpressions(instruction).map(analyseExpression);
  const drawsLast = drawsTimerDuration(instruction);
  // Within one expression the evaluation order decides; across expressions any order counts.
  return facts.some(
    (fact, index) =>
      fact.changeBeforeDraw ||
      (fact.changes &&
        (drawsLast || facts.some((other, position) => position !== index && other.draws))),
  );
}

/** Post-order facts about an expression: whether it changes state, draws, and changes state before a later draw. */
function analyseExpression(root: ExpressionPlan): {
  readonly changes: boolean;
  readonly draws: boolean;
  readonly changeBeforeDraw: boolean;
} {
  let changes = false;
  let draws = false;
  let changeBeforeDraw = false;
  const draw = (): void => {
    draws = true;
    if (changes) changeBeforeDraw = true;
  };
  // Post-order, children in evaluation order: a node's own draw or change follows its children's.
  const work: { node: ExpressionPlan; entered: boolean }[] = [{ node: root, entered: false }];
  while (work.length > 0) {
    const item = work.pop()!;
    const node = item.node;
    if (!item.entered) {
      work.push({ node, entered: true });
      const children = evaluatedChildren(node);
      for (let index = children.length - 1; index >= 0; index -= 1)
        work.push({ node: children[index]!, entered: false });
      continue;
    }
    if (node.kind === "template") {
      // Each placeholder that holds a list draws right after it is evaluated; a conservative reading draws after all.
      if (node.parts.some((part) => part.kind === "expression")) draw();
      continue;
    }
    if (drawKindOf(node) !== null) draw();
    if (node.kind === "call") {
      const name =
        node.callee.kind === "property"
          ? node.callee.name
          : node.callee.kind === "identifier"
            ? node.callee.name
            : null;
      if (
        (node.callee.kind === "property" && name !== null && MUTATING_CALLS.has(name)) ||
        name === "removePermanentButton"
      ) {
        changes = true;
        // `pause()` may end a round that is already due, which draws the next one after the change.
        if (name === "pause") draw();
      }
    }
  }
  return { changes, draws, changeBeforeDraw };
}

/**
 * Whether instruction `index` needs a state copy to be undone: it may change state before a draw, it is an `end` that
 * continues at a glob fallback after leaving its activation, or it returns from a timer, media, or button block, whose
 * catch-up after the return may draw.
 */
export function unitNeedsStateCopy(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  index: number,
): boolean {
  const instruction = plan.instructions[index]!;
  if (mayChangeBeforeDraw(instruction)) return true;
  if (instruction.kind === "end")
    return (
      snapshot.fallback !== null &&
      "pick" in snapshot.fallback &&
      !snapshot.callFrames.some((frame) => frame.kind === "file")
    );
  if (instruction.kind === "returnVoid" || instruction.kind === "returnValue") {
    const top = snapshot.callFrames.at(-1);
    return top?.kind === "function" && top.timerInterruption !== null;
  }
  return false;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Outcomes                                                                                                         */
/* ---------------------------------------------------------------------------------------------------------------- */

/** `outcome` as a detached outcome when `support` admits it, otherwise why it does not. */
/** `outcome` checked for a draw of `support`; `keysOf` is the object whose own keys the outcome's shape counts. */
export function checkedOutcome(
  support: RandomSupport,
  outcome: unknown,
  keysOf: unknown = outcome,
): RandomOutcome | string {
  const problem = outcomeProblem(support, outcome);
  if (problem !== null) return problem;
  return isOutcomeShape(outcome, keysOf)
    ? canonicalOutcome(outcome)
    : "An outcome holds only its kind and its value, index, or order.";
}

function outcomeProblem(support: RandomSupport, outcome: unknown): string | null {
  if (typeof outcome !== "object" || outcome === null) return "An outcome must be an object.";
  // EVIDENCE: validation: each branch below checks the fields it reads.
  const candidate = outcome as Record<string, unknown>;
  const number = (): number | null =>
    candidate.kind === "number" && typeof candidate.value === "number" ? candidate.value : null;
  switch (support.kind) {
    case "unit": {
      const value = number();
      return value !== null && Number.isFinite(value) && value >= 0 && value < 1
        ? null
        : "random() takes a number from 0 up to, but not including, 1.";
    }
    case "chance": {
      if (candidate.kind !== "boolean" || typeof candidate.value !== "boolean")
        return "chance(...) takes a boolean outcome.";
      if (support.percent <= 0 && candidate.value) return "chance(0) is always false.";
      if (support.percent >= 100 && !candidate.value) return "chance(100) is always true.";
      return null;
    }
    case "integer": {
      const value = number();
      return value !== null &&
        Number.isSafeInteger(value) &&
        value >= support.min &&
        value <= support.max
        ? null
        : `This draw takes a whole number from ${support.min} through ${support.max}.`;
    }
    case "candidates":
    case "weighted": {
      const index = candidate.kind === "index" ? candidate.index : undefined;
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= support.candidates.length
      )
        return `This draw takes the index of one of its ${support.candidates.length} candidates.`;
      if (support.kind === "weighted" && !(support.weights[index]! > 0))
        return "A candidate with weight 0 cannot be drawn.";
      return null;
    }
    case "normal": {
      const value = number();
      if (value === null || !Number.isFinite(value)) return "randomNormal takes a finite number.";
      return support.spread === 0 && value !== support.mean
        ? `randomNormal with spread 0 always gives its mean, ${support.mean}.`
        : null;
    }
    case "beta": {
      const value = number();
      return value !== null && Number.isFinite(value) && value >= 0 && value <= 1
        ? null
        : "randomBeta takes a number from 0 through 1.";
    }
    case "pert": {
      const value = number();
      return value !== null &&
        Number.isFinite(value) &&
        value >= support.min &&
        value <= support.max
        ? null
        : `randomPert takes a number from ${support.min} through ${support.max}.`;
    }
    case "order": {
      const order = candidate.kind === "order" ? candidate.order : undefined;
      const length = support.items.length;
      if (!Array.isArray(order) || order.length !== length)
        return `A shuffle takes an order of all ${length} items, as their old indexes.`;
      const seen = new Set<number>();
      for (const index of order) {
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= length)
          return `A shuffle takes an order of all ${length} items, as their old indexes.`;
        seen.add(index);
      }
      return seen.size === length ? null : "A shuffle's order names every item once.";
    }
  }
}

/**
 * The fields of an outcome a host chose for a draw of `support`, each read once, so that the outcome the engine checks is
 * the one it uses, whatever the host's object does on later reads: its `kind` and the one field that kind holds, which
 * are all the check reads. The items of an `order` are read by index, only when its length, read once, is the
 * shuffle's; any other `order` is refused on its length. The object's own keys are counted only once these pass.
 */
function readOnce(outcome: Record<string, unknown>, support: RandomSupport): ReadOutcome {
  const kind = outcome.kind;
  if (kind === "number" || kind === "boolean") return { kind, value: outcome.value };
  if (kind === "index") return { kind, index: outcome.index };
  if (kind !== "order") return { kind };
  const order = outcome.order;
  if (!Array.isArray(order)) return { kind, order };
  const length = order.length;
  return {
    kind,
    order:
      support.kind === "order" && length === support.items.length
        ? Array.from({ length }, (_, index) => order[index])
        : null,
  };
}

/** The fields of a chosen outcome that its check reads, each read once. */
interface ReadOutcome {
  readonly kind: unknown;
  readonly value?: unknown;
  readonly index?: unknown;
  readonly order?: unknown;
}

/** A detached copy of an outcome the engine checked, holding only its own fields. */
function canonicalOutcome(outcome: RandomOutcome): RandomOutcome {
  switch (outcome.kind) {
    case "number":
      return Object.freeze({ kind: "number", value: outcome.value });
    case "boolean":
      return Object.freeze({ kind: "boolean", value: outcome.value });
    case "index":
      return Object.freeze({ kind: "index", index: outcome.index });
    case "order":
      return Object.freeze({ kind: "order", order: Object.freeze([...outcome.order]) });
  }
}

/**
 * The natural result of a draw of `support` from generator state `drawId`, sampled again on a local generator: what a
 * restored pending draw must hold. A draw whose support does not determine its sampler, such as a custom one, has none.
 */
function resampledNatural(support: RandomSupport, drawId: number): RandomNatural {
  const rng: XorShift32State = { algorithm: XORSHIFT32_ALGORITHM, state: drawId };
  const draw: PrimitiveDraw = () => nextXorShift32(rng);
  switch (support.kind) {
    case "unit":
      return { kind: "number", value: draw() };
    case "chance":
      return { kind: "boolean", value: sampleChance(draw, support.percent) };
    case "integer":
      return {
        kind: "number",
        value: support.min + sampleIndex(draw, support.max - support.min + 1),
      };
    case "candidates":
      return { kind: "index", index: sampleIndex(draw, support.candidates.length) };
    case "weighted":
      return { kind: "index", index: weightedIndex(support.weights, draw()) };
    case "order":
      return { kind: "order", order: sampleOrder(draw, support.items.length) };
    case "normal":
      return distributionNatural("randomNormal", [support.mean, support.spread], draw);
    case "beta":
      return distributionNatural("randomBeta", [support.alpha, support.beta], draw);
    case "pert":
      return distributionNatural(
        "randomPert",
        [support.min, support.mostLikely, support.max],
        draw,
      );
  }
}

function distributionNatural(
  name: "randomNormal" | "randomBeta" | "randomPert",
  numbers: readonly number[],
  draw: PrimitiveDraw,
): RandomNatural {
  const result = NUMERIC_FUNCTIONS.get(name)!.apply(numbers, {}, draw);
  return typeof result === "number"
    ? { kind: "number", value: result }
    : { kind: "failure", code: result.code, message: result.failure };
}

/** The support a draw kind can have. */
const SUPPORT_KINDS: Readonly<Record<RandomDrawKind, readonly RandomSupport["kind"][]>> = {
  random: ["unit"],
  chance: ["chance"],
  randomInteger: ["integer"],
  duration: ["integer"],
  timerRepeat: ["integer"],
  collectionRandom: ["candidates"],
  interpolation: ["candidates"],
  tagQuery: ["candidates"],
  glob: ["candidates"],
  randomWeighted: ["weighted"],
  randomNormal: ["normal"],
  randomBeta: ["beta"],
  randomPert: ["pert"],
  shuffle: ["order"],
};

/* ---------------------------------------------------------------------------------------------------------------- */
/* Snapshot validation                                                                                              */
/* ---------------------------------------------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** A draw ID: a non-zero xorshift32 state. */
function isDrawId(value: unknown): value is number {
  return safeInteger(value) && value > 0 && value <= 0xffff_ffff;
}

function isDrawKind(value: unknown): value is RandomDrawKind {
  return RANDOM_DRAW_KINDS.some((kind) => kind === value);
}

function isValueList(value: unknown): value is SerializableRuntimeValue[] {
  return (
    Array.isArray(value) &&
    value.every((item) => validateCapturedSerializableValue(item, "$") === null)
  );
}

/** A pending draw's support, which must fit its kind, or why it is malformed. */
function parseSupport(kind: RandomDrawKind, value: unknown): RandomSupport | string {
  const malformed = "Pending random draw support is malformed.";
  if (!isRecord(value)) return malformed;
  const has = (...keys: string[]) => hasExactKeys(value, ["kind", ...keys]);
  let support: RandomSupport | null = null;
  const { percent, min, max, candidates, weights, mean, spread, alpha, beta, mostLikely, items } =
    value;
  switch (value.kind) {
    case "unit":
      if (has()) support = { kind: "unit" };
      break;
    case "chance":
      if (has("percent") && finite(percent) && percent >= 0 && percent <= 100)
        support = { kind: "chance", percent };
      break;
    case "integer":
      if (has("min", "max") && safeInteger(min) && safeInteger(max) && min <= max)
        if (Number.isSafeInteger(max - min + 1)) support = { kind: "integer", min, max };
      break;
    case "candidates":
      if (has("candidates") && isValueList(candidates) && candidates.length > 0)
        support = { kind: "candidates", candidates };
      break;
    case "weighted":
      if (
        has("candidates", "weights") &&
        isValueList(candidates) &&
        Array.isArray(weights) &&
        weights.length === candidates.length
      ) {
        const checked = weights.filter((weight): weight is number => finite(weight) && weight >= 0);
        if (checked.length === weights.length && checked.some((weight) => weight > 0))
          support = { kind: "weighted", candidates, weights: checked };
      }
      break;
    case "normal":
      if (has("mean", "spread") && finite(mean) && finite(spread) && spread >= 0)
        support = { kind: "normal", mean, spread };
      break;
    case "beta":
      if (has("alpha", "beta") && finite(alpha) && finite(beta) && alpha > 0 && beta > 0)
        support = { kind: "beta", alpha, beta };
      break;
    case "pert":
      if (
        has("min", "mostLikely", "max") &&
        finite(min) &&
        finite(mostLikely) &&
        finite(max) &&
        min <= mostLikely &&
        mostLikely <= max
      )
        support = { kind: "pert", min, mostLikely, max };
      break;
    case "order":
      if (has("items") && isValueList(items) && items.length > 1)
        support = { kind: "order", items };
      break;
  }
  if (support === null) return malformed;
  return SUPPORT_KINDS[kind].includes(support.kind)
    ? support
    : "Pending random draw support does not fit its kind.";
}

function sameNatural(left: RandomNatural, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const PENDING_KEYS = [
  "draw",
  "unit",
  "root",
  "instructionBudget",
  "instructionsUsed",
  "eventsBefore",
  "forced",
  "builtinResults",
] as const;

/**
 * Validates `randomControl` of a snapshot: its shape, a pending draw's support and outcomes, its natural result
 * sampled again from its generator state, and a continuation that fits where execution stands.
 */
export function validateRandomControl(
  value: unknown,
  snapshot: Readonly<Record<string, unknown>>,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  if (value === null) return;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["forcedChoices", "pending"]) ||
    !safeInteger(value.forcedChoices) ||
    value.forcedChoices < 0
  ) {
    errors.push("Runtime randomControl is malformed.");
    return;
  }
  const pending = value.pending;
  if (pending === null) return;
  if (!isRecord(pending) || !hasExactKeys(pending, PENDING_KEYS)) {
    errors.push("Runtime pending random draw is malformed.");
    return;
  }
  const draw = pending.draw;
  if (
    !isRecord(draw) ||
    !hasExactKeys(draw, ["drawId", "site", "kind", "support", "natural"]) ||
    !isDrawId(draw.drawId) ||
    typeof draw.site !== "string" ||
    !isDrawKind(draw.kind)
  ) {
    errors.push("Runtime pending random draw is malformed.");
    return;
  }
  const support = parseSupport(draw.kind, draw.support);
  if (typeof support === "string") {
    errors.push(support);
    return;
  }
  if (!sameNatural(resampledNatural(support, draw.drawId), draw.natural))
    errors.push("Runtime pending random draw's natural result does not follow from its draw ID.");
  if (plan !== undefined && !randomSitesOf(plan).ids.has(draw.site))
    errors.push("Runtime pending random draw names a site the plan does not have.");
  const { unit, root, instructionBudget, instructionsUsed, eventsBefore } = pending;
  if (unit !== "instruction" && unit !== "dueWork")
    errors.push("Runtime pending random draw unit is invalid.");
  if (
    root !== "run" &&
    root !== "stepToEvent" &&
    root !== "executeInstruction" &&
    root !== "dueWork"
  )
    errors.push("Runtime pending random draw root is invalid.");
  const budgeted = root === "run" || root === "stepToEvent";
  if (
    budgeted
      ? !safeInteger(instructionBudget) ||
        !safeInteger(instructionsUsed) ||
        instructionsUsed < 0 ||
        instructionsUsed > instructionBudget
      : instructionBudget !== null || instructionsUsed !== null
  )
    errors.push("Runtime pending random draw instruction budget is invalid.");
  if (typeof eventsBefore !== "boolean" || (eventsBefore && root !== "stepToEvent"))
    errors.push("Runtime pending random draw eventsBefore is invalid.");
  if (root === "dueWork" && unit !== "dueWork")
    errors.push("Runtime pending random draw continues due work only from due work.");
  const ids = new Set<number>([draw.drawId]);
  const forcedValid =
    Array.isArray(pending.forced) &&
    pending.forced.every((entry: unknown) => {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, ["drawId", "outcome"]) ||
        !isDrawId(entry.drawId) ||
        ids.has(entry.drawId) ||
        !isOutcomeShape(entry.outcome)
      )
        return false;
      ids.add(entry.drawId);
      return true;
    });
  if (!forcedValid) errors.push("Runtime pending random draw's earlier outcomes are malformed.");
  if (!isValueList(pending.builtinResults))
    errors.push("Runtime pending random draw's builtin results are malformed.");
  const status = snapshot.status;
  if (status === "halted" || status === "failed")
    errors.push("A halted or failed runtime cannot have a pending random draw.");
  if (unit === "instruction" && status !== "ready" && status !== "running")
    errors.push("A pending random draw in an instruction needs a runnable script.");
}

function isOutcomeShape(value: unknown, keysOf: unknown = value): value is RandomOutcome {
  if (!isRecord(value) || !isRecord(keysOf)) return false;
  switch (value.kind) {
    case "number":
      return hasExactKeys(keysOf, ["kind", "value"]) && finite(value.value);
    case "boolean":
      return hasExactKeys(keysOf, ["kind", "value"]) && typeof value.value === "boolean";
    case "index":
      return (
        hasExactKeys(keysOf, ["kind", "index"]) && safeInteger(value.index) && value.index >= 0
      );
    case "order":
      return (
        hasExactKeys(keysOf, ["kind", "order"]) &&
        Array.isArray(value.order) &&
        value.order.every((index: unknown) => safeInteger(index) && index >= 0)
      );
    default:
      return false;
  }
}

/** A trusted copy of the random control state, sharing nothing with `control`. */
export function cloneRandomControl(
  control: RuntimeRandomControlSnapshot | null,
): RuntimeRandomControlSnapshot | null {
  if (control === null) return null;
  const pending = control.pending;
  return {
    forcedChoices: control.forcedChoices,
    pending:
      pending === null
        ? null
        : {
            draw: cloneDrawView(pending.draw),
            unit: pending.unit,
            root: pending.root,
            instructionBudget: pending.instructionBudget,
            instructionsUsed: pending.instructionsUsed,
            eventsBefore: pending.eventsBefore,
            forced: pending.forced.map((entry) => ({
              drawId: entry.drawId,
              outcome: canonicalOutcome(entry.outcome),
            })),
            builtinResults: pending.builtinResults.map(cloneCapturedSerializableValue),
          },
  };
}

function cloneDrawView(draw: RandomDrawView): RandomDrawView {
  return {
    drawId: draw.drawId,
    site: draw.site,
    kind: draw.kind,
    support: cloneSupport(draw.support),
    natural: draw.natural.kind === "failure" ? { ...draw.natural } : canonicalOutcome(draw.natural),
  };
}

function cloneSupport(support: RandomSupport): RandomSupport {
  switch (support.kind) {
    case "candidates":
      return {
        kind: "candidates",
        candidates: support.candidates.map(cloneCapturedSerializableValue),
      };
    case "weighted":
      return {
        kind: "weighted",
        candidates: support.candidates.map(cloneCapturedSerializableValue),
        weights: [...support.weights],
      };
    case "order":
      return { kind: "order", items: support.items.map(cloneCapturedSerializableValue) };
    default:
      return { ...support };
  }
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Policy                                                                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

/** A host's control options, checked against one plan. */
export interface RandomPolicy {
  readonly plan: InstructionPlan;
  readonly sites: ReadonlySet<string> | null;
  readonly kinds: ReadonlySet<RandomDrawKind> | null;
  readonly decide: ((draw: RandomDrawView) => RandomDecision) | null;
  /** Whether any draw can match: an empty site or kind list matches none. */
  readonly matchesAny: boolean;
}

/**
 * Checks and reads a host's control options once. Unknown sites and kinds are host errors, thrown before anything
 * runs; so is control together with an injected random source, which would leave a pause without its generator state.
 */
export function compileRandomPolicy(
  plan: InstructionPlan,
  options: RandomControlOptions,
  injectedRandom: boolean,
): RandomPolicy {
  if (typeof options !== "object" || options === null)
    throw new TypeError("randomControl must be an object.");
  if (injectedRandom)
    throw new TypeError(
      "randomControl cannot be used with an injected capabilities.random: a paused draw needs the session generator.",
    );
  const { filter, decide } = options;
  if (decide !== undefined && typeof decide !== "function")
    throw new TypeError("randomControl.decide must be a function.");
  let sites: Set<string> | null = null;
  let kinds: Set<RandomDrawKind> | null = null;
  if (filter !== undefined) {
    if (typeof filter !== "object" || filter === null)
      throw new TypeError("randomControl.filter must be an object.");
    const { sites: siteList, kinds: kindList } = filter;
    if (siteList !== undefined) {
      if (!Array.isArray(siteList))
        throw new TypeError("randomControl.filter.sites must be a list of site IDs.");
      const known = randomSitesOf(plan).ids;
      sites = new Set();
      for (const site of siteList) {
        if (typeof site !== "string" || !known.has(site))
          throw new TypeError(
            `randomControl.filter.sites names ${typeof site === "string" ? `'${site}'` : "a value"}, which is not a random site of the plan.`,
          );
        sites.add(site);
      }
    }
    if (kindList !== undefined) {
      if (!Array.isArray(kindList))
        throw new TypeError("randomControl.filter.kinds must be a list of draw kinds.");
      kinds = new Set();
      for (const kind of kindList) {
        if (!isDrawKind(kind))
          throw new TypeError("randomControl.filter.kinds names an unknown draw kind.");
        kinds.add(kind);
      }
    }
  }
  return Object.freeze({
    plan,
    sites,
    kinds,
    decide: decide ?? null,
    matchesAny: (sites === null || sites.size > 0) && (kinds === null || kinds.size > 0),
  });
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* One operation's control                                                                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

/** How resuming answers the draws of the unit it executes again. */
interface Replay {
  readonly forced: ReadonlyMap<number, RandomOutcome>;
  readonly builtinResults: readonly SerializableRuntimeValue[];
  builtinIndex: number;
  readonly pending: RandomDrawView;
  readonly resolution: "natural" | RandomOutcome;
  reached: boolean;
}

/** What undoing a unit restores. */
interface Unit {
  readonly kind: "instruction" | "dueWork";
  readonly rngState: number;
  readonly nextEventSequence: number;
  readonly eventsLength: number;
  readonly currentSessionTimeMs: number;
  readonly loopFrames: number;
  readonly status: RuntimeStatus;
  readonly copy: RuntimeSnapshot | null;
  readonly trace: ReturnType<TraceStore["stage"]>;
  readonly forced: { readonly drawId: number; readonly outcome: RandomOutcome }[];
  readonly builtinResults: SerializableRuntimeValue[];
}

/**
 * The controlled randomness of one operation: the host's policy, a replay of the unit being resumed, and the units
 * that a pause undoes. Evaluators of the operation, also staged ones, share it.
 */
export class RandomControl {
  readonly receipts: RandomChoiceReceipt[] = [];
  refusal: RandomDecisionRefusal | null = null;
  #unit: Unit | null = null;
  #replay: Replay | null;

  public constructor(
    readonly plan: InstructionPlan,
    readonly policy: RandomPolicy | null,
    /** The operation's debug trace, which marks a chosen outcome on its draw's record. */
    readonly trace: TraceStore | null,
    replay: Omit<Replay, "builtinIndex" | "reached"> | null = null,
  ) {
    this.#replay = replay === null ? null : { ...replay, builtinIndex: 0, reached: false };
  }

  /** Whether a draw can pause: only then are units tracked. */
  get tracking(): boolean {
    return this.#replay !== null || (this.policy !== null && this.policy.matchesAny);
  }

  get inUnit(): boolean {
    return this.#unit !== null;
  }

  /**
   * Starts a unit, unless one runs: the restore point of its counters, a trusted state copy when `copy`, and a trace
   * stage. Returns whether it started one.
   */
  beginUnit(
    kind: "instruction" | "dueWork",
    snapshot: RuntimeSnapshot,
    events: readonly InterpreterEvent[],
    trace: TraceStore | null,
    copy: (() => RuntimeSnapshot) | null,
  ): boolean {
    if (this.#unit !== null || !this.tracking) return false;
    this.#unit = {
      kind,
      rngState: snapshot.rng.state,
      nextEventSequence: snapshot.nextEventSequence,
      eventsLength: events.length,
      currentSessionTimeMs: snapshot.currentSessionTimeMs,
      loopFrames: snapshot.loopFrames.length,
      status: snapshot.status,
      copy: copy === null ? null : copy(),
      trace: trace?.stage() ?? null,
      forced: [],
      builtinResults: [],
    };
    return true;
  }

  /** A unit that ended, also by a runtime failure: its trace records stay, and a replay is over. */
  endUnit(trace: TraceStore | null): void {
    const unit = this.#unit;
    if (unit === null) return;
    this.#unit = null;
    trace?.commit(unit.trace);
    this.assertReplayDone();
  }

  /** A unit left by a thrown error, which ends the operation anyway. */
  discardUnit(trace: TraceStore | null): void {
    const unit = this.#unit;
    if (unit === null) return;
    this.#unit = null;
    trace?.commit(unit.trace);
    this.#replay = null;
  }

  /** Undoes the unit a draw paused: the state, the events it emitted, and its trace records. */
  abortUnit(
    suspension: RandomSuspension,
    snapshot: RuntimeSnapshot,
    events: InterpreterEvent[],
    trace: TraceStore | null,
  ): void {
    const unit = this.#unit!;
    this.#unit = null;
    trace?.rollback(unit.trace);
    if (unit.copy !== null) Object.assign(snapshot, unit.copy);
    snapshot.rng.state = unit.rngState;
    snapshot.nextEventSequence = unit.nextEventSequence;
    snapshot.currentSessionTimeMs = unit.currentSessionTimeMs;
    snapshot.loopFrames.length = unit.loopFrames;
    snapshot.status = unit.status;
    snapshot.contextualSpeaker = null;
    events.length = unit.eventsLength;
    suspension.unit = unit.kind;
    suspension.journal = { forced: unit.forced, builtinResults: unit.builtinResults };
    this.#replay = null;
  }

  /** The unit being resumed reached the paused draw and used every recorded builtin result. */
  assertReplayDone(): void {
    const replay = this.#replay;
    if (replay === null) return;
    this.#replay = null;
    if (!replay.reached || replay.builtinIndex !== replay.builtinResults.length)
      throw new RandomReplayDivergence();
  }

  /**
   * While the unit before the paused draw is executed again, the result a host builtin gave there, which the host is
   * not asked for again; otherwise `undefined`.
   */
  replayedBuiltin(): SerializableRuntimeValue | undefined {
    const replay = this.#replay;
    if (replay === null || replay.reached) return undefined;
    if (replay.builtinIndex >= replay.builtinResults.length) throw new RandomReplayDivergence();
    return cloneCapturedSerializableValue(replay.builtinResults[replay.builtinIndex++]!);
  }

  /** A host builtin's checked result, which a pause in the same unit keeps for executing the unit again. */
  recordBuiltin(result: SerializableRuntimeValue): void {
    this.#unit?.builtinResults.push(cloneCapturedSerializableValue(result));
  }

  /**
   * Resolves one draw after its natural sampling: the recorded or chosen outcome, the natural one, or a pause.
   * `support` is computed only for a draw the host decides.
   */
  resolve(
    instruction: number,
    span: SourceSpan | PlanSourceLocation,
    kind: RandomDrawKind,
    drawId: number,
    natural: RandomNatural,
    support: () => RandomSupport,
  ): RandomNatural {
    const replay = this.#replay;
    if (replay !== null && !replay.reached) {
      if (drawId === replay.pending.drawId) {
        replay.reached = true;
        const site = randomSiteAt(this.plan, instruction, span);
        if (site !== replay.pending.site || kind !== replay.pending.kind)
          throw new RandomReplayDivergence();
        if (!sameNatural(natural, replay.pending.natural)) throw new RandomReplayDivergence();
        if (replay.resolution === "natural") return natural;
        if (typeof checkedOutcome(support(), replay.resolution) === "string")
          throw new RandomReplayDivergence();
        return this.#force(drawId, site, kind, replay.resolution);
      }
      const recorded = replay.forced.get(drawId);
      if (recorded === undefined) return natural;
      // A restored outcome is checked against the draw it now meets, so it never selects outside the support.
      const forced = checkedOutcome(support(), recorded);
      if (typeof forced === "string") throw new RandomReplayDivergence();
      this.trace?.forcedRandom();
      this.#unit?.forced.push({ drawId, outcome: forced });
      return forced;
    }
    const policy = this.policy;
    if (policy === null || !policy.matchesAny) return natural;
    if (policy.kinds !== null && !policy.kinds.has(kind)) return natural;
    const site = randomSiteAt(this.plan, instruction, span);
    if (policy.sites !== null && !policy.sites.has(site)) return natural;
    const view: RandomDrawView = Object.freeze({ drawId, site, kind, support: support(), natural });
    if (policy.decide === null) throw this.#suspension(view);
    // The decision is read completely inside the guard, so whatever the host's code throws, also from reading what
    // `decide` returned, ends the operation alike.
    let answer: "natural" | "suspend" | RandomOutcome | { readonly refusal: string };
    try {
      const decision: unknown = policy.decide(publishedView(view));
      const decided = isRecord(decision) ? decision.kind : undefined;
      if (decided === "natural" || decided === "suspend") answer = decided;
      else if (isRecord(decision) && decided === "choose") {
        const chosen = decision.outcome;
        const outcome = checkedOutcome(
          view.support,
          isRecord(chosen) ? readOnce(chosen, view.support) : chosen,
          chosen,
        );
        answer = typeof outcome === "string" ? { refusal: outcome } : outcome;
      } else
        answer = {
          refusal:
            'A decision is { kind: "natural" }, { kind: "choose", outcome }, or { kind: "suspend" }.',
        };
    } catch (error) {
      throw new RandomDecisionError(error);
    }
    if (answer === "natural") return natural;
    if (answer !== "suspend" && !("refusal" in answer))
      return this.#force(drawId, site, kind, answer);
    if (answer !== "suspend") this.refusal = Object.freeze({ drawId, message: answer.refusal });
    throw this.#suspension(view);
  }

  /** A pause at `view`, which keeps its own copy of the draw's candidates. */
  #suspension(view: RandomDrawView): RandomSuspension {
    if (this.#unit === null) throw new Error("A random draw paused outside an undoable unit.");
    return new RandomSuspension(cloneDrawView(view));
  }

  #force(
    drawId: number,
    site: string,
    kind: RandomDrawKind,
    outcome: RandomOutcome,
  ): RandomOutcome {
    const chosen = canonicalOutcome(outcome);
    this.trace?.forcedRandom();
    this.#unit?.forced.push({ drawId, outcome: chosen });
    this.receipts.push(Object.freeze({ drawId, site, kind, outcome: chosen }));
    return chosen;
  }
}

/** Executing a paused unit again did not reach its draw as the snapshot recorded it: the state was not engine-made. */
export class RandomReplayDivergence extends RandomControlSignal {
  public constructor() {
    super("Resuming did not reach the paused random draw as the snapshot records it.");
    this.name = "RandomReplayDivergence";
  }
}

/** What the host's decision callback threw, carried out of the operation as its cause. */
export class RandomDecisionError extends RandomControlSignal {
  public constructor(cause: unknown) {
    super("randomControl.decide threw.", { cause });
    this.name = "RandomDecisionError";
  }
}

/**
 * The control that repeats recorded decisions: each chosen outcome at the draw its receipt names, a pause at `pauseAt`,
 * and the natural outcome everywhere else. Running the recorded operations with it reaches the recorded state; its
 * own receipts then equal `choices`.
 */
export function replayRandomChoices(
  choices: readonly RandomChoiceReceipt[],
  pauseAt: number | null = null,
): RandomControlOptions {
  const chosen = new Map(choices.map((receipt) => [receipt.drawId, receipt.outcome]));
  return {
    decide: (draw) => {
      const outcome = chosen.get(draw.drawId);
      if (outcome !== undefined) return { kind: "choose", outcome };
      return draw.drawId === pauseAt ? { kind: "suspend" } : { kind: "natural" };
    },
  };
}

/** The draw a snapshot is paused at, as a deeply frozen copy, or `null`. */
export function pendingRandomDraw(snapshot: RuntimeSnapshot): RandomDrawView | null {
  const pending = snapshot.randomControl?.pending ?? null;
  return pending === null ? null : publishedView(pending.draw);
}

/** The control of one operation, or `null` when no draw can be decided or paused. */
export function randomControlFor(
  plan: InstructionPlan,
  policy: RandomPolicy | null,
  trace: TraceStore | null,
): RandomControl | null {
  return policy === null || !policy.matchesAny ? null : new RandomControl(plan, policy, trace);
}

/** A deeply frozen copy of a draw for a host, sharing nothing with the state. */
function publishedView(view: RandomDrawView): RandomDrawView {
  return deepFreeze(cloneDrawView(view));
}

function deepFreeze<T>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item !== "object" || item === null || Object.isFrozen(item)) continue;
    Object.freeze(item);
    for (const nested of Object.values(item)) pending.push(nested);
  }
  return value;
}
