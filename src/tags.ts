/** A tag of a script or an image (ADR 0023): a canonical name and an optional number. */
export interface Tag {
  readonly name: string;
  /** The tag's number, as in `punishment: 4`; `null` for a plain tag. */
  readonly value: number | null;
}

const TAG_NAME = /^[a-z0-9-]+$/u;

/**
 * The canonical form of a written tag name: surrounding whitespace removed and ASCII letters lowercased, as in
 * `" Punishment"` → `punishment`. Returns `null` when the result is empty or has a character other than a lowercase
 * ASCII letter, a digit, or a hyphen.
 */
export function normalizeTagName(text: string): string | null {
  const name = text.trim().replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
  return TAG_NAME.test(name) ? name : null;
}

/** A finite number in a V30 decimal or scientific form with an optional sign, such as `4`, `-1.5`, or `2e3`. */
const TAG_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;

/**
 * Reads a tag written as text, as in an image keyword or a captured photo's tags: `"bedroom"` or `"punishment: 4"`,
 * with any spaces around the `:`. Returns `null` when the name is not a tag name or the number is not a finite number.
 */
export function readTagText(text: string): Tag | null {
  const colon = text.indexOf(":");
  const name = normalizeTagName(colon === -1 ? text : text.slice(0, colon));
  if (name === null) return null;
  if (colon === -1) return { name, value: null };
  const written = text.slice(colon + 1).trim();
  const value = Number(written);
  return TAG_NUMBER.test(written) && Number.isFinite(value) ? { name, value } : null;
}

/**
 * Adds `tag` to `tags`, keyed by name. A repeated name is merged: a number wins over its absence. Two different numbers
 * for one name conflict and leave the first.
 */
export function addTag(tags: Map<string, Tag>, tag: Tag): "added" | "repeated" | "conflict" {
  const existing = tags.get(tag.name);
  if (existing === undefined) {
    tags.set(tag.name, tag);
    return "added";
  }
  if (existing.value !== null && tag.value !== null && existing.value !== tag.value) {
    return "conflict";
  }
  if (existing.value === null && tag.value !== null) tags.set(tag.name, tag);
  return "repeated";
}
