import type { DeveloperWarningCode } from "../../diagnostic-codes.js";
import { exactDurationMilliseconds } from "../values/temporal-operations.js";
import { resolveMessagePresentation } from "../message-presentation.js";
import type { TemporalContext } from "../../temporal.js";
import {
  type Instruction,
  type InteractionAccessibleName,
  type InteractionTemporalKind,
  type InteractionUiPayload,
  type PreparedInteractionUiPayload,
  DEFAULT_EXPORT_FILE_NAME,
  DEFAULT_EXPORT_TITLE,
  DEFAULT_OPEN_URL_BUTTON_TEXT,
  DEFAULT_POPUP_BUTTON_TEXT,
} from "../../plan/model.js";
import { parseMessageMarkup } from "../../message-markup.js";
import {
  isBlankTextAnswer,
  numberAnswerText,
  temporalAnswerText,
} from "../../interaction-answers.js";
import {
  boundedInteractionUtf8ByteLength,
  MAX_INTERACTION_AGGREGATE_UTF8_BYTES,
} from "../../interaction-limits.js";
import { buttonBackgroundMessage } from "../../choice-rules.js";
import {
  timeoutLengthMessage,
  timeoutSceneTimeMessage,
  unmeasurableLengthMessage,
} from "../../delay-rules.js";
import type { Evaluator } from "../evaluator.js";
import { internalFault } from "../errors.js";
import {
  assertEventSequenceCapacity,
  setCapturedTemporary,
  takeSequence,
} from "../operations/support.js";
import type { ActionRequestedEvent, DeveloperWarningEvent, InterpreterEvent } from "../events.js";
import {
  cloneCapturedSerializableValue,
  type SerializableRuntimeValue,
} from "../values/serializable-values.js";
import {
  type RuntimeSnapshot,
  type RuntimeSpeakerSnapshot,
  type RuntimeTemporarySnapshot,
  currentTemporalContext,
  MAX_RUNTIME_SESSION_TIME_MS,
} from "../snapshot/state.js";
import {
  ACTION_COMPLETION_EVENTS,
  type RuntimeInteractionActionSnapshot,
  type RuntimeFormStateSnapshot,
} from "../actions/model.js";
import { isValidSessionTime } from "../actions/delay.js";
import {
  cloneFormState,
  cloneFormUi,
  formRequestValue,
  formUiTexts,
  materializeForm,
} from "../actions/form.js";
import {
  buttonTimeoutMilliseconds,
  cloneImageUi,
  imageRequestValue,
} from "../actions/interaction.js";
import {
  emptyImageFilterMessage,
  IMAGE_NO_SOURCE_MESSAGE,
  imageFilterTextProblem,
} from "../../image-input.js";
import { normalizeOpaqueColor } from "../../color.js";
import { describeShownValue } from "../values/value-types.js";
import { conversionTo } from "../../conversions.js";
import {
  isDate,
  isDateTime,
  isAnyDuration,
  isList,
  isObject,
  isSpeakerReference,
  isTime,
} from "../values/value-predicates.js";
import { fieldText } from "../values/value-text.js";
import { canonicalWebUrl, OPEN_URL_FIX, OPEN_URL_RULE } from "../../web-url.js";
import { expandChoiceOptions, preselectedChoice } from "../actions/choice-options.js";
import { cloneInteractionChoiceValue } from "../../choice-values.js";
import { describeValue } from "../../value-kinds.js";
import { advance, durationFix, fault, readTemporary, type SourceSpan } from "./support.js";
import { emitSay } from "./say.js";
import { copySpan } from "../../plan/source-location.js";

// Interactions: the speaker of an ask or button, and the request that opens it with its UI and time limit.

/** The presentation a form's prose takes: prose, with the asking speaker's prose defaults. */
const PROSE_PRESENTATION: SerializableRuntimeValue = Object.freeze({
  kind: "object",
  properties: [{ name: "kind", value: "prose" }],
});

