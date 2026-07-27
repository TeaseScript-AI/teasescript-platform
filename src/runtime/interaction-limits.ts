/**
 * Versioned technical bounds for the JSON-safe foreground-interaction boundary.
 * These constrain retained/runtime and host-message data; they are not UI advice.
 */
export const INTERACTION_LIMITS_VERSION = 1;
export const MAX_INTERACTION_TEXT_LENGTH = 16_384;
export const MAX_INTERACTION_OPTIONS = 512;
export const MAX_INTERACTION_SERIALIZED_CHARACTERS = 65_536;

export function isBoundedInteractionText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_INTERACTION_TEXT_LENGTH;
}
