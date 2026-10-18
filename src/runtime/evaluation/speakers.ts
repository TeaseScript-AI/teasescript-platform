import type { DeveloperWarningCode } from "../../diagnostic-codes.js";
import { normalizeColor } from "../../color.js";
import { escapedMarkupLength, escapeMarkup } from "../../message-markup.js";
import { PERSON_FIELDS, PLAYER } from "../../speaker-terms.js";
import { internalFault } from "../errors.js";
import type { DeveloperWarningEvent, InterpreterEvent, OutputSpeaker } from "../events.js";
import { takeSequence } from "../operations/support.js";
import {
  GLOBAL_SCOPE_ID,
  detachPreparedReferencesForMutation,
  type PreparedReferenceStep,
} from "../prepared-references.js";
import { isVisibleScalar, quotedTextWithin, valueNotation, visibleText } from "../value-text.js";
import { checkTextLength, MAX_TEXT_LENGTH } from "../text-length.js";
import { formatDuration } from "../../duration.js";
import {
  cloneCapturedSerializableValue,
  type SerializableRuntimeValue,
  type SerializableTimerHandle,
  type SerializableMediaHandle,
  type SerializableCameraViewHandle,
  type SerializablePermanentButtonHandle,
} from "../serializable-values.js";
import { currentTemporalContext, type RuntimeSpeakerSnapshot } from "../state.js";
import {
  isDict,
  isDuration,
  isList,
  isSpeakerReference,
  isTimerHandle,
  isCameraView,
  isPermanentButton,
} from "../value-predicates.js";
import { describeShownValue } from "../value-types.js";
import { mediaProperty } from "../media.js";
import { timerProperty } from "../timers.js";
import { shownPermanentButton } from "../permanent-buttons.js";
import { stateKey } from "../debug-trace.js";
import { VALUE_KINDS, valueKindOf } from "../../value-kinds.js";
import { timerOf, mediaOf, cameraView } from "./handles.js";
import { randomItem } from "./draws.js";
import { type SourceSpan, fault } from "./support.js";
import type { Evaluator } from "../evaluator.js";
import { copySpan } from "../../plan/source-location.js";

// Speakers, the account, and the text a say shows: a speaker's output, interpolation, and handle notation.

export function speakerByName(
  evaluator: Evaluator,
  name: string,
  span: SourceSpan,
): RuntimeSpeakerSnapshot {
  const binding = evaluator.binding(name);
  if (binding === undefined || !isSpeakerReference(binding.value)) {
    throw fault("TSR023", internalFault(`'${name}' is not a declared speaker.`), span);
  }
  return speakerById(evaluator, binding.value.speakerId, span);
}

export function speakerById(
  evaluator: Evaluator,
  id: number,
  span: SourceSpan,
): RuntimeSpeakerSnapshot {
  const speaker = evaluator.snapshot.speakers.find((item) => item.id === id);
  if (speaker === undefined)
    throw fault("TSR023", internalFault(`The session has no speaker with ID ${id}.`), span);
  return speaker;
}

/** A speaker's name or title as shown text, like any other shown value, or `null` when it is not set. */
function speakerText(
  evaluator: Evaluator,
  speaker: RuntimeSpeakerSnapshot,
  name: string,
  span: SourceSpan,
): string | null {
  const value = speaker.properties.find((property) => property.name === name)?.value;
  if (value === undefined || value === null || typeof value === "string" || !isVisibleScalar(value))
    return optionalSpeakerString(speaker, name, span);
  return visibleText(value, span, currentTemporalContext(evaluator.snapshot));
}

/**
 * `player.copyFrom(account)` (V30 §37): the player gets a copy of each person field of the account and loses each one
 * the account lacks, in place, so its other properties keep their order.
 */
