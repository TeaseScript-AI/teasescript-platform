import type { Expression, InteractionExpression } from "../../ast.js";
import type { SourceSpan } from "../../source.js";
import type {
  ExpressionPlan,
  Instruction,
  InteractionChoiceOption,
  InteractionKind,
  InteractionUiPayload,
  PreparedInteractionUiPayload,
} from "../../plan/model.js";
import { numberAnswerText } from "../../interaction-answers.js";
import { staticChoiceValue, staticVisibleText } from "../../static-evaluation.js";
import { compileChild, type CompileTask } from "../continuation.js";
import { askOperands, namedAskArguments } from "../../expression-children.js";
import type { InstructionCompiler, LoweredExpression } from "./compiler.js";
import {
  emitResultInteraction,
  emitPreparedResultInteraction,
  prepareInteractionSpeaker,
  lowerInteractionPayloadTask,
  lowerInteractionPayloadsTask,
  materializeDedicatedInteractionValue,
} from "./interactions.js";
import { unwrapParentheses, copySpan } from "./expression-plans.js";

// Asks: a question with its answer field, buttons, or form, whose UI is embedded when every part of it is known.

/**
 * A basic ask says its question, then opens its field; `askChoice` opens its buttons, and `askBoolean` says its
 * question, then opens its two buttons. The question and the options are evaluated once, in written order, before
 * the question is said, so a prefill that asks itself comes first. The question is said by the requesting speaker,
 * captured before any operand. It is said `instant`, so its field or buttons appear with it (owner decision on #829,
 * 2026-10-11).
 */
export function* lowerInteractionTask(
  compiler: InstructionCompiler,
  expression: InteractionExpression,
): CompileTask<LoweredExpression> {
  if (expression.interactionKind === "form" || expression.interactionKind === "booleans")
    return yield* compileChild(lowerFormTask(compiler, expression));
  const expectedResult =
    expression.interactionKind === "choice" || expression.interactionKind === "boolean"
      ? ("choice" as const)
      : expression.interactionKind === "number" || expression.interactionKind === "integer"
        ? ("number" as const)
        : expression.interactionKind === "text" || expression.interactionKind === "password"
          ? ("string" as const)
          : ("temporal" as const);

  const ui = staticInteractionUi(expression);
  const staticQuestion =
    expression.question === null ? null : staticVisibleText(expression.question);
  if (ui !== undefined && staticQuestion !== undefined && expression.presentation === null) {
    if (staticQuestion !== null) {
      // Said and asked by the same speaker: nothing runs between the two instructions.
      compiler.instructions.push({
        kind: "say",
        presentation: null,
        speaker: expression.speaker?.name ?? null,
        value: {
          kind: "literal",
          value: staticQuestion,
          span: copySpan(expression.question!.span),
        },
        skipPolicy: null,
        pacing: "instant",
        span: copySpan(expression.span),
      });
    }
    return emitResultInteraction(
      compiler,
      {
        interactionKind: planInteractionKind(expression),
        target: "standardChat",
        speaker: expression.speaker?.name ?? null,
        expectedResult,
        ui,
        span: copySpan(expression.span),
      },
      expression.span,
    );
  }
  if (expression.interactionKind === "boolean")
    return yield* compileChild(lowerAskBooleanTask(compiler, expression));

  const values =
    expression.interactionKind === "choice"
      ? expression.options.map((option) => option.expression)
      : [];
  const speakerTemporary = prepareInteractionSpeaker(
    compiler,
    expression.speaker?.name ?? null,
    expression.asSpan ?? expression.commandSpan,
  );
  let preparedUi: PreparedInteractionUiPayload;
  const preparedTemporaryIds: number[] = [speakerTemporary];

  if (expression.interactionKind !== "choice") {
    const { hint, prefill } = yield* compileChild(
      lowerAskQuestionTask(compiler, expression, speakerTemporary),
    );
    if (hint !== null) preparedTemporaryIds.push(hint.temporaryId);
    if (prefill !== null) preparedTemporaryIds.push(prefill.temporaryId);
    preparedUi =
      expression.interactionKind === "password"
        ? {
            kind: "password",
            hintTemporary: hint?.temporaryId ?? null,
            accessibleName: { kind: "localizedDefault", key: "password" },
          }
        : expression.interactionKind === "text"
          ? {
              kind: "text",
              hintTemporary: hint?.temporaryId ?? null,
              ...(prefill === null ? {} : { prefillTemporary: prefill.temporaryId }),
              accessibleName: { kind: "localizedDefault", key: "answer" },
            }
          : expression.interactionKind === "number" || expression.interactionKind === "integer"
            ? {
                kind: "number",
                hintTemporary: hint?.temporaryId ?? null,
                ...(prefill === null ? {} : { prefillTemporary: prefill.temporaryId }),
                ...(expression.interactionKind === "integer" ? { integer: true as const } : {}),
                accessibleName: { kind: "localizedDefault", key: "number" },
              }
            : {
                kind: "temporal",
                temporalKind: expression.interactionKind,
                hintTemporary: hint?.temporaryId ?? null,
                ...(prefill === null ? {} : { prefillTemporary: prefill.temporaryId }),
                accessibleName: { kind: "localizedDefault", key: "answer" },
              };
  } else {
    // The `prefill:` after the options is evaluated after them.
    const loweredValues = yield* compileChild(
      lowerInteractionPayloadsTask(
        compiler,
        expression.prefill === null ? values : [...values, expression.prefill],
        speakerTemporary,
      ),
    );
    const optionsTemporary = compiler.allocateTemporary();
    compiler.instructions.push({
      kind: "storeTemporary",
      temporaryId: optionsTemporary,
      value: {
        kind: "list",
        elements: loweredValues.slice(0, values.length).map((item) => item.plan),
        span: copySpan(expression.span),
      },
      expectBoolean: false,
      span: copySpan(expression.span),
    });
    preparedTemporaryIds.push(optionsTemporary);
    let prefillTemporary: number | undefined;
    if (expression.prefill !== null) {
      prefillTemporary = compiler.allocateTemporary();
      compiler.instructions.push({
        kind: "storeTemporary",
        temporaryId: prefillTemporary,
        value: loweredValues[values.length]!.plan,
        expectBoolean: false,
        span: copySpan(expression.prefill.span),
      });
      preparedTemporaryIds.push(prefillTemporary);
    }
    compiler.emitTemporaryCleanup(
      loweredValues.flatMap((item) => item.temporaryIds),
      expression.span,
    );
    preparedUi = {
      kind: "choice",
      optionsTemporary,
      values: expression.options.map((option) =>
        option.value === null ? null : authoredChoiceValue(option.value),
      ),
      ...(prefillTemporary === undefined ? {} : { prefillTemporary }),
      accessibleName: { kind: "localizedDefault", key: "chooseOption" },
    };
  }

  const lowered = emitPreparedResultInteraction(
    compiler,
    planInteractionKind(expression),
    expectedResult,
    speakerTemporary,
    preparedUi,
    expression.span,
  );
  compiler.emitTemporaryCleanup(preparedTemporaryIds, expression.span);
  return lowered;
}

