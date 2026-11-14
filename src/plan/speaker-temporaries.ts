import type { InstructionPlan } from "./model.js";

const speakerTemporaryIds = new WeakMap<InstructionPlan, ReadonlySet<number>>();

/** The temporaries that hold the speaker of a prepared message for its `speaker` reads, collected once per plan. */
export function speakerTemporaries(plan: InstructionPlan): ReadonlySet<number> {
  let ids = speakerTemporaryIds.get(plan);
  if (ids === undefined) {
    ids = new Set(
      plan.instructions.flatMap((instruction) =>
        instruction.kind === "prepareSayContextualSpeaker" ||
        instruction.kind === "prepareInteractionSpeaker"
          ? [instruction.destinationTemporary]
          : [],
      ),
    );
    speakerTemporaryIds.set(plan, ids);
  }
  return ids;
}
