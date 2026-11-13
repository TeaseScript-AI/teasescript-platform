// The restore check of an interaction action: its timing, its prepared form, and whether a prepared UI matches it.

import type { TemporalContext } from "../../../temporal.js";
import {
  temporalCaptureShownAt,
  temporalCapturesProblem,
  type RuntimeTemporalCapture,
} from "../../host-data/temporal-captures.js";
import { normalizeOpaqueColor } from "../../../color.js";
import { expandChoiceOptions, preselectedChoice } from "../choice-options.js";
import { RuntimeFault } from "../../errors.js";
import {
  serializableEquals,
  validateCapturedSerializableValue,
  type SerializableRuntimeValue,
} from "../../values/serializable-values.js";
import {
  type Instruction,
  type InteractionChoiceOption,
  type InstructionPlan,
  type PlanSourceLocation,
  DEFAULT_EXPORT_FILE_NAME,
  DEFAULT_EXPORT_TITLE,
  DEFAULT_OPEN_URL_BUTTON_TEXT,
  DEFAULT_POPUP_BUTTON_TEXT,
} from "../../../plan/model.js";
import { interactionStringHasNonWhitespace } from "../../../interaction-limits.js";
import { buttonTimeoutMilliseconds, imageRequestValue } from "../interaction.js";
import { formAnswerMismatch, formShapeFits } from "../form/materialize.js";
import { formRequestValue, isFormUi, validFormState } from "../form/ui-state.js";
import { isPlainRecord } from "../../values/plain-data.js";
import {
  validSessionTime,
  positiveSafeInteger,
  nonNegativeSafeInteger,
  hasExactKeys,
  runtimeTemporaryValue,
  silentInteraction,
  valuelessInteraction,
  isInteractionKind,
} from "./shared-checks.js";
import {
  accessibleNameEqual,
  validInteractionUiShape,
  interactionUiEqual,
  choiceOptionsEqual,
} from "./interaction-ui.js";

/** The buttons a prepared choice shows for its captured option values, or `undefined` when they are invalid. */
export function preparedChoiceOptions(
  prepared: import("../../../plan/model.js").PreparedInteractionUiPayload,
  temporaries: unknown,
  context: TemporalContext | undefined,
  span: PlanSourceLocation,
): readonly InteractionChoiceOption[] | undefined {
  if (prepared.kind !== "choice" || !Array.isArray(temporaries) || context === undefined)
    return undefined;
  const raw = runtimeTemporaryValue(temporaries, prepared.optionsTemporary);
  if (
    validateCapturedSerializableValue(raw) !== null ||
    !isPlainRecord(raw) ||
    raw.kind !== "list" ||
    !Array.isArray(raw.items) ||
    raw.items.length !== prepared.values.length
  )
    return undefined;
  try {
    // EVIDENCE: validation: validateCapturedSerializableValue accepted the captured list and its items above.
    return expandChoiceOptions(
      raw.items as SerializableRuntimeValue[],
      prepared.values,
      context,
      span,
    );
  } catch (error) {
    if (error instanceof RuntimeFault) return undefined;
    throw error;
  }
}

/**
 * An interaction appeared at a scene time no later than now. Only a button has a timeout, and its deadline is a
 * representable later scene time. A pending button is not overdue unless catch-up is paused for execution that runs
 * first, such as a queued expiry block or one that suspends it.
 */
function validInteractionTiming(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  allowDue: boolean,
): boolean {
  // An interaction that stood still while blocks ran counts its time from later, but never from after now.
  const pausedMs = action.pausedMs ?? 0;
  if (
    !validSessionTime(action.createdAtMs) ||
    !validSessionTime(snapshot.currentSessionTimeMs) ||
    (action.pausedMs !== undefined && (!validSessionTime(pausedMs) || !(pausedMs > 0))) ||
    typeof pausedMs !== "number" ||
    action.createdAtMs + pausedMs > snapshot.currentSessionTimeMs
  )
    return false;
  if (action.timeoutMs === null) return true;
  if (
    (action.interactionKind !== "button" && action.interactionKind !== "form") ||
    typeof action.timeoutMs !== "number" ||
    !(action.timeoutMs > 0) ||
    !Number.isFinite(action.timeoutMs)
  )
    return false;
  const deadlineMs = action.createdAtMs + pausedMs + action.timeoutMs;
  return (
    validSessionTime(deadlineMs) &&
    deadlineMs > action.createdAtMs + pausedMs &&
    (allowDue || deadlineMs > snapshot.currentSessionTimeMs)
  );
}

