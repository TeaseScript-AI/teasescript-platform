import type {
  Block,
  Expression,
  TimerParts,
  MediaParts,
  ShowPermanentButtonParts,
} from "../../ast.js";
import { createSourceSpan } from "../../source.js";
import type { ExpressionPlan, DelayDisplay, MediaCuePlan } from "../../plan/model.js";
import { compileChild, type CompileTask } from "../continuation.js";
import { mediaHandlerBlocks, mediaOperands, timerOperands } from "../../expression-children.js";
import type { InstructionCompiler, LoweredExpression } from "./compiler.js";
import { copySpan } from "./expression-plans.js";

// Background actions: timers, media, and permanent buttons, and the variables their blocks share.

/**
 * Lowers a blocking timer to a foreground `wait` delay and an async timer to `startTimer`. The instruction evaluates
 * duration, display, then label; operands written in another order are materialized first in source order.
 */
export function* lowerTimerTask(
  compiler: InstructionCompiler,
  timer: TimerParts,
  value: boolean,
): CompileTask<LoweredExpression | null> {
  const dynamicDisplay = typeof timer.display === "object" ? timer.display : null;
  // The instruction's evaluation order; `timerOperands` gives the source order.
  const operands = [timer.duration, dynamicDisplay, timer.label].filter(
    (operand): operand is Expression => operand !== null,
  );
  const sourceOrder = timerOperands(timer);
  const reordered = sourceOrder.some((operand, index) => operand !== operands[index]);
  const lowered = yield* compileChild(compiler.lowerOrderedExpressionsTask(sourceOrder));
  const planOf = (operand: Expression): LoweredExpression => {
    const item = lowered[sourceOrder.indexOf(operand)]!;
    return reordered && item.plan.kind !== "temporary"
      ? compiler.materializeExpression(item, operand.span)
      : item;
  };
  // Materialization must follow source order, so resolve every operand before building the instruction.
  const loweredBySource = sourceOrder.map(planOf);
  const plan = (operand: Expression): ExpressionPlan =>
    loweredBySource[sourceOrder.indexOf(operand)]!.plan;
  const temporaryIds = loweredBySource.flatMap((item) => item.temporaryIds);
  const staticDisplay: DelayDisplay = typeof timer.display === "string" ? timer.display : "visible";
  const display = dynamicDisplay === null ? staticDisplay : plan(dynamicDisplay);
  if (!timer.async) {
    compiler.instructions.push({
      kind: "wait",
      command: "timer",
      duration: plan(timer.duration),
      unit: timer.unit,
      display,
      label: timer.label === null ? null : plan(timer.label),
      span: copySpan(timer.span),
    });
    compiler.emitTemporaryCleanup(temporaryIds, timer.span);
    return null;
  }
  const destinationTemporary = value ? compiler.allocateTemporary() : null;
  compiler.instructions.push({
    kind: "startTimer",
    duration: plan(timer.duration),
    unit: timer.unit,
    display,
    label: timer.label === null ? null : plan(timer.label),
    repeat: timer.repeat,
    persist: timer.persist,
    handlerFunctionId:
      timer.handler === null ? null : compiler.registerHandler(timer.handler, "timer", null),
    captures: capturesOf(compiler, timer.handler === null ? [] : [timer.handler]),
    destinationTemporary,
    span: copySpan(timer.span),
  });
  compiler.emitTemporaryCleanup(temporaryIds, timer.span);
  return destinationTemporary === null
    ? null
    : {
        plan: { kind: "temporary", temporaryId: destinationTemporary, span: copySpan(timer.span) },
        temporaryIds: [destinationTemporary],
      };
}

/**
 * `showPermanentButton <text> { ... }` evaluates its text and shows the button; the block becomes a parameterless
 * handler region that a click runs. Used as a value, it gives the button's identifier.
 */
export function* lowerPermanentButtonTask(
  compiler: InstructionCompiler,
  button: ShowPermanentButtonParts,
  value: boolean,
): CompileTask<LoweredExpression | null> {
  const text = yield* compileChild(compiler.lowerExpressionTask(button.text));
  const span = createSourceSpan(button.commandSpan.start, button.text.span.end);
  const destinationTemporary = value ? compiler.allocateTemporary() : null;
  compiler.instructions.push({
    kind: "showPermanentButton",
    text: text.plan,
    persist: button.persist,
    handlerFunctionId: compiler.registerHandler(button.handler, "button", null),
    captures: capturesOf(compiler, [button.handler]),
    destinationTemporary,
    span: copySpan(span),
  });
  compiler.emitTemporaryCleanup(text.temporaryIds, span);
  return destinationTemporary === null
    ? null
    : {
        plan: { kind: "temporary", temporaryId: destinationTemporary, span: copySpan(span) },
        temporaryIds: [destinationTemporary],
      };
}

