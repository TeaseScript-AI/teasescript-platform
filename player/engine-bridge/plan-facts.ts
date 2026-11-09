import { listRandomSites, type InstructionPlan, type RandomSite } from "../../src/playback.js";
import { planLockNeeds, playerRuntimeStageImages } from "../runtime/plan-metadata.js";

/*
 * What the host reads from a plan for the Player, Worker-side: the plan's random sites come from the engine. A leaf of
 * the engine bridge: the ops and their composition (`player-ops.ts`) import it, and it imports none of them.
 */

/** What the Player reads from a plan the Worker holds, sent with the plan's token instead of the plan. */
export interface PlanMetadata {
  /** The plan's script files, in plan order. */
  readonly files: readonly string[];
  readonly stageImages: readonly string[];
  readonly randomSites: readonly RandomSite[];
  /** Whether the script locks or opens anything, and whether it encrypts. */
  readonly locks: boolean;
  readonly encrypts: boolean;
}

/** What the Player reads from a plan, sent with its token. */
export function planMetadata(plan: InstructionPlan): PlanMetadata {
  return {
    files: plan.files.map((file) => file.path),
    stageImages: playerRuntimeStageImages(plan),
    randomSites: listRandomSites(plan),
    ...planLockNeeds(plan),
  };
}
