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