export function validInteractionAction(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan,
  allowDue: boolean,
): boolean {
  if (
    !hasExactKeys(action, [
      "kind",
      "interactionKind",
      "actionId",
      "owningInstruction",
      "continuationInstruction",
      "ownerCallFrameId",
      "scopeDepth",
      "loopDepth",
      "destinationTemporary",
      "expectedResult",
      "target",
      "speakerId",
      "ui",
      "createdAtMs",
      "timeoutMs",
      "requestEventSequence",
      ...(action.interactionKind === "form" ? ["form"] : []),
      ...(Object.hasOwn(action, "pausedMs") ? ["pausedMs"] : []),
      ...(Object.hasOwn(action, "resumes") ? ["resumes"] : []),
    ])
  )
    return false;
  // Only a password field counts its returns after blocks.
  if (
    Object.hasOwn(action, "resumes") &&
    (action.interactionKind !== "password" || !positiveSafeInteger(action.resumes))
  )
    return false;
  if (
    !isInteractionKind(action.interactionKind) ||
    action.target !== "standardChat" ||
    !validInteractionTiming(action, snapshot, allowDue)
  )
    return false;
  const expected =
    action.interactionKind === "button" || silentInteraction(action.interactionKind)
      ? action.destinationTemporary === null
        ? "none"
        : "duration"
      : action.interactionKind === "number"
        ? "number"
        : action.interactionKind === "choice"
          ? "choice"
          : action.interactionKind === "temporal"
            ? "temporal"
            : action.interactionKind === "form"
              ? "form"
              : "string";
  if (
    action.expectedResult !== expected ||
    (action.speakerId !== null && !positiveSafeInteger(action.speakerId))
  )
    return false;
  const speakers = Array.isArray(snapshot.speakers) ? snapshot.speakers : [];
  if (
    action.speakerId !== null &&
    !speakers.some((speaker) => isPlainRecord(speaker) && speaker.id === action.speakerId)
  )
    return false;
  // A button or a popup used as a value gives one; an `openUrl` or an `exportText` never does.
  if (
    action.destinationTemporary !== null
      ? !positiveSafeInteger(action.destinationTemporary) ||
        valuelessInteraction(action.interactionKind)
      : action.interactionKind !== "button" && !silentInteraction(action.interactionKind)
  )
    return false;
  if (
    action.destinationTemporary !== null &&
    Array.isArray(snapshot.temporaries) &&
    snapshot.temporaries.some(
      (temporary) => isPlainRecord(temporary) && temporary.id === action.destinationTemporary,
    )
  )
    return false;
  if (!validInteractionUiShape(action.interactionKind, action.ui)) return false;
  // EVIDENCE: validation: validInteractionUiShape accepted the form definition above.
  if (
    action.interactionKind === "form" &&
    !(isFormUi(action.ui) && validFormState(action.ui, action.form))
  )
    return false;
  if (!nonNegativeSafeInteger(action.owningInstruction)) return true;
  const instruction = plan.instructions[action.owningInstruction];
  if (
    instruction?.kind !== "interaction" ||
    instruction.interactionKind !== action.interactionKind ||
    instruction.expectedResult !== action.expectedResult ||
    instruction.destinationTemporary !== action.destinationTemporary ||
    instruction.target !== action.target
  )
    return false;

  if ("preparedUi" in instruction) {
    return validPreparedInteractionAction(instruction, action, snapshot, speakers);
  }
  if (!interactionUiEqual(instruction.ui, action.ui) || action.timeoutMs !== null) return false;
  // The action keeps the default speaker of its request; an interrupt block may have changed the default since.
  if (instruction.speaker === null) return true;
  const explicitSpeaker = speakerGlobalValue(snapshot, instruction.speaker);
  if (
    !isPlainRecord(explicitSpeaker) ||
    explicitSpeaker.kind !== "speakerReference" ||
    !positiveSafeInteger(explicitSpeaker.speakerId) ||
    typeof explicitSpeaker.identifier !== "string" ||
    explicitSpeaker.identifier.length === 0 ||
    !speakers.some((speaker) => isPlainRecord(speaker) && speaker.id === explicitSpeaker.speakerId)
  )
    return false;
  return action.speakerId === explicitSpeaker.speakerId;
}