/**
 * A basic ask's question and its `hint:` and `prefill:`: the question's speaker, mode, and text are prepared, the named
 * arguments are evaluated in written order into temporaries, and then the question is said. The caller clears the
 * temporaries it is given.
 */
export function* lowerAskQuestionTask(
  compiler: InstructionCompiler,
  expression: InteractionExpression,
  speakerTemporary: number,
): CompileTask<{
  readonly hint: { readonly temporaryId: number } | null;
  readonly prefill: { readonly temporaryId: number } | null;
}> {
  let question: Extract<Instruction, { kind: "say" }> | null = null;
  let questionTemporaryIds: number[] = [];
  if (expression.question !== null) {
    const sayTemporaries = prepareQuestionSpeaker(
      compiler,
      expression.speaker?.name ?? null,
      expression.asSpan ?? expression.commandSpan,
    );
    const presentation = yield* compileChild(
      lowerQuestionPresentationTask(
        compiler,
        expression.presentation ?? undefined,
        speakerTemporary,
      ),
    );
    const lowered = yield* compileChild(
      lowerInteractionPayloadTask(compiler, expression.question, speakerTemporary),
    );
    const textTemporary = compiler.allocateTemporary();
    compiler.instructions.push({
      kind: "prepareSayText",
      value: lowered.plan,
      destinationTemporary: textTemporary,
      field: true,
      span: copySpan(expression.question.span),
    });
    compiler.emitTemporaryCleanup(lowered.temporaryIds, expression.question.span);
    question = {
      kind: "say",
      presentation: presentation?.plan ?? null,
      speaker: expression.speaker?.name ?? null,
      value: lowered.plan,
      ...sayTemporaries,
      textTemporary,
      skipPolicy: null,
      pacing: "instant",
      span: copySpan(expression.span),
    };
    questionTemporaryIds = [
      sayTemporaries.speakerTemporary,
      sayTemporaries.contextualSpeakerTemporary,
      ...(presentation?.temporaryIds ?? []),
      textTemporary,
    ];
  }
  let hint: { readonly temporaryId: number } | null = null;
  let prefill: { readonly temporaryId: number } | null = null;
  for (const operand of askOperands(expression)) {
    if (operand === expression.question || operand === expression.presentation) continue;
    const materialized = materializeDedicatedInteractionValue(
      compiler,
      yield* compileChild(lowerInteractionPayloadTask(compiler, operand, speakerTemporary)),
      operand.span,
    );
    if (operand === expression.hint) hint = materialized;
    else prefill = materialized;
  }
  if (question !== null) {
    compiler.instructions.push(question);
    compiler.emitTemporaryCleanup(questionTemporaryIds, expression.span);
  }
  return { hint, prefill };
}

