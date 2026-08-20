import assert from "node:assert/strict";
import test from "node:test";
import {
  compileSource,
  createLanguageDocument,
  formatLanguageDocument,
  languageCompletions,
  languageContextHelp,
  languageDiagnostics,
  languageHover,
  languagePositionAt,
  languageSignatureHelp,
} from "../src/index.js";

function labels(source: string, offset = source.length): readonly string[] {
  const document = createLanguageDocument("file:///main.tease", source);
  return languageCompletions(document, languagePositionAt(document, offset)).map((item) => item.label);
}

test("language positions use UTF-16 offsets and CRLF-aware zero-based lines", () => {
  const document = createLanguageDocument("file:///main.tease", "a\r\n😀b");
  assert.deepEqual(languagePositionAt(document, 3), { offset: 3, line: 1, column: 0 });
  assert.deepEqual(languagePositionAt(document, 5), { offset: 5, line: 1, column: 2 });
});

test("language diagnostics are the canonical compilation diagnostics", () => {
  const document = createLanguageDocument("file:///main.tease", "let answer = askText as");
  assert.deepEqual(languageDiagnostics(document), compileSource(document.text).diagnostics);
});

test("completion exposes accepted compact commands without deferred APIs", () => {
  assert.deepEqual([...labels("")].sort(), ["say", "showButton"]);
  const expression = labels("let answer = ");
  for (const expected of ["askText", "askNumber", "choose"]) assert.ok(expression.includes(expected));
  for (const unsupported of ["timeout", "elapsed", "typingIndicator", "interpret", "import"]) assert.ok(!expression.includes(unsupported));
});

test("completion exposes optional speaker and current say modifiers", () => {
  const speakers = labels('speaker mistress { name: "Mistress" }\nlet answer = askText as');
  assert.ok(speakers.includes("mistress"));
  const say = labels("say");
  assert.ok(say.includes("as"));
  assert.ok(say.includes("skippable"));
  assert.ok(say.includes("unskippable"));
  const pacing = labels('say "Hi",');
  assert.ok(pacing.includes("instant"));
  assert.ok(pacing.includes("0"));
});

test("context, hover, and signature help describe current compact semantics", () => {
  const document = createLanguageDocument("file:///main.tease", 'let answer = askText "Type here"');
  const position = languagePositionAt(document, document.text.indexOf("askText") + 2);
  const help = languageContextHelp(document, position);
  assert.equal(help?.command, "askText");
  assert.match(help?.summary ?? "", /whitespace-only/u);
  assert.match(help?.summary ?? "", /not transcript text/u);
  assert.match(languageHover(document, position)?.contents.join(" ") ?? "", /askText/u);
  assert.equal(languageSignatureHelp(document, position)?.label, "askText [as speaker] [hint]");
});

test("number and choice help reflects current result rules", () => {
  const numberDoc = createLanguageDocument("file:///number.tease", "let x = askNumber");
  assert.match(languageContextHelp(numberDoc, languagePositionAt(numberDoc, 10))?.summary ?? "", /negative zero/u);
  const choiceDoc = createLanguageDocument("file:///choice.tease", 'let x = choose first: "A", second: "B"');
  assert.match(languageContextHelp(choiceDoc, languagePositionAt(choiceDoc, 10))?.summary ?? "", /exact label/u);
});

test("formatter normalizes compact owned whitespace and is idempotent", () => {
  const source = [
    'speaker mistress { name: "Mistress" }',
    'showButton   as   mistress   "Continue"',
    'let answer = askText   as   mistress   "Type here"',
    'let result = choose   first :   "A"  ,\n   second  : "B"',
    'say as mistress skippable   "Good",   instant',
  ].join("\n");
  const document = createLanguageDocument("file:///main.tease", source);
  const first = formatLanguageDocument(document);
  assert.match(first.text, /showButton as mistress "Continue"/u);
  assert.match(first.text, /askText as mistress "Type here"/u);
  assert.match(first.text, /choose first: "A", second: "B"/u);
  assert.match(first.text, /"Good", instant/u);
  const second = formatLanguageDocument(createLanguageDocument(document.uri, first.text));
  assert.equal(second.text, first.text);
  assert.equal(second.edits.length, 0);
});

test("formatter preserves strings, escapes, templates, comments, and choice order", () => {
  const source = [
    '// keep  comment spacing',
    'let prefix = "x  y"',
    'let result = choose first: `A  ${prefix}`, second: "B\\n  C"',
  ].join("\n");
  const formatted = formatLanguageDocument(createLanguageDocument("file:///main.tease", source)).text;
  assert.ok(formatted.includes("// keep  comment spacing"));
  assert.ok(formatted.includes('"x  y"'));
  assert.ok(formatted.includes('`A  ${prefix}`'));
  assert.ok(formatted.includes('"B\\n  C"'));
  assert.ok(formatted.indexOf("first:") < formatted.indexOf("second:"));
});

test("formatter leaves malformed and incomplete source untouched", () => {
  for (const source of ["showButton", "let x = choose", 'let x = choose "A",', "let x = askText as"]) {
    const result = formatLanguageDocument(createLanguageDocument("file:///main.tease", source));
    assert.equal(result.text, source);
    assert.equal(result.edits.length, 0);
  }
});

test("editor analysis compiles but never executes source", () => {
  const document = createLanguageDocument("file:///main.tease", "let x = sideEffect()\nlet answer = askText");
  const before = globalThis.__languageToolingSideEffect;
  languageDiagnostics(document);
  languageCompletions(document, languagePositionAt(document, document.text.length));
  assert.equal(globalThis.__languageToolingSideEffect, before);
});

declare global {
  // Test-only sentinel proving analysis cannot call package/source code.
  var __languageToolingSideEffect: unknown;
}
