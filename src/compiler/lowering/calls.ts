import type { Expression, NamedArgument } from "../../ast.js";
import { InstructionCompilationError } from "../errors.js";
import type {
  JumpIfFalseInstruction,
  StoreTemporaryInstruction,
  CallArgumentPlan,
} from "../../plan/model.js";
import { boundParameterName } from "../../function-arguments.js";
import { compileChild, type CompileTask } from "../continuation.js";
import type { InstructionCompiler, LoweredExpression, ControlOrigin } from "./compiler.js";
import { unwrapParentheses, withTypeCheck, copySpan } from "./expression-plans.js";

// Calls, the script's own functions included, and `load`, with a `default:` that runs only when it is used.

export function* lowerUserFunctionCallTask(
  compiler: InstructionCompiler,
  expression: Extract<Expression, { kind: "callExpression" }>,
): CompileTask<LoweredExpression> {
  // EVIDENCE: invariant: the caller selects this path only for a registered identifier callee.
  const name = (expression.callee as Extract<Expression, { kind: "identifier" }>).name;
  const registered = compiler.functionByName.get(name)!;
  const temporaryIds: number[] = [];
  const planned: CallArgumentPlan[] = [];
  const loweredArguments = yield* compileChild(
    compiler.lowerOrderedExpressionsTask(
      expression.arguments.map((argument) => argument.value),
      true,
    ),
  );
  expression.arguments.forEach((argument, index) => {
    const lowered = loweredArguments[index]!;
    for (const temporaryId of lowered.temporaryIds) temporaryIds.push(temporaryId);
    const parameterName = boundParameterName(registered.declaration.parameters, argument, index);
    if (parameterName === undefined) {
      throw new InstructionCompilationError(
        "TSC003",
        `Function '${name}' has no parameter for positional argument ${index + 1}.`,
        argument.span,
      );
    }
    planned.push({
      parameterName,
      value: lowered.plan,
      span: copySpan(argument.span),
      ...withTypeCheck(compiler.typeChecks.get(argument)),
    });
  });
  const destinationTemporary = compiler.allocateTemporary();
  const callIndex = compiler.instructions.length;
  if (registered.id === null) compiler.project.foreignCalls.push({ instruction: callIndex, name });
  compiler.instructions.push({
    kind: "callFunction",
    functionId: registered.id ?? 0,
    arguments: planned,
    destinationTemporary,
    returnInstruction: callIndex + 1,
    span: copySpan(expression.span),
  });
  if (temporaryIds.length > 0) {
    compiler.instructions.push({
      kind: "clearTemporaries",
      temporaryIds: [...new Set(temporaryIds)],
      span: copySpan(expression.span),
    });
  }
  return {
    plan: { kind: "temporary", temporaryId: destinationTemporary, span: copySpan(expression.span) },
    temporaryIds: [destinationTemporary],
  };
}

/**
 * A call of a function or method other than the script's own; `omitted` is a `default:` left out to run after the call
 * as instructions (see `#lowerLazyDefaultTask`).
 */
export function* lowerCallTask(
  compiler: InstructionCompiler,
  expression: Extract<Expression, { kind: "callExpression" }>,
  omitted: NamedArgument | null,
): CompileTask<LoweredExpression> {
  const written = expression.arguments.filter((argument) => argument !== omitted);
  let callee: LoweredExpression;
  // Grouping a method does not detach it from its receiver: `(text.trim)()` calls `text.trim()`.
  const method = unwrapParentheses(expression.callee);
  if (method.kind === "propertyAccessExpression") {
    let receiver = yield* compileChild(compiler.lowerExpressionTask(method.object));
    if (written.some((argument) => compiler.emitsInstructions(argument.value))) {
      receiver = compiler.prepareReferenceExpression(receiver, method.object.span);
      compiler.instructions.push({
        kind: "validateCallReceiver",
        receiver: receiver.plan,
        method: method.property.name,
        span: copySpan(method.span),
      });
    }
    callee = {
      plan: {
        kind: "property",
        object: receiver.plan,
        name: method.property.name,
        span: copySpan(method.span),
      },
      temporaryIds: receiver.temporaryIds,
    };
  } else {
    callee = yield* compileChild(compiler.lowerExpressionTask(expression.callee));
  }
  const loweredArguments = yield* compileChild(
    compiler.lowerOrderedExpressionsTask(written.map((argument) => argument.value)),
  );
  const argumentsList = written.map((argument, index) => ({
    argument,
    lowered: loweredArguments[index]!,
  }));
  return {
    plan: {
      kind: "call",
      callee: callee.plan,
      arguments: argumentsList.map(({ argument, lowered }) =>
        argument.kind === "positionalArgument"
          ? { kind: "positional", value: lowered.plan, span: copySpan(argument.span) }
          : {
              kind: "named",
              name: argument.name.name,
              value: lowered.plan,
              span: copySpan(argument.span),
            },
      ),
      // The check of a `get` default goes with the default.
      ...(omitted === null ? withTypeCheck(compiler.typeChecks.get(expression)) : {}),
      span: copySpan(expression.span),
    },
    temporaryIds: [
      ...callee.temporaryIds,
      ...argumentsList.flatMap((item) => item.lowered.temporaryIds),
    ],
  };
}