/**
 * `askForm` and `askBooleans`: after the requesting speaker, the question and the named arguments are evaluated once,
 * in written order, into one object that the form reads when it opens. Like a basic ask, it then says its question,
 * read from that object, and the form opens with the shape the type check found, or as a list of toggles for
 * `askBooleans`.
 */
function* lowerFormTask(
  compiler: InstructionCompiler,
  expression: InteractionExpression,
): CompileTask<LoweredExpression> {
  const { speakerTemporary, requestTemporary } = yield* compileChild(
    prepareAskRequestTask(compiler, expression),
  );
  const lowered = emitPreparedResultInteraction(
    compiler,
    "form",
    "form",
    speakerTemporary,
    {
      kind: "form",
      requestTemporary,
      shape:
        expression.interactionKind === "booleans"
          ? { kind: "booleanList" }
          : (compiler.formShapes.get(expression) ?? { kind: "unknown" }),
      accessibleName: { kind: "localizedDefault", key: "answer" },
    },
    expression.span,
  );
  compiler.emitTemporaryCleanup([speakerTemporary, requestTemporary], expression.span);
  return lowered;
}

/**
 * `askBoolean` with an operand only known at runtime, or with its question named `message:`: like a form, its
 * arguments are evaluated in written order into one object, from which it says its question. Its two buttons,
 * `yesText:` (default "Yes") returning `true` and `noText:` (default "No") returning `false`, then open as an
 * `askChoice` of two choice objects.
 */
function* lowerAskBooleanTask(
  compiler: InstructionCompiler,
  expression: InteractionExpression,
): CompileTask<LoweredExpression> {
  const span = copySpan(expression.span);
  const { speakerTemporary, requestTemporary } = yield* compileChild(
    prepareAskRequestTask(compiler, expression),
  );
  const written = new Set(expression.formArguments.map((argument) => argument.name.name));
  const request: ExpressionPlan = { kind: "temporary", temporaryId: requestTemporary, span };
  const button = (name: string, value: boolean): ExpressionPlan => ({
    kind: "object",
    properties: [
      {
        name: "text",
        value: written.has(name)
          ? { kind: "property", object: request, name, span }
          : { kind: "literal", value: ASK_BOOLEAN_TEXTS[name]!, span },
        span,
      },
      { name: "value", value: { kind: "literal", value, span }, span },
    ],
    span,
  });
  const optionsTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "storeTemporary",
    temporaryId: optionsTemporary,
    value: { kind: "list", elements: [button("yesText", true), button("noText", false)], span },
    expectBoolean: false,
    span,
  });
  // `prefill:` preselects the button whose value it is.
  let prefillTemporary: number | undefined;
  if (written.has("prefill")) {
    prefillTemporary = compiler.allocateTemporary();
    compiler.instructions.push({
      kind: "storeTemporary",
      temporaryId: prefillTemporary,
      value: { kind: "property", object: request, name: "prefill", span },
      expectBoolean: false,
      span,
    });
  }
  compiler.emitTemporaryCleanup([requestTemporary], expression.span);
  const lowered = emitPreparedResultInteraction(
    compiler,
    "choice",
    "choice",
    speakerTemporary,
    {
      kind: "choice",
      optionsTemporary,
      values: [null, null],
      ...(prefillTemporary === undefined
        ? {}
        : { prefillTemporary, booleanPrefill: true as const }),
      accessibleName: { kind: "localizedDefault", key: "chooseOption" },
    },
    expression.span,
  );
  compiler.emitTemporaryCleanup(
    [
      speakerTemporary,
      optionsTemporary,
      ...(prefillTemporary === undefined ? [] : [prefillTemporary]),
    ],
    expression.span,
  );
  return lowered;
}

