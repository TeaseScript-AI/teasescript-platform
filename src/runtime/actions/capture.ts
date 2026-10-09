import { interactionStringFits } from "../../interaction-limits.js";
import { isPlainRecord } from "../operations/support.js";
import { CAPTURE_UNAVAILABLE_REASONS, type CaptureUnavailableReason } from "./model.js";

/** Trusted host knowledge about captured media; the engine admits a captured reference only when it vouches for it. */
export interface CapturedMediaAdmission {
  /** Whether `reference` names stored media of `kind` that this host created or loaded. */
  holds(reference: string, kind: "image"): boolean;
}

export type CaptureCompletion =
  | { readonly ok: true; readonly result: string; readonly unavailableReason: null }
  | {
      readonly ok: true;
      readonly result: null;
      readonly unavailableReason: CaptureUnavailableReason;
    }
  | { readonly ok: false; readonly message: string };

const UNAVAILABLE_MESSAGES: Readonly<Record<CaptureUnavailableReason, string>> = {
  unconfigured: "No camera is configured for this session, so takePhoto() returned null.",
  denied: "Camera access was denied, so takePhoto() returned null.",
  notFound: "No camera was found, so takePhoto() returned null.",
  busy: "The camera is in use or could not be started, so takePhoto() returned null.",
  unsupported: "This browser does not support camera capture, so takePhoto() returned null.",
  revoked: "The camera was disconnected or access was revoked, so takePhoto() returned null.",
  failed: "The camera could not capture a photo, so takePhoto() returned null.",
};

export function captureUnavailableMessage(reason: CaptureUnavailableReason): string {
  return UNAVAILABLE_MESSAGES[reason];
}

/**
 * Resolves a capture completion payload. A captured photo must name an image reference the trusted host admits, so an
 * arbitrary host string never becomes a captured reference; an unavailable camera carries one bounded reason.
 */
export function resolveCaptureCompletion(
  payload: unknown,
  admission: CapturedMediaAdmission | undefined,
): CaptureCompletion {
  if (!isPlainRecord(payload)) return invalid();
  if (payload.kind === "captured") {
    const media = payload.media;
    if (
      Object.keys(payload).length !== 2 ||
      !isPlainRecord(media) ||
      Object.keys(media).length !== 2 ||
      media.kind !== "image" ||
      typeof media.reference !== "string" ||
      media.reference.length === 0 ||
      !interactionStringFits(media.reference)
    )
      return invalid();
    if (admission?.holds(media.reference, "image") !== true)
      return { ok: false, message: "The captured photo is not stored media of this host." };
    return { ok: true, result: media.reference, unavailableReason: null };
  }
  if (payload.kind === "unavailable") {
    const reason = CAPTURE_UNAVAILABLE_REASONS.find((candidate) => candidate === payload.reason);
    if (Object.keys(payload).length !== 2 || reason === undefined) return invalid();
    return { ok: true, result: null, unavailableReason: reason };
  }
  return invalid();
}

function invalid(): CaptureCompletion {
  return {
    ok: false,
    message:
      "Capture completion payload must be a captured image reference or an unavailable reason.",
  };
}