/**
 * A `default:` that runs instructions, such as an ask, runs only when it is used (owner decision, 2026-10-16). `probe`
 * runs the call or `load` without it, into the result's temporary, and says in the other temporary whether it needs
 * the default. Only then do the default's instructions run, and its value takes the result's place, checked by
 * `accept` as the call checks a default or as the load's result.
 */
export function* lowerLazyDefaultTask(
  compiler: InstructionCompiler,
  probe: (temporaryId: number, defaultTemporary: number) => void,
  defaultValue: Expression,
  accept: Pick<StoreTemporaryInstruction, "defaultOf" | "typeCheck">,
  origin: Extract<ControlOrigin, { kind: "default" }>["expression"],
): CompileTask<LoweredExpression> {
  const resultTemporary = compiler.allocateTemporary();
  const defaultTemporary = compiler.allocateTemporary();
  probe(resultTemporary, defaultTemporary);
  const span = copySpan(origin.span);
  const conditional = compiler.instructions.length;
  const conditionalInstruction: JumpIfFalseInstruction = {
    kind: "jumpIfFalse",
    condition: { kind: "temporary", temporaryId: defaultTemporary, span },
    target: -1,
    span,
  };
  compiler.instructions.push(conditionalInstruction);
  compiler.originate(conditional, { kind: "default", expression: origin });
  const lowered = yield* compileChild(compiler.lowerExpressionTask(defaultValue));
  compiler.instructions.push({
    kind: "storeTemporary",
    temporaryId: resultTemporary,
    value: lowered.plan,
    expectBoolean: false,
    ...accept,
    span: copySpan(defaultValue.span),
  });
  compiler.instructions[conditional] = {
    ...conditionalInstruction,
    target: compiler.instructions.length,
  };
  return {
    plan: { kind: "temporary", temporaryId: resultTemporary, span },
    temporaryIds: [...lowered.temporaryIds, defaultTemporary, resultTemporary],
  };
}

/**
 * Lowers `load`. A default that emits instructions runs only when the key is absent, or holds a value that does not
 * fit the load's type. Any other default stays lazy inside the load plan.
 */
export function* lowerLoadTask(
  compiler: InstructionCompiler,
  expression: Extract<Expression, { kind: "loadExpression" }>,
): CompileTask<LoweredExpression> {
  const key = yield* compileChild(compiler.lowerExpressionTask(expression.key));
  const defaultValue = expression.defaultValue;
  const type = compiler.typeChecks.get(expression)?.type ?? null;
  if (defaultValue === null || !compiler.emitsInstructions(defaultValue)) {
    const lowered =
      defaultValue === null
        ? null
        : yield* compileChild(compiler.lowerExpressionTask(defaultValue));
    return {
      plan: {
        kind: "storageLoad",
        key: key.plan,
        default: lowered?.plan ?? null,
        type,
        span: copySpan(expression.span),
      },
      temporaryIds: [...key.temporaryIds, ...(lowered?.temporaryIds ?? [])],
    };
  }
  // The default takes the place of the stored value, so it fits the load's type, or is null.
  const check = compiler.typeChecks.get(expression);
  const lowered = yield* compileChild(
    lowerLazyDefaultTask(
      compiler,
      (temporaryId, defaultTemporary) => {
        compiler.instructions.push({
          kind: "storeTemporary",
          temporaryId,
          value: {
            kind: "storageLoad",
            key: key.plan,
            default: null,
            type,
            span: copySpan(expression.span),
          },
          expectBoolean: false,
          defaultTemporary,
          span: copySpan(expression.span),
        });
      },
      defaultValue,
      check === undefined
        ? {}
        : {
            typeCheck: {
              type: { kind: "union", members: [check.type, { kind: "null" }] },
              place: check.place,
            },
          },
      expression,
    ),
  );
  return { plan: lowered.plan, temporaryIds: [...key.temporaryIds, ...lowered.temporaryIds] };
}
