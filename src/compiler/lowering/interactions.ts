import type {
  CallArgument,
  Expression,
  ShowButtonParts,
  ShowPopupParts,
  OpenUrlStatement,
  ExportTextStatement,
} from "../../ast.js";
import type { SourceSpan } from "../../source.js";
import type {
  InteractionKind,
  InteractionResultDomain,
  InteractionUiPayload,
  PreparedInteractionUiPayload,
} from "../../plan/model.js";
import { DEFAULT_OPEN_URL_BUTTON_TEXT, DEFAULT_POPUP_BUTTON_TEXT } from "../../plan/model.js";
import { canonicalWebUrl } from "../../web-url.js";
import { staticVisibleText } from "../../static-evaluation.js";
import { compileChild, type CompileTask } from "../continuation.js";
import { showButtonOptions } from "../../expression-children.js";
import type { InstructionCompiler, LoweredExpression } from "./compiler.js";
import { planSpan } from "./expression-plans.js";

// Buttons, popups, web addresses, exports, and what every interaction shares: its speaker, operands, and result.

/**
 * Lowers a `showButton`. A static label without options embeds its UI; otherwise the requesting speaker, the label,
 * and the options are prepared in source order. As a value, the button yields its elapsed waiting time.
 */
export function* lowerShowButtonTask(
  compiler: InstructionCompiler,
  parts: ShowButtonParts,
  valueWanted: boolean,
): CompileTask<LoweredExpression | null> {
  const expectedResult = valueWanted ? "duration" : "none";
  const accessibleName = { kind: "localizedDefault", key: "continue" } as const;
  const staticLabel = staticVisibleText(parts.label);
  if (staticLabel !== undefined && parts.background === null && parts.timeout === null) {
    const instruction = {
      interactionKind: "button",
      target: "standardChat",
      speaker: parts.speaker?.name ?? null,
      expectedResult,
      ui: { kind: "button", buttonLabel: staticLabel, accessibleName },
      span: planSpan(parts.span),
    } as const;
    if (valueWanted) return emitResultInteraction(compiler, instruction, parts.span);
    compiler.instructions.push({ kind: "interaction", ...instruction, destinationTemporary: null });
    return null;
  }

  const speakerTemporary = prepareInteractionSpeaker(
    compiler,
    parts.speaker?.name ?? null,
    parts.asSpan ?? parts.commandSpan,
  );
  const label = materializeDedicatedInteractionValue(
    compiler,
    yield* compileChild(lowerInteractionPayloadTask(compiler, parts.label, speakerTemporary)),
    parts.label.span,
  );
  const optionTemporaries: { background?: number; timeout?: number } = {};
  for (const option of showButtonOptions(parts)) {
    optionTemporaries[option.name] = materializeDedicatedInteractionValue(
      compiler,
      yield* compileChild(lowerInteractionPayloadTask(compiler, option.value, speakerTemporary)),
      option.value.span,
    ).temporaryId;
  }
  const { background, timeout } = optionTemporaries;
  const preparedUi: PreparedInteractionUiPayload = {
    kind: "button",
    buttonLabelTemporary: label.temporaryId,
    ...(background === undefined ? {} : { backgroundTemporary: background }),
    ...(timeout === undefined ? {} : { timeoutTemporary: timeout }),
    accessibleName,
  };
  const preparedTemporaryIds = [
    speakerTemporary,
    label.temporaryId,
    ...Object.values(optionTemporaries),
  ];
  let lowered: LoweredExpression | null = null;
  if (valueWanted) {
    lowered = emitPreparedResultInteraction(
      compiler,
      "button",
      "duration",
      speakerTemporary,
      preparedUi,
      parts.span,
    );
  } else {
    compiler.instructions.push({
      kind: "interaction",
      interactionKind: "button",
      target: "standardChat",
      speakerTemporary,
      destinationTemporary: null,
      expectedResult: "none",
      preparedUi,
      span: planSpan(parts.span),
    });
  }
  compiler.emitTemporaryCleanup(preparedTemporaryIds, parts.span);
  return lowered;
}

