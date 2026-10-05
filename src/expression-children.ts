import type {
  Block,
  Expression,
  InteractionExpression,
  MediaParts,
  ShowButtonParts,
  TagQueryExpression,
} from "./ast.js";

/**
 * The operands of a basic ask in evaluation order: the question, then `hint:` and `default:` in the order they are
 * written.
 */
export function askOperands(expression: InteractionExpression): readonly Expression[] {
  const named = [expression.hint, expression.defaultValue].filter(
    (operand): operand is Expression => operand !== null,
  );
  if (named.length === 2 && named[1]!.span.start.offset < named[0]!.span.start.offset)
    named.reverse();
  return expression.question === null ? named : [expression.question, ...named];
}
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
      return [expression.callee, ...expression.arguments.map((argument) => argument.value)];
    case "unaryExpression":
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
      return [
        ...(typeof expression.display === "object" && expression.display !== null
          ? [expression.display]
          : []),
        expression.duration,
        ...(expression.label === null ? [] : [expression.label]),
      ];
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
