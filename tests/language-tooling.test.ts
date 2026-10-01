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
  createFreshRuntimeSnapshot,
  run,
} from "../src/index.js";

function labels(source: string, offset = source.length): readonly string[] {
  const document = createLanguageDocument("file:///main.tease", source);
  return languageCompletions(document, languagePositionAt(document, offset)).map(
    (item) => item.label,
  );
}

test("language positions use UTF-16 offsets and CRLF-aware zero-based lines", () => {
  const document = createLanguageDocument("file:///main.tease", "a\r\n😀b");
  assert.deepEqual(languagePositionAt(document, 2), { offset: 2, line: 1, column: 0 });
  assert.deepEqual(languagePositionAt(document, 3), { offset: 3, line: 1, column: 0 });
  assert.deepEqual(languagePositionAt(document, 5), { offset: 5, line: 1, column: 2 });
});

test("language diagnostics are the canonical compilation diagnostics", () => {
  const document = createLanguageDocument("file:///main.tease", "let answer = askText as");
  assert.deepEqual(languageDiagnostics(document), compileSource(document.text).diagnostics);
});

test("completion exposes accepted compact commands", () => {
  const statement = labels("");
  for (const expected of ["say", "showButton"]) assert.ok(statement.includes(expected), expected);
  const expression = labels("let answer = ");
  for (const expected of ["askText", "askNumber", "choose"])
    assert.ok(expression.includes(expected), expected);
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

test("context, hover, and signature help select the compact command and its slots", () => {
  const document = createLanguageDocument("file:///main.tease", 'let answer = askText "Type here"');
  const start = document.text.indexOf("askText");
  const position = languagePositionAt(document, document.text.indexOf("Type"));
  assert.equal(languageContextHelp(document, position)?.command, "askText");
  assert.deepEqual(languageHover(document, position)?.range, {
    start: languagePositionAt(document, start),
    end: languagePositionAt(document, start + "askText".length),
  });
  const signature = languageSignatureHelp(document, position);
  assert.deepEqual(signature?.parameters, ["speaker", "hint"]);
  assert.equal(signature?.activeParameter, 1);
});

const DEEP_SAY = 'say   "deep"  ,instant';

/** The deepest `say` has irregular owned whitespace, so formatting that stops descending leaves it unchanged. */
function assertDeepSayTooling(source: string): void {
  assert.notEqual(compileSource(source).plan, null);
  const document = createLanguageDocument("file:///main.tease", source);
  const start = source.indexOf(DEEP_SAY);
  const formatted = formatLanguageDocument(document);
  assert.equal(formatted.text, source.replace(DEEP_SAY, 'say "deep", instant'));
  assert.notEqual(formatted.edits.length, 0);
  for (const edit of formatted.edits) {
    assert.ok(edit.range.start.offset > start && edit.range.end.offset < start + DEEP_SAY.length);
  }
  const hover = languageHover(document, languagePositionAt(document, start + 1));
  assert.deepEqual(hover?.range, {
    start: languagePositionAt(document, start),
    end: languagePositionAt(document, start + "say".length),
  });
  const topLevel = createLanguageDocument("file:///top.tease", 'say "top"');
  assert.deepEqual(
    hover?.contents,
    languageHover(topLevel, languagePositionAt(topLevel, 1))?.contents,
  );
}

test("hover and formatting handle deeply nested source inside a timer expiry block", () => {
  const depth = 4_000;
  assertDeepSayTooling(
    `timer async 1 {\n${"if true {\n".repeat(depth)}${DEEP_SAY}\n${"}\n".repeat(depth)}}\n`,
  );
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

test("formatter preserves strings, escapes, interpolation, comments, and choice order", () => {
  const source = [
    "// keep  comment spacing",
    'let prefix = "x  y"',
    'let result = choose   first :   "A  ${prefix}"  ,   second  :  "B\\n  C"',
  ].join("\n");
  const result = formatLanguageDocument(createLanguageDocument("file:///main.tease", source));
  assert.notEqual(result.edits.length, 0);
  const formatted = result.text;
  assert.ok(formatted.includes("// keep  comment spacing"));
  assert.ok(formatted.includes('"x  y"'));
  assert.ok(formatted.includes('choose first: "A  ${prefix}", second: "B\\n  C"'));
  assert.ok(formatted.indexOf("first:") < formatted.indexOf("second:"));
});

test("formatter preserves block-string values and is idempotent", () => {
  const source = 'say   """\r\n\tFirst\r\n\t  Second ${1 + 1}\r\n\t""",   instant';
  const document = createLanguageDocument("file:///block.tease", source);
  const first = formatLanguageDocument(document);
  const second = formatLanguageDocument(createLanguageDocument(document.uri, first.text));
  assert.equal(second.text, first.text);
  assert.equal(second.edits.length, 0);

  for (const candidate of [source, first.text]) {
    const compiled = compileSource(candidate);
    assert.deepEqual(compiled.diagnostics, []);
    assert.notEqual(compiled.plan, null);
    const execution = run(compiled.plan!, createFreshRuntimeSnapshot(compiled.plan!));
    assert.equal(execution.events.find((event) => event.kind === "say")?.text, "First\n  Second 2");
  }
});

test("formatter leaves malformed and incomplete source untouched", () => {
  for (const source of [
    "showButton",
    "let x = choose",
    'let x = choose "A",',
    "let x = askText as",
  ]) {
    const result = formatLanguageDocument(createLanguageDocument("file:///main.tease", source));
    assert.equal(result.text, source);
    assert.equal(result.edits.length, 0);
  }
});

test("signature help ignores punctuation inside say strings and tracks grammar slots", () => {
  const active = (source: string) => {
    const document = createLanguageDocument("file:///main.tease", source);
    return languageSignatureHelp(document, languagePositionAt(document, source.length))
      ?.activeParameter;
  };
  assert.equal(active('say "Hello, there"'), 2);
  assert.equal(active('say "Hello, there",'), 3);
  assert.equal(active("say as narrator"), 0);
  assert.equal(active("say as narrator "), 2);
  assert.equal(active("say skippable"), 1);
  assert.equal(active("say skippable "), 2);
  assert.equal(active("say unskippable "), 2);
  assert.equal(active("askText as mistress"), 0);
  assert.equal(active("askText as mistress "), 1);
  assert.equal(active("askNumber as mistress "), 1);
  assert.equal(active("showButton as mistress "), 1);
  assert.equal(active("choose as mistress "), 1);
  assert.equal(active('say ["Hello", "there"]'), 2);
});

test("editor tooling handles deeply nested media blocks without native recursion", () => {
  const depth = 2_500;
  assertDeepSayTooling(
    `${'playAudio async "a" {\n'.repeat(depth)}${DEEP_SAY}\n${"}\n".repeat(depth)}`,
  );
});