/**
 * Lowers a `showPopup` (V30 §31). A static message and button text embed the popup's UI; otherwise the requesting
 * speaker is captured, as for any interaction, and the written arguments are evaluated once, in written order, into
 * temporaries that the popup reads when it opens. As a value, the popup yields its elapsed waiting time, as a button
 * does.
 */
export function* lowerShowPopupTask(
  compiler: InstructionCompiler,
  parts: ShowPopupParts,
  valueWanted: boolean,
): CompileTask<LoweredExpression | null> {
  const expectedResult = valueWanted ? "duration" : "none";
  const accessibleName = { kind: "localizedDefault", key: "continue" } as const;
  const message = parts.arguments.find(
    (argument) => argument.kind === "positionalArgument" || argument.name.name === "message",
  );
  if (message === undefined) throw new TypeError("A popup without a message reached lowering.");
  const buttonText = parts.arguments.find((argument) => argument !== message);
  const staticMessage = staticVisibleText(message.value);
  const staticButtonText =
    buttonText === undefined ? DEFAULT_POPUP_BUTTON_TEXT : staticVisibleText(buttonText.value);
  if (staticMessage !== undefined && staticButtonText !== undefined) {
    const instruction = {
      interactionKind: "popup",
      target: "standardChat",
      speaker: null,
      expectedResult,
      ui: { kind: "popup", message: staticMessage, buttonText: staticButtonText, accessibleName },
      span: planSpan(parts.span),
    } as const;
    if (valueWanted) return emitResultInteraction(compiler, instruction, parts.span);
    compiler.instructions.push({ kind: "interaction", ...instruction, destinationTemporary: null });
    return null;
  }
  const speakerTemporary = prepareInteractionSpeaker(compiler, null, parts.span);
  const temporaries = new Map<CallArgument, number>();
  for (const argument of parts.arguments)
    temporaries.set(
      argument,
      materializeDedicatedInteractionValue(
        compiler,
        yield* compileChild(compiler.lowerExpressionTask(argument.value)),
        argument.value.span,
      ).temporaryId,
    );
  const buttonTextTemporary = buttonText === undefined ? undefined : temporaries.get(buttonText);
  const preparedUi: PreparedInteractionUiPayload = {
    kind: "popup",
    messageTemporary: temporaries.get(message)!,
    ...(buttonTextTemporary === undefined ? {} : { buttonTextTemporary }),
    accessibleName,
  };
  let lowered: LoweredExpression | null = null;
  if (valueWanted) {
    lowered = emitPreparedResultInteraction(
      compiler,
      "popup",
      "duration",
      speakerTemporary,
      preparedUi,
      parts.span,
    );
  } else {
    compiler.instructions.push({
      kind: "interaction",
      interactionKind: "popup",
      target: "standardChat",
      speakerTemporary,
      destinationTemporary: null,
      expectedResult: "none",
      preparedUi,
      span: planSpan(parts.span),
    });
  }
  compiler.emitTemporaryCleanup([speakerTemporary, ...temporaries.values()], parts.span);
  return lowered;
}

/**
 * Lowers an `openUrl` (V30 §33), which waits until the Player opened its web address. A written address, button text,
 * and `alwaysButton:` embed the request; the address is checked and made canonical here. Otherwise the arguments are
 * evaluated once, in written order, into temporaries that the request checks when it opens.
 */
