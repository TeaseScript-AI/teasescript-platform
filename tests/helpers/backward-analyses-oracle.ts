import type { Instruction, InstructionPlan } from "../../src/plan/model.js";
import { PlanControlFlow } from "../../src/plan/control-flow.js";
import { rootRegionNeeds } from "../../src/plan/instruction-stream-analyses.js";
import {
  instructionKilledTemporaries,
  requiredInstructionTemporaries,
} from "../../src/plan/temporary-uses.js";
import {
  snapshotValidationAnalysis,
  type SnapshotValidationAnalysis,
} from "../../src/runtime/snapshot-validation-analysis.js";
import {
  requiredContinuationTemporaries,
  type ContinuationRequests,
} from "../../src/runtime/state.js";

/*
 * The two backward analyses as they walked the plan before they moved onto the plan's control flow
 * (`src/plan/control-flow.ts`) and the backward solver (`src/plan/dataflow.ts`), kept as the oracle for that move: what
 * the code of a root region needs at each instruction, which decides where a label may stand, and what a continuation
 * needs, which decides whether a snapshot's call frame can resume.
 */

/** What both analyses give for a plan, and where they differ. */
export interface BackwardAnalysesComparison {
  /** Root instructions compared. */
  readonly rootInstructions: number;
  /** Continuation queries compared. */
  readonly continuationQueries: number;
  /** Continuation queries left out, as their context has more loops than the limit. */
  readonly skippedQueries: number;
  readonly differences: readonly string[];
}

/**
 * Compares the oracle with the analyses of `src` on every root instruction and every continuation of `plan`, leaving
 * out contexts of more than `contextLoops` loops: each such context has a graph of its own with a node for every
 * instruction and depth, so deeply nested loops would make the comparison quadratic.
 */
export function compareBackwardAnalyses(
  plan: InstructionPlan,
  contextLoops = Number.POSITIVE_INFINITY,
): BackwardAnalysesComparison {
  const differences: string[] = [];
  let rootInstructions = 0;
  const flow = new PlanControlFlow(plan);
  plan.files.forEach((file, fileIndex) => {
    const { startInstruction: start, rootEndInstruction: end } = file;
    const expected = oracleRootNeeds(plan.instructions, start, end);
    const actual = rootRegionNeeds(plan, flow, start, end);
    for (let slot = 0; slot < end - start; slot += 1) {
      rootInstructions += 1;
      const needs = actual[slot] ?? null;
      const shown = describeNeeds(
        needs === null ? [] : [...needs.temporaries],
        needs?.scopes ?? 0,
        needs === null ? [] : [...needs.loops],
      );
      const oracle = describeNeeds([...expected.temporaries[slot]!], expected.scopes[slot]!, [
        ...expected.loops[slot]!,
      ]);
      if (shown !== oracle)
        differences.push(`file ${fileIndex} root ${start + slot}: ${shown}, oracle ${oracle}`);
    }
  });

  // A copy outside the validated-plan registry, so that both analyses start with no kept requirement.
  const analysis = snapshotValidationAnalysis(structuredClone(plan));
  const requests: ContinuationRequests = { graphs: new Map(), required: new Map() };
  const oracleRequests: OracleRequests = { graphs: new Map(), required: new Map() };
  let continuationQueries = 0;
  let skippedQueries = 0;
  for (let position = 0; position < plan.instructions.length; position += 1) {
    for (const context of loopContexts(analysis, position)) {
      if (context.length > contextLoops) {
        skippedQueries += 1;
        continue;
      }
      continuationQueries += 1;
      const shown = describeSet(
        requiredContinuationTemporaries(analysis, position, position, context, requests),
      );
      const oracle = describeSet(
        oracleRequiredContinuationTemporaries(
          analysis,
          position,
          position,
          context,
          oracleRequests,
        ),
      );
      if (shown !== oracle)
        differences.push(
          `continuation ${position} in loops [${context.join(",")}]: ${shown}, oracle ${oracle}`,
        );
    }
  }
  return { rootInstructions, continuationQueries, skippedQueries, differences };
}

/**
 * The loop contexts that a continuation at `position` may come with: none, the loops whose body holds it, those with the
 * loops whose header holds it, those of a session that cannot stand there, and one of an unknown loop.
 */
