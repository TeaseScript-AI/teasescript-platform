import type { ExpressionPlan, Instruction, InstructionPlan } from "../../src/plan/model.js";
import { captureOrReuseInstructionPlan } from "../../src/plan/capture.js";
import { compileValidPlan } from "./compile-valid-plan.js";

/** How a placeholder's `say` is paced: smart, instant, or a number of seconds. */
export type MessageSayPacing = "smart" | "instant" | number;

/**
 * A trusted plan whose `say`s give message handles, written in source that compiles without them: each
 * `timer(duration: 1 ms, async: true, label: <text>)` becomes a `say <text>` at `pacing` whose handle goes where the
 * timer's handle went. Reads and writes of `.text` go through functions with untyped parameters, which the compiler
 * leaves to the runtime.
 */
export function messageSayPlan(
  source: string,
  pacing: MessageSayPacing = "instant",
): InstructionPlan {
  return withMessageSays(compileValidPlan(source), pacing);
}

/** `plan` with each placeholder timer replaced by its result-bearing `say`; see `messageSayPlan`. */
export function withMessageSays(
  plan: InstructionPlan,
  pacing: MessageSayPacing = "instant",
): InstructionPlan {
  let replaced = 0;
  const instructions = plan.instructions.map((instruction): Instruction => {
    if (
      instruction.kind !== "startTimer" ||
      instruction.duration.kind !== "duration" ||
      instruction.duration.milliseconds !== 1 ||
      instruction.label === null ||
      instruction.destinationTemporary === null
    )
      return instruction;
    replaced += 1;
    const paced: ExpressionPlan | "smart" | "instant" =
      typeof pacing === "number"
        ? { kind: "literal", value: pacing, span: instruction.span }
        : pacing;
    return {
      kind: "say",
      presentation: null,
      speaker: null,
      value: instruction.label,
      skipPolicy: null,
      pacing: paced,
      destinationTemporary: instruction.destinationTemporary,
      span: instruction.span,
    };
  });
  if (replaced === 0) throw new Error("The source has no placeholder for a result-bearing say.");
  // Validated and immutable like a compiled plan, so that every operation reuses it and a trace keeps its epoch.
  const captured = captureOrReuseInstructionPlan({ ...plan, instructions });
  if (captured.plan === null)
    throw new Error(captured.validation.errors[0]?.message ?? "Invalid plan.");
  return captured.plan;
}

/** Functions that read and write `.text` of whatever they are given, for placeholder sources. */
export const MESSAGE_TEXT_FUNCTIONS = [
  "function setText(message, text) {",
  "    message.text = text",
  "}",
  "function appendText(message, text) {",
  "    message.text += text",
  "}",
  "function textOf(message) {",
  "    return message.text",
  "}",
].join("\n");