export function* lowerOpenUrlTask(
  compiler: InstructionCompiler,
  statement: OpenUrlStatement,
): CompileTask<void> {
  const accessibleName = { kind: "localizedDefault", key: "continue" } as const;
  const [address] = statement.arguments;
  if (address === undefined) throw new TypeError("openUrl without an address reached lowering.");
  const named = (name: string) =>
    statement.arguments.find(
      (argument) => argument.kind === "namedArgument" && argument.name.name === name,
    );
  const buttonText = named("buttonText");
  const alwaysButton = named("alwaysButton");
  const written = staticVisibleText(address.value);
  const url = written === undefined ? null : canonicalWebUrl(written);
  const staticButtonText =
    buttonText === undefined ? DEFAULT_OPEN_URL_BUTTON_TEXT : staticVisibleText(buttonText.value);
  let writtenAlways = alwaysButton?.value;
  while (writtenAlways?.kind === "parenthesizedExpression")
    writtenAlways = writtenAlways.expression;
  const staticAlways =
    writtenAlways === undefined
      ? false
      : writtenAlways.kind === "booleanLiteral"
        ? writtenAlways.value
        : undefined;
  if (url !== null && staticButtonText !== undefined && staticAlways !== undefined) {
    compiler.instructions.push({
      kind: "interaction",
      interactionKind: "url",
      target: "standardChat",
      speaker: null,
      destinationTemporary: null,
      expectedResult: "none",
      ui: {
        kind: "url",
        url,
        buttonText: staticButtonText,
        alwaysButton: staticAlways,
        accessibleName,
      },
      span: planSpan(statement.span),
    });
    return;
  }
  const speakerTemporary = prepareInteractionSpeaker(compiler, null, statement.span);
  const temporaries = new Map<CallArgument, number>();
  for (const argument of statement.arguments)
    temporaries.set(
      argument,
      materializeDedicatedInteractionValue(
        compiler,
        yield* compileChild(compiler.lowerExpressionTask(argument.value)),
        argument.value.span,
      ).temporaryId,
    );
  const buttonTextTemporary = buttonText === undefined ? undefined : temporaries.get(buttonText);
  const alwaysButtonTemporary =
    alwaysButton === undefined ? undefined : temporaries.get(alwaysButton);
  compiler.instructions.push({
    kind: "interaction",
    interactionKind: "url",
    target: "standardChat",
    speakerTemporary,
    destinationTemporary: null,
    expectedResult: "none",
    preparedUi: {
      kind: "url",
      urlTemporary: temporaries.get(address)!,
      ...(buttonTextTemporary === undefined ? {} : { buttonTextTemporary }),
      ...(alwaysButtonTemporary === undefined ? {} : { alwaysButtonTemporary }),
      accessibleName,
    },
    span: planSpan(statement.span),
  });
  compiler.emitTemporaryCleanup([speakerTemporary, ...temporaries.values()], statement.span);
}

/**
 * Lowers an `exportText` (V30 §31), which waits until the player closes its dialog. The written arguments are
 * evaluated once, in written order, into temporaries that the dialog reads when it opens; its text is never embedded,
 * as it may be as long as any text.
 */
export function* lowerExportTextTask(
  compiler: InstructionCompiler,
  statement: ExportTextStatement,
): CompileTask<void> {
  const [text] = statement.arguments;
  if (text === undefined) throw new TypeError("exportText without its text reached lowering.");
  const named = (name: string) =>
    statement.arguments.find(
      (argument) => argument.kind === "namedArgument" && argument.name.name === name,
    );
  const title = named("title");
  const fileName = named("fileName");
  const speakerTemporary = prepareInteractionSpeaker(compiler, null, statement.span);
  const temporaries = new Map<CallArgument, number>();
  for (const argument of statement.arguments)
    temporaries.set(
      argument,
      materializeDedicatedInteractionValue(
        compiler,
        yield* compileChild(compiler.lowerExpressionTask(argument.value)),
        argument.value.span,
      ).temporaryId,
    );
  const titleTemporary = title === undefined ? undefined : temporaries.get(title);
  const fileNameTemporary = fileName === undefined ? undefined : temporaries.get(fileName);
  compiler.instructions.push({
    kind: "interaction",
    interactionKind: "export",
    target: "standardChat",
    speakerTemporary,
    destinationTemporary: null,
    expectedResult: "none",
    preparedUi: {
      kind: "export",
      textTemporary: temporaries.get(text)!,
      ...(titleTemporary === undefined ? {} : { titleTemporary }),
      ...(fileNameTemporary === undefined ? {} : { fileNameTemporary }),
      accessibleName: { kind: "localizedDefault", key: "continue" },
    },
    span: planSpan(statement.span),
  });
  compiler.emitTemporaryCleanup([speakerTemporary, ...temporaries.values()], statement.span);
}

