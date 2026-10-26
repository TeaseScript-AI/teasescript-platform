// Walking a text by code point, from its own code units only. V8's optimizing compiler (Maglev, in Node 24 and 26) reads
// `codePointAt` at the last index of a sliced text past its end: at a lone high surrogate there it can return the pair
// that the original text went on with, which made a walk end one unit after the text.

/**
 * The UTF-16 width of the character at `index`: 2 for a high surrogate followed by a low one, otherwise 1, also for a
 * lone surrogate at the end.
 */
export function codePointWidth(text: string, index: number): 1 | 2 {
  const unit = text.charCodeAt(index);
  if (unit < 0xd800 || unit > 0xdbff || index + 1 >= text.length) return 1;
  const next = text.charCodeAt(index + 1);
  return next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
}

/** The code point at `index`, a lone surrogate as itself, as `codePointAt` gives it in a text of its own. */
export function readCodePoint(text: string, index: number): number {
  const unit = text.charCodeAt(index);
  if (codePointWidth(text, index) === 1) return unit;
  return (unit - 0xd800) * 0x400 + (text.charCodeAt(index + 1) - 0xdc00) + 0x10000;
}
