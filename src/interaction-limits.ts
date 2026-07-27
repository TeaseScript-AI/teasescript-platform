/**
 * Versioned technical safety limits for foreground-interaction data.
 *
 * These are transport/runtime ceilings, not recommended UI lengths. Strings
 * are counted as UTF-8 bytes. The aggregate budget counts every retained UI
 * string and choice label string once. Collection entries are counted
 * separately so validation and matching remain bounded even for empty text.
 */
export const INTERACTION_LIMITS_VERSION = 1;
export const INTERACTION_WHITESPACE_CLASSIFICATION = "ecmascript-whitespace-v1";
export const MAX_INTERACTION_STRING_UTF8_BYTES = 65_536;
export const MAX_INTERACTION_OPTION_ENTRIES = 4_096;
export const MAX_INTERACTION_AGGREGATE_UTF8_BYTES = 65_536;

const encoder = new TextEncoder();

export function interactionUtf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function interactionStringFits(value: string): boolean {
  // UTF-8 is never shorter than the source UTF-16 code-unit count. This
  // constant-time rejection avoids allocating an oversized encoded copy.
  if (value.length > MAX_INTERACTION_STRING_UTF8_BYTES) return false;
  return interactionUtf8ByteLength(value) <= MAX_INTERACTION_STRING_UTF8_BYTES;
}

export function interactionStringHasNonWhitespace(value: string): boolean {
  return !/^\s*$/u.test(value);
}