export function emitResultInteraction(
  compiler: InstructionCompiler,
  instruction: Omit<
    Extract<
      import("../../plan/model.js").InteractionInstruction,
      { readonly ui: InteractionUiPayload }
    >,
    "kind" | "destinationTemporary"
  >,
  span: SourceSpan,
): LoweredExpression {
  const transientTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "interaction",
    ...instruction,
    destinationTemporary: transientTemporary,
  });
  return consumeInteractionResult(compiler, transientTemporary, span);
}

export function emitPreparedResultInteraction(
  compiler: InstructionCompiler,
  interactionKind: InteractionKind,
  expectedResult: Exclude<InteractionResultDomain, "none">,
  speakerTemporary: number,
  preparedUi: PreparedInteractionUiPayload,
  span: SourceSpan,
): LoweredExpression {
  const transientTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "interaction",
    interactionKind,
    target: "standardChat",
    speakerTemporary,
    destinationTemporary: transientTemporary,
    expectedResult,
    preparedUi,
    span: planSpan(span),
  });
  return consumeInteractionResult(compiler, transientTemporary, span);
}

export function consumeInteractionResult(
  compiler: InstructionCompiler,
  transientTemporary: number,
  span: SourceSpan,
): LoweredExpression {
  const ordinaryTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "storeTemporary",
    temporaryId: ordinaryTemporary,
    value: { kind: "temporary", temporaryId: transientTemporary, span: planSpan(span) },
    expectBoolean: false,
    span: planSpan(span),
  });
  compiler.instructions.push({
    kind: "clearTemporary",
    temporaryId: transientTemporary,
    span: planSpan(span),
  });
  return {
    plan: { kind: "temporary", temporaryId: ordinaryTemporary, span: planSpan(span) },
    temporaryIds: [ordinaryTemporary],
  };
}

export function prepareInteractionSpeaker(
  compiler: InstructionCompiler,
  speaker: string | null,
  span: SourceSpan,
): number {
  const destinationTemporary = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "prepareInteractionSpeaker",
    speaker,
    destinationTemporary,
    span: planSpan(span),
  });
  return destinationTemporary;
}

export function* lowerInteractionPayloadTask(
  compiler: InstructionCompiler,
  expression: Expression,
  speakerTemporary: number,
): CompileTask<LoweredExpression> {
  const previous = compiler.contextualSpeakerTemporary;
  compiler.contextualSpeakerTemporary = speakerTemporary;
  try {
    return yield* compileChild(compiler.lowerExpressionTask(expression));
  } finally {
    compiler.contextualSpeakerTemporary = previous;
  }
}

export function* lowerInteractionPayloadsTask(
  compiler: InstructionCompiler,
  expressions: readonly Expression[],
  speakerTemporary: number,
): CompileTask<LoweredExpression[]> {
  const previous = compiler.contextualSpeakerTemporary;
  compiler.contextualSpeakerTemporary = speakerTemporary;
  try {
    return yield* compileChild(compiler.lowerOrderedExpressionsTask(expressions));
  } finally {
    compiler.contextualSpeakerTemporary = previous;
  }
}

export function materializeDedicatedInteractionValue(
  compiler: InstructionCompiler,
  lowered: LoweredExpression,
  span: SourceSpan,
): { readonly temporaryId: number } {
  const temporaryId = compiler.allocateTemporary();
  compiler.instructions.push({
    kind: "storeTemporary",
    temporaryId,
    value: lowered.plan,
    expectBoolean: false,
    span: planSpan(span),
  });
  compiler.emitTemporaryCleanup(lowered.temporaryIds, span);
  return { temporaryId };
}