function loopContexts(
  analysis: SnapshotValidationAnalysis,
  position: number,
): readonly (readonly number[])[] {
  const body: [number, number][] = [];
  const header: [number, number][] = [];
  for (const [loopId, loop] of analysis.loops) {
    if (position > loop.start && position < loop.target) body.push([loop.start, loopId]);
    else if (position >= loop.continueStart && position <= loop.start)
      header.push([loop.start, loopId]);
  }
  const inOrder = (loops: [number, number][]) =>
    loops.sort((left, right) => left[0] - right[0]).map(([, loopId]) => loopId);
  const bodyLoops = inOrder(body);
  const contexts = [
    [],
    bodyLoops,
    inOrder([...body, ...header]),
    bodyLoops.slice(-1),
    inOrder(header),
    [...bodyLoops, 1_000_000],
  ];
  const seen = new Set<string>();
  return contexts.filter((context) => {
    const key = context.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function describeNeeds(
  temporaries: readonly number[],
  scopes: number,
  loops: readonly number[],
): string {
  return `temporaries [${sorted(temporaries)}] scopes ${scopes} loops [${sorted(loops)}]`;
}

function describeSet(values: ReadonlySet<number>): string {
  return `[${sorted([...values])}]`;
}

function sorted(values: readonly number[]): string {
  return [...values].sort((left, right) => left - right).join(",");
}

// The oracle: label requirements -------------------------------------------------------------------------------------

function oracleRootNeeds(
  instructions: readonly Instruction[],
  start: number,
  end: number,
): {
  readonly temporaries: readonly ReadonlySet<number>[];
  readonly scopes: readonly number[];
  readonly loops: readonly ReadonlySet<number>[];
} {
  const length = end - start;
  const temporaries = Array.from({ length }, () => new Set<number>());
  const scopes = new Array<number>(length).fill(0);
  const loops = Array.from({ length }, () => new Set<number>());
  const inRegion = (index: number): boolean => index >= start && index < end;
  for (let changed = true; changed;) {
    changed = false;
    for (let index = end - 1; index >= start; index -= 1) {
      const instruction = instructions[index]!;
      const successors = rootSuccessors(instruction, index).filter(inRegion);
      const neededTemporaries = new Set<number>();
      let neededScopes = 0;
      const neededLoops = new Set<number>();
      for (const successor of successors) {
        for (const id of temporaries[successor - start]!) neededTemporaries.add(id);
        neededScopes = Math.max(neededScopes, scopes[successor - start]!);
        // A loop that starts here is active on the way into its body.
        const providesLoop =
          instruction.kind === "loopStart" && successor === index + 1 ? instruction.loopId : null;
        for (const id of loops[successor - start]!) if (id !== providesLoop) neededLoops.add(id);
      }
      for (const id of instructionKilledTemporaries(instruction)) neededTemporaries.delete(id);
      for (const id of requiredInstructionTemporaries(instruction, null)) neededTemporaries.add(id);
      if (instruction.kind === "enterScope") neededScopes = Math.max(neededScopes - 1, 0);
      // More open blocks than instructions means a cycle that leaves blocks it never entered.
      if (instruction.kind === "leaveScope") neededScopes = Math.min(neededScopes + 1, length + 1);
      if (instruction.kind === "loopControl") neededLoops.add(instruction.loopId);
      const slot = index - start;
      if (
        !sameNumbers(temporaries[slot]!, neededTemporaries) ||
        scopes[slot] !== neededScopes ||
        !sameNumbers(loops[slot]!, neededLoops)
      ) {
        temporaries[slot] = neededTemporaries;
        scopes[slot] = neededScopes;
        loops[slot] = neededLoops;
        changed = true;
      }
    }
  }
  return { temporaries, scopes, loops };
}

/** Where execution can continue from a root instruction; transfers and endings leave the region's flow. */
function rootSuccessors(instruction: Instruction, index: number): readonly number[] {
  switch (instruction.kind) {
    case "jump":
    case "loopControl":
      return [instruction.target];
    case "jumpIfFalse":
    case "loopStart":
      return [instruction.target, index + 1];
    case "callFunction":
      return [instruction.returnInstruction];
    // A file call returns after it; a goto to a file leaves.
    case "transfer":
      return instruction.mode === "call" ? [index + 1] : [];
    case "exit":
    case "end":
    case "goto":
    case "returnValue":
    case "returnVoid":
      return [];
    default:
      return [index + 1];
  }
}

function sameNumbers(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

// The oracle: continuation liveness ----------------------------------------------------------------------------------

interface OracleRequests {
  readonly graphs: Map<string, OracleGraph>;
  readonly required: Map<string, ReadonlySet<number>>;
}

interface OracleGraph {
  readonly nodes: Map<number, OracleNode>;
  readonly liveIn: Map<number, ReadonlySet<number>>;
}

interface OracleNode {
  readonly successors: readonly number[];
  readonly killed: ReadonlySet<number>;
  readonly read: ReadonlySet<number>;
}

const NOTHING_LIVE: ReadonlySet<number> = new Set<number>();

function oracleRequiredContinuationTemporaries(
  analysis: SnapshotValidationAnalysis,
  startInstruction: number,
  callerPosition: number,
  contextLoops: readonly number[],
  continuationRequests: OracleRequests,
): ReadonlySet<number> {
  const activeLoops = analysableLoops(analysis, contextLoops, callerPosition);
  const loopsKey = activeLoops.join(",");
  const key = `${startInstruction}:${loopsKey}`;
  const known = continuationRequests.required.get(key);
  if (known !== undefined) return known;
  let graph = continuationRequests.graphs.get(loopsKey);
  if (graph === undefined) {
    graph = { nodes: new Map(), liveIn: new Map() };
    continuationRequests.graphs.set(loopsKey, graph);
  }
  const required = continuationRequirement(analysis, startInstruction, activeLoops, graph);
  continuationRequests.required.set(key, required);
  return required;
}

function analysableLoops(
  analysis: SnapshotValidationAnalysis,
  loopIds: readonly number[],
  position: number,
): readonly number[] {
  const listed = new Set<number>();
  let previousStart = -1;
  let possible = true;
  for (const loopId of loopIds) {
    const loop = analysis.loops.get(loopId);
    if (
      loop === undefined ||
      loop.start <= previousStart ||
      position < loop.continueStart ||
      position >= loop.target
    ) {
      possible = false;
      break;
    }
    previousStart = loop.start;
    listed.add(loopId);
  }
  if (possible) {
    for (const [loopId, loop] of analysis.loops) {
      if (position > loop.start && position < loop.target && !listed.has(loopId)) {
        possible = false;
        break;
      }
    }
  }
  if (possible) return loopIds;
  const innermost = loopIds.at(-1);
  return innermost !== undefined && analysis.loops.has(innermost) ? [innermost] : [];
}

function continuationRequirement(
  analysis: SnapshotValidationAnalysis,
  startInstruction: number,
  activeLoops: readonly number[],
  graph: OracleGraph,
): ReadonlySet<number> {
  const { plan } = analysis;
  if (plan.instructions[startInstruction] === undefined) return NOTHING_LIVE;
  const { nodes, liveIn } = graph;
  const depths = activeLoops.length + 1;
  const startNode = startInstruction * depths + activeLoops.length;
  const added: number[] = [];
  const pending = [startNode];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (nodes.has(node)) continue;
    const index = Math.floor(node / depths);
    const active = node % depths;
    const instruction = plan.instructions[index];
    const innermost = activeLoops[active - 1] ?? null;
    const successors: number[] = [];
    if (instruction === undefined) {
      nodes.set(node, { successors, killed: NOTHING_LIVE, read: NOTHING_LIVE });
      continue;
    }
    for (const successor of instructionSuccessors(analysis, index)) {
      const leaves = innermost !== null && leavesLoop(instruction, innermost, successor);
      if (leaves) successors.push(successor * depths + active - 1);
      // An empty loop body would make a loop's exit and its body the same instruction.
      if (!leaves || (instruction.kind === "loopStart" && successor === index + 1)) {
        successors.push(successor * depths + active);
      }
    }
    nodes.set(node, {
      successors,
      killed: instructionKilledTemporaries(instruction),
      read: requiredInstructionTemporaries(instruction, innermost),
    });
    added.push(node);
    for (const successor of successors) pending.push(successor);
  }
  if (added.length === 0) return liveIn.get(startNode) ?? NOTHING_LIVE;
  added.sort((left, right) => right - left);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of added) {
      const { successors, killed, read } = nodes.get(node)!;
      let liveOut: Set<number> | undefined;
      for (const successor of successors) {
        for (const temporaryId of liveIn.get(successor) ?? NOTHING_LIVE) {
          (liveOut ??= new Set()).add(temporaryId);
        }
      }
      for (const temporaryId of killed) liveOut?.delete(temporaryId);
      for (const temporaryId of read) (liveOut ??= new Set()).add(temporaryId);
      if (liveOut !== undefined && !sameNumbers(liveIn.get(node) ?? NOTHING_LIVE, liveOut)) {
        liveIn.set(node, liveOut);
        changed = true;
      }
    }
  }
  return liveIn.get(startNode) ?? NOTHING_LIVE;
}

function leavesLoop(instruction: Instruction, loopId: number, successor: number): boolean {
  if (instruction.kind === "loopStart") {
    return instruction.loopId === loopId && successor === instruction.target;
  }
  return (
    instruction.kind === "loopControl" &&
    instruction.action === "break" &&
    instruction.loopId === loopId
  );
}

function instructionSuccessors(
  analysis: SnapshotValidationAnalysis,
  index: number,
): readonly number[] {
  const { plan } = analysis;
  const instruction = plan.instructions[index];
  if (instruction === undefined) return [];
  const regionEnd = analysis.regionEnds[index] ?? plan.instructions.length;
  const next = index + 1 < regionEnd ? index + 1 : null;
  switch (instruction.kind) {
    case "jump":
    case "loopControl":
      return instruction.target < regionEnd ? [instruction.target] : [];
    case "jumpIfFalse":
    case "loopStart": {
      const successors = [instruction.target];
      if (next !== null) successors.push(next);
      return successors.filter((candidate) => candidate >= 0 && candidate < regionEnd);
    }
    case "returnValue":
    case "returnVoid":
    case "exit":
    // A goto or end leaves this path with no temporaries, so nothing it holds stays live.
    case "goto":
    case "end":
      return [];
    // A file call returns after it with the caller's temporaries; a file goto leaves like a goto.
    case "transfer":
      return instruction.mode === "call" && next !== null ? [next] : [];
    case "callFunction":
      return instruction.returnInstruction < regionEnd ? [instruction.returnInstruction] : [];
    default:
      return next === null ? [] : [next];
  }
}