export function copyAccount(evaluator: Evaluator, span: SourceSpan): void {
  const player = speakerByName(evaluator, PLAYER, span);
  const reference: SerializableRuntimeValue = {
    kind: "speakerReference",
    speakerId: player.id,
    identifier: player.identifier,
  };
  // The copy may change every person field, so a reference prepared to one keeps the value it leads to now.
  for (const name of PERSON_FIELDS) {
    const path: PreparedReferenceStep[] = [{ kind: "property", name }];
    detachPreparedReferencesForMutation(evaluator.snapshot, {
      rootFrameId: GLOBAL_SCOPE_ID,
      rootName: player.identifier,
      path,
      speakerPath: { speakerId: player.id, path },
    });
  }
  for (const name of PERSON_FIELDS) {
    const value = evaluator.snapshot.account.find((field) => field.name === name)?.value;
    if (value === undefined) {
      const index = player.properties.findIndex((property) => property.name === name);
      if (index >= 0) player.properties.splice(index, 1);
      continue;
    }
    setSpeakerProperty(player, name, value, span);
    if (evaluator.trace === null) continue;
    // Each field depends only on the account's field it copies.
    const previous = evaluator.trace.push();
    evaluator.trace.readState(stateKey("account", name), null, `account.${name}`, value, true);
    evaluator.writeState(reference, name, value, span, { property: name });
    evaluator.trace.pop(previous);
  }
}

export function outputSpeaker(
  evaluator: Evaluator,
  speaker: RuntimeSpeakerSnapshot,
  span: SourceSpan,
  events: InterpreterEvent[],
): OutputSpeaker {
  // The player's own message shows no name and no avatar (V30 §37).
  if (speaker.identifier === PLAYER)
    return Object.freeze({
      identifier: PLAYER,
      displayName: "",
      color: normalizeColor(
        speaker.properties.find((property) => property.name === "color")?.value,
      ),
      font: optionalSpeakerString(speaker, "font", span),
      avatar: null,
    });
  const explicit = speakerText(evaluator, speaker, "displayName", span);
  let displayName: string;
  let fallback = false;
  if (explicit !== null) {
    if (explicit.length === 0) {
      throw fault(
        "TSR022",
        `Speaker '${speaker.identifier}' has an empty displayName. Give it a name, or leave displayName out to show '${speaker.identifier}'.`,
        span,
      );
    }
    displayName = explicit;
  } else {
    const parts = [
      speakerText(evaluator, speaker, "title", span) ??
        speakerText(evaluator, speaker, "shortTitle", span),
      speakerText(evaluator, speaker, "firstName", span),
      speakerText(evaluator, speaker, "lastName", span),
    ].filter((part): part is string => part !== null && part.length > 0);
    checkTextLength(
      parts.reduce((length, part) => length + part.length + 1, -1),
      "say",
      span,
    );
    const derived = parts.join(" ");
    displayName = derived.length === 0 ? speaker.identifier : derived;
    fallback = derived.length === 0;
  }
  if (fallback && !evaluator.snapshot.warnedSpeakerIds.includes(speaker.id)) {
    const warningSequence = takeSequence(evaluator.snapshot);
    evaluator.snapshot.warnedSpeakerIds.push(speaker.id);
    events.push(
      Object.freeze({
        kind: "developerWarning",
        sequence: warningSequence,
        severity: "warning",
        code: "TSW001" satisfies DeveloperWarningCode,
        message: `Speaker '${speaker.identifier}' uses its identifier as the display name.`,
        span: copySpan(span),
      } satisfies DeveloperWarningEvent),
    );
  }
  return Object.freeze({
    identifier: speaker.identifier,
    displayName,
    color: normalizeColor(speaker.properties.find((property) => property.name === "color")?.value),
    font: optionalSpeakerString(speaker, "font", span),
    avatar: optionalSpeakerString(speaker, "avatar", span),
  });
}

/** `${...}` text. A list selects one element with the session RNG, again at every evaluation. */
export function interpolationText(
  evaluator: Evaluator,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): string {
  if (isDict(value)) throw fault("TSR021", DICT_TEXT_MESSAGE, span);
  if (!isList(value)) return visibleText(value, span, currentTemporalContext(evaluator.snapshot));
  if (value.items.length === 0)
    throw fault(
      "TSR019",
      "'${...}' shows one random element of a list, but this list is empty. Check its length first.",
      span,
    );
  if (!value.items.every(isVisibleScalar))
    throw fault(
      "TSR021",
      "An interpolated list may contain only text, numbers, true, false, null, durations, angles, date and time values, script references, and regexes, because one element is shown as text.",
      span,
    );
  return visibleText(
    randomItem(evaluator, value.items, span, "interpolation"),
    span,
    currentTemporalContext(evaluator.snapshot),
  );
}

