/** What a token or comment is, for its colour (see `classifyTokens` in `language-tooling.ts`). */
export const LANGUAGE_TOKEN_CLASSES = Object.freeze([
  "keyword",
  "type",
  "command",
  "name",
  "number",
  "string",
  "interpolation",
  "regex",
  "comment",
  "operator",
  "punctuation",
] as const);

export type LanguageTokenClass = (typeof LANGUAGE_TOKEN_CLASSES)[number];