function validPreparedInteractionAction(
  instruction: import("../../../plan/model.js").PreparedInteractionInstruction,
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  speakers: readonly unknown[],
): boolean {
  if (!Array.isArray(snapshot.temporaries)) return false;
  const preparedSpeaker = runtimeTemporaryValue(snapshot.temporaries, instruction.speakerTemporary);
  if (preparedSpeaker === undefined) return false;
  if (preparedSpeaker === null) {
    if (action.speakerId !== null) return false;
  } else {
    if (
      !isPlainRecord(preparedSpeaker) ||
      preparedSpeaker.kind !== "speakerReference" ||
      !positiveSafeInteger(preparedSpeaker.speakerId) ||
      typeof preparedSpeaker.identifier !== "string" ||
      !speakers.some(
        (speaker) => isPlainRecord(speaker) && speaker.id === preparedSpeaker.speakerId,
      ) ||
      action.speakerId !== preparedSpeaker.speakerId
    )
      return false;
  }
  // The action keeps the timeout its prepared temporary held when the button appeared.
  const prepared = instruction.preparedUi;
  // A form keeps its time limit in its definition, which its request temporary holds.
  const timeoutMs =
    prepared.kind === "button" && prepared.timeoutTemporary !== undefined
      ? buttonTimeoutMilliseconds(
          runtimeTemporaryValue(snapshot.temporaries, prepared.timeoutTemporary),
        )
      : prepared.kind === "form" && isFormUi(action.ui)
        ? (action.ui.timeout?.milliseconds ?? null)
        : null;
  if (
    (prepared.kind === "button" && prepared.timeoutTemporary !== undefined && timeoutMs === null) ||
    action.timeoutMs !== timeoutMs
  )
    return false;
  return preparedInteractionUiMatchesAction(
    prepared,
    action.ui,
    snapshot.temporaries,
    // The buttons were shown with the context in force when the interaction opened, also after a later Continue.
    snapshotTemporalContextAt(snapshot, action.createdAtMs, action.requestEventSequence),
    instruction.span,
  );
}

/** The snapshot's temporal context at a scene time when its captures are valid: choice texts are derived from it. */
export function snapshotTemporalContextAt(
  snapshot: Record<string, unknown>,
  atMs: unknown,
  eventSequence: unknown = Infinity,
): TemporalContext | undefined {
  if (
    typeof atMs !== "number" ||
    typeof eventSequence !== "number" ||
    typeof snapshot.currentSessionTimeMs !== "number" ||
    typeof snapshot.observedSessionTimeMs !== "number" ||
    typeof snapshot.nextEventSequence !== "number" ||
    temporalCapturesProblem(
      snapshot.temporalCaptures,
      snapshot.currentSessionTimeMs,
      snapshot.observedSessionTimeMs,
      snapshot.nextEventSequence,
    ) !== null
  )
    return undefined;
  // EVIDENCE: validation: temporalCapturesProblem accepted the snapshot's captures.
  const captures = snapshot.temporalCaptures as RuntimeTemporalCapture[];
  // Without a capture recorded before the request, the shown texts cannot be derived again, so they do not validate.
  return temporalCaptureShownAt(captures, atMs, eventSequence)?.context;
}