/**
 * The requesting speaker, then the question, as `message`, and the named arguments of `askForm`, `askBoolean`, or
 * `askBooleans`, evaluated once, in written order, into one object; then the question, read from that object, said by
 * that speaker.
 */
function* prepareAskRequestTask(
  compiler: InstructionCompiler,
  expression: InteractionExpression,
): CompileTask<{ readonly speakerTemporary: number; readonly requestTemporary: number }> {
  const speaker = expression.speaker?.name ?? null;
  const speakerSpan = expression.asSpan ?? expression.commandSpan;
  const speakerTemporary = prepareInteractionSpeaker(compiler, speaker, speakerSpan);
  const named = namedAskArguments(expression);
  const sayTemporaries = named.some((argument) => argument.name === "message")
    ? prepareQuestionSpeaker(compiler, speaker, speakerSpan)
    : null;
  const presentation =
    sayTemporaries === null
      ? null
      : yield* compileChild(
          lowerQuestionPresentationTask(
            compiler,
            expression.presentation ?? undefined,
            speakerTemporary,
          ),
        );
  const values = yield* compileChild(
    lowerInteractionPayloadsTask(
      compiler,
      named.map((argument) => argument.value),
      speakerTemporary,
    ),
  );
  const requestTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "storeTemporary",
    temporaryId: requestTemporary,
    value: {
      kind: "object",
      properties: named.map((argument, index) => ({
        // The request of `askBooleans` keeps its earlier name for the `prefill:` list.
        name:
          expression.interactionKind === "booleans" && argument.name === "prefill"
            ? "defaults"
            : argument.name,
        value: values[index]!.plan,
        span: copySpan(argument.value.span),
      })),
      span: copySpan(expression.span),
    },
    expectBoolean: false,
    span: copySpan(expression.span),
  });
  compiler.emitTemporaryCleanup(
    values.flatMap((value) => value.temporaryIds),
    expression.span,
  );
  if (sayTemporaries !== null) {
    const question: ExpressionPlan = {
      kind: "property",
      object: { kind: "temporary", temporaryId: requestTemporary, span: copySpan(expression.span) },
      name: "message",
      span: copySpan(expression.span),
    };
    const textTemporary = compiler.allocateTemporary();
    compiler.instructions.push({
      kind: "prepareSayText",
      value: question,
      destinationTemporary: textTemporary,
      field: true,
      span: copySpan(expression.span),
    });
    compiler.instructions.push({
      kind: "say",
      presentation: presentation?.plan ?? null,
      speaker,
      value: question,
      ...sayTemporaries,
      textTemporary,
      skipPolicy: null,
      pacing: "instant",
      span: copySpan(expression.span),
    });
    compiler.emitTemporaryCleanup(
      [
        sayTemporaries.speakerTemporary,
        sayTemporaries.contextualSpeakerTemporary,
        ...(presentation?.temporaryIds ?? []),
        textTemporary,
      ],
      expression.span,
    );
  }
  return { speakerTemporary, requestTemporary };
}

/**
 * `askImage(...)`: the written arguments are evaluated once, in source order, into one object, which the interaction
 * reads when it opens. It is always prepared: its request is checked then. Like a basic ask, it first says its
 * question, the message, read from that object; `speaker` in its mode and in every argument is the asking speaker.
 */