export function executePrepareInteractionSpeaker(
  instruction: Extract<Instruction, { kind: "prepareInteractionSpeaker" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
): void {
  const speaker =
    instruction.speaker !== null
      ? evaluator.speakerByName(instruction.speaker, instruction.span)
      : snapshot.contextualSpeaker !== null
        ? evaluator.speakerById(snapshot.contextualSpeaker, instruction.span)
        : snapshot.defaultSpeaker !== null
          ? evaluator.speakerById(snapshot.defaultSpeaker, instruction.span)
          : null;
  setCapturedTemporary(
    snapshot.temporaries,
    instruction.destinationTemporary,
    speaker === null
      ? null
      : { kind: "speakerReference", speakerId: speaker.id, identifier: speaker.identifier },
  );
  advance(snapshot);
}

export function executeInteraction(
  instruction: Extract<Instruction, { kind: "interaction" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  if (
    instruction.destinationTemporary !== null &&
    snapshot.temporaries.some((temporary) => temporary.id === instruction.destinationTemporary)
  ) {
    throw fault(
      "TSR050",
      internalFault("The slot for an interaction's answer is already in use."),
      instruction.span,
    );
  }
  if (
    !Number.isSafeInteger(snapshot.nextActionId) ||
    snapshot.nextActionId >= Number.MAX_SAFE_INTEGER
  ) {
    throw fault(
      "TSR051",
      internalFault("The session has used up its action numbers."),
      instruction.span,
    );
  }
  // The request and the completion events.
  const requiredEventSequences = 1 + ACTION_COMPLETION_EVENTS.interaction;
  assertEventSequenceCapacity(snapshot, requiredEventSequences, instruction.span);
  const prepared = "preparedUi" in instruction;
  const speaker = prepared
    ? preparedInteractionSpeaker(
        instruction.speakerTemporary,
        snapshot.temporaries,
        evaluator,
        instruction.span,
      )
    : instruction.speaker !== null
      ? evaluator.speakerByName(instruction.speaker, instruction.span)
      : snapshot.defaultSpeaker === null
        ? null
        : evaluator.speakerById(snapshot.defaultSpeaker, instruction.span);
  const materialized = prepared
    ? materializeInteractionUi(
        instruction.preparedUi,
        snapshot.temporaries,
        currentTemporalContext(snapshot),
        instruction.span,
      )
    : { ui: instruction.ui, stagedWrites: [] as const };
  const timeoutMs =
    prepared &&
    instruction.preparedUi.kind === "button" &&
    instruction.preparedUi.timeoutTemporary !== undefined
      ? buttonTimeoutMs(
          readTemporary(
            snapshot.temporaries,
            instruction.preparedUi.timeoutTemporary,
            instruction.span,
          ),
          snapshot,
          instruction.span,
        )
      : materialized.ui.kind === "form" && materialized.ui.timeout !== null
        ? formTimeoutMs(materialized.ui.timeout.milliseconds, snapshot, instruction.span)
        : null;
  if (materialized.warning !== undefined) {
    assertEventSequenceCapacity(snapshot, requiredEventSequences + 1, instruction.span);
    events.push(
      Object.freeze({
        kind: "developerWarning",
        sequence: takeSequence(snapshot),
        severity: "warning",
        code: materialized.warning.code,
        message: materialized.warning.message,
        span: copySpan(instruction.span),
      } satisfies DeveloperWarningEvent),
    );
  }
  // A form's descriptions and outro are said as one prose message as it opens, after its question.
  if (materialized.prose !== undefined) {
    assertEventSequenceCapacity(snapshot, requiredEventSequences + 1, instruction.span);
    const content = parseMessageMarkup(materialized.prose);
    emitSay(
      snapshot,
      events,
      instruction.span,
      speaker === null ? null : evaluator.outputSpeaker(speaker, instruction.span, events),
      content,
      content.visibleText,
      resolveMessagePresentation(PROSE_PRESENTATION, speaker, copySpan(instruction.span)),
    );
  }
  const sequence = snapshot.nextEventSequence;
  const action: RuntimeInteractionActionSnapshot = Object.freeze({
    kind: "interaction",
    interactionKind: instruction.interactionKind,
    actionId: snapshot.nextActionId,
    owningInstruction: snapshot.nextInstruction,
    continuationInstruction: snapshot.nextInstruction + 1,
    ownerCallFrameId: snapshot.callFrames.at(-1)?.id ?? null,
    scopeDepth: snapshot.frames.length,
    loopDepth: snapshot.loopFrames.length,
    destinationTemporary: instruction.destinationTemporary,
    expectedResult: instruction.expectedResult,
    target: instruction.target,
    speakerId: speaker?.id ?? null,
    ui: cloneInteractionUi(materialized.ui),
    createdAtMs: snapshot.currentSessionTimeMs,
    timeoutMs,
    requestEventSequence: sequence,
    ...(materialized.form === undefined ? {} : { form: cloneFormState(materialized.form) }),
  });
  commitInteractionMaterialization(snapshot, materialized.stagedWrites);
  const committedSequence = takeSequence(snapshot);
  if (committedSequence !== sequence) {
    throw new Error("Interaction event-sequence staging drifted unexpectedly.");
  }
  snapshot.nextActionId += 1;
  snapshot.foregroundAction = action;
  snapshot.status = "waiting";
  events.push(
    Object.freeze({
      kind: "actionRequested",
      sequence,
      action: cloneInteractionAction(action),
      span: copySpan(instruction.span),
    } satisfies ActionRequestedEvent),
  );
}

function preparedInteractionSpeaker(
  temporaryId: number,
  temporaries: readonly RuntimeTemporarySnapshot[],
  evaluator: Evaluator,
  span: SourceSpan,
): RuntimeSpeakerSnapshot | null {
  const prepared = readTemporary(temporaries, temporaryId, span);
  if (prepared === null) return null;
  if (!isSpeakerReference(prepared)) {
    throw fault(
      "TSR052",
      internalFault("The prepared speaker of an interaction is invalid."),
      span,
    );
  }
  return evaluator.speakerById(prepared.speakerId, span);
}

interface MaterializedInteractionUi {
  readonly ui: InteractionUiPayload;
  /** A form's starting answers. */
  readonly form?: RuntimeFormStateSnapshot;
  /** The prose a form's speaker says as it opens. */
  readonly prose?: string;
  /** A developer warning about how it opens, such as a `prefill:` that no button's value matches. */
  readonly warning?: { readonly code: DeveloperWarningCode; readonly message: string };
  readonly stagedWrites: readonly {
    readonly temporaryId: number;
    readonly value: SerializableRuntimeValue;
  }[];
}

function materializeInteractionUi(
  prepared: PreparedInteractionUiPayload,
  temporaries: RuntimeTemporarySnapshot[],
  temporalContext: TemporalContext,
  span: SourceSpan,
): MaterializedInteractionUi {
  const stagedWrites: Array<{
    readonly temporaryId: number;
    readonly value: SerializableRuntimeValue;
  }> = [];
  const read = (temporaryId: number): RuntimeTemporarySnapshot => {
    const temporary = temporaries.find((item) => item.id === temporaryId);
    if (temporary === undefined)
      throw fault(
        "TSR046",
        internalFault(
          `An internal value (temporary ${temporaryId}) is missing from the session's state.`,
        ),
        span,
      );
    return temporary;
  };
  const readText = (temporaryId: number): string => {
    const temporary = read(temporaryId);
    const text = fieldText(temporary.value, span, temporalContext);
    stagedWrites.push({ temporaryId: temporary.id, value: text });
    return text;
  };

  const backgroundColor = (value: SerializableRuntimeValue): string => {
    const normalized = normalizeOpaqueColor(value);
    if (normalized === null)
      throw fault("TSR052", buttonBackgroundMessage(describeShownValue(value)), span);
    return normalized;
  };

  let ui: InteractionUiPayload;
  let form: RuntimeFormStateSnapshot | undefined;
  let prose: string | undefined;
  let warning: MaterializedInteractionUi["warning"];
  if (prepared.kind === "button") {
    ui = {
      kind: "button",
      buttonLabel: readText(prepared.buttonLabelTemporary),
      ...(prepared.backgroundTemporary === undefined
        ? {}
        : { background: backgroundColor(read(prepared.backgroundTemporary).value) }),
      accessibleName: prepared.accessibleName,
    };
  } else if (prepared.kind === "popup") {
    ui = {
      kind: "popup",
      message: readText(prepared.messageTemporary),
      buttonText:
        prepared.buttonTextTemporary === undefined
          ? DEFAULT_POPUP_BUTTON_TEXT
          : readText(prepared.buttonTextTemporary),
      accessibleName: prepared.accessibleName,
    };
  } else if (prepared.kind === "url") {
    // A web address is checked and made canonical as the request opens; the temporary keeps the canonical form.
    const temporary = read(prepared.urlTemporary);
    const url = typeof temporary.value === "string" ? canonicalWebUrl(temporary.value) : null;
    if (url === null)
      throw fault(
        "TSR050",
        `${OPEN_URL_RULE}, but this is ${describeShownValue(temporary.value)}. ${OPEN_URL_FIX}`,
        span,
      );
    stagedWrites.push({ temporaryId: temporary.id, value: url });
    const buttonText =
      prepared.buttonTextTemporary === undefined
        ? DEFAULT_OPEN_URL_BUTTON_TEXT
        : readText(prepared.buttonTextTemporary);
    const always =
      prepared.alwaysButtonTemporary === undefined
        ? false
        : read(prepared.alwaysButtonTemporary).value;
    if (typeof always !== "boolean")
      throw fault(
        "TSR050",
        `'alwaysButton:' of openUrl takes true or false, but this is ${describeShownValue(always)}. Write true or false.`,
        span,
      );
    ui = {
      kind: "url",
      url,
      buttonText,
      alwaysButton: always,
      accessibleName: prepared.accessibleName,
    };
  } else if (prepared.kind === "export") {
    // The text and the file name are taken as they are, so only text is either.
    const text = read(prepared.textTemporary).value;
    if (typeof text !== "string")
      throw fault(
        "TSR050",
        `exportText needs its text as text (string), but this is ${describeShownValue(text)}.`,
        span,
      );
    const fileName =
      prepared.fileNameTemporary === undefined
        ? DEFAULT_EXPORT_FILE_NAME
        : read(prepared.fileNameTemporary).value;
    if (typeof fileName !== "string")
      throw fault(
        "TSR050",
        `'fileName:' of exportText takes text (string), but this is ${describeShownValue(fileName)}.`,
        span,
      );
    ui = {
      kind: "export",
      text,
      title:
        prepared.titleTemporary === undefined
          ? DEFAULT_EXPORT_TITLE
          : readText(prepared.titleTemporary),
      fileName,
      accessibleName: prepared.accessibleName,
    };
  } else if (prepared.kind === "text" || prepared.kind === "number") {
    const hint = prepared.hintTemporary === null ? null : readText(prepared.hintTemporary);
    let prefill: string | undefined;
    const integer = prepared.kind === "number" && prepared.integer === true;
    if (prepared.prefillTemporary !== undefined) {
      const temporary = read(prepared.prefillTemporary);
      if (!isEmptyPrefill(temporary.value))
        prefill = interactionPrefill(integer ? "integer" : prepared.kind, temporary.value, span);
      stagedWrites.push({ temporaryId: temporary.id, value: prefill ?? null });
    }
    ui = {
      kind: prepared.kind,
      hint,
      ...(prefill === undefined ? {} : { prefill }),
      ...(integer ? { integer: true as const } : {}),
      accessibleName: prepared.accessibleName,
    };
  } else if (prepared.kind === "password") {
    ui = {
      kind: "password",
      hint: prepared.hintTemporary === null ? null : readText(prepared.hintTemporary),
      accessibleName: prepared.accessibleName,
    };
  } else if (prepared.kind === "temporal") {
    const hint = prepared.hintTemporary === null ? null : readText(prepared.hintTemporary);
    let prefill: string | undefined;
    if (prepared.prefillTemporary !== undefined) {
      const temporary = read(prepared.prefillTemporary);
      if (!isEmptyPrefill(temporary.value))
        prefill = temporalPrefill(prepared.temporalKind, temporary.value, span);
      stagedWrites.push({ temporaryId: temporary.id, value: prefill ?? null });
    }
    ui = {
      kind: "temporal",
      temporalKind: prepared.temporalKind,
      hint,
      ...(prefill === undefined ? {} : { prefill }),
      accessibleName: prepared.accessibleName,
    };
  } else if (prepared.kind === "image") {
    const request = read(prepared.requestTemporary);
    const image = imageInteractionUi(request.value, prepared.accessibleName, temporalContext, span);
    // The request keeps what it shows, so a restore can check the open request against it.
    stagedWrites.push({ temporaryId: request.id, value: imageRequestValue(image) });
    ui = image;
  } else if (prepared.kind === "form") {
    const request = read(prepared.requestTemporary);
    const materialized = materializeForm(
      request.value,
      prepared.shape,
      prepared.accessibleName,
      temporalContext,
      span,
    );
    // Like an image request, the request keeps the definition, so a restore can check the open form against it.
    stagedWrites.push({ temporaryId: request.id, value: formRequestValue(materialized.ui) });
    ui = materialized.ui;
    form = materialized.state;
    prose = materialized.prose ?? undefined;
  } else {
    const source = read(prepared.optionsTemporary);
    if (!isList(source.value) || source.value.items.length !== prepared.values.length) {
      throw fault(
        "TSR052",
        internalFault(
          "The prepared options of a choice do not match the options written in the script.",
        ),
        span,
      );
    }
    const options = expandChoiceOptions(source.value.items, prepared.values, temporalContext, span);
    let preselected: number | null | undefined = null;
    if (prepared.prefillTemporary !== undefined && prepared.booleanPrefill === true) {
      // askBoolean: true or false preselects its button, and null or blank text none, as for an ask's prefill (V30 §20).
      const prefill = read(prepared.prefillTemporary).value;
      if (typeof prefill === "boolean") preselected = preselectedChoice(options, prefill);
      else if (prefill !== null && !(typeof prefill === "string" && isBlankTextAnswer(prefill)))
        throw fault(
          "TSR052",
          `The prefill of askBoolean must be true or false, not ${describeValue(prefill)}.`,
          span,
        );
    } else if (prepared.prefillTemporary !== undefined) {
      const prefill = read(prepared.prefillTemporary).value;
      preselected = preselectedChoice(options, prefill);
      // A value no button has preselects none; the script goes on, and Debug shows why (owner decision, 2026-10-08).
      if (preselected === undefined)
        warning = {
          code: "TSW017",
          message: `No button has the prefill value (${prefillNotation(prefill)}), so none is preselected.${
            // The likely mistake: the text of a button whose value differs.
            typeof prefill === "string" && options.some((option) => option.text === prefill)
              ? " 'prefill:' gives a button's value, not its text."
              : ""
          }`,
        };
    }
    ui = {
      kind: "choice",
      options,
      ...(typeof preselected === "number" ? { preselected } : {}),
      accessibleName: prepared.accessibleName,
    };
  }

  assertInteractionUiLimits(ui, span);
  return Object.freeze({
    ui,
    ...(form === undefined ? {} : { form }),
    ...(prose === undefined ? {} : { prose }),
    ...(warning === undefined ? {} : { warning }),
    stagedWrites: Object.freeze(
      stagedWrites.map((staged) =>
        Object.freeze({
          temporaryId: staged.temporaryId,
          value: cloneCapturedSerializableValue(staged.value),
        }),
      ),
    ),
  });
}

/** A `prefill:` value as a warning shows it: a text in quotes, a number or boolean as written, or else its kind. */
function prefillNotation(value: SerializableRuntimeValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return describeValue(value);
}

/**
 * A prefill that is `null` or blank text when the field opens prefills nothing (V30 §20), such as a `load` of a key a
 * first play has not saved yet. Its temporary then holds `null`, which checkpoint validation reads as no prefill.
 */
function isEmptyPrefill(value: SerializableRuntimeValue): boolean {
  return value === null || (typeof value === "string" && isBlankTextAnswer(value));
}

/**
 * The request of `askImage`, from its written arguments in source order: the message as text, sources that default to
 * true and are not both off, `allowSkip:`, which defaults to false, and `types:` and `mime:` lists of valid texts.
 */
function imageInteractionUi(
  value: SerializableRuntimeValue,
  accessibleName: InteractionAccessibleName,
  temporalContext: TemporalContext,
  span: SourceSpan,
): Extract<InteractionUiPayload, { kind: "image" }> {
  if (!isObject(value))
    throw fault("TSR052", internalFault("The prepared askImage request is malformed."), span);
  let question: string | null = null;
  let hint: string | null = null;
  let allowCamera = true;
  let allowFile = true;
  let allowSkip = false;
  let types: readonly string[] | null = null;
  let mime: readonly string[] | null = null;
  for (const { name, value: argument } of value.properties) {
    if (name === "message") question = fieldText(argument, span, temporalContext);
    else if (name === "hint") hint = fieldText(argument, span, temporalContext);
    else if (name === "allowCamera" || name === "allowFile" || name === "allowSkip") {
      if (typeof argument !== "boolean")
        throw fault(
          "TSR052",
          `askImage(${name}:) takes true or false, not ${describeValue(argument)}.`,
          span,
        );
      if (name === "allowCamera") allowCamera = argument;
      else if (name === "allowFile") allowFile = argument;
      else allowSkip = argument;
    } else if (name === "types" || name === "mime") {
      const texts = imageFilterTexts(name, argument, span);
      if (name === "types") types = texts;
      else mime = texts;
    } else
      throw fault("TSR052", internalFault("The prepared askImage request is malformed."), span);
  }
  if (!allowCamera && !allowFile) throw fault("TSR052", IMAGE_NO_SOURCE_MESSAGE, span);
  return {
    kind: "image",
    question,
    hint,
    allowCamera,
    allowFile,
    allowSkip,
    types,
    mime,
    accessibleName,
  };
}

function imageFilterTexts(
  option: "types" | "mime",
  value: SerializableRuntimeValue,
  span: SourceSpan,
): readonly string[] {
  if (!isList(value))
    throw fault(
      "TSR052",
      option === "types"
        ? `askImage(types:) takes a list of file extensions, such as [".png"], not ${describeValue(value)}.`
        : `askImage(mime:) takes a list of image MIME types, such as ["image/png"], not ${describeValue(value)}.`,
      span,
    );
  if (value.items.length === 0) throw fault("TSR052", emptyImageFilterMessage(option), span);
  return value.items.map((item) => {
    if (typeof item !== "string")
      throw fault(
        "TSR052",
        `askImage(${option}:) takes texts such as ${option === "types" ? '".png"' : '"image/png"'}, but it holds ${describeValue(item)}.`,
        span,
      );
    const problem = imageFilterTextProblem(option, item);
    if (problem !== null) throw fault("TSR052", problem, span);
    return item;
  });
}

/** The prefill text of a `prefill:` value, which must be an answer the field accepts. */
function interactionPrefill(
  kind: "text" | "number" | "integer",
  value: SerializableRuntimeValue,
  span: SourceSpan,
): string {
  if (kind === "integer") {
    // A non-whole prefill is an error, never rounded.
    if (typeof value !== "number" || !Number.isSafeInteger(value))
      throw fault(
        "TSR052",
        "The prefill of askInteger must be a whole number. Round the prefill with the floor, round or ceil function, or ask without 'prefill:'.",
        span,
      );
    return numberAnswerText(value);
  }
  if (kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw fault(
        "TSR052",
        "The prefill of askNumber must be a finite number. Ask without 'prefill:' when there is no number to offer.",
        span,
      );
    return numberAnswerText(value);
  }
  if (typeof value !== "string")
    throw fault(
      "TSR052",
      "The prefill of askText must be text. Put the value into a text with interpolation.",
      span,
    );
  return value;
}

/** The ISO prefill text of a date or time `prefill:` value, which must be of the kind the field asks for. */
function temporalPrefill(
  kind: InteractionTemporalKind,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): string {
  const answer =
    kind === "date"
      ? isDate(value) && value
      : kind === "time"
        ? isTime(value) && value
        : isDateTime(value) && value;
  if (answer !== false) return temporalAnswerText(answer);
  const [command, noun] =
    kind === "date"
      ? ["askDate", "a date"]
      : kind === "time"
        ? ["askTime", "a time"]
        : ["askDateTime", "a date and time"];
  throw fault(
    "TSR052",
    `The prefill of ${command} must be ${noun}, not ${describeValue(value)}.${typeof value === "string" ? ` Convert the text with the ${conversionTo(kind)} function.` : ""}`,
    span,
  );
}

function commitInteractionMaterialization(
  snapshot: RuntimeSnapshot,
  stagedWrites: readonly {
    readonly temporaryId: number;
    readonly value: SerializableRuntimeValue;
  }[],
): void {
  for (const staged of stagedWrites) {
    const temporary = snapshot.temporaries.find((item) => item.id === staged.temporaryId);
    if (temporary === undefined) {
      throw new Error(
        `Prepared interaction temporary '${staged.temporaryId}' disappeared before commit.`,
      );
    }
    temporary.value = cloneCapturedSerializableValue(staged.value);
  }
}

function assertInteractionUiLimits(ui: InteractionUiPayload, span: SourceSpan): void {
  const strings: string[] = [];
  if (ui.accessibleName.kind === "text") strings.push(ui.accessibleName.text);
  if (ui.kind === "button") strings.push(ui.buttonLabel);
  else if (ui.kind === "popup") strings.push(ui.message, ui.buttonText);
  else if (ui.kind === "url") strings.push(ui.url, ui.buttonText);
  // The exported text may be as long as any text.
  else if (ui.kind === "export") strings.push(ui.title, ui.fileName);
  else if (ui.kind === "form") {
    // Item by item, as for an image filter: a large form must reach the limit below, not a native argument limit.
    for (const text of formUiTexts(ui)) strings.push(text);
  } else if (ui.kind === "image") {
    if (ui.question !== null) strings.push(ui.question);
    if (ui.hint !== null) strings.push(ui.hint);
    // Item by item: a long computed filter must reach the limit below, not the native argument limit of a spread.
    for (const text of ui.types ?? []) strings.push(text);
    for (const text of ui.mime ?? []) strings.push(text);
  } else if (ui.kind === "password") {
    if (ui.hint !== null) strings.push(ui.hint);
  } else if (ui.kind !== "choice") {
    if (ui.hint !== null) strings.push(ui.hint);
    if (ui.prefill !== undefined) strings.push(ui.prefill);
  } else {
    for (const option of ui.options) {
      strings.push(option.text);
      if (typeof option.value === "string" && option.value !== option.text)
        strings.push(option.value);
    }
  }
  let aggregate = 0;
  for (const value of strings) {
    const bytes = boundedInteractionUtf8ByteLength(
      value,
      MAX_INTERACTION_AGGREGATE_UTF8_BYTES - aggregate,
    );
    if (bytes === null)
      throw fault(
        "TSR052",
        `The text in this interaction adds up to more than ${MAX_INTERACTION_AGGREGATE_UTF8_BYTES.toLocaleString("en-US")} bytes of UTF-8. Shorten its message, title, labels, hints, prefill or choice values, file filters, file name, or web address.`,
        span,
      );
    aggregate += bytes;
  }
}

function cloneInteractionUi(
  ui: RuntimeInteractionActionSnapshot["ui"],
): RuntimeInteractionActionSnapshot["ui"] {
  const accessibleName =
    ui.accessibleName.kind === "text"
      ? { kind: "text" as const, text: ui.accessibleName.text }
      : { kind: "localizedDefault" as const, key: ui.accessibleName.key };
  if (ui.kind === "choice") {
    const options = ui.options.map((option) => ({
      text: option.text,
      value: cloneInteractionChoiceValue(option.value),
      ...(option.background === undefined ? {} : { background: option.background }),
    }));
    return {
      kind: "choice",
      options,
      ...(ui.preselected === undefined ? {} : { preselected: ui.preselected }),
      accessibleName,
    };
  }
  if (ui.kind === "popup")
    return { kind: "popup", message: ui.message, buttonText: ui.buttonText, accessibleName };
  if (ui.kind === "url")
    return {
      kind: "url",
      url: ui.url,
      buttonText: ui.buttonText,
      alwaysButton: ui.alwaysButton,
      accessibleName,
    };
  if (ui.kind === "export")
    return {
      kind: "export",
      text: ui.text,
      title: ui.title,
      fileName: ui.fileName,
      accessibleName,
    };
  if (ui.kind === "button")
    return {
      kind: "button",
      buttonLabel: ui.buttonLabel,
      ...(ui.background === undefined ? {} : { background: ui.background }),
      accessibleName,
    };
  if (ui.kind === "temporal")
    return {
      kind: "temporal",
      temporalKind: ui.temporalKind,
      hint: ui.hint,
      ...(ui.prefill === undefined ? {} : { prefill: ui.prefill }),
      accessibleName,
    };
  if (ui.kind === "image") return cloneImageUi(ui, accessibleName);
  if (ui.kind === "form") return cloneFormUi(ui, accessibleName);
  if (ui.kind === "password") return { kind: "password", hint: ui.hint, accessibleName };
  return {
    kind: ui.kind,
    hint: ui.hint,
    ...(ui.prefill === undefined ? {} : { prefill: ui.prefill }),
    ...(ui.kind === "number" && ui.integer === true ? { integer: true as const } : {}),
    accessibleName,
  };
}

function cloneInteractionAction(
  action: RuntimeInteractionActionSnapshot,
): RuntimeInteractionActionSnapshot {
  return {
    kind: "interaction",
    interactionKind: action.interactionKind,
    actionId: action.actionId,
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    ownerCallFrameId: action.ownerCallFrameId,
    scopeDepth: action.scopeDepth,
    loopDepth: action.loopDepth,
    destinationTemporary: action.destinationTemporary,
    expectedResult: action.expectedResult,
    target: action.target,
    speakerId: action.speakerId,
    ui: cloneInteractionUi(action.ui),
    createdAtMs: action.createdAtMs,
    timeoutMs: action.timeoutMs,
    requestEventSequence: action.requestEventSequence,
    ...(action.form === undefined ? {} : { form: cloneFormState(action.form) }),
  };
}

/** A form's time limit, whose deadline must be a representable later scene time. */
function formTimeoutMs(timeoutMs: number, snapshot: RuntimeSnapshot, span: SourceSpan): number {
  if (snapshot.currentSessionTimeMs === MAX_RUNTIME_SESSION_TIME_MS)
    throw fault(
      "TSR052",
      "Scene time has reached its limit, so this askForm timeout cannot run. Remove 'timeout:' and 'onTimeout:' to wait without a time limit.",
      span,
    );
  const deadlineMs = snapshot.currentSessionTimeMs + timeoutMs;
  if (!isValidSessionTime(deadlineMs) || deadlineMs <= snapshot.currentSessionTimeMs)
    throw fault(
      "TSR052",
      isValidSessionTime(deadlineMs)
        ? unmeasurableLengthMessage(
            "This askForm timeout",
            timeoutMs,
            snapshot.currentSessionTimeMs,
            "timeout",
          )
        : timeoutSceneTimeMessage("askForm"),
      span,
    );
  return timeoutMs;
}

/**
 * A `showButton` timeout in milliseconds: a duration greater than zero whose deadline is a representable later scene
 * time.
 */
function buttonTimeoutMs(
  value: SerializableRuntimeValue,
  snapshot: RuntimeSnapshot,
  span: SourceSpan,
): number {
  // A calendar duration has no fixed length (ADR 0026).
  if (isAnyDuration(value)) exactDurationMilliseconds(value, "A showButton timeout", span);
  const timeoutMs = buttonTimeoutMilliseconds(value);
  if (timeoutMs === null) {
    throw fault(
      "TSR050",
      typeof value === "number"
        ? `A showButton timeout is a duration, but this is ${describeShownValue(value)}. ${durationFix(value, "30 s")}`
        : timeoutLengthMessage("showButton", describeShownValue(value)),
      span,
    );
  }
  if (snapshot.currentSessionTimeMs === MAX_RUNTIME_SESSION_TIME_MS) {
    throw fault(
      "TSR050",
      "Scene time has reached its limit, so this showButton timeout cannot run. Remove 'timeout:' to wait without a time limit.",
      span,
    );
  }
  const deadlineMs = snapshot.currentSessionTimeMs + timeoutMs;
  if (!isValidSessionTime(deadlineMs) || deadlineMs <= snapshot.currentSessionTimeMs) {
    throw fault(
      "TSR050",
      isValidSessionTime(deadlineMs)
        ? unmeasurableLengthMessage(
            "This showButton timeout",
            timeoutMs,
            snapshot.currentSessionTimeMs,
            "timeout",
          )
        : timeoutSceneTimeMessage("showButton"),
      span,
    );
  }
  return timeoutMs;
}