function preparedInteractionUiMatchesAction(
  prepared: import("../../../plan/model.js").PreparedInteractionUiPayload,
  actual: unknown,
  temporaries: readonly unknown[],
  context: TemporalContext | undefined,
  span: PlanSourceLocation,
): boolean {
  if (
    !isPlainRecord(actual) ||
    actual.kind !== prepared.kind ||
    !accessibleNameEqual(prepared.accessibleName, actual.accessibleName)
  )
    return false;
  if (prepared.kind === "button") {
    return (
      runtimeTemporaryValue(temporaries, prepared.buttonLabelTemporary) === actual.buttonLabel &&
      (prepared.backgroundTemporary === undefined
        ? actual.background === undefined
        : normalizeOpaqueColor(runtimeTemporaryValue(temporaries, prepared.backgroundTemporary)) ===
          actual.background)
    );
  }
  // The temporaries keep the canonical address and the button text the request opened with.
  if (prepared.kind === "url")
    return (
      runtimeTemporaryValue(temporaries, prepared.urlTemporary) === actual.url &&
      (prepared.buttonTextTemporary === undefined
        ? actual.buttonText === DEFAULT_OPEN_URL_BUTTON_TEXT
        : runtimeTemporaryValue(temporaries, prepared.buttonTextTemporary) === actual.buttonText) &&
      (prepared.alwaysButtonTemporary === undefined
        ? actual.alwaysButton === false
        : runtimeTemporaryValue(temporaries, prepared.alwaysButtonTemporary) ===
          actual.alwaysButton)
    );
  if (prepared.kind === "popup") {
    return (
      runtimeTemporaryValue(temporaries, prepared.messageTemporary) === actual.message &&
      (prepared.buttonTextTemporary === undefined
        ? actual.buttonText === DEFAULT_POPUP_BUTTON_TEXT
        : runtimeTemporaryValue(temporaries, prepared.buttonTextTemporary) === actual.buttonText)
    );
  }
  if (prepared.kind === "export")
    return (
      runtimeTemporaryValue(temporaries, prepared.textTemporary) === actual.text &&
      (prepared.titleTemporary === undefined
        ? actual.title === DEFAULT_EXPORT_TITLE
        : runtimeTemporaryValue(temporaries, prepared.titleTemporary) === actual.title) &&
      (prepared.fileNameTemporary === undefined
        ? actual.fileName === DEFAULT_EXPORT_FILE_NAME
        : runtimeTemporaryValue(temporaries, prepared.fileNameTemporary) === actual.fileName)
    );
  if (prepared.kind === "text" || prepared.kind === "number") {
    const hint =
      prepared.hintTemporary === null
        ? null
        : runtimeTemporaryValue(temporaries, prepared.hintTemporary);
    // A field without a prefill left `null` in the temporary of its empty prefill.
    const prefill =
      prepared.prefillTemporary === undefined
        ? undefined
        : (runtimeTemporaryValue(temporaries, prepared.prefillTemporary) ?? undefined);
    return (
      hint === actual.hint &&
      prefill === actual.prefill &&
      actual.integer === (prepared.kind === "number" ? prepared.integer : undefined)
    );
  }
  if (prepared.kind === "password")
    return (
      (prepared.hintTemporary === null
        ? null
        : runtimeTemporaryValue(temporaries, prepared.hintTemporary)) === actual.hint
    );
  if (prepared.kind === "temporal") {
    const hint =
      prepared.hintTemporary === null
        ? null
        : runtimeTemporaryValue(temporaries, prepared.hintTemporary);
    const prefill =
      prepared.prefillTemporary === undefined
        ? undefined
        : (runtimeTemporaryValue(temporaries, prepared.prefillTemporary) ?? undefined);
    return (
      actual.temporalKind === prepared.temporalKind &&
      hint === actual.hint &&
      prefill === actual.prefill
    );
  }
  if (prepared.kind === "form") {
    // The open form keeps its definition in its request temporary.
    const request = runtimeTemporaryValue(temporaries, prepared.requestTemporary);
    if (!isFormUi(actual) || validateCapturedSerializableValue(request) !== null) return false;
    // EVIDENCE: validation: validateCapturedSerializableValue accepted the captured request above.
    const captured = request as SerializableRuntimeValue;
    return (
      formShapeFits(prepared.shape, actual.shape) &&
      serializableEquals(captured, formRequestValue(actual)) &&
      formAnswerMismatch(actual.fields, prepared.shape) === null
    );
  }
  if (prepared.kind === "image") {
    // The open request keeps what it shows in its request temporary.
    const request = runtimeTemporaryValue(temporaries, prepared.requestTemporary);
    const fields = imageRequestFields(actual);
    return (
      fields !== null &&
      validateCapturedSerializableValue(request) === null &&
      serializableEquals(
        // EVIDENCE: validation: validateCapturedSerializableValue accepted the captured request above.
        request as SerializableRuntimeValue,
        imageRequestValue(fields),
      )
    );
  }
  const options = preparedChoiceOptions(prepared, temporaries, context, span);
  if (options === undefined || !choiceOptionsEqual(options, actual.options)) return false;
  // The prefill temporary keeps the value, so the preselected button is found again.
  if (prepared.prefillTemporary === undefined) return actual.preselected === undefined;
  const prefill = runtimeTemporaryValue(temporaries, prepared.prefillTemporary);
  if (prefill === undefined || validateCapturedSerializableValue(prefill) !== null) return false;
  // askBoolean opens only with true, false, null, or blank text, as its prefill must be.
  if (
    prepared.booleanPrefill === true &&
    !(
      typeof prefill === "boolean" ||
      prefill === null ||
      (typeof prefill === "string" && !interactionStringHasNonWhitespace(prefill))
    )
  )
    return false;
  // EVIDENCE: validation: validateCapturedSerializableValue accepted the captured prefill above.
  const preselected = preselectedChoice(options, prefill as SerializableRuntimeValue);
  return actual.preselected === (typeof preselected === "number" ? preselected : undefined);
}

