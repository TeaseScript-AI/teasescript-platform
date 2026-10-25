import type { Expression } from "../../ast.js";
import type { ExpressionPlan, LockInstruction } from "../../plan/model.js";
import { directPasswordField } from "../../capture-call.js";
import { isConversion, takesDefault, takesFiles } from "../../conversions.js";
import { lazyDefaultArgument } from "../../lazy-defaults.js";
import { compileChild, type CompileTask } from "../continuation.js";
import type { InstructionCompiler, LoweredExpression } from "./compiler.js";
import { prepareInteractionSpeaker } from "./interactions.js";
import { lowerAskQuestionTask } from "./asks.js";
import { lowerLazyDefaultTask } from "./calls.js";
import { planSpan } from "./expression-plans.js";

// File store and lock calls: their operands wait in temporaries, so every run of the instruction reads the same values.

/**
 * A call that may use the Player's file store (V30 §13 and §33). Its arguments are evaluated in written order into
 * temporaries, unless they are literals, so that the instruction reads the same values when it runs again with the
 * Player's answer; they are cleared once it gave its result. Its `default:` runs after it, only when it is used.
 */
export function* lowerFileStoreTask(
  compiler: InstructionCompiler,
  expression: Extract<Expression, { kind: "callExpression" }>,
): CompileTask<LoweredExpression> {
  if (expression.callee.kind !== "identifier")
    throw new TypeError("A file store call reached lowering without its name.");
  const call = expression.callee.name;
  const conversion = isConversion(call) && takesFiles(call);
  if (call !== "fileFromBase64" && call !== "fileToBase64" && call !== "hashFile" && !conversion)
    throw new TypeError(`'${call}' is not a file store call.`);
  // The default runs only when it is used, as instructions after the call.
  const lazy = lazyDefaultArgument(expression);
  const written = expression.arguments.filter((argument) => argument !== lazy?.argument);
  const lowered = yield* compileChild(
    compiler.lowerOrderedExpressionsTask(written.map((argument) => argument.value)),
  );
  const operands: Record<"value" | "files", ExpressionPlan | null> = { value: null, files: null };
  const temporaryIds: number[] = [];
  written.forEach((argument, index) => {
    const operand = lowered[index]!;
    temporaryIds.push(...operand.temporaryIds);
    let plan = operand.plan;
    if (plan.kind !== "temporary" && plan.kind !== "literal") {
      const temporaryId = compiler.allocateTemporary();
      compiler.instructions.push({
        kind: "storeTemporary",
        temporaryId,
        value: plan,
        expectBoolean: false,
        span: planSpan(argument.value.span),
      });
      temporaryIds.push(temporaryId);
      plan = { kind: "temporary", temporaryId, span: planSpan(argument.value.span) };
    }
    const name = argument.kind === "positionalArgument" ? "value" : argument.name.name;
    if (name !== "value" && name !== "files")
      throw new TypeError(`${call}(...) reached lowering with '${name}:'.`);
    operands[name] = plan;
  });
  const value = operands.value;
  if (value === null) throw new TypeError(`${call}(...) reached lowering without its value.`);
  const store = (destinationTemporary: number, defaultTemporary: number | null): void => {
    compiler.instructions.push({
      kind: "fileStore",
      call,
      value,
      defaultTemporary,
      files: operands.files,
      destinationTemporary,
      span: planSpan(expression.span),
    });
    compiler.emitTemporaryCleanup(temporaryIds, expression.span);
  };
  if (lazy !== null)
    return yield* compileChild(
      lowerLazyDefaultTask(
        compiler,
        store,
        lazy.argument.value,
        { defaultOf: lazy.operation },
        expression,
      ),
    );
  if (call === "fileFromBase64" || (conversion && takesDefault(call)))
    throw new TypeError(`${call}(...) reached lowering without its default:.`);
  const destinationTemporary = compiler.allocateTemporary();
  store(destinationTemporary, null);
  return {
    plan: { kind: "temporary", temporaryId: destinationTemporary, span: planSpan(expression.span) },
    temporaryIds: [destinationTemporary],
  };
}

/**
 * `encryptText`, `encryptFile`, `decryptText`, or `decryptFile` (V30 §13). Like a file store call, its arguments are
 * evaluated in written order into temporaries, unless they are literals, so that every run of the instruction reads the
 * same values; they are cleared once it gave its result. A decrypt call's default runs only when it is used, as
 * instructions after the call.
 */