export function* lowerAskImageTask(
  compiler: InstructionCompiler,
  expression: Extract<Expression, { kind: "callExpression" }>,
): CompileTask<LoweredExpression> {
  const speakerTemporary = prepareInteractionSpeaker(compiler, null, expression.span);
  const asksQuestion = expression.arguments.some(
    (argument) => argument.kind === "positionalArgument" || argument.name.name === "message",
  );
  const sayTemporaries = asksQuestion
    ? prepareQuestionSpeaker(compiler, null, expression.span)
    : null;
  const presentation =
    sayTemporaries === null
      ? null
      : yield* compileChild(
          lowerQuestionPresentationTask(compiler, expression.presentation, speakerTemporary),
        );
  const values = yield* compileChild(
    lowerInteractionPayloadsTask(
      compiler,
      expression.arguments.map((argument) => argument.value),
      speakerTemporary,
    ),
  );
  const requestTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "storeTemporary",
    temporaryId: requestTemporary,
    value: {
      kind: "object",
      properties: expression.arguments.map((argument, index) => ({
        name: argument.kind === "namedArgument" ? argument.name.name : "message",
        value: values[index]!.plan,
        span: copySpan(argument.span),
      })),
      span: copySpan(expression.span),
    },
    expectBoolean: false,
    span: copySpan(expression.span),
  });
  compiler.emitTemporaryCleanup(
    values.flatMap((value) => value.temporaryIds),
    expression.span,
  );
  if (sayTemporaries !== null) {
    const question: ExpressionPlan = {
      kind: "property",
      object: { kind: "temporary", temporaryId: requestTemporary, span: copySpan(expression.span) },
      name: "message",
      span: copySpan(expression.span),
    };
    const textTemporary = compiler.allocateTemporary();
    compiler.instructions.push({
      kind: "prepareSayText",
      value: question,
      destinationTemporary: textTemporary,
      field: true,
      span: copySpan(expression.span),
    });
    compiler.instructions.push({
      kind: "say",
      presentation: presentation?.plan ?? null,
      speaker: null,
      value: question,
      ...sayTemporaries,
      textTemporary,
      skipPolicy: null,
      pacing: "instant",
      span: copySpan(expression.span),
    });
    compiler.emitTemporaryCleanup(
      [
        sayTemporaries.speakerTemporary,
        sayTemporaries.contextualSpeakerTemporary,
        ...(presentation?.temporaryIds ?? []),
        textTemporary,
      ],
      expression.span,
    );
  }
  const lowered = emitPreparedResultInteraction(
    compiler,
    "image",
    "string",
    speakerTemporary,
    {
      kind: "image",
      requestTemporary,
      accessibleName: { kind: "localizedDefault", key: "answer" },
    },
    expression.span,
  );
  compiler.emitTemporaryCleanup([speakerTemporary, requestTemporary], expression.span);
  return lowered;
}

/**
 * The output speaker of an ask question, captured right after the requesting speaker, which it therefore matches:
 * both are the named speaker or else the default one.
 */
function prepareQuestionSpeaker(
  compiler: InstructionCompiler,
  speaker: string | null,
  span: SourceSpan,
): { readonly speakerTemporary: number; readonly contextualSpeakerTemporary: number } {
  const speakerTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "prepareSaySpeaker",
    speaker,
    destinationTemporary: speakerTemporary,
    span: copySpan(span),
  });
  const contextualSpeakerTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "prepareSayContextualSpeaker",
    speakerTemporary,
    destinationTemporary: contextualSpeakerTemporary,
    span: copySpan(span),
  });
  return { speakerTemporary, contextualSpeakerTemporary };
}

/**
 * The options of the mode written for an ask's question, `bubble(...)` or `prose(...)` (#832), evaluated once before
 * the question as those of a `say` are, into a temporary its `say` reads; `null` when none is written.
 */
function* lowerQuestionPresentationTask(
  compiler: InstructionCompiler,
  presentation: Expression | undefined,
  speakerTemporary: number,
): CompileTask<LoweredExpression | null> {
  if (presentation === undefined) return null;
  return compiler.materializeExpression(
    yield* compileChild(lowerInteractionPayloadTask(compiler, presentation, speakerTemporary)),
    presentation.span,
  );
}

/** The value written before `:` in a choice option: an identifier is text, a numeric literal a number. */
function authoredChoiceValue(
  value: NonNullable<InteractionExpression["options"][number]["value"]>,
): string | number {
  return value.kind === "identifier" ? value.name : Object.is(value.value, -0) ? 0 : value.value;
}

/**
 * The prefill text of a literal `prefill:` answer, or `undefined` when the prefill is evaluated at runtime, where
 * arithmetic, also inside an interpolation, keeps its ordinary runtime errors. Semantic validation has already rejected
 * literals of the wrong type.
 */
function staticInteractionPrefill(expression: InteractionExpression): string | undefined {
  const kind = expression.interactionKind;
  // A date or time prefill is a value that the field shows as ISO text when it opens.
  if (kind === "date" || kind === "time" || kind === "datetime") return undefined;
  let literal = expression.prefill!;
  let negative = false;
  while (
    literal.kind === "parenthesizedExpression" ||
    (expression.interactionKind !== "text" &&
      literal.kind === "unaryExpression" &&
      (literal.operator === "-" || literal.operator === "+"))
  ) {
    if (literal.kind === "unaryExpression") {
      negative = negative !== (literal.operator === "-");
      literal = literal.operand;
    } else literal = literal.expression;
  }
  if (expression.interactionKind !== "text")
    return literal.kind === "numberLiteral"
      ? numberAnswerText(negative ? -literal.value : literal.value)
      : undefined;
  return literal.kind === "stringLiteral" &&
    literal.parts.every((part) => part.kind === "stringText")
    ? staticVisibleText(literal)
    : undefined;
}

