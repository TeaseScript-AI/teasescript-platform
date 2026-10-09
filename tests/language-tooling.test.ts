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

test("completion exposes accepted compact commands and takePhoto", () => {
  const statement = labels("");
  for (const expected of ["say", "showButton", "showCamera", "hideCamera"])
    assert.ok(statement.includes(expected), expected);
  const expression = labels("let answer = ");
  for (const expected of [
    "askText",
    "askNumber",
    "askInteger",
    "askDate",
    "askTime",
    "askDateTime",
    "choose",
    "showButton",
    "takePhoto",
    "showCamera",
  ])
    assert.ok(expression.includes(expected), expected);
});

test("completion exposes optional speaker and current say modifiers", () => {
  const speakers = labels('speaker mistress { name: "Mistress" }\nlet answer = askText as');
  assert.ok(speakers.includes("mistress"));
  const protectedSpeaker = labels(
    'speaker set { name: "Set" }\nspeaker mistress { name: "Mistress" }\nsay as',
  );
  assert.ok(protectedSpeaker.includes("mistress"));
  assert.ok(!protectedSpeaker.includes("set"));
  const say = labels("say");
  assert.ok(say.includes("as"));
  assert.ok(say.includes("skippable"));
  assert.ok(say.includes("unskippable"));
  const pacing = labels('say "Hi",');
  assert.ok(pacing.includes("instant"));
  assert.ok(pacing.includes("0"));
});

test("context, hover, and signature help select the compact command and its slots", () => {
  const document = createLanguageDocument(
    "file:///main.tease",
    'let answer = askText "Type here"\nexit',
  );
  const start = document.text.indexOf("askText");
  const position = languagePositionAt(document, document.text.indexOf("Type"));
  assert.equal(languageContextHelp(document, position)?.command, "askText");
  assert.deepEqual(languageHover(document, position)?.range, {
    start: languagePositionAt(document, start),
    end: languagePositionAt(document, start + "askText".length),
  });
  const signature = languageSignatureHelp(document, position);
  assert.deepEqual(signature?.parameters, ["speaker", "question", "prefill", "hint"]);
  assert.equal(signature?.activeParameter, 1);
});

test("formatting reaches a command inside a computed call target", () => {
  const document = createLanguageDocument(
    "file:///main.tease",
    'call script(askText   "Room?")\nexit',
  );
  assert.equal(formatLanguageDocument(document).text, 'call script(askText "Room?")\nexit');
});

test("editor help and formatting cover showButton used as a value with a timeout", () => {
  const source = 'let elapsed = showButton   as   mistress "Go", timeout: 5';
  const document = createLanguageDocument(
    "file:///main.tease",
    `speaker mistress { name: "Mistress" }\n${source}\nexit`,
  );
  const start = document.text.indexOf("showButton");
  const hover = languageHover(document, languagePositionAt(document, document.text.indexOf("5")));
  assert.deepEqual(hover?.range, {
    start: languagePositionAt(document, start),
    end: languagePositionAt(document, start + "showButton".length),
  });
  assert.ok(hover?.contents.some((line) => line.includes("timeout: duration")));
  assert.match(
    formatLanguageDocument(document).text,
    /let elapsed = showButton as mistress "Go", timeout: 5/u,
  );
});

