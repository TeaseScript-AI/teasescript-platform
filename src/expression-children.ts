import type {
  Block,
  Expression,
  InteractionExpression,
  MediaParts,
  SayParts,
  ShowButtonParts,
  Statement,
  TagQueryExpression,
  TimerParts,
} from "./ast.js";

/** Whether an ask keeps all its named arguments in written order: `askForm`, `askBoolean`, and `askBooleans`. */
function hasNamedAskArguments(expression: InteractionExpression): boolean {
  return (
    expression.interactionKind === "form" ||
    expression.interactionKind === "boolean" ||
    expression.interactionKind === "booleans"
  );
}

/**
 * The arguments of `askForm`, `askBoolean`, or `askBooleans` in written order, by name: the question, which comes first,
 * as `message`, then the named arguments.
 */
export function namedAskArguments(
  expression: InteractionExpression,
): readonly { readonly name: string; readonly value: Expression }[] {
  return [
    ...(expression.question === null ? [] : [{ name: "message", value: expression.question }]),
    ...expression.formArguments.map((argument) => ({
      name: argument.name.name,
      value: argument.value,
    })),
  ];
}

/**
 * The operands of an ask in evaluation order: the options of its question's mode, then the question, then `hint:` and
 * `prefill:` in the order they are written, or every named argument of an ask that keeps them. For `askChoice`, the
 * `prefill:` that follows its options.
 */
export function askOperands(expression: InteractionExpression): readonly Expression[] {
  const presentation = expression.presentation === null ? [] : [expression.presentation];
  if (hasNamedAskArguments(expression))
    return [...presentation, ...namedAskArguments(expression).map((argument) => argument.value)];
  const named = [expression.hint, expression.prefill].filter(
    (operand): operand is Expression => operand !== null,
  );
  if (named.length === 2 && named[1]!.span.start.offset < named[0]!.span.start.offset)
    named.reverse();
  return [
    ...presentation,
    ...(expression.question === null ? [] : [expression.question]),
    ...named,
  ];
}

/** Every operand of an ask in evaluation order: the options of `askChoice` as written, then {@link askOperands}. */
export function askParts(expression: InteractionExpression): readonly Expression[] {
  return [...expression.options.map((option) => option.expression), ...askOperands(expression)];
}

/**
 * The operands of a `say` in evaluation order: its presentation options, its text, then its pacing. They are evaluated
 * for the speaker the `say` chooses, so walkers that keep a speaker context take them through this.
 */
export function sayOperands(parts: SayParts): readonly Expression[] {
  return [
    ...(parts.presentation === null ? [] : [parts.presentation]),
    parts.value,
    ...(parts.pacing === null || parts.pacing === "instant" ? [] : [parts.pacing]),
  ];
}

export function expressionChildren(expression: Expression): readonly Expression[] {
  switch (expression.kind) {
    case "booleanLiteral":
    case "nullLiteral":
    case "numberLiteral":
    case "durationLiteral":
    case "regexLiteral":
      return [];
    case "stringLiteral":
      return expression.parts.flatMap((part) =>
        part.kind === "stringInterpolation" ? [part.expression] : [],
      );
    case "identifier":
    case "interactionExpression":
    case "sayExpression":
    case "showButtonExpression":
    case "showCameraExpression":
      return [];
    case "parenthesizedExpression":
      return [expression.expression];
    case "listLiteral":
    case "setLiteral":
      return expression.elements;
    case "objectLiteral":
      return expression.properties.map((property) => property.value);
    case "dictLiteral":
      // Each key is evaluated before its value.
      return expression.entries.flatMap((entry) => [entry.key, entry.value]);
    case "propertyAccessExpression":
      return [expression.object];
    case "indexExpression":
      return [expression.object, expression.index];
    case "callExpression":
      return [
        expression.callee,
        ...(expression.presentation === undefined ? [] : [expression.presentation]),
        ...expression.arguments.map((argument) => argument.value),
      ];
    case "showPopupExpression":
      return expression.arguments.map((argument) => argument.value);
    case "unaryExpression":
    case "unitExpression":
    case "angleExpression":
      return [expression.operand];
    case "binaryExpression":
      return [expression.left, expression.right];
    case "rangeExpression":
      return [expression.start, expression.end];
    case "playMediaExpression":
      return mediaOperands(expression);
    case "typeTestExpression":
      return [expression.value];
    case "loadExpression":
      return expression.defaultValue === null
        ? [expression.key]
        : [expression.key, expression.defaultValue];
    case "tagQueryExpression":
      return tagQueryOperands(expression);
    case "timerExpression":
      return timerOperands(expression);
    case "showPermanentButtonExpression":
      return [expression.text];
  }
}

/** The comparison bounds and tag lists of a tag query, in written order, which is their evaluation order. */
export function tagQueryOperands(query: TagQueryExpression): readonly Expression[] {
  return query.steps.flatMap((step) =>
    step.kind === "tagCompare" ? [step.bound] : step.kind === "tagList" ? [step.value] : [],
  );
}

/**
 * The operands of a play command in source evaluation order: the arguments as written, then the cue positions in
 * block order.
 */
export function mediaOperands(parts: MediaParts): readonly Expression[] {
  const repeat =
    parts.repeat === null || parts.repeat.kind === "indefinite"
      ? null
      : parts.repeat.kind === "times"
        ? parts.repeat.count
        : parts.repeat.value;
  const argumentsInSourceOrder = [parts.file, repeat, parts.startAt, parts.endAt, parts.volume]
    .filter((operand): operand is Expression => operand !== null)
    .sort((left, right) => left.span.start.offset - right.span.start.offset);
  const cueOffsets =
    parts.handlers?.kind === "cues"
      ? parts.handlers.cues.flatMap((cue) => (cue.offset === null ? [] : [cue.offset]))
      : [];
  return [...argumentsInSourceOrder, ...cueOffsets];
}