/** Lowers a play command; its operands evaluate in source order. */
export function* lowerMediaTask(
  compiler: InstructionCompiler,
  media: MediaParts,
  value: boolean,
): CompileTask<LoweredExpression | null> {
  const repeatOperand =
    media.repeat === null || media.repeat.kind === "indefinite"
      ? null
      : media.repeat.kind === "times"
        ? media.repeat.count
        : media.repeat.value;
  const cues = media.handlers?.kind === "cues" ? media.handlers.cues : [];
  // The instruction's evaluation order; `mediaOperands` gives the source order.
  const operands = [
    media.file,
    repeatOperand,
    media.startAt,
    media.endAt,
    media.volume,
    ...cues.map((cue) => cue.offset),
  ].filter((operand): operand is Expression => operand !== null);
  const sourceOrder = mediaOperands(media);
  const reordered = sourceOrder.some((operand, index) => operand !== operands[index]);
  const lowered = yield* compileChild(compiler.lowerOrderedExpressionsTask(sourceOrder));
  const loweredByOperand = new Map<Expression, LoweredExpression>();
  sourceOrder.forEach((operand, index) => {
    const item = lowered[index]!;
    loweredByOperand.set(
      operand,
      reordered && item.plan.kind !== "temporary"
        ? compiler.materializeExpression(item, operand.span)
        : item,
    );
  });
  const plan = (operand: Expression): ExpressionPlan => loweredByOperand.get(operand)!.plan;
  const temporaryIds = [...loweredByOperand.values()].flatMap((item) => item.temporaryIds);
  const selfHandle = media.async ? (compiler.selfHandleByInitializer.get(media) ?? null) : null;
  const register = (block: Block): number => compiler.registerHandler(block, "media", selfHandle);
  const cuePlans: MediaCuePlan[] = [];
  let finishFunctionId: number | null = null;
  if (media.handlers?.kind === "compact") {
    cuePlans.push({
      kind: "beforeEnd",
      offset: { kind: "duration", milliseconds: 0, span: copySpan(media.handlers.body.span) },
      functionId: register(media.handlers.body),
    });
  }
  for (const cue of cues) {
    if (cue.kind === "finish") finishFunctionId = register(cue.body);
    else
      cuePlans.push({ kind: cue.kind, offset: plan(cue.offset!), functionId: register(cue.body) });
  }
  const destinationTemporary = value ? compiler.allocateTemporary() : null;
  compiler.instructions.push({
    kind: "playMedia",
    media: media.media,
    async: media.async,
    file: plan(media.file),
    repeat:
      media.repeat === null
        ? { kind: "once" }
        : media.repeat.kind === "indefinite"
          ? { kind: "indefinite" }
          : media.repeat.kind === "times"
            ? { kind: "times", count: plan(media.repeat.count) }
            : { kind: "value", value: plan(media.repeat.value) },
    startAt: media.startAt === null ? null : plan(media.startAt),
    endAt: media.endAt === null ? null : plan(media.endAt),
    volume: media.volume === null ? null : plan(media.volume),
    cues: cuePlans,
    finishFunctionId,
    captures: capturesOf(compiler, mediaHandlerBlocks(media)),
    destinationTemporary,
    span: copySpan(media.span),
  });
  compiler.emitTemporaryCleanup(temporaryIds, media.span);
  return destinationTemporary === null
    ? null
    : {
        plan: { kind: "temporary", temporaryId: destinationTemporary, span: copySpan(media.span) },
        temporaryIds: [destinationTemporary],
      };
}

/** The variables that blocks of one resource share with the code that creates it, in the order of first use. */
function capturesOf(compiler: InstructionCompiler, blocks: readonly Block[]): string[] {
  const names = new Set<string>();
  for (const block of blocks)
    for (const name of compiler.captures.get(block) ?? []) names.add(name);
  return [...names];
}
