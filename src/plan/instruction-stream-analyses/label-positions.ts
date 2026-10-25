import { type PlanValidationError, planError } from "../validation-support.js";
import type { InstructionPlan } from "../model.js";
import { recordValidationTestWork } from "../../validation-testing.js";
import { PlanControlFlow, type FlowEdge } from "../control-flow.js";
import { sameSet, setUnion, solveBackward } from "../dataflow.js";
import {
  instructionKilledTemporaries,
  requiredInstructionTemporaries,
  temporariesLiveBefore,
} from "../temporary-uses.js";
import type { PlanFileBoundaries } from "./execution-regions.js";

// Where labels may stand, from what the code after each instruction of a root region needs.

/**
 * A goto leaves every block, loop, and temporary value behind, so the code from a label on may need none of them: no
 * temporary that it reads before setting, no block that it leaves before entering, and no loop that it continues or
 * breaks before starting. Checked backward along the root region's control flow; call only for an otherwise valid
 * plan.
 */
export function validateLabelPositions(
  plan: InstructionPlan,
  files: readonly PlanFileBoundaries[],
  errors: PlanValidationError[],
): void {
  if (files.every((file) => file.labelInstructions.size === 0)) return;
  recordValidationTestWork("labelPositionAnalyses");
  const flow = new PlanControlFlow(plan);
  files.forEach((file, fileIndex) => {
    if (file.labelInstructions.size === 0) return;
    const needs = rootRegionNeeds(plan, flow, file.startInstruction, file.rootEndInstruction);
    for (const label of file.labelInstructions) {
      if (needs[label - file.startInstruction] !== null) {
        errors.push(
          planError(
            "TSC002",
            "A label must stand between statements of its file's outer scope.",
            `$.files[${fileIndex}].labels`,
          ),
        );
      }
    }
  });
}

/** What the code from an instruction on needs before it sets it up itself. */
export interface RootNeeds {
  /** The temporaries it reads before setting them. */
  readonly temporaries: ReadonlySet<number>;
  /** How many blocks it leaves before entering them. */
  readonly scopes: number;
  /** The loops it continues or breaks before starting them. */
  readonly loops: ReadonlySet<number>;
}

const NO_NUMBERS: ReadonlySet<number> = new Set<number>();

/**
 * What the code from each instruction of the root region `start`..`end` on needs, by its place in the region, along the
 * region's control flow; `null` where it needs nothing.
 */
export function rootRegionNeeds(
  plan: InstructionPlan,
  flow: PlanControlFlow,
  start: number,
  end: number,
): readonly (RootNeeds | null)[] {
  const length = end - start;
  const instructions = plan.instructions.slice(start, end);
  const read = instructions.map((instruction) => requiredInstructionTemporaries(instruction, null));
  const killed = instructions.map(instructionKilledTemporaries);
  return solveBackward<RootNeeds, FlowEdge>({
    nodeCount: length,
    // A goto or a transfer leaves the region's flow, as an end does; a call comes back at its `resume`.
    successors: (node) =>
      flow
        .successors(start + node)
        .map(({ edge, target }) => ({
          edge,
          node:
            target === null ||
            target < start ||
            target >= end ||
            edge.kind === "goto" ||
            edge.kind === "transfer"
              ? null
              : target - start,
        })),
    join: (left, right) => ({
      temporaries: setUnion(left.temporaries, right.temporaries),
      scopes: Math.max(left.scopes, right.scopes),
      loops: setUnion(left.loops, right.loops),
    }),
    equals: (left, right) =>
      left.scopes === right.scopes &&
      sameSet(left.temporaries, right.temporaries) &&
      sameSet(left.loops, right.loops),
    transfer: (node, edge, after) => {
      const instruction = instructions[node]!;
      const temporaries = temporariesLiveBefore(
        read[node]!,
        killed[node]!,
        after?.temporaries ?? NO_NUMBERS,
      );
      let scopes = after?.scopes ?? 0;
      if (instruction.kind === "enterScope") scopes = Math.max(scopes - 1, 0);
      // More open blocks than instructions means a cycle that leaves blocks it never entered.
      if (instruction.kind === "leaveScope") scopes = Math.min(scopes + 1, length + 1);
      let loops = after?.loops ?? NO_NUMBERS;
      // A loop that starts here is active on the way into its body.
      if (
        edge.kind === "iterate" &&
        instruction.kind === "loopStart" &&
        loops.has(instruction.loopId)
      ) {
        const remaining = new Set(loops);
        remaining.delete(instruction.loopId);
        loops = remaining;
      }
      if (instruction.kind === "loopControl" && !loops.has(instruction.loopId))
        loops = new Set(loops).add(instruction.loopId);
      if (temporaries.size === 0 && scopes === 0 && loops.size === 0) return null;
      if (
        after !== null &&
        temporaries === after.temporaries &&
        scopes === after.scopes &&
        loops === after.loops
      )
        return after;
      return { temporaries, scopes, loops };
    },
  });
}
