import type { Block, Expression, MediaParts } from "./ast.js";
export function expressionChildren(expression: Expression): readonly Expression[] {
  switch (expression.kind) {
    case "booleanLiteral":
    case "nullLiteral":
    case "numberLiteral":
    case "durationLiteral":
      return [];
    case "stringLiteral":
      return expression.parts.flatMap((part) =>
        part.kind === "stringInterpolation" ? [part.expression] : [],
      );
    case "identifier":
    case "interactionExpression":
      return [];
    case "parenthesizedExpression":
      return [expression.expression];
    case "listLiteral":
    case "setLiteral":
      return expression.elements;
    case "objectLiteral":
      return expression.properties.map((property) => property.value);
    case "propertyAccessExpression":
      return [expression.object];
    case "indexExpression":
      return [expression.object, expression.index];
    case "callExpression":
      return [expression.callee, ...expression.arguments.map((argument) => argument.value)];
    case "unaryExpression":
      return [expression.operand];
    case "binaryExpression":
      return [expression.left, expression.right];
    case "rangeExpression":
      return [expression.start, expression.end];
    case "playMediaExpression":
      return mediaOperands(expression);
    case "timerExpression":
      return [
        ...(typeof expression.display === "object" && expression.display !== null
          ? [expression.display]
          : []),
        expression.duration,
        ...(expression.label === null ? [] : [expression.label]),
      ];
  }
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

/** The handler blocks of a play command, in source order. */
export function mediaHandlerBlocks(parts: MediaParts): readonly Block[] {
  if (parts.handlers === null) return [];
  return parts.handlers.kind === "compact"
    ? [parts.handlers.body]
    : parts.handlers.cues.map((cue) => cue.body);
}