/** A speaker is a global of the session, so an interaction finds its speaker among the globals. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: boundary: binding payloads remain unvalidated during snapshot lineage checks.
function speakerGlobalValue(snapshot: Record<string, unknown>, name: string): unknown {
  if (!Array.isArray(snapshot.globals)) return undefined;
  const binding = snapshot.globals.find(
    (candidate) => isPlainRecord(candidate) && candidate.name === name,
  );
  return isPlainRecord(binding) ? binding.value : undefined;
}

/** The request fields of an image UI, read without assuming their types; `null` when one is malformed. */
function imageRequestFields(
  ui: Record<string, unknown>,
): Parameters<typeof imageRequestValue>[0] | null {
  const { question, hint, allowCamera, allowFile, allowSkip } = ui;
  const types = textList(ui.types);
  const mime = textList(ui.mime);
  if (
    (question !== null && typeof question !== "string") ||
    (hint !== null && typeof hint !== "string") ||
    typeof allowCamera !== "boolean" ||
    typeof allowFile !== "boolean" ||
    typeof allowSkip !== "boolean" ||
    types === undefined ||
    mime === undefined
  )
    return null;
  return { question, hint, allowCamera, allowFile, allowSkip, types, mime };
}

/**
 * Whether the image request of `instruction` may be skipped: its UI says so, or for a prepared request, the request its
 * temporary keeps while it is open and until its result is taken.
 */
export function imageRequestAllowsSkip(
  instruction: Extract<Instruction, { kind: "interaction" }>,
  temporaries: unknown,
): boolean {
  if (!("preparedUi" in instruction))
    return instruction.ui.kind === "image" && instruction.ui.allowSkip;
  if (instruction.preparedUi.kind !== "image" || !Array.isArray(temporaries)) return false;
  const request = runtimeTemporaryValue(temporaries, instruction.preparedUi.requestTemporary);
  return (
    isPlainRecord(request) &&
    request.kind === "object" &&
    Array.isArray(request.properties) &&
    request.properties.some(
      (property: unknown) =>
        isPlainRecord(property) && property.name === "allowSkip" && property.value === true,
    )
  );
}

function textList(value: unknown): readonly string[] | null | undefined {
  if (value === null) return null;
  return Array.isArray(value) && value.every((text): text is string => typeof text === "string")
    ? value
    : undefined;
}
