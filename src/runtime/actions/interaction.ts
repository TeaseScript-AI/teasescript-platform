import { isTimeoutLength } from "../../delay-rules.js";
import { isSha256Hex } from "../values/sha256.js";
import { resolveAnswer, type ResolvedInteraction } from "../../interaction-completion.js";
import type { InteractionAccessibleName, InteractionUiPayload } from "../../plan/model.js";
import type { SerializableRuntimeValue } from "../values/serializable-values.js";
import type { CapturedMediaAdmission } from "./capture.js";
import type { TemporalContext } from "../../temporal.js";
import type { RuntimeInteractionActionSnapshot } from "./model.js";

/**
 * The milliseconds of a `showButton` timeout: an elapsed duration that is finite and greater than zero. Returns `null`
 * for any other value.
 */
export function buttonTimeoutMilliseconds(value: unknown): number | null {
  const milliseconds =
    isPlainRecord(value) && value.kind === "duration" && typeof value.milliseconds === "number"
      ? value.milliseconds
      : Number.NaN;
  return isTimeoutLength(milliseconds) ? milliseconds : null;
}

export type { ResolvedInteraction } from "../../interaction-completion.js";

/**
 * `context` is the player's presentation now, which shows a date or time answer in the transcript. `capturedMedia`
 * vouches for an image answer; without it no image request completes.
 */
export function resolveInteractionCompletion(
  action: RuntimeInteractionActionSnapshot,
  payload: unknown,
  context: TemporalContext,
  capturedMedia: CapturedMediaAdmission | undefined,
): ResolvedInteraction {
  if (!isPlainRecord(payload)) {
    return { ok: false, message: "Interaction completion payload must be an object." };
  }
  // askPassword: the Player answers with the SHA-256 of the typed text, never the text (V30 §20).
  if (action.interactionKind === "password")
    return payload.kind === "submittedPassword" &&
      Object.keys(payload).length === 2 &&
      isSha256Hex(payload.hash)
      ? { ok: true, result: payload.hash, transcriptText: null }
      : {
          ok: false,
          message:
            "Password completion requires { kind: 'submittedPassword', hash } with the SHA-256 of the typed text as 64 lowercase hexadecimal digits.",
        };
  return resolveAnswer(action, payload, context, capturedMedia);
}

type ImageInteractionUi = Extract<InteractionUiPayload, { kind: "image" }>;

export function cloneImageUi(
  ui: ImageInteractionUi,
  accessibleName: InteractionAccessibleName,
): ImageInteractionUi {
  return {
    kind: "image",
    question: ui.question,
    hint: ui.hint,
    allowCamera: ui.allowCamera,
    allowFile: ui.allowFile,
    allowSkip: ui.allowSkip,
    types: ui.types === null ? null : [...ui.types],
    mime: ui.mime === null ? null : [...ui.mime],
    accessibleName,
  };
}

/**
 * What an open image request keeps in its request temporary: its arguments as they apply, with the question (`message`)
 * and hint as text and no question, hint, `types`, or `mime` when there is none. Reading it again gives the same request.
 */
export function imageRequestValue(
  ui: Pick<
    ImageInteractionUi,
    "question" | "hint" | "allowCamera" | "allowFile" | "allowSkip" | "types" | "mime"
  >,
): SerializableRuntimeValue {
  const texts = (items: readonly string[]): SerializableRuntimeValue => ({
    kind: "list",
    items: [...items],
  });
  return {
    kind: "object",
    properties: [
      ...(ui.question === null ? [] : [{ name: "message", value: ui.question }]),
      ...(ui.hint === null ? [] : [{ name: "hint", value: ui.hint }]),
      { name: "allowCamera", value: ui.allowCamera },
      { name: "allowFile", value: ui.allowFile },
      { name: "allowSkip", value: ui.allowSkip },
      ...(ui.types === null ? [] : [{ name: "types", value: texts(ui.types) }]),
      ...(ui.mime === null ? [] : [{ name: "mime", value: texts(ui.mime) }]),
    ],
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