/** The texts of the `askBoolean` buttons without `yesText:` or `noText:` (V30 §20). */
const ASK_BOOLEAN_TEXTS: Readonly<Record<string, string>> = { yesText: "Yes", noText: "No" };

/**
 * `askInteger` runs as a `number` interaction whose UI only accepts whole numbers, `askDate`, `askTime`, and
 * `askDateTime` as a `temporal` interaction whose UI says what it asks for, `askBoolean` as a `choice` of two buttons,
 * and `askBooleans` as a `form`.
 */
function planInteractionKind(expression: InteractionExpression): InteractionKind {
  switch (expression.interactionKind) {
    case "integer":
      return "number";
    case "date":
    case "time":
    case "datetime":
      return "temporal";
    case "boolean":
      return "choice";
    case "booleans":
      return "form";
    default:
      return expression.interactionKind;
  }
}

/** The UI of an interaction whose hint, values, and prefill are all known at compile time. */
function staticInteractionUi(expression: InteractionExpression): InteractionUiPayload | undefined {
  // A form reads its fields when it opens.
  if (expression.interactionKind === "form" || expression.interactionKind === "booleans")
    return undefined;
  if (expression.interactionKind === "boolean") {
    // A question written as `message:` is said from the prepared arguments.
    if (expression.formArguments.some((argument) => argument.name.name === "message"))
      return undefined;
    const options: InteractionChoiceOption[] = [];
    for (const [name, value] of [
      ["yesText", true],
      ["noText", false],
    ] as const) {
      const written = expression.formArguments.find((argument) => argument.name.name === name);
      const text =
        written === undefined ? ASK_BOOLEAN_TEXTS[name]! : staticVisibleText(written.value);
      if (text === undefined) return undefined;
      options.push({ text, value });
    }
    // A literal `prefill:` preselects its button: Yes for `true`, No for `false`.
    const prefill = expression.formArguments.find((argument) => argument.name.name === "prefill");
    const preselected = prefill === undefined ? undefined : unwrapParentheses(prefill.value);
    if (preselected !== undefined && preselected.kind !== "booleanLiteral") return undefined;
    return {
      kind: "choice",
      options,
      ...(preselected === undefined ? {} : { preselected: preselected.value ? 0 : 1 }),
      accessibleName: { kind: "localizedDefault", key: "chooseOption" },
    };
  }
  // A choice with `prefill:` finds its preselected button when it opens.
  if (expression.interactionKind === "choice" && expression.prefill !== null) return undefined;
  if (expression.interactionKind !== "choice") {
    const hint = expression.hint === null ? null : staticVisibleText(expression.hint);
    const prefill = expression.prefill === null ? null : staticInteractionPrefill(expression);
    if (hint === undefined || prefill === undefined) return undefined;
    if (expression.interactionKind === "password")
      return {
        kind: "password",
        hint,
        accessibleName: { kind: "localizedDefault", key: "password" },
      };
    return expression.interactionKind === "text"
      ? {
          kind: "text",
          hint,
          ...(prefill === null ? {} : { prefill }),
          accessibleName: { kind: "localizedDefault", key: "answer" },
        }
      : expression.interactionKind === "number" || expression.interactionKind === "integer"
        ? {
            kind: "number",
            hint,
            ...(prefill === null ? {} : { prefill }),
            ...(expression.interactionKind === "integer" ? { integer: true as const } : {}),
            accessibleName: { kind: "localizedDefault", key: "number" },
          }
        : {
            kind: "temporal",
            temporalKind: expression.interactionKind,
            hint,
            ...(prefill === null ? {} : { prefill }),
            accessibleName: { kind: "localizedDefault", key: "answer" },
          };
  }
  const options: InteractionChoiceOption[] = [];
  for (const option of expression.options) {
    const text = staticVisibleText(option.expression);
    const known = option.value === null ? staticChoiceValue(option.expression) : undefined;
    if (text === undefined || (option.value === null && known === undefined)) return undefined;
    options.push({
      text,
      value: option.value === null ? known!.value : authoredChoiceValue(option.value),
    });
  }
  return {
    kind: "choice",
    options,
    accessibleName: { kind: "localizedDefault", key: "chooseOption" },
  };
}