/**
 * `say` text. A value shown as text (`shown`) shows as its text, and any other in code-like notation, escaped so that
 * markup leaves it literal: a script reference shows as the call that makes it, and a regex as its literal.
 */
export function sayText(
  evaluator: Evaluator,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): string {
  if (isVisibleScalar(value) && VALUE_KINDS[valueKindOf(value)].shown === "text")
    return visibleText(value, span, currentTemporalContext(evaluator.snapshot));
  const notation = valueNotation(
    value,
    span,
    (handle) => handleNotation(evaluator, handle, span),
    "say",
  );
  // Escaping puts a backslash before some characters, so only a notation that could get too long is measured first.
  if (notation.length * 2 > MAX_TEXT_LENGTH)
    checkTextLength(escapedMarkupLength(notation), "say", span);
  return escapeMarkup(notation);
}

/**
 * A handle as `say` shows it, from the state the snapshot holds now: `<timer "Beat", 7 s left>`,
 * `<timer, paused, 7 s left>`, `<media "music.mp3", playing at 12 s>`, a settled `<timer, finished>`, or
 * `<permanent button "Stop">`.
 */
function handleNotation(
  evaluator: Evaluator,
  handle:
    | SerializableTimerHandle
    | SerializableMediaHandle
    | SerializablePermanentButtonHandle
    | SerializableCameraViewHandle,
  span: SourceSpan,
): string {
  if (evaluator.trace !== null) evaluator.readState(handle, null);
  if (isCameraView(handle)) {
    const view = cameraView(evaluator);
    return view.shown ? `<camera ${view.placement}>` : "<camera, hidden>";
  }
  if (isPermanentButton(handle)) {
    const shown = shownPermanentButton(evaluator.snapshot, handle.buttonId);
    return shown === undefined
      ? "<permanent button, removed>"
      : quotedTextWithin("<permanent button ", shown.button.text, ">", "say", span);
  }
  const now = evaluator.snapshot.currentSessionTimeMs;
  const time = (value: SerializableRuntimeValue | undefined): string =>
    value !== undefined && isDuration(value) ? formatDuration(value.milliseconds) : "";
  if (isTimerHandle(handle)) {
    const timer = timerOf(evaluator, handle, span);
    const left = `${time(timerProperty(timer, "remaining", now))} left`;
    const rest =
      timer.state === "running"
        ? `, ${left}>`
        : timer.state === "paused"
          ? `, paused, ${left}>`
          : `, ${timer.state}>`;
    return timer.label === null
      ? `<timer${rest}`
      : quotedTextWithin("<timer ", timer.label, rest, "say", span);
  }
  const media = mediaOf(evaluator, handle, span);
  const at = `at ${time(mediaProperty(media, "position", now))}`;
  const state =
    media.state === "running"
      ? `playing ${at}`
      : media.state === "paused"
        ? `paused ${at}`
        : media.state;
  return quotedTextWithin("<media ", media.source, `, ${state}>`, "say", span);
}

const DICT_TEXT_MESSAGE =
  '"${...}" cannot show a dict. Select one value with dict[key], or show every value with dict.values.join().';

function optionalSpeakerString(
  speaker: RuntimeSpeakerSnapshot,
  name: string,
  span: SourceSpan,
): string | null {
  const value = speaker.properties.find((property) => property.name === name)?.value;
  if (value === undefined || value === null) return null;
  if (isList(value) && name !== "font" && name !== "avatar")
    throw fault(
      "TSR030",
      `A list cannot be the speaker's ${name}. Select one element with "\${list}" or list.random.`,
      span,
    );
  if (typeof value !== "string")
    throw fault(
      "TSR030",
      `Speaker property '${name}' must be text (string), but this is ${describeShownValue(value)}.`,
      span,
    );
  return value;
}

export function setSpeakerProperty(
  speaker: RuntimeSpeakerSnapshot,
  name: string,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): void {
  if (name === "defaultSaySkippable" && typeof value !== "boolean") {
    throw fault(
      "TSR050",
      `Speaker property 'defaultSaySkippable' must be true or false (boolean), but this is ${describeShownValue(value)}.`,
      span,
    );
  }
  const property = speaker.properties.find((item) => item.name === name);
  if (property === undefined)
    speaker.properties.push({ name, value: cloneCapturedSerializableValue(value) });
  else property.value = cloneCapturedSerializableValue(value);
}