test("formatting and help reach a say used as a value, which keeps its parentheses where they are written", () => {
  const document = createLanguageDocument(
    "file:///main.tease",
    'let line = say   "Waiting."  ,instant\nlet lines = [say("A" ,instant), say   ("B")]\nexit',
  );
  assert.equal(
    formatLanguageDocument(document).text,
    'let line = say "Waiting.", instant\nlet lines = [say("A", instant), say ("B")]\nexit',
  );
  const hover = languageHover(document, languagePositionAt(document, document.text.indexOf('"A"')));
  assert.ok(hover?.contents.some((line) => line.includes("messageHandle")));
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
  const topLevel = createLanguageDocument("file:///top.tease", 'say "top"\nexit');
  assert.deepEqual(
    hover?.contents,
    languageHover(topLevel, languagePositionAt(topLevel, 1))?.contents,
  );
}

test("hover and formatting handle deeply nested source inside a timer expiry block", () => {
  const depth = 4_000;
  assertDeepSayTooling(
    `timer async 1 {\n${"if true {\n".repeat(depth)}${DEEP_SAY}\n${"}\n".repeat(depth)}}\nexit\n`,
  );
});

test("formatter normalizes compact owned whitespace and is idempotent", () => {
  const source = [
    'speaker mistress { name: "Mistress" }',
    'showButton   as   mistress   "Continue"',
    'let answer = askText   as   mistress   "Type here"',
    'let result = choose   first :   "A"  ,\n   second  : "B"',
    'say as mistress skippable   "Good",   instant',
    "exit",
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
    "exit",
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
  const source = 'say   """\r\n\tFirst\r\n\t  Second ${1 + 1}\r\n\t""",   instant\nexit';
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
  // Compare slot names, not positions, so adding an accepted slot to a signature does not shift the expectations.
  // `after` follows the cursor.
  const activeSlot = (source: string, after = "") => {
    const document = createLanguageDocument("file:///main.tease", source + after);
    const help = languageSignatureHelp(document, languagePositionAt(document, source.length));
    return help === null ? null : help.parameters[help.activeParameter];
  };
  assert.equal(activeSlot('say "Hello, there"'), "text");
  assert.equal(activeSlot('say "Hello, there",'), "pacing");
  assert.equal(activeSlot("say as narrator"), "speaker");
  assert.equal(activeSlot("say as narrator "), "text");
  assert.equal(activeSlot("say skippable"), "skip policy");
  assert.equal(activeSlot("say skippable "), "text");
  assert.equal(activeSlot("say unskippable "), "text");
  assert.equal(activeSlot("askText as mistress"), "speaker");
  assert.equal(activeSlot("askText as mistress "), "question");
  assert.equal(activeSlot("askNumber as mistress "), "question");
  assert.equal(activeSlot('askText "Name?", prefill: '), "prefill");
  assert.equal(activeSlot("askNumber prefill: "), "prefill");
  assert.equal(activeSlot('askInteger "How many?", prefill: '), "prefill");
  assert.equal(activeSlot('askDateTime "When?", prefill: '), "prefill");
  assert.equal(activeSlot('askText "Name?", hint: '), "hint");
  // A parenthesized ask's own parentheses hold its arguments.
  assert.equal(activeSlot('askText("Q", prefill: '), "prefill");
  assert.equal(activeSlot('askText("Q", hint: '), "hint");
  assert.equal(activeSlot('askText as mistress ("Q", prefill: '), "prefill");
  assert.equal(activeSlot('askText("Q"'), "question");
  assert.equal(activeSlot('askText("Q", prefill: pick(hint: 1'), "prefill");
  assert.equal(activeSlot('say "${askText("Q", hint: '), "hint");
  // Its `)` ends it, so what follows belongs to the enclosing construct, if any.
  assert.equal(activeSlot('let more = askInteger("How many?", prefill: 3) + '), null);
  assert.equal(activeSlot('let more = askInteger as mistress ("How many?") + '), null);
  assert.equal(activeSlot('askText("Q", prefill: askText("Default") + '), "prefill");
  assert.equal(activeSlot('say askText("Q") + '), "text");
  // Before its `)`, as an editor that closes brackets leaves the cursor, the ask is still open.
  assert.equal(activeSlot("askText(", ")"), "question");
  assert.equal(activeSlot('askText("Q", hint: ', ")"), "hint");
  assert.equal(activeSlot('askText("Q", prefill: askText(', "))"), "question");
  assert.equal(activeSlot('askText("Q", prefill: askText("D"', "))"), "question");
  assert.equal(activeSlot('askText("Q", prefill: askText("D")', ")"), "prefill");
  // A command ends with its statement, but its options may go on after a comma or an opening parenthesis.
  assert.equal(activeSlot('askText "Q", hint: 1\nlet y = '), null);
  assert.equal(activeSlot('if ready {\n    askText "Q", hint: 1\n    let y = '), null);
  assert.equal(activeSlot('showButton "Go", timeout: 5 s {\n    let y = '), null);
  assert.equal(activeSlot('askText "Q",\n\n    hint: '), "hint");
  assert.equal(activeSlot('askText(\n    "Q",\n    prefill: ', "\n)"), "prefill");
  assert.equal(activeSlot('let x = askText "Q", hint: "a" +\n    '), "hint");
  assert.equal(activeSlot('askInteger "How many?", hint: "1 to 10", prefill: '), "prefill");
  assert.equal(activeSlot('askText { default: "Name?" }.default'), "question");
  assert.equal(activeSlot('let answer = askText "${askNumber prefill: 3}"'), "question");
  assert.equal(activeSlot("showButton as mistress "), "label");
  assert.equal(activeSlot('showButton "Go", timeout: '), "timeout");
  assert.equal(
    activeSlot('let elapsed = showButton "Go", background: "gold", timeout: 5'),
    "timeout",
  );
  assert.equal(activeSlot('showButton "Go", timeout: 5, background: '), "background");
  assert.equal(activeSlot('let e = { x: (showButton "A"), timeout: 3'), null);
  assert.equal(
    activeSlot('showButton "A", timeout: (askNumber "Seconds"), background: '),
    "background",
  );
  assert.equal(activeSlot("choose as mistress "), "options");
  assert.equal(activeSlot('say ["Hello", "there"]'), "text");
});

test("editor tooling handles deeply nested media blocks without native recursion", () => {
  const depth = 2_500;
  assertDeepSayTooling(
    `${'playAudio async "a" {\n'.repeat(depth)}${DEEP_SAY}\n${"}\n".repeat(depth)}exit\n`,
  );
});
