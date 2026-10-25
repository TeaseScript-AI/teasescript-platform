import type { SayParts } from "../../ast.js";
import type { SayInstruction } from "../../plan/model.js";
import { compileChild, type CompileTask } from "../continuation.js";
import type { InstructionCompiler, LoweredExpression } from "./compiler.js";
import { lowerInteractionPayloadTask } from "./interactions.js";
import { copySpan } from "./expression-plans.js";

// Say: a message, with its speaker, presentation, text, and pacing prepared first when an operand runs instructions.

/**
 * A `say`: plain when no operand emits instructions, otherwise with its speaker, context, and, before a pacing that
 * emits instructions, its text prepared. Used as a value, it gets a temporary for the handle of its message, which
 * the instruction sets once the message is shown.
 */
export function* lowerSayTask(
  compiler: InstructionCompiler,
  say: SayParts,
  value: boolean,
): CompileTask<LoweredExpression | null> {
  const textCanSuspend = say.presentation !== null || compiler.emitsInstructions(say.value);
  const pacingCanSuspend =
    say.pacing !== null && say.pacing !== "instant" && compiler.emitsInstructions(say.pacing);
  const pacingOf = (lowered: LoweredExpression | null): SayInstruction["pacing"] =>
    say.pacing === null ? "smart" : lowered === null ? "instant" : lowered.plan;
  let destinationTemporary: number | undefined;
  const result = (): LoweredExpression | null =>
    destinationTemporary === undefined
      ? null
      : {
          plan: { kind: "temporary", temporaryId: destinationTemporary, span: copySpan(say.span) },
          temporaryIds: [destinationTemporary],
        };
  if (!textCanSuspend && !pacingCanSuspend) {
    const lowered = yield* compileChild(compiler.lowerExpressionTask(say.value));
    const loweredPacing =
      say.pacing === null || say.pacing === "instant"
        ? null
        : yield* compileChild(compiler.lowerExpressionTask(say.pacing));
    if (value) destinationTemporary = compiler.allocateTemporary();
    compiler.instructions.push({
      kind: "say",
      presentation: null,
      speaker: say.speaker?.name ?? null,
      value: lowered.plan,
      skipPolicy: say.skipPolicy,
      pacing: pacingOf(loweredPacing),
      ...(destinationTemporary === undefined ? {} : { destinationTemporary }),
      span: copySpan(say.span),
    });
    compiler.emitTemporaryCleanup(
      [...lowered.temporaryIds, ...(loweredPacing?.temporaryIds ?? [])],
      say.span,
    );
    return result();
  }
  const speakerTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "prepareSaySpeaker",
    speaker: say.speaker?.name ?? null,
    destinationTemporary: speakerTemporary,
    span: copySpan(say.span),
  });
  const contextualSpeakerTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "prepareSayContextualSpeaker",
    speakerTemporary,
    destinationTemporary: contextualSpeakerTemporary,
    span: copySpan(say.span),
  });
  const loweredPresentation =
    say.presentation === null
      ? null
      : compiler.materializeExpression(
          yield* compileChild(
            lowerInteractionPayloadTask(compiler, say.presentation, contextualSpeakerTemporary),
          ),
          say.presentation.span,
        );
  const lowered = yield* compileChild(
    lowerInteractionPayloadTask(compiler, say.value, contextualSpeakerTemporary),
  );
  if (!pacingCanSuspend) {
    const loweredPacing =
      say.pacing === null || say.pacing === "instant"
        ? null
        : yield* compileChild(
            lowerInteractionPayloadTask(compiler, say.pacing, contextualSpeakerTemporary),
          );
    if (value) destinationTemporary = compiler.allocateTemporary();
    compiler.instructions.push({
      kind: "say",
      presentation: loweredPresentation?.plan ?? null,
      speaker: say.speaker?.name ?? null,
      value: lowered.plan,
      speakerTemporary,
      contextualSpeakerTemporary,
      skipPolicy: say.skipPolicy,
      pacing: pacingOf(loweredPacing),
      ...(destinationTemporary === undefined ? {} : { destinationTemporary }),
      span: copySpan(say.span),
    });
    compiler.emitTemporaryCleanup(
      [
        speakerTemporary,
        contextualSpeakerTemporary,
        ...(loweredPresentation?.temporaryIds ?? []),
        ...lowered.temporaryIds,
        ...(loweredPacing?.temporaryIds ?? []),
      ],
      say.span,
    );
    return result();
  }
  const textTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "prepareSayText",
    value: lowered.plan,
    destinationTemporary: textTemporary,
    span: copySpan(say.value.span),
  });
  compiler.emitTemporaryCleanup(lowered.temporaryIds, say.value.span);
  const loweredPacing = compiler.materializeExpression(
    yield* compileChild(
      lowerInteractionPayloadTask(compiler, say.pacing!, contextualSpeakerTemporary),
    ),
    say.pacing!.span,
  );
  if (value) destinationTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "say",
    presentation: loweredPresentation?.plan ?? null,
    speaker: say.speaker?.name ?? null,
    value: lowered.plan,
    speakerTemporary,
    contextualSpeakerTemporary,
    textTemporary,
    skipPolicy: say.skipPolicy,
    pacing: loweredPacing.plan,
    ...(destinationTemporary === undefined ? {} : { destinationTemporary }),
    span: copySpan(say.span),
  });
  compiler.emitTemporaryCleanup(
    [
      speakerTemporary,
      contextualSpeakerTemporary,
      textTemporary,
      ...(loweredPresentation?.temporaryIds ?? []),
      ...loweredPacing.temporaryIds,
    ],
    say.span,
  );
  return result();
}