/**
 * The operands of a timer in source evaluation order: the named form's `display:`, `duration:`, and `label:` as written,
 * or the short form's duration and label.
 */
export function timerOperands(timer: TimerParts): readonly Expression[] {
  return [typeof timer.display === "object" ? timer.display : null, timer.duration, timer.label]
    .filter((operand): operand is Expression => operand !== null)
    .sort((left, right) => left.span.start.offset - right.span.start.offset);
}

/** The handler blocks of a play command, in source order. */
export function mediaHandlerBlocks(parts: MediaParts): readonly Block[] {
  if (parts.handlers === null) return [];
  return parts.handlers.kind === "compact"
    ? [parts.handlers.body]
    : parts.handlers.cues.map((cue) => cue.body);
}

/** The `background:` and `timeout:` options of a `showButton` in source evaluation order. */
export function showButtonOptions(
  parts: ShowButtonParts,
): readonly { readonly name: "background" | "timeout"; readonly value: Expression }[] {
  const options = [
    ...(parts.background === null
      ? []
      : [{ name: "background" as const, value: parts.background }]),
    ...(parts.timeout === null ? [] : [{ name: "timeout" as const, value: parts.timeout }]),
  ];
  return options.sort(
    (left, right) => left.value.span.start.offset - right.value.span.start.offset,
  );
}

/**
 * The statements of the blocks that run as part of a statement: branches and loop bodies, not handler blocks. A
 * `global` with `default:` assigns where it stands.
 */
export function nestedStatements(statement: Statement): readonly Statement[] {
  switch (statement.kind) {
    case "globalStatement":
      return statement.assignment === null ? [] : [statement.assignment];
    case "ifStatement":
      return [
        ...statement.thenBlock.statements,
        ...(statement.elseBlock === null
          ? []
          : statement.elseBlock.kind === "ifStatement"
            ? [statement.elseBlock]
            : statement.elseBlock.statements),
      ];
    case "whileStatement":
    case "repeatStatement":
    case "forStatement":
      return statement.body.statements;
    case "switchStatement":
      return [
        ...statement.cases.flatMap((switchCase) => switchCase.body.statements),
        ...(statement.defaultBlock?.statements ?? []),
      ];
    default:
      return [];
  }
}

/** The timer, media, or permanent button blocks that a statement or expression registers. */
export function handlerBlocks(node: Statement | Expression): readonly Block[] {
  if (node.kind === "timerStatement" || node.kind === "timerExpression")
    return node.handler === null ? [] : [node.handler];
  if (node.kind === "showPermanentButtonStatement" || node.kind === "showPermanentButtonExpression")
    return [node.handler];
  if (node.kind === "playMediaStatement" || node.kind === "playMediaExpression")
    return mediaHandlerBlocks(node);
  return [];
}

/** The expressions a statement evaluates itself, outside its nested blocks. */
export function statementExpressions(statement: Statement): readonly Expression[] {
  switch (statement.kind) {
    case "letStatement":
      return [statement.initializer];
    case "assignmentStatement":
      return statement.target.kind === "identifier"
        ? [statement.value]
        : [...expressionChildren(statement.target), statement.value];
    case "expressionStatement":
      return [statement.expression];
    case "switchStatement":
      return [statement.subject, ...statement.cases.flatMap((switchCase) => switchCase.values)];
    case "speakerDeclaration":
      return statement.properties.map((property) => property.value);
    case "sayStatement":
      return sayOperands(statement);
    case "showButtonStatement":
      return showButtonOperands(statement);
    case "waitStatement":
      return [statement.duration];
    case "timerStatement":
      return timerOperands(statement);
    case "showPermanentButtonStatement":
      return [statement.text];
    case "playMediaStatement":
      return mediaOperands(statement);
    case "showImageStatement":
      return [statement.image];
    case "showPopupStatement":
    case "openUrlStatement":
    case "exportTextStatement":
      return statement.arguments.map((argument) => argument.value);
    case "saveStatement":
      return [statement.value, statement.key];
    case "deleteStatement":
      return [statement.key];
    case "ifStatement":
    case "whileStatement":
      return [statement.condition];
    case "repeatStatement":
      return [statement.count];
    case "forStatement":
      return [statement.iterable];
    case "returnStatement":
      return statement.value === null ? [] : [statement.value];
    case "gotoStatement":
    case "callFileStatement":
    case "fallbackStatement":
      return statement.target?.kind === "scriptTarget" ? [statement.target.expression] : [];
    default:
      return [];
  }
}

/** The direct subexpressions of an expression, including interaction operands. */
export function expressionParts(expression: Expression): readonly Expression[] {
  if (expression.kind === "interactionExpression") return askParts(expression);
  if (expression.kind === "showButtonExpression") return showButtonOperands(expression);
  if (expression.kind === "sayExpression") return sayOperands(expression);
  return expressionChildren(expression);
}

function showButtonOperands(parts: ShowButtonParts): readonly Expression[] {
  return [parts.label, ...showButtonOptions(parts).map((option) => option.value)];
}

/** The expression inside any parentheses around it. */
export function unwrap(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
}

/** The text of a string literal without interpolation, or `undefined`. */
export function staticText(expression: Expression): string | undefined {
  const literal = unwrap(expression);
  if (literal.kind !== "stringLiteral" || literal.parts.some((part) => part.kind !== "stringText"))
    return undefined;
  return literal.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join("");
}
