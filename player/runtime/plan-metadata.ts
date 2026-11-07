import type { InstructionPlan } from "../../src/plan/model.js";
import { evaluateTagSteps } from "../../src/tag-query.js";

// What the Player reads from a plan before it runs, without the compiler: the engine Worker reports it with the plan.

/**
 * The Stage images a plan names before it runs, in plan order, for the Player to load ahead: the path of each
 * `showImage "<path>"`, and every package image a `showImage tagged …` can pick, whatever its comparisons and tag lists
 * read. An image path computed while the script runs is not among them.
 */
export function playerRuntimeStageImages(plan: InstructionPlan): readonly string[] {
  const paths = new Set<string>();
  for (const instruction of plan.instructions) {
    if (instruction.kind !== "showImage" || instruction.image === null) continue;
    const image = instruction.image;
    if (image.kind === "literal" && typeof image.value === "string") paths.add(image.value);
    if (image.kind !== "tagQuery" || image.catalog !== "images") continue;
    for (const candidate of plan.images) {
      const tags = new Set(candidate.tags.map((tag) => tag.name));
      const picks = evaluateTagSteps(image.steps, (step) =>
        step.kind === "tag" ? tags.has(step.name) : null,
      );
      if (picks !== false) paths.add(candidate.path);
    }
  }
  return [...paths];
}

/** Whether a plan locks or opens anything, and whether it encrypts, so the Player loads that code while it is online. */
export function planLockNeeds(plan: InstructionPlan): {
  readonly locks: boolean;
  readonly encrypts: boolean;
} {
  const locks = plan.instructions.some((instruction) => instruction.kind === "lock");
  const encrypts = plan.instructions.some(
    (instruction) =>
      instruction.kind === "lock" &&
      (instruction.call === "encryptText" || instruction.call === "encryptFile"),
  );
  return { locks, encrypts };
}
