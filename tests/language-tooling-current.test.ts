import assert from "node:assert/strict";
import test from "node:test";
import {
  createLanguageDocument,
  formatLanguageDocument,
  languageCompletions,
  languageDiagnostics,
  languageHover,
  languagePositionAt,
  languageSignatureHelp,
} from "../src/index.js";

test("language tooling exposes canonical diagnostics and ADR 0018 completion", () => {
  const document = createLanguageDocument("file:///main.tease", "let answer = \n");
  assert.equal(languageDiagnostics(document)[0]?.code, "TSP012");
  const position = languagePositionAt(document, document.text.length - 1);
  assert.ok(languageCompletions(document, position).some((item) => item.label === "askText"));
  const command = createLanguageDocument("file:///main.tease", "let answer = askText");
  assert.equal(
    languageHover(command, languagePositionAt(command, command.text.length - 2))?.contents[0],
    "**askText**",
  );
  assert.equal(
    languageSignatureHelp(command, languagePositionAt(command, command.text.length - 2))
      ?.activeParameter,
    1,
  );
});

test("formatter is safe for malformed source and idempotent for valid compact forms", () => {
  const malformed = createLanguageDocument("file:///main.tease", 'say "unterminated');
  assert.equal(formatLanguageDocument(malformed).text, malformed.text);
  const source = createLanguageDocument(
    "file:///main.tease",
    'say   "Hello" ,instant\nshowButton   "Go"\n',
  );
  const once = formatLanguageDocument(source).text;
  const twice = formatLanguageDocument(createLanguageDocument(source.uri, once)).text;
  assert.equal(once, twice);
});