export function* lowerLockTask(
  compiler: InstructionCompiler,
  expression: Extract<Expression, { kind: "callExpression" }>,
): CompileTask<LoweredExpression> {
  if (expression.callee.kind !== "identifier")
    throw new TypeError("A lock call reached lowering without its name.");
  const call = expression.callee.name;
  if (
    call !== "encryptText" &&
    call !== "encryptFile" &&
    call !== "decryptText" &&
    call !== "decryptFile"
  )
    throw new TypeError(`'${call}' is not a lock call.`);
  const lazy = lazyDefaultArgument(expression);
  const written = expression.arguments.filter((argument) => argument !== lazy?.argument);
  const operands: Record<
    "value" | "password" | "publicKey" | "key" | "timeLock",
    ExpressionPlan | null
  > = { value: null, password: null, publicKey: null, key: null, timeLock: null };
  const temporaryIds: number[] = [];
  let passwordField: LockInstruction["passwordField"] = null;
  // A password field written directly says its question where `password:` stands; the arguments before it are kept
  // in temporaries first, and those after it are evaluated after the question.
  const fieldIndex = written.findIndex(
    (argument) =>
      argument.kind === "namedArgument" &&
      argument.name.name === "password" &&
      directPasswordField(argument.value) !== null,
  );
  const groups =
    fieldIndex === -1 ? [written] : [written.slice(0, fieldIndex), written.slice(fieldIndex + 1)];
  for (const [group, part] of groups.entries()) {
    if (group === 1) {
      const field = directPasswordField(written[fieldIndex]!.value)!;
      const speakerTemporary = prepareInteractionSpeaker(
        compiler,
        field.speaker?.name ?? null,
        field.asSpan ?? field.commandSpan,
      );
      const { hint } = yield* compileChild(lowerAskQuestionTask(compiler, field, speakerTemporary));
      temporaryIds.push(speakerTemporary, ...(hint === null ? [] : [hint.temporaryId]));
      passwordField = {
        hint:
          hint === null
            ? null
            : {
                kind: "temporary",
                temporaryId: hint.temporaryId,
                span: planSpan(field.hint!.span),
              },
      };
    }
    const lowered = yield* compileChild(
      compiler.lowerOrderedExpressionsTask(part.map((argument) => argument.value)),
    );
    part.forEach((argument, index) => {
      const operand = lowered[index]!;
      temporaryIds.push(...operand.temporaryIds);
      let plan = operand.plan;
      if (plan.kind !== "temporary" && plan.kind !== "literal") {
        const temporaryId = compiler.allocateTemporary();
        compiler.instructions.push({
          kind: "storeTemporary",
          temporaryId,
          value: plan,
          expectBoolean: false,
          span: planSpan(argument.value.span),
        });
        temporaryIds.push(temporaryId);
        plan = { kind: "temporary", temporaryId, span: planSpan(argument.value.span) };
      }
      const name = argument.kind === "positionalArgument" ? "value" : argument.name.name;
      if (
        name !== "value" &&
        name !== "password" &&
        name !== "publicKey" &&
        name !== "key" &&
        name !== "timeLock"
      )
        throw new TypeError(`${call}(...) reached lowering with '${name}:'.`);
      operands[name] = plan;
    });
  }
  const value = operands.value;
  if (value === null) throw new TypeError(`${call}(...) reached lowering without its value.`);
  const lock = (destinationTemporary: number, defaultTemporary: number | null): void => {
    compiler.instructions.push({
      kind: "lock",
      call,
      value,
      password: operands.password,
      passwordField,
      publicKey: operands.publicKey,
      key: operands.key,
      timeLock: operands.timeLock,
      defaultTemporary,
      destinationTemporary,
      span: planSpan(expression.span),
    });
    compiler.emitTemporaryCleanup(temporaryIds, expression.span);
  };
  if (lazy !== null)
    return yield* compileChild(
      lowerLazyDefaultTask(
        compiler,
        lock,
        lazy.argument.value,
        { defaultOf: lazy.operation },
        expression,
      ),
    );
  if (call === "decryptText" || call === "decryptFile")
    throw new TypeError(`${call}(...) reached lowering without its default:.`);
  const destinationTemporary = compiler.allocateTemporary();
  lock(destinationTemporary, null);
  return {
    plan: { kind: "temporary", temporaryId: destinationTemporary, span: planSpan(expression.span) },
    temporaryIds: [destinationTemporary],
  };
}
